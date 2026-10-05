/**
 * Wires the IRC client, the transfer manager, and the UI store together, and implements
 * the slash commands. Holds no rendering code, so the whole thing is drivable headlessly.
 */

import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs';
import path from 'node:path';
import { TransferManager, type QueueItem } from '../dcc/manager.js';
import { IrcClient } from '../irc/client.js';
import { normaliseChannels, parseGetSpec, type Config } from '../config.js';
import { Store, isChannelSource } from './store.js';

/**
 * Network services, which notice everyone on sight and are not having a conversation.
 *
 * Every network names them the same way — NickServ, ChanServ, MemoServ and the rest — and
 * a tab for NickServ on every single connect would be noise, not a message.
 */
function isService(nick: string): boolean {
  return /serv$/i.test(nick) || /^global$/i.test(nick);
}

/** The client's topic map as the plain object the store and the snapshot carry. */
function topicsOf(client: IrcClient): Record<string, string> {
  return Object.fromEntries(client.topics);
}

export interface SessionHooks {
  /**
   * A private message arrived from a person, with their conversation already open. Used
   * by the desktop app to raise a notification; the terminal UI passes nothing.
   */
  onPrivateMessage?: (nick: string, text: string) => void;
}

export class Session {
  readonly store = new Store();
  readonly client: IrcClient;
  readonly manager: TransferManager;
  /** Absolute download directory, resolved once at construction. */
  readonly downloadDir: string;

  private logStream?: WriteStream;
  private autoGetDone = false;

  constructor(
    private readonly config: Config,
    private readonly hooks: SessionHooks = {},
  ) {
    const channels = normaliseChannels(config);
    const downloadDir = path.resolve(config.downloadDir);
    mkdirSync(downloadDir, { recursive: true });
    this.downloadDir = downloadDir;

    this.client = new IrcClient({
      host: config.network.host,
      port: config.network.port,
      tls: config.network.tls,
      rejectUnauthorized: config.network.rejectUnauthorized,
      nick: config.network.nick,
      ...(config.network.username ? { username: config.network.username } : {}),
      ...(config.network.realname ? { realname: config.network.realname } : {}),
      ...(config.network.sasl ? { sasl: config.network.sasl } : {}),
      ...(config.network.nickserv ? { nickserv: config.network.nickserv } : {}),
      channels,
      maxReconnectAttempts: config.network.maxReconnectAttempts,
    });

    this.manager = new TransferManager({
      downloadDir,
      maxConcurrent: config.maxConcurrent,
      maxRetries: config.maxRetries,
      passive: {
        ...(config.passive.externalIp ? { externalIp: config.passive.externalIp } : {}),
        portRange: config.passive.portRange,
        listenTimeoutMs: config.passive.listenTimeoutMs,
      },
      sendMessage: (target, text) => this.client.say(target, text),
      sendCtcpRaw: (target, body) => this.client.send('PRIVMSG', [target, `\x01${body}\x01`]),
      fallbackLocalIp: () => this.client.localAddress,
      requestTimeoutMs: config.timeouts.requestMs,
      resumeTimeoutMs: config.timeouts.resumeMs,
      connectTimeoutMs: config.timeouts.connectMs,
      stallTimeoutMs: config.timeouts.stallMs,
    });

    if (config.logFile) {
      this.logStream = createWriteStream(path.resolve(config.logFile), { flags: 'a' });
    }

    this.store.setState({
      network: `${config.network.host}:${config.network.port}`,
      nick: config.network.nick,
    });

    this.wire();
  }

  private write(level: Parameters<Store['log']>[0], source: string, text: string): void {
    this.store.log(level, source, text);
    this.logStream?.write(`${new Date().toISOString()} [${source}] ${text}\n`);
  }

  private wire(): void {
    const { client, manager } = this;

    client.on('state', (state) => {
      // A fresh connection starts in no channels, and the client has already cleared its
      // own set by this point; leaving the old list on screen would offer chat views that
      // no longer exist.
      const channels = state === 'connecting' ? { channels: [], topics: {} } : {};
      this.store.setState({ connection: state, nick: client.nick, ...channels });
    });
    client.on('status', (text) => this.write('info', '*', text));
    client.on('error', (err) => this.write('error', '*', err.message));
    client.on('registered', () => {
      this.store.setState({ nick: client.nick });
      if ((this.config.network.channels ?? []).length === 0) this.runAutoGet();
    });
    client.on('joined', () => {
      this.store.setState({ channels: [...client.channels] });
      this.runAutoGet();
    });
    client.on('parted', (channel) => {
      this.write('info', '*', `Left ${channel}`);
      this.store.setState({ channels: [...client.channels], topics: topicsOf(client) });
    });

    client.on('topic', ({ channel, topic, by }) => {
      this.store.setState({ topics: topicsOf(client) });
      // Filed under the channel, so it reads in that channel's view rather than the
      // server one. Joining a channel with no topic set says nothing at all.
      if (by) {
        this.write(
          'info',
          channel,
          topic ? `${by} changed the topic to: ${topic}` : `${by} cleared the topic`,
        );
      } else if (topic) {
        this.write('info', channel, `Topic: ${topic}`);
      }
    });

    client.on('privmsg', ({ from, target, text, fromServer }) => {
      if (isChannelSource(target)) {
        this.write('irc', target, `<${from}> ${text}`);
        return;
      }
      // Addressed to us personally. The view is opened before the line is written so the
      // message that started the conversation is counted inside it.
      if (from && !fromServer) {
        this.openConversation(from);
        this.hooks.onPrivateMessage?.(from, text);
      }
      this.write('irc', from || '*', `<${from}> ${text}`);
    });

    client.on('notice', ({ from, target, text, fromServer }) => {
      const forTransfer = from ? manager.handleNotice(from, text) : false;

      if (!isChannelSource(target) && from && !fromServer && !forTransfer && !isService(from)) {
        // Somebody is talking to us. Plenty of clients and scripts send a private message
        // as a notice rather than a privmsg, so refusing to open a tab for one loses real
        // conversations. What is filtered out instead is everything that is not a person:
        // the server's own announcements, the services robots, and the queue-position
        // chatter from a bot we have a transfer in flight with — which `handleNotice`
        // has just told us about.
        this.openConversation(from);
        this.hooks.onPrivateMessage?.(from, text);
      }

      const source = isChannelSource(target) ? target : from || '*';
      this.write('bot', source, `-${from}- ${text}`);
    });

    client.on('ctcp', ({ from, command, args, isReply }) => {
      if (isReply) return;
      if (command === 'DCC') {
        manager.handleCtcp(from, command, args);
        return;
      }
      // Answer the handful of CTCP requests that are normal to answer, and ignore the
      // rest rather than leaking anything about this host.
      if (command === 'PING') client.send('NOTICE', [from, `\x01PING ${args}\x01`]);
      else if (command === 'VERSION') client.send('NOTICE', [from, '\x01VERSION fastxdcc\x01']);
    });

    manager.on('status', (text) => this.write('info', 'dcc', text));
    manager.on('update', () => this.store.touch());
  }

  private runAutoGet(): void {
    if (this.autoGetDone) return;
    this.autoGetDone = true;
    for (const entry of this.config.autoGet) {
      this.manager.enqueue(entry.bot, entry.packs);
    }
  }

  start(): void {
    this.client.connect();
  }

  get items(): QueueItem[] {
    return this.manager.items;
  }

  /**
   * Handle one line of user input: a slash command, or a message to a channel.
   *
   * `target` is the conversation the input was typed into. With several channels open on
   * one server it is the only thing that says where plain text should go, so a caller that
   * shows per-channel views must pass it; without it the first joined channel is used.
   */
  handleInput(input: string, target?: string): void {
    const line = input.trim();
    if (line === '') return;

    const where = this.resolveTarget(target);

    if (!line.startsWith('/')) {
      if (!where) {
        this.write('error', '*', 'Not in a channel; use /msg <target> <text>');
        return;
      }
      this.client.say(where, line);
      this.write('self', where, `<${this.client.nick}> ${line}`);
      return;
    }

    const sp = line.indexOf(' ');
    const command = (sp === -1 ? line.slice(1) : line.slice(1, sp)).toLowerCase();
    const rest = sp === -1 ? '' : line.slice(sp + 1).trim();

    try {
      this.runCommand(command, rest, where);
    } catch (err) {
      this.write('error', '*', (err as Error).message);
    }
  }

  /**
   * Where input typed in a given view should go. A view naming a channel we are still in
   * wins; otherwise fall back to the first channel, which is what a single-channel caller
   * such as the terminal UI has always used.
   */
  private resolveTarget(target?: string): string | undefined {
    if (target) {
      if (this.client.isIn(target)) return target;
      const open = this.findConversation(target);
      if (open) return open;
    }
    return [...this.client.channels][0];
  }

  private findConversation(nick: string): string | undefined {
    const wanted = nick.toLowerCase();
    return this.store.state.conversations.find((open) => open.toLowerCase() === wanted);
  }

  private runCommand(command: string, rest: string, where?: string): void {
    switch (command) {
      case 'help':
        this.write('info', '*', HELP);
        return;

      case 'join': {
        if (!rest) throw new Error('Usage: /join #channel [key]');
        const [name, key] = rest.split(/\s+/, 2);
        this.client.join(name!, key);
        return;
      }

      case 'part': {
        // Bare `/part` leaves the channel being looked at, as every other client does. A
        // conversation is not a channel, so it is never what a bare /part acts on.
        const named = rest.split(/\s+/)[0];
        const channel = named || (where && isChannelSource(where) ? where : undefined);
        if (!channel) throw new Error('Usage: /part #channel');
        this.client.part(channel);
        return;
      }

      case 'query':
      case 'q': {
        if (!rest) throw new Error('Usage: /query <nick> [message]');
        const sp = rest.indexOf(' ');
        const nick = sp === -1 ? rest : rest.slice(0, sp);
        const text = sp === -1 ? '' : rest.slice(sp + 1).trim();
        const open = this.openConversation(nick);
        if (text !== '') {
          this.client.say(open, text);
          this.write('self', open, `<${this.client.nick}> ${text}`);
        }
        return;
      }

      case 'close': {
        // Bare `/close` closes the conversation being looked at, mirroring bare `/part`.
        const named = rest.split(/\s+/)[0];
        const nick = named || (where && !isChannelSource(where) ? where : undefined);
        if (!nick) throw new Error('Usage: /close <nick>');
        this.closeConversation(nick);
        return;
      }

      case 'msg': {
        const sp = rest.indexOf(' ');
        if (sp === -1) throw new Error('Usage: /msg <target> <message>');
        const target = rest.slice(0, sp);
        const text = rest.slice(sp + 1);
        // Messaging a person opens their conversation, so the reply has somewhere to land.
        if (!isChannelSource(target)) this.openConversation(target);
        this.client.say(target, text);
        this.write('self', target, `<${this.client.nick}> ${text}`);
        return;
      }

      case 'get':
      case 'xdcc': {
        if (!rest) throw new Error("Usage: /get <bot> <packs>   e.g. /get SomeBot #1,3-5");
        const spec = parseGetSpec(rest);
        const added = this.manager.enqueue(spec.bot, spec.packs);
        if (added.length > 0) {
          this.write('info', '*', `Queued ${added.length} pack(s) from ${spec.bot}`);
        }
        return;
      }

      case 'list':
        if (!rest) throw new Error('Usage: /list <bot>');
        this.client.say(rest, 'xdcc list');
        return;

      case 'queue': {
        const items = this.manager.items;
        if (items.length === 0) {
          this.write('info', '*', 'Queue is empty');
          return;
        }
        for (const item of items) {
          const where = item.filename ? ` ${item.filename}` : '';
          const note = item.note ? ` (${item.note})` : '';
          this.write('info', '*', `${item.id} ${item.bot} #${item.pack} ${item.state}${where}${note}`);
        }
        return;
      }

      case 'cancel': {
        const words = rest.split(/\s+/).filter((w) => w !== '');
        const discard = words.includes('discard');
        const target = words.find((w) => w !== 'discard');
        const count = this.manager.cancel(
          target === undefined || target === 'all' ? undefined : target,
          discard,
        );
        this.write(
          'info',
          '*',
          `Cancelled ${count} item(s)${discard ? '; partial files discarded' : ''}`,
        );
        return;
      }

      case 'clean':
        this.write('info', '*', `Removed ${this.manager.clearFinished()} finished item(s)`);
        return;

      case 'clear':
        this.store.clearLog();
        return;

      case 'raw':
        if (!rest) throw new Error('Usage: /raw <IRC line>');
        this.client.raw(rest);
        return;

      case 'quit':
      case 'exit':
        this.shutdown();
        return;

      default:
        throw new Error(`Unknown command: /${command} (try /help)`);
    }
  }

  /** Join a channel for the GUI, validating the name so a typo is reported, not sent. */
  joinChannel(channel: string, key?: string): string {
    const name = channel.trim();
    if (name === '') throw new Error('Enter a channel name.');
    if (/\s/.test(name)) throw new Error('A channel name cannot contain spaces.');
    const full = /^[#&+!]/.test(name) ? name : `#${name}`;
    if (this.client.connectionState !== 'registered') {
      throw new Error('Not connected to this server yet.');
    }
    if (this.client.isIn(full)) throw new Error(`Already in ${full}.`);
    this.client.join(full, key && key.trim() !== '' ? key.trim() : undefined);
    return full;
  }

  /**
   * Give a nick a private message view of its own.
   *
   * Returns the name as it is listed, which is the spelling first seen: nicks are matched
   * without regard to case, but lower-casing one would misname the person.
   */
  openConversation(nick: string): string {
    const name = nick.trim();
    if (name === '') throw new Error('Enter a nick.');
    if (isChannelSource(name)) throw new Error(`${name} is a channel; join it instead.`);
    if (/\s/.test(name)) throw new Error('A nick cannot contain spaces.');

    const existing = this.findConversation(name);
    if (existing) return existing;

    // Tracked before the caller logs anything, so the view's count starts at its first line.
    this.store.track(name);
    this.store.setState({ conversations: [...this.store.state.conversations, name] });
    return name;
  }

  /**
   * Close a private message view. Purely local: nothing is sent, and what was said stays
   * in the log, where the server view shows it again.
   */
  closeConversation(nick: string): void {
    const open = this.findConversation(nick);
    if (!open) throw new Error(`No conversation open with ${nick}.`);
    this.store.setState({
      conversations: this.store.state.conversations.filter((name) => name !== open),
    });
  }

  partChannel(channel: string): void {
    if (!this.client.isIn(channel)) throw new Error(`Not in ${channel}.`);
    this.client.part(channel);
  }

  shutdown(): void {
    this.manager.shutdown();
    this.client.quit();
    this.logStream?.end();
  }
}

const HELP = [
  '/get <bot> <packs>    request packs, e.g. /get SomeBot #1,3-5',
  '/list <bot>           ask a bot for its pack list',
  '/queue                show the transfer queue',
  '/cancel [id|all]      cancel a transfer; add "discard" to delete the partial file',
  '/clean                remove finished rows from the queue',
  '/join #chan [key]     join a channel',
  '/part [#chan]         leave a channel, or the one you are looking at',
  '/msg <target> <text>  send a message, opening a tab for a person',
  '/query <nick> [text]  open a private message tab, optionally sending a line',
  '/close [nick]         close a private message tab, or the one you are looking at',
  '/raw <line>           send a raw IRC line',
  '/clear                clear the log pane',
  '/quit                 disconnect and exit',
].join('\n');
