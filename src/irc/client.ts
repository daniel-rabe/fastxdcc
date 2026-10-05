/**
 * The protocol half of an IRC connection: registration (with SASL), keepalive, channel
 * membership, CTCP dispatch, and reconnection.
 */

import { EventEmitter } from 'node:events';
import { Connection, type ConnectionOptions } from './connection.js';
import { extractCtcp, formatCtcp, stripCtcp } from './ctcp.js';
import { formatMessage, parseIsupport, parseMessage, type Message } from './parser.js';

export interface ChannelConfig {
  name: string;
  key?: string;
}

export interface ClientOptions extends ConnectionOptions {
  nick: string;
  username?: string;
  realname?: string;
  /** SASL PLAIN credentials. Preferred over NickServ when the server supports it. */
  sasl?: { account: string; password: string };
  /** Fallback when SASL is unavailable or not configured. */
  nickserv?: { password: string; account?: string };
  channels?: ChannelConfig[];
  /** Attempts before giving up; 0 disables reconnection. */
  maxReconnectAttempts?: number;
}

export interface CtcpEvent {
  from: string;
  target: string;
  command: string;
  args: string;
  /** CTCP replies arrive as NOTICE; requests arrive as PRIVMSG. */
  isReply: boolean;
}

export interface TopicEvent {
  channel: string;
  /** The topic text, or empty when the channel has none. */
  topic: string;
  /** Who set it, present only when the change arrived live rather than on joining. */
  by?: string;
}

export interface TextEvent {
  from: string;
  target: string;
  text: string;
  /**
   * True unless the sender is demonstrably a person.
   *
   * A real client's message carries a full `nick!user@host` prefix. The server's own
   * announcements carry a bare name, and whether that name looks like a host is only a
   * guess — so anything without a user or host part is treated as not a person, which is
   * the safe way round for deciding whether to open a conversation for it.
   */
  fromServer: boolean;
}

export type ClientState = 'disconnected' | 'connecting' | 'registering' | 'registered';

export interface ClientEvents {
  state: [ClientState];
  registered: [string];
  message: [Message];
  privmsg: [TextEvent];
  notice: [TextEvent];
  ctcp: [CtcpEvent];
  joined: [string];
  /** We are no longer in this channel, whether we left or were removed. */
  parted: [string];
  /** A channel's topic, on joining it and whenever it changes afterwards. */
  topic: [TopicEvent];
  /** Human-readable line for the UI log. */
  status: [string];
  error: [Error];
  closed: [];
}

export declare interface IrcClient {
  on<K extends keyof ClientEvents>(event: K, listener: (...args: ClientEvents[K]) => void): this;
  once<K extends keyof ClientEvents>(event: K, listener: (...args: ClientEvents[K]) => void): this;
  off<K extends keyof ClientEvents>(event: K, listener: (...args: ClientEvents[K]) => void): this;
  emit<K extends keyof ClientEvents>(event: K, ...args: ClientEvents[K]): boolean;
}

export class IrcClient extends EventEmitter {
  private connection?: Connection;
  private state: ClientState = 'disconnected';
  private currentNick: string;
  private nickAttempt = 0;
  private reconnectAttempt = 0;
  private reconnectTimer?: NodeJS.Timeout;
  private stopping = false;

  private saslInProgress = false;
  private saslSucceeded = false;
  private capLsBuffer = '';

  readonly isupport: Record<string, string | true> = {};
  readonly channels = new Set<string>();
  /** Current topic per joined channel, keyed by lower-cased name. */
  readonly topics = new Map<string, string>();

  constructor(private readonly options: ClientOptions) {
    super();
    this.currentNick = options.nick;
  }

  get nick(): string {
    return this.currentNick;
  }

  /** The server this client was built for, so callers can compare it against a link. */
  get host(): string {
    return this.options.host;
  }

  get port(): number {
    return this.options.port;
  }

  get connectionState(): ClientState {
    return this.state;
  }

  /** The local address of the IRC socket - a usable default for reverse-DCC listeners. */
  get localAddress(): string | undefined {
    return this.connection?.localAddress;
  }

  private setState(state: ClientState): void {
    if (this.state === state) return;
    this.state = state;
    this.emit('state', state);
  }

  connect(): void {
    this.stopping = false;
    this.openConnection();
  }

  private openConnection(): void {
    this.setState('connecting');
    this.saslInProgress = false;
    this.saslSucceeded = false;
    this.capLsBuffer = '';
    this.nickAttempt = 0;
    this.currentNick = this.options.nick;
    this.channels.clear();
    this.topics.clear();

    const conn = new Connection(this.options);
    this.connection = conn;

    conn.on('connect', () => {
      this.emit('status', `Connected to ${this.options.host}:${this.options.port}`);
      this.reconnectAttempt = 0;
      this.register();
    });
    conn.on('line', (line) => this.onLine(line));
    conn.on('error', (err) => this.emit('error', err));
    conn.on('close', () => {
      this.setState('disconnected');
      this.emit('closed');
      this.scheduleReconnect();
    });

    conn.connect();
  }

  private scheduleReconnect(): void {
    const max = this.options.maxReconnectAttempts ?? 10;
    if (this.stopping || max === 0) return;
    if (this.reconnectAttempt >= max) {
      this.emit('error', new Error(`Giving up after ${max} reconnection attempts`));
      return;
    }
    const delay = Math.min(60_000, 2_000 * 2 ** this.reconnectAttempt);
    this.reconnectAttempt++;
    this.emit(
      'status',
      `Reconnecting in ${Math.round(delay / 1000)}s (attempt ${this.reconnectAttempt})`,
    );
    this.reconnectTimer = setTimeout(() => this.openConnection(), delay);
    this.reconnectTimer.unref?.();
  }

  private register(): void {
    this.setState('registering');
    // CAP LS must come before NICK/USER so the server holds registration open for SASL.
    this.send('CAP', ['LS', '302']);
    this.send('NICK', [this.currentNick]);
    this.send('USER', [
      this.options.username ?? this.options.nick,
      '0',
      '*',
      this.options.realname ?? 'fastxdcc',
    ]);
  }

  private onLine(line: string): void {
    const msg = parseMessage(line);
    if (!msg) return;
    this.emit('message', msg);

    switch (msg.command) {
      case 'PING':
        // Never queued: a delayed PONG gets us pinged out during a busy transfer.
        this.connection?.sendImmediate(formatMessage('PONG', msg.params.slice(0, 1)));
        return;
      case 'CAP':
        this.onCap(msg);
        return;
      case 'AUTHENTICATE':
        this.onAuthenticate(msg);
        return;
      case 'PRIVMSG':
      case 'NOTICE':
        this.onText(msg);
        return;
      case 'JOIN':
        if (msg.prefix?.nick === this.currentNick) {
          const channel = msg.params[0] ?? '';
          this.channels.add(channel.toLowerCase());
          this.emit('joined', channel);
          this.emit('status', `Joined ${channel}`);
        }
        return;
      case 'TOPIC':
        // Anyone in the channel may change it, so this is not limited to our own nick.
        this.setTopic(msg.params[0] ?? '', msg.params[1] ?? '', msg.prefix?.nick);
        return;
      case 'PART':
        // Only our own departure changes what we are in; other people's are chatter.
        if (msg.prefix?.nick === this.currentNick) this.dropChannel(msg.params[0] ?? '');
        return;
      case 'KICK':
        if (msg.params[1] === this.currentNick) {
          const channel = msg.params[0] ?? '';
          this.emit('status', `Kicked from ${channel}${msg.params[2] ? `: ${msg.params[2]}` : ''}`);
          this.dropChannel(channel);
        }
        return;
      case 'ERROR':
        this.emit('error', new Error(msg.params.join(' ')));
        return;
      case 'NICK':
        if (msg.prefix?.nick === this.currentNick && msg.params[0]) {
          this.currentNick = msg.params[0];
        }
        return;
      default:
        break;
    }

    this.onNumeric(msg);
  }

  private onNumeric(msg: Message): void {
    switch (msg.command) {
      case '001': // RPL_WELCOME
        if (msg.params[0]) this.currentNick = msg.params[0];
        this.setState('registered');
        this.emit('registered', this.currentNick);
        this.emit('status', `Registered as ${this.currentNick}`);
        this.identifyWithNickServ();
        break;
      case '005': // RPL_ISUPPORT
        Object.assign(this.isupport, parseIsupport(msg.params));
        break;
      case '376': // RPL_ENDOFMOTD
      case '422': // ERR_NOMOTD
        this.joinConfiguredChannels();
        break;
      case '433': {
        // ERR_NICKNAMEINUSE
        this.nickAttempt++;
        if (this.nickAttempt > 5) {
          this.emit('error', new Error('Could not find an available nickname'));
          break;
        }
        this.currentNick = `${this.options.nick}${'_'.repeat(this.nickAttempt)}`;
        this.emit('status', `Nick in use; trying ${this.currentNick}`);
        this.send('NICK', [this.currentNick]);
        break;
      }
      case '903': // RPL_SASLSUCCESS
        this.saslSucceeded = true;
        this.saslInProgress = false;
        this.emit('status', 'SASL authentication succeeded');
        this.send('CAP', ['END']);
        break;
      case '902': // ERR_NICKLOCKED
      case '904': // ERR_SASLFAIL
      case '905': // ERR_SASLTOOLONG
      case '906': // ERR_SASLABORTED
      case '907': // ERR_SASLALREADY
        this.saslInProgress = false;
        this.emit('status', `SASL failed (${msg.command}); continuing unauthenticated`);
        this.send('CAP', ['END']);
        break;
      case '332': // RPL_TOPIC, sent on joining a channel that has one
        this.setTopic(msg.params[1] ?? '', msg.params[2] ?? '');
        break;
      case '331': // RPL_NOTOPIC
        this.setTopic(msg.params[1] ?? '', '');
        break;
      case '473': // ERR_INVITEONLYCHAN
      case '474': // ERR_BANNEDFROMCHAN
      case '475': // ERR_BADCHANNELKEY
        this.emit('status', `Cannot join ${msg.params[1] ?? '?'}: ${msg.params[2] ?? msg.command}`);
        break;
      default:
        break;
    }
  }

  private onCap(msg: Message): void {
    const sub = (msg.params[1] ?? '').toUpperCase();

    if (sub === 'LS') {
      // CAP LS 302 may be split across lines, marked by a `*` before the list.
      const isMultiline = msg.params[2] === '*';
      this.capLsBuffer += ` ${msg.params[isMultiline ? 3 : 2] ?? ''}`;
      if (isMultiline) return;

      const caps = new Set(
        this.capLsBuffer
          .trim()
          .split(/\s+/)
          .map((c) => c.split('=')[0]!.toLowerCase())
          .filter((c) => c !== ''),
      );

      if (this.options.sasl && caps.has('sasl')) {
        this.send('CAP', ['REQ', 'sasl']);
      } else {
        if (this.options.sasl) this.emit('status', 'Server does not advertise SASL');
        this.send('CAP', ['END']);
      }
      return;
    }

    if (sub === 'ACK' && (msg.params[2] ?? '').toLowerCase().includes('sasl')) {
      this.saslInProgress = true;
      this.send('AUTHENTICATE', ['PLAIN']);
      return;
    }

    if (sub === 'NAK') {
      this.emit('status', 'Server refused the SASL capability');
      this.send('CAP', ['END']);
    }
  }

  private onAuthenticate(msg: Message): void {
    if (!this.saslInProgress || !this.options.sasl) return;
    if (msg.params[0] !== '+') return;

    const { account, password } = this.options.sasl;
    const payload = Buffer.from(`${account}\0${account}\0${password}`, 'utf8').toString('base64');

    // AUTHENTICATE payloads go in 400-character chunks; a final chunk that is exactly
    // 400 characters must be followed by a lone `+` so the server knows it ended.
    for (let i = 0; i < payload.length; i += 400) {
      this.send('AUTHENTICATE', [payload.slice(i, i + 400)]);
    }
    if (payload.length % 400 === 0) this.send('AUTHENTICATE', ['+']);
  }

  private identifyWithNickServ(): void {
    const ns = this.options.nickserv;
    if (!ns || this.saslSucceeded) return;
    const args = ns.account ? `IDENTIFY ${ns.account} ${ns.password}` : `IDENTIFY ${ns.password}`;
    this.send('PRIVMSG', ['NickServ', args]);
    this.emit('status', 'Sent IDENTIFY to NickServ');
  }

  private joinConfiguredChannels(): void {
    for (const channel of this.options.channels ?? []) {
      this.join(channel.name, channel.key);
    }
  }

  private onText(msg: Message): void {
    const from = msg.prefix?.nick ?? '';
    const target = msg.params[0] ?? '';
    const body = msg.params[1] ?? '';
    const isReply = msg.command === 'NOTICE';

    for (const ctcp of extractCtcp(body)) {
      this.emit('ctcp', { from, target, command: ctcp.command, args: ctcp.args, isReply });
    }

    const text = stripCtcp(body);
    if (text === '') return;
    this.emit(isReply ? 'notice' : 'privmsg', {
      from,
      target,
      text,
      fromServer:
        !msg.prefix ||
        msg.prefix.isServer ||
        (msg.prefix.user === undefined && msg.prefix.host === undefined),
    });
  }

  send(command: string, params: string[] = []): void {
    this.connection?.send(formatMessage(command, params));
  }

  raw(line: string): void {
    this.connection?.send(line);
  }

  join(channel: string, key?: string): void {
    this.send('JOIN', key ? [channel, key] : [channel]);
  }

  part(channel: string, reason = ''): void {
    this.send('PART', reason ? [channel, reason] : [channel]);
    // Dropped straight away rather than on the server's echo, so the UI reacts even when
    // the connection is already gone. `dropChannel` ignores the echo when it arrives.
    this.dropChannel(channel);
  }

  /** Forget a channel, announcing it only the first time. */
  private dropChannel(channel: string): void {
    if (!this.channels.delete(channel.toLowerCase())) return;
    this.topics.delete(channel.toLowerCase());
    this.emit('parted', channel);
  }

  /**
   * Record a channel's topic. An empty one is stored as absent rather than as a blank
   * string, so "this channel has no topic" and "we have not been told yet" read alike to
   * everything downstream — both mean there is nothing to show.
   */
  private setTopic(channel: string, topic: string, by?: string): void {
    if (channel === '') return;
    const key = channel.toLowerCase();
    if (topic === '') this.topics.delete(key);
    else this.topics.set(key, topic);
    this.emit('topic', { channel, topic, ...(by ? { by } : {}) });
  }

  /** The topic of a joined channel, matched case-insensitively. */
  topicFor(channel: string): string | undefined {
    return this.topics.get(channel.toLowerCase());
  }

  say(target: string, text: string): void {
    this.send('PRIVMSG', [target, text]);
  }

  ctcp(target: string, command: string, args = ''): void {
    this.send('PRIVMSG', [target, formatCtcp(command, args)]);
  }

  /** True once we are in the channel, matched case-insensitively. */
  isIn(channel: string): boolean {
    return this.channels.has(channel.toLowerCase());
  }

  quit(reason = 'fastxdcc'): void {
    this.stopping = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.connection?.connected) {
      this.connection.sendImmediate(formatMessage('QUIT', [reason]));
    }
    this.connection?.close();
    this.setState('disconnected');
  }
}
