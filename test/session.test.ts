/**
 * Full-stack tests: a real Session built from a real config, talking to a fake IRC
 * server whose "bot" answers `xdcc send` with a real DCC offer. Nothing between the
 * config file and the bytes on disk is stubbed.
 */

import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Session } from '../src/app/session.js';
import { snapshotSession } from '../src/app/snapshot.js';
import { ConfigSchema, type Config } from '../src/config.js';
import { formatDccSend } from '../src/dcc/ctcp.js';
import { startActiveSender, type SenderHandle } from './helpers/fakeBot.js';
import { startFakeIrc, type FakeIrc } from './helpers/fakeIrc.js';

let dir: string;
let irc: FakeIrc | undefined;
let session: Session | undefined;
let sender: SenderHandle | undefined;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'fastxdcc-session-'));
});

afterEach(async () => {
  session?.shutdown();
  session = undefined;
  await irc?.close();
  irc = undefined;
  await sender?.close();
  sender = undefined;
  await rm(dir, { recursive: true, force: true });
});

function makeConfig(port: number, over: Partial<Config> = {}): Config {
  return ConfigSchema.parse({
    network: {
      host: '127.0.0.1',
      port,
      tls: false,
      nick: 'tester',
      channels: ['#packs'],
      maxReconnectAttempts: 0,
    },
    downloadDir: dir,
    maxConcurrent: 1,
    maxRetries: 0,
    timeouts: { requestMs: 5_000, resumeMs: 500, connectMs: 5_000, stallMs: 5_000 },
    ...over,
  });
}

async function until(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('Session end to end', () => {
  it('connects, joins, requests a pack, and writes the file', async () => {
    const payload = randomBytes(256 * 1024);
    sender = await startActiveSender(payload);

    irc = await startFakeIrc({
      onPrivmsg: (target, text, ctx) => {
        if (target !== 'packbot' || !/^xdcc send #1$/.test(text)) return;
        const offer = formatDccSend({
          filename: 'episode.mkv',
          ip: '127.0.0.1',
          port: sender!.port,
          size: payload.length,
        });
        ctx.send(`:packbot!u@h NOTICE ${ctx.nick} :** Sending you pack #1`);
        ctx.send(`:packbot!u@h PRIVMSG ${ctx.nick} :\x01${offer}\x01`);
      },
    });

    session = new Session(makeConfig(irc.port, { autoGet: [{ bot: 'packbot', packs: [1] }] }));
    session.start();

    await until(() => session!.items.some((i) => i.state === 'completed'));

    const written = await readFile(path.join(dir, 'episode.mkv'));
    expect(written.equals(payload)).toBe(true);
    expect(session.store.state.channels).toContain('#packs');
  });

  it('accepts a pack requested with /get at runtime', async () => {
    const payload = randomBytes(64 * 1024);
    sender = await startActiveSender(payload);

    irc = await startFakeIrc({
      onPrivmsg: (target, text, ctx) => {
        if (target !== 'packbot' || !text.startsWith('xdcc send')) return;
        const offer = formatDccSend({
          filename: 'file.bin',
          ip: '127.0.0.1',
          port: sender!.port,
          size: payload.length,
        });
        ctx.send(`:packbot!u@h PRIVMSG ${ctx.nick} :\x01${offer}\x01`);
      },
    });

    session = new Session(makeConfig(irc.port));
    session.start();
    await until(() => session!.store.state.channels.length > 0);

    session.handleInput('/get packbot #3');
    await until(() => session!.items.some((i) => i.state === 'completed'));

    expect(session.items[0]!.pack).toBe(3);
    const written = await readFile(path.join(dir, 'file.bin'));
    expect(written.equals(payload)).toBe(true);
  });

  it('shows a bot queue position in the queue rather than failing', async () => {
    irc = await startFakeIrc({
      onPrivmsg: (target, text, ctx) => {
        if (target !== 'packbot' || !text.startsWith('xdcc send')) return;
        ctx.send(
          `:packbot!u@h NOTICE ${ctx.nick} :** All Slots Full, Added you to the main queue in position 2 of 7`,
        );
      },
    });

    session = new Session(makeConfig(irc.port));
    session.start();
    await until(() => session!.store.state.channels.length > 0);

    session.handleInput('/get packbot #1');
    await until(() => session!.items[0]?.state === 'botQueued');

    expect(session.items[0]!.position).toBe(2);
    expect(session.items[0]!.total).toBe(7);
  });

  it('reports a denial without retrying forever', async () => {
    irc = await startFakeIrc({
      onPrivmsg: (target, text, ctx) => {
        if (target !== 'packbot' || !text.startsWith('xdcc send')) return;
        ctx.send(
          `:packbot!u@h NOTICE ${ctx.nick} :** XDCC SEND denied, you must be on a known channel`,
        );
      },
    });

    session = new Session(makeConfig(irc.port));
    session.start();
    await until(() => session!.store.state.channels.length > 0);

    session.handleInput('/get packbot #1');
    await until(() => session!.items[0]?.state === 'failed');
    expect(session.items[0]!.error).toMatch(/known channel/);
  });

  it('reports an unknown command instead of sending it to the server', async () => {
    irc = await startFakeIrc();
    session = new Session(makeConfig(irc.port));
    session.start();
    await until(() => session!.store.state.connection === 'registered');

    session.handleInput('/nonsense');
    const logged = session.store.tail(50).some((l) => /Unknown command/.test(l.text));
    expect(logged).toBe(true);
  });

  it('sends a raw line when asked to', async () => {
    irc = await startFakeIrc();
    session = new Session(makeConfig(irc.port));
    session.start();
    await until(() => session!.store.state.connection === 'registered');

    session.handleInput('/raw WHOIS somebody');
    await irc.waitFor(/^WHOIS somebody/);
  });
});

describe('Session with several channels on one server', () => {
  async function connected(): Promise<Session> {
    irc = await startFakeIrc();
    const s = new Session(makeConfig(irc.port, { network: {
      host: '127.0.0.1',
      port: irc.port,
      tls: false,
      nick: 'tester',
      channels: ['#packs', '#chat'],
      maxReconnectAttempts: 0,
    } }));
    s.start();
    await until(() => s.store.state.channels.length === 2);
    return s;
  }

  it('joins every configured channel and lists them in join order', async () => {
    session = await connected();
    expect(session.store.state.channels).toEqual(['#packs', '#chat']);
  });

  it('joins another channel at runtime without losing the first', async () => {
    session = await connected();
    session.handleInput('/join #third');
    await until(() => session!.store.state.channels.length === 3);
    expect(session.store.state.channels).toContain('#third');
    expect(session.store.state.channels).toContain('#packs');
  });

  it('sends plain text to the channel it was typed into, not the first one', async () => {
    session = await connected();
    session.handleInput('hello there', '#chat');
    await irc!.waitFor(/^PRIVMSG #chat :hello there/);
    // The echo is filed under the channel it went to, so that view shows it.
    const echoed = session.store.tail(50).find((l) => l.text.includes('hello there'));
    expect(echoed?.source).toBe('#chat');
  });

  it('falls back to the first channel when no view is given', async () => {
    session = await connected();
    session.handleInput('hello there');
    await irc!.waitFor(/^PRIVMSG #packs :hello there/);
  });

  it('ignores a view it is no longer in and uses the first channel instead', async () => {
    session = await connected();
    session.handleInput('a message', '#never-joined');
    await irc!.waitFor(/^PRIVMSG #packs :a message/);
  });

  it('counts chat per channel so unread badges can be worked out', async () => {
    session = await connected();
    session.handleInput('one', '#chat');
    session.handleInput('two', '#chat');
    session.handleInput('three', '#packs');
    expect(session.store.activityFor('#chat')).toBe(2);
    expect(session.store.activityFor('#PACKS')).toBe(1);
  });

  it('keeps counting past the point where old lines are trimmed', async () => {
    session = await connected();
    for (let i = 0; i < 1200; i++) session.store.log('irc', '#chat', `line ${i}`);
    // The log itself is capped, but the badge must not drift downwards with it.
    expect(session.store.tail(5_000).length).toBeLessThan(1200);
    expect(session.store.activityFor('#chat')).toBe(1200);
  });

  it('drops a channel from the list when the server confirms the part', async () => {
    session = await connected();
    session.handleInput('/part #packs');
    await irc!.waitFor(/^PART #packs/);
    await until(() => !session!.store.state.channels.includes('#packs'));
    expect(session.store.state.channels).toEqual(['#chat']);
  });

  it('parts the channel being looked at when /part is given no name', async () => {
    session = await connected();
    session.handleInput('/part', '#chat');
    await irc!.waitFor(/^PART #chat/);
    expect(session.client.isIn('#chat')).toBe(false);
    expect(session.client.isIn('#packs')).toBe(true);
  });

  it('drops a channel it was kicked out of', async () => {
    session = await connected();
    irc!.send(`:op!u@h KICK #chat tester :bye`);
    await until(() => !session!.store.state.channels.includes('#chat'));
    expect(session.store.state.channels).toEqual(['#packs']);
  });

  it('reports a bad join through the GUI path instead of sending it', async () => {
    session = await connected();
    expect(() => session!.joinChannel('#packs')).toThrow(/Already in #packs/);
    expect(() => session!.joinChannel('  ')).toThrow(/Enter a channel/);
    expect(() => session!.joinChannel('#a #b')).toThrow(/cannot contain spaces/);
    // A bare name is still usable: every network in practice prefixes with '#'.
    expect(session.joinChannel('fresh')).toBe('#fresh');
    await irc!.waitFor(/^JOIN #fresh/);
  });

  it('refuses to part a channel it is not in', async () => {
    session = await connected();
    expect(() => session!.partChannel('#nowhere')).toThrow(/Not in #nowhere/);
  });
});

describe('Session private messages', () => {
  async function connected(): Promise<Session> {
    irc = await startFakeIrc();
    const s = new Session(makeConfig(irc.port));
    s.start();
    await until(() => s.store.state.channels.length > 0);
    return s;
  }

  it('opens a conversation when someone messages us directly', async () => {
    session = await connected();
    irc!.send(':bob!u@h PRIVMSG tester :are you there?');
    await until(() => session!.store.state.conversations.length > 0);

    expect(session.store.state.conversations).toEqual(['bob']);
    // The line that opened the view has to be counted inside it, not left in the server
    // view it would otherwise have landed in.
    expect(session.store.activityFor('bob')).toBe(1);
    const line = session.store.tail(50).find((l) => l.text.includes('are you there?'));
    expect(line?.source).toBe('bob');
  });

  it('leaves a channel message where it is', async () => {
    session = await connected();
    irc!.send(':bob!u@h PRIVMSG #packs :hello everyone');
    await until(() => session!.store.tail(50).some((l) => l.text.includes('hello everyone')));
    expect(session.store.state.conversations).toEqual([]);
  });

  it('does not open a conversation for queue chatter from a bot we are downloading from', async () => {
    irc = await startFakeIrc({
      onPrivmsg: (target, text, ctx) => {
        if (target !== 'packbot' || !text.startsWith('xdcc send')) return;
        ctx.send(`:packbot!u@h NOTICE ${ctx.nick} :** All Slots Full, Added you to the queue in position 2 of 7`);
      },
    });
    session = new Session(makeConfig(irc.port));
    session.start();
    await until(() => session!.store.state.channels.length > 0);

    session.handleInput('/get packbot #1');
    await until(() => session!.items[0]?.state === 'botQueued');

    // XDCC bots announce every queue position this way; a tab each would bury the real
    // conversations, so a notice about a transfer in flight stays in the server view.
    expect(session.store.state.conversations).toEqual([]);
  });

  it('opens a conversation for a notice from someone we have no transfer with', async () => {
    session = await connected();
    // Plenty of clients and scripts send a private message as a notice. Refusing to open
    // a tab for one loses real conversations.
    irc!.send(':carol!u@h NOTICE tester :are you around?');
    await until(() => session!.store.state.conversations.length > 0);
    expect(session.store.state.conversations).toEqual(['carol']);
  });

  it('does not open a conversation for the server or for services', async () => {
    session = await connected();
    irc!.send(':fake.irc NOTICE tester :*** Looking up your hostname');
    irc!.send(':NickServ!s@services NOTICE tester :This nickname is registered');
    irc!.send(':ChanServ!s@services NOTICE tester :You are now op');
    await until(() => session!.store.tail(50).some((l) => l.text.includes('now op')));

    // A tab for the server's own announcements, or for NickServ on every connect, would
    // be noise rather than a message.
    expect(session.store.state.conversations).toEqual([]);
  });

  it('keeps one conversation per person however the nick is cased', async () => {
    session = await connected();
    irc!.send(':Bob!u@h PRIVMSG tester :first');
    await until(() => session!.store.state.conversations.length === 1);
    irc!.send(':bob!u@h PRIVMSG tester :second');
    await until(() => session!.store.activityFor('bob') === 2);

    // The spelling first seen is kept, since lower-casing it would misname the person.
    expect(session.store.state.conversations).toEqual(['Bob']);
  });

  it('opens a conversation from /msg and from /query', async () => {
    session = await connected();
    session.handleInput('/msg alice hello there');
    await irc!.waitFor(/^PRIVMSG alice :hello there/);
    expect(session.store.state.conversations).toEqual(['alice']);

    session.handleInput('/query carol');
    expect(session.store.state.conversations).toEqual(['alice', 'carol']);

    session.handleInput('/query dave how are you');
    await irc!.waitFor(/^PRIVMSG dave :how are you/);
    expect(session.store.state.conversations).toEqual(['alice', 'carol', 'dave']);
  });

  it('sends plain text to the conversation it was typed into', async () => {
    session = await connected();
    session.handleInput('/query alice');
    session.handleInput('a private reply', 'alice');
    await irc!.waitFor(/^PRIVMSG alice :a private reply/);

    const echoed = session.store.tail(50).find((l) => l.text.includes('a private reply'));
    expect(echoed?.source).toBe('alice');
  });

  it('refuses to treat a channel as a person', async () => {
    session = await connected();
    expect(() => session!.openConversation('#packs')).toThrow(/is a channel/);
    expect(() => session!.openConversation('  ')).toThrow(/Enter a nick/);
  });

  it('never parts a channel because a conversation was open', async () => {
    session = await connected();
    session.handleInput('/query alice');
    // A bare /part in a private message view has no channel to act on, and must not send
    // PART to the person.
    session.handleInput('/part', 'alice');
    expect(session.store.tail(20).some((l) => /Usage: \/part/.test(l.text))).toBe(true);
    expect(session.client.isIn('#packs')).toBe(true);
  });

  it('closes the conversation being looked at, without telling the server', async () => {
    session = await connected();
    session.handleInput('/query alice');
    session.handleInput('/close', 'alice');
    expect(session.store.state.conversations).toEqual([]);
    expect(irc!.received.some((l) => /alice/i.test(l))).toBe(false);
  });

  it('reports closing a conversation that is not open', async () => {
    session = await connected();
    expect(() => session!.closeConversation('nobody')).toThrow(/No conversation open/);
  });

  it('moves a nick between the server view and its own as the conversation opens and closes', async () => {
    session = await connected();
    irc!.send(':carol!u@h NOTICE tester :are you around?');
    await until(() => session!.store.state.conversations.includes('carol'));

    // Opened, so her line is hers and no longer counts towards the server view.
    const withTab = session.store.serverActivity();
    expect(session.store.activityFor('carol')).toBe(1);
    expect(session.store.serverActivity(['carol'])).toBe(withTab);

    // Closed, and it goes back to the server view, which is where it is shown again.
    session.closeConversation('carol');
    expect(session.store.serverActivity()).toBe(withTab + 1);
  });
});

describe('Session channel topics', () => {
  const TOPIC = 'Packs at https://packs.example.net | no requests';

  it('records the topic a channel is joined with and shows it in the channel', async () => {
    irc = await startFakeIrc({ topic: () => TOPIC });
    session = new Session(makeConfig(irc.port));
    session.start();
    await until(() => session!.store.state.topics['#packs'] !== undefined);

    expect(session.store.state.topics['#packs']).toBe(TOPIC);
    expect(session.client.topicFor('#PACKS')).toBe(TOPIC);
    // Filed under the channel, so it reads in that channel's view.
    const line = session.store.tail(50).find((l) => l.text.startsWith('Topic:'));
    expect(line?.source).toBe('#packs');
  });

  it('carries the topic on the channel view in the snapshot', async () => {
    irc = await startFakeIrc({ topic: () => TOPIC });
    session = new Session(makeConfig(irc.port));
    session.start();
    await until(() => session!.store.state.topics['#packs'] !== undefined);

    const snap = snapshotSession(session, 'test:1');
    expect(snap.channels[0]).toMatchObject({ name: '#packs', topic: TOPIC });
    expect(() => structuredClone(snap)).not.toThrow();
  });

  it('says nothing when the channel has no topic', async () => {
    irc = await startFakeIrc();
    session = new Session(makeConfig(irc.port));
    session.start();
    await until(() => session!.store.state.channels.length > 0);

    expect(session.store.state.topics).toEqual({});
    expect(snapshotSession(session, 'test:1').channels[0]!.topic).toBeUndefined();
    expect(session.store.tail(50).some((l) => /Topic/.test(l.text))).toBe(false);
  });

  it('follows a topic changed while we are in the channel, naming who changed it', async () => {
    irc = await startFakeIrc({ topic: () => TOPIC });
    session = new Session(makeConfig(irc.port));
    session.start();
    await until(() => session!.store.state.topics['#packs'] !== undefined);

    irc.send(':op!u@h TOPIC #packs :Now at https://mirror.example.net');
    await until(() => session!.store.state.topics['#packs'] !== TOPIC);

    expect(session.store.state.topics['#packs']).toBe('Now at https://mirror.example.net');
    const line = session.store.tail(50).find((l) => l.text.includes('changed the topic'));
    expect(line?.text).toMatch(/^op changed the topic to: Now at/);
    expect(line?.source).toBe('#packs');
  });

  it('treats a cleared topic as having none', async () => {
    irc = await startFakeIrc({ topic: () => TOPIC });
    session = new Session(makeConfig(irc.port));
    session.start();
    await until(() => session!.store.state.topics['#packs'] !== undefined);

    irc.send(':op!u@h TOPIC #packs :');
    await until(() => session!.store.state.topics['#packs'] === undefined);

    expect(snapshotSession(session, 'test:1').channels[0]!.topic).toBeUndefined();
    expect(session.store.tail(50).some((l) => l.text === 'op cleared the topic')).toBe(true);
  });

  it('forgets the topic of a channel it has left', async () => {
    irc = await startFakeIrc({ topic: (channel) => `topic for ${channel}` });
    session = new Session(
      makeConfig(irc.port, {
        network: {
          host: '127.0.0.1',
          port: irc.port,
          tls: false,
          nick: 'tester',
          channels: ['#packs', '#chat'],
          maxReconnectAttempts: 0,
        },
      }),
    );
    session.start();
    await until(() => Object.keys(session!.store.state.topics).length === 2);

    session.handleInput('/part #packs');
    await until(() => session!.store.state.topics['#packs'] === undefined);

    expect(session.store.state.topics).toEqual({ '#chat': 'topic for #chat' });
  });
});
