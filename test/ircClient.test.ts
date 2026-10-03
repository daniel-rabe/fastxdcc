import { afterEach, describe, expect, it } from 'vitest';
import { IrcClient } from '../src/irc/client.js';
import { startFakeIrc, type FakeIrc } from './helpers/fakeIrc.js';

let irc: FakeIrc | undefined;
let client: IrcClient | undefined;

afterEach(async () => {
  client?.quit();
  client = undefined;
  await irc?.close();
  irc = undefined;
});

function connect(
  server: FakeIrc,
  options: Partial<ConstructorParameters<typeof IrcClient>[0]> = {},
): IrcClient {
  const c = new IrcClient({
    host: '127.0.0.1',
    port: server.port,
    tls: false,
    nick: 'tester',
    maxReconnectAttempts: 0,
    messageInterval: 5,
    ...options,
  });
  client = c;
  c.on('error', () => {});
  c.connect();
  return c;
}

function once<T>(emitter: IrcClient, event: never, timeoutMs = 5_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${event}`)), timeoutMs);
    emitter.once(event, ((value: T) => {
      clearTimeout(timer);
      resolve(value);
    }) as never);
  });
}

describe('registration', () => {
  it('registers and reports the nick', async () => {
    irc = await startFakeIrc();
    const c = connect(irc);
    const nick = await once<string>(c, 'registered' as never);
    expect(nick).toBe('tester');
    expect(c.connectionState).toBe('registered');
  });

  it('sends CAP LS before NICK so SASL can be negotiated', async () => {
    irc = await startFakeIrc();
    const c = connect(irc);
    await once(c, 'registered' as never);
    const capIndex = irc.received.findIndex((l) => l.startsWith('CAP LS'));
    const nickIndex = irc.received.findIndex((l) => l.startsWith('NICK'));
    expect(capIndex).toBeGreaterThanOrEqual(0);
    expect(capIndex).toBeLessThan(nickIndex);
  });

  it('ends capability negotiation when the server offers no SASL', async () => {
    irc = await startFakeIrc({ sasl: false });
    const c = connect(irc, { sasl: { account: 'acct', password: 'pw' } });
    await once(c, 'registered' as never);
    expect(irc.received).toContain('CAP END');
    expect(irc.received.some((l) => l.startsWith('AUTHENTICATE'))).toBe(false);
  });

  it('completes SASL PLAIN with a correctly encoded payload', async () => {
    irc = await startFakeIrc({ sasl: true });
    const c = connect(irc, { sasl: { account: 'acct', password: 'pw' } });
    await once(c, 'registered' as never);

    const line = irc.received.find((l) => /^AUTHENTICATE [^+P]/.test(l))!;
    expect(line).toBeDefined();
    const decoded = Buffer.from(line.slice('AUTHENTICATE '.length), 'base64').toString('utf8');
    expect(decoded).toBe('acct\0acct\0pw');
    expect(irc.received).toContain('CAP END');
  });

  it('carries on unauthenticated when SASL fails', async () => {
    irc = await startFakeIrc({ sasl: true, saslFails: true });
    const c = connect(irc, { sasl: { account: 'acct', password: 'bad' } });
    const nick = await once<string>(c, 'registered' as never);
    expect(nick).toBe('tester');
  });

  it('retries with a suffixed nick when the first is taken', async () => {
    irc = await startFakeIrc({ nickInUse: true });
    const c = connect(irc);
    const nick = await once<string>(c, 'registered' as never);
    expect(nick).toBe('tester_');
  });

  it('identifies with NickServ when SASL is not in use', async () => {
    irc = await startFakeIrc();
    const c = connect(irc, { nickserv: { password: 'hunter2' } });
    await once(c, 'registered' as never);
    await irc.waitFor(/^PRIVMSG NickServ/);
    expect(irc.received.some((l) => l === 'PRIVMSG NickServ :IDENTIFY hunter2')).toBe(true);
  });

  it('does not double-authenticate when SASL already succeeded', async () => {
    irc = await startFakeIrc({ sasl: true });
    const c = connect(irc, {
      sasl: { account: 'acct', password: 'pw' },
      nickserv: { password: 'hunter2' },
    });
    await once(c, 'registered' as never);
    expect(irc.received.some((l) => l.startsWith('PRIVMSG NickServ'))).toBe(false);
  });
});

describe('session behaviour', () => {
  it('joins configured channels after the MOTD', async () => {
    irc = await startFakeIrc();
    const c = connect(irc, { channels: [{ name: '#packs' }, { name: '#keyed', key: 'sekrit' }] });
    await once(c, 'registered' as never);
    await irc.waitFor(/^JOIN #keyed/);
    expect(irc.received).toContain('JOIN #packs');
    expect(irc.received).toContain('JOIN #keyed sekrit');
  });

  it('tracks channel membership', async () => {
    irc = await startFakeIrc();
    const c = connect(irc, { channels: [{ name: '#packs' }] });
    await new Promise<void>((resolve) => c.once('joined', () => resolve()));
    expect(c.isIn('#PACKS')).toBe(true);
  });

  it('answers PING immediately', async () => {
    irc = await startFakeIrc();
    const c = connect(irc);
    await once(c, 'registered' as never);
    irc.send('PING :abc123');
    await irc.waitFor(/^PONG abc123/);
  });

  it('emits CTCP separately from plain text', async () => {
    irc = await startFakeIrc();
    const c = connect(irc);
    await once(c, 'registered' as never);

    const ctcp = new Promise<{ command: string; args: string }>((resolve) => {
      c.once('ctcp', (event) => resolve(event));
    });
    irc.send(':bot!u@h PRIVMSG tester :\x01DCC SEND file.bin 2130706433 5000 1024\x01');

    const event = await ctcp;
    expect(event.command).toBe('DCC');
    expect(event.args).toBe('SEND file.bin 2130706433 5000 1024');
  });

  it('emits notices for bot replies', async () => {
    irc = await startFakeIrc();
    const c = connect(irc);
    await once(c, 'registered' as never);

    const notice = new Promise<{ from: string; text: string }>((resolve) => {
      c.once('notice', (event) => resolve(event));
    });
    irc.send(':bot!u@h NOTICE tester :** Sending you pack #5');

    const event = await notice;
    expect(event.from).toBe('bot');
    expect(event.text).toBe('** Sending you pack #5');
  });

  it('does not let a newline in a parameter inject a second command', async () => {
    irc = await startFakeIrc();
    const c = connect(irc);
    await once(c, 'registered' as never);
    c.say('#chan', 'hello\r\nJOIN #evil');
    await irc.waitFor(/^PRIVMSG #chan/);
    expect(irc.received.some((l) => l.startsWith('JOIN #evil'))).toBe(false);
  });
});
