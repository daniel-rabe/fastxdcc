/**
 * A minimal IRC server, enough to drive registration, SASL, joins, and message delivery.
 * It speaks the real wire protocol over loopback, so the client is not mocked anywhere.
 */

import net from 'node:net';
import { parseMessage } from '../../src/irc/parser.js';

export interface FakeIrcOptions {
  /** Advertise the sasl capability in CAP LS. */
  sasl?: boolean;
  /** Fail SASL with 904 instead of succeeding with 903. */
  saslFails?: boolean;
  /** Reject the first nick with 433, so the retry path runs. */
  nickInUse?: boolean;
  serverName?: string;
  /**
   * The topic to announce when a channel is joined. Off by default: most tests count log
   * lines, and an unasked-for topic would add one to every channel they join.
   */
  topic?: (channel: string) => string | undefined;
  /** Called for every PRIVMSG the client sends, so a test can play the part of a bot. */
  onPrivmsg?: (target: string, text: string, ctx: { nick: string; send: (line: string) => void }) => void;
}

export interface FakeIrc {
  port: number;
  /** Every line the client sent, in order. */
  received: string[];
  /** Send a raw line to the connected client. */
  send(line: string): void;
  /** Resolve once a line matching `pattern` has been received. */
  waitFor(pattern: RegExp, timeoutMs?: number): Promise<string>;
  close(): Promise<void>;
}

export async function startFakeIrc(options: FakeIrcOptions = {}): Promise<FakeIrc> {
  const serverName = options.serverName ?? 'fake.irc';
  const received: string[] = [];
  const waiters: Array<{ pattern: RegExp; resolve: (line: string) => void }> = [];

  let socket: net.Socket | undefined;
  let sawCapLs = false;
  let userDone = false;
  let registered = false;
  let nick = '*';
  let rejectedOnce = false;

  const send = (line: string) => {
    socket?.write(`${line}\r\n`);
  };

  const completeRegistration = () => {
    if (registered || !userDone) return;
    // A real server holds registration open until a nick has actually been accepted.
    if (nick === '*') return;
    if (sawCapLs && !received.some((l) => /^CAP END/i.test(l))) return;
    registered = true;
    send(`:${serverName} 001 ${nick} :Welcome to the fake network`);
    send(`:${serverName} 005 ${nick} CHANTYPES=# PREFIX=(ov)@+ :are supported by this server`);
    send(`:${serverName} 375 ${nick} :- Message of the day -`);
    send(`:${serverName} 376 ${nick} :End of /MOTD command.`);
  };

  const server = net.createServer((conn) => {
    socket = conn;
    let buffer = '';

    conn.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let index: number;
      while ((index = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, index).replace(/\r$/, '');
        buffer = buffer.slice(index + 1);
        if (line === '') continue;

        received.push(line);
        for (let i = waiters.length - 1; i >= 0; i--) {
          if (waiters[i]!.pattern.test(line)) {
            waiters[i]!.resolve(line);
            waiters.splice(i, 1);
          }
        }
        handle(line);
      }
    });
    conn.on('error', () => {});
  });

  function handle(line: string): void {
    const msg = parseMessage(line);
    if (!msg) return;

    switch (msg.command) {
      case 'CAP': {
        const sub = (msg.params[0] ?? '').toUpperCase();
        if (sub === 'LS') {
          sawCapLs = true;
          send(`:${serverName} CAP * LS :multi-prefix${options.sasl ? ' sasl=PLAIN' : ''}`);
        } else if (sub === 'REQ') {
          send(`:${serverName} CAP * ACK :${msg.params[1] ?? ''}`);
        } else if (sub === 'END') {
          completeRegistration();
        }
        return;
      }
      case 'AUTHENTICATE':
        if (msg.params[0] === 'PLAIN') send('AUTHENTICATE +');
        else if (options.saslFails) send(`:${serverName} 904 ${nick} :SASL authentication failed`);
        else send(`:${serverName} 903 ${nick} :SASL authentication successful`);
        return;
      case 'NICK': {
        const requested = msg.params[0] ?? '*';
        if (options.nickInUse && !rejectedOnce) {
          rejectedOnce = true;
          send(`:${serverName} 433 * ${requested} :Nickname is already in use`);
          return;
        }
        nick = requested;
        completeRegistration();
        return;
      }
      case 'USER':
        userDone = true;
        completeRegistration();
        return;
      case 'JOIN': {
        const channel = msg.params[0] ?? '';
        send(`:${nick}!user@host JOIN ${channel}`);
        const topic = options.topic?.(channel);
        // A real server sends one or the other before the names list, never neither.
        if (topic) send(`:${serverName} 332 ${nick} ${channel} :${topic}`);
        else send(`:${serverName} 331 ${nick} ${channel} :No topic is set`);
        send(`:${serverName} 353 ${nick} = ${channel} :${nick} somebot`);
        send(`:${serverName} 366 ${nick} ${channel} :End of /NAMES list.`);
        return;
      }
      case 'PART':
        // Echoed back the way a real server does, so the client's own bookkeeping is
        // exercised rather than only its optimistic local removal.
        send(`:${nick}!user@host PART ${msg.params[0] ?? ''}`);
        return;
      case 'PRIVMSG':
        options.onPrivmsg?.(msg.params[0] ?? '', msg.params[1] ?? '', { nick, send });
        return;
      case 'PING':
        send(`:${serverName} PONG ${serverName} :${msg.params[0] ?? ''}`);
        return;
      default:
        return;
    }
  }

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;

  return {
    port,
    received,
    send,
    waitFor(pattern: RegExp, timeoutMs = 5_000): Promise<string> {
      const existing = received.find((l) => pattern.test(l));
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`Timed out waiting for ${pattern} (saw: ${received.join(' | ')})`)),
          timeoutMs,
        );
        waiters.push({
          pattern,
          resolve: (line) => {
            clearTimeout(timer);
            resolve(line);
          },
        });
      });
    },
    close() {
      socket?.destroy();
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}
