/**
 * Electron main process.
 *
 * All the Node-side work lives here: the IRC session, the DCC transfers, and the config
 * file. The renderer is a plain web page with no Node access; it talks to this process
 * through the channels in `ipc.ts` and receives state as serialisable snapshots.
 */

import { BrowserWindow, Notification, app, clipboard, dialog, ipcMain, shell } from 'electron';
import path from 'node:path';
import { networkInterfaces } from 'node:os';
import { Session } from '../app/session.js';
import {
  emptySnapshot,
  snapshotSession,
  type AppSnapshot,
} from '../app/snapshot.js';
import {
  defaultConfig,
  readConfigFile,
  requireConnectable,
  writeConfigFile,
  type DraftConfig,
} from '../app/configFile.js';
import { parseDownloadRequests } from '../xdcc/request.js';
import {
  channelsForTarget,
  planIrcLink,
  sessionIdFor,
  type SessionSummary,
} from '../app/ircLink.js';
import { formatIrcTarget, parseIrcUrl, type IrcTarget } from '../irc/url.js';
import { normaliseChannels } from '../config.js';
import { EmbeddedBrowser, type Rect } from './browserView.js';
import {
  BROWSE_TAB,
  CHANNELS,
  type CommandRequest,
  type ConfigPayload,
  type ConnectResponse,
  type ConversationRequest,
  type JoinChannelRequest,
  type JoinChannelResponse,
  type ListPacksRequest,
  type NoticeEvent,
  type OpenConversationResponse,
  type PartChannelRequest,
  type QueueAddRequest,
  type QueueAddResponse,
  type QueueCancelRequest,
  type Result,
  type RevealRequest,
  type SessionRequest,
} from './ipc.js';

/** Bounded UI refresh rate; see `publish` below for why this is not event-driven. */
const UI_REFRESH_HZ = 10;

let window: BrowserWindow | undefined;
/**
 * One session per server, keyed by `host:port` and kept in insertion order so the tabs
 * stay where the user last saw them.
 */
const sessions = new Map<string, Session>();
let config: DraftConfig | undefined;
let configPath = '';
let storeDirty = false;
let publishTimer: NodeJS.Timeout | undefined;
let browser: EmbeddedBrowser | undefined;

/**
 * Last notification per sender, so a burst of lines from one person raises one alert
 * rather than a stack of them.
 */
const lastWhisperAlert = new Map<string, number>();
const WHISPER_ALERT_GAP_MS = 5_000;
/** Notifications actually raised, so the smoke check can prove the path is reachable. */
let whisperAlertsShown = 0;

/**
 * Tell the user, outside the app, that somebody messaged them.
 *
 * Only when the window is not focused: if they are looking at it, the tab and its unread
 * count already say so, and a desktop notification on top of that is just noise.
 */
function alertPrivateMessage(sessionId: string, nick: string, text: string): void {
  if (!window || window.isDestroyed() || window.isFocused()) return;
  if (!Notification.isSupported()) return;

  const key = `${sessionId}\u0000${nick.toLowerCase()}`;
  const now = Date.now();
  if (now - (lastWhisperAlert.get(key) ?? 0) < WHISPER_ALERT_GAP_MS) return;
  lastWhisperAlert.set(key, now);

  const alert = new Notification({
    title: `${nick} messaged you`,
    body: text.length > 160 ? `${text.slice(0, 157)}…` : text,
  });
  alert.on('click', () => {
    if (!window || window.isDestroyed()) return;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
    // Bring that connection's tab forward, so the message is one click from being read.
    notify('info', `Private message from ${nick}`, sessionId);
  });
  alert.show();
  whisperAlertsShown++;
}

/** Raise a message in the renderer that did not come from a request it made. */
function notify(kind: NoticeEvent['kind'], text: string, activateTab?: NoticeEvent['activateTab']): void {
  if (!window || window.isDestroyed()) return;
  const notice: NoticeEvent = { kind, text, ...(activateTab ? { activateTab } : {}) };
  window.webContents.send(CHANNELS.notice, notice);
}

/** Wrap a handler so every failure reaches the renderer as a message, never as a crash. */
function handle<Req, Res>(
  channel: string,
  fn: (request: Req) => Promise<Res> | Res,
): void {
  ipcMain.handle(channel, async (_event, request: Req): Promise<Result<Res>> => {
    try {
      return { ok: true, value: await fn(request) };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
}

let revision = 0;

function downloadDir(): string {
  return path.resolve(config?.downloadDir ?? app.getPath('downloads'));
}

function currentSnapshot(): AppSnapshot {
  const snapshot = emptySnapshot(downloadDir());
  snapshot.revision = ++revision;
  for (const [id, session] of sessions) {
    snapshot.sessions.push(snapshotSession(session, id));
  }
  return snapshot;
}

/**
 * Push state to the renderer on a timer rather than on every change.
 *
 * A running transfer updates its byte counter thousands of times a second. Sending an IPC
 * message per update would serialise the whole snapshot each time and swamp the renderer,
 * so the store marks itself dirty and this samples it. `hasActiveTransfer` covers transfer
 * progress, which deliberately does not mark the store dirty at all.
 */
function publish(force = false): void {
  if (!window || window.isDestroyed()) return;
  const hasActiveTransfer = [...sessions.values()].some((session) =>
    session.items.some((item) => item.state === 'transferring'),
  );
  if (!force && !storeDirty && !hasActiveTransfer) return;
  storeDirty = false;
  window.webContents.send(CHANNELS.state, currentSnapshot());
}

function startPublishing(): void {
  if (publishTimer) clearInterval(publishTimer);
  publishTimer = setInterval(() => publish(), Math.round(1000 / UI_REFRESH_HZ));
}

/** Disconnect a session and drop its tab. */
function closeSession(id: string): void {
  const session = sessions.get(id);
  if (!session) return;
  session.shutdown();
  sessions.delete(id);
  storeDirty = true;
}

function closeAllSessions(): void {
  for (const id of [...sessions.keys()]) closeSession(id);
}

/**
 * Open a connection, optionally to a server that came from a link rather than from the
 * saved settings. The link only says where to connect; the nickname, download folder and
 * everything else still come from the user's configuration.
 *
 * Connecting to a server that already has a tab reuses it rather than opening a second.
 */
function startSession(target?: IrcTarget): string {
  if (!config) throw new Error('Settings have not been loaded yet.');

  const draft = target
    ? {
        ...config,
        network: {
          ...config.network,
          host: target.host,
          port: target.port,
          tls: target.tls,
          channels: channelsForTarget(
            {
              host: config.network.host,
              port: config.network.port,
              channels: normaliseChannels(config),
            },
            target,
          ),
        },
      }
    : config;

  const connectable = requireConnectable(draft);
  const id = sessionIdFor(connectable.network.host, connectable.network.port);

  // Reconnecting the same server replaces its session but keeps its place in the tab bar,
  // because Map preserves the order a key was first inserted.
  sessions.get(id)?.shutdown();

  const next = new Session(connectable, {
    onPrivateMessage: (nick, text) => alertPrivateMessage(id, nick, text),
  });
  next.store.subscribe(() => {
    storeDirty = true;
  });
  sessions.set(id, next);
  next.start();
  publish(true);
  return id;
}

function requireSession(id: string): Session {
  const session = sessions.get(id);
  if (!session) throw new Error('That connection is no longer open.');
  return session;
}

function summariseSessions(): SessionSummary[] {
  return [...sessions.entries()].map(([id, session]) => ({
    id,
    host: session.client.host,
    port: session.client.port,
    channels: [...session.client.channels],
  }));
}

/**
 * Act on an `irc://` link the user clicked in the browser tab.
 *
 * A link to a server that is not open yet gets its own tab, so following one never
 * disturbs transfers already running somewhere else.
 */
async function followIrcLink(raw: string): Promise<void> {
  let target: IrcTarget;
  try {
    target = parseIrcUrl(raw);
  } catch (err) {
    notify('error', (err as Error).message);
    return;
  }

  const plan = planIrcLink(target, summariseSessions());

  switch (plan.action) {
    case 'unsupported':
      notify('error', plan.reason);
      return;

    case 'alreadyThere':
      notify(
        'info',
        plan.channel ? `Already in ${plan.channel}.` : 'Already connected to that server.',
        plan.sessionId,
      );
      return;

    case 'join':
      try {
        requireSession(plan.sessionId).client.join(plan.channel, plan.key);
        notify('info', `Joining ${plan.channel} on ${target.host}…`, plan.sessionId);
        storeDirty = true;
      } catch (err) {
        notify('error', (err as Error).message);
      }
      return;

    case 'open':
      try {
        const id = startSession(target);
        notify('info', `Connecting to ${formatIrcTarget(target)}…`, id);
      } catch (err) {
        notify('error', (err as Error).message);
      }
      return;

    default:
      return;
  }
}

function registerHandlers(): void {
  handle<void, ConfigPayload>(CHANNELS.configGet, () => {
    if (!config) throw new Error('Settings have not been loaded yet.');
    return { config, path: configPath };
  });

  handle<DraftConfig, ConfigPayload>(CHANNELS.configSave, async (next) => {
    config = await writeConfigFile(configPath, next);
    storeDirty = true;
    publish(true);
    return { config, path: configPath };
  });

  handle<void, ConnectResponse>(CHANNELS.connect, () => {
    return { sessionId: startSession() };
  });

  // Disconnecting keeps the tab so its transfer history and log stay readable; closing
  // is the one that makes the tab go away.
  handle<SessionRequest, undefined>(CHANNELS.disconnect, ({ sessionId }) => {
    requireSession(sessionId).client.quit();
    storeDirty = true;
    publish(true);
    return undefined;
  });

  handle<SessionRequest, undefined>(CHANNELS.closeSession, async ({ sessionId }) => {
    const session = requireSession(sessionId);
    const running = session.items.filter((item) => item.state === 'transferring').length;

    // Closing a tab is the one action that can still throw away work in progress, so it
    // is the one that asks.
    if (running > 0 && window) {
      const { response } = await dialog.showMessageBox(window, {
        type: 'warning',
        buttons: ['Keep open', 'Close anyway'],
        defaultId: 0,
        cancelId: 0,
        title: 'Close this connection?',
        message: `Stop ${running} running transfer(s) on ${session.client.host}?`,
        detail: 'Partly downloaded files are kept and can be resumed later.',
      });
      if (response !== 1) return undefined;
    }

    closeSession(sessionId);
    publish(true);
    return undefined;
  });

  handle<QueueAddRequest, QueueAddResponse>(CHANNELS.queueAdd, ({ sessionId, input }) => {
    const active = requireSession(sessionId);
    // Throws with a message meant for the user if nothing in the paste parses.
    const requests = parseDownloadRequests(input);

    let added = 0;
    const bots = new Set<string>();
    for (const request of requests) {
      added += active.manager.enqueue(request.bot, request.packs).length;
      bots.add(request.bot);
    }

    storeDirty = true;
    publish(true);
    const summary =
      added === 0
        ? 'Nothing added; those packs are already queued.'
        : `Queued ${added} pack(s) from ${[...bots].join(', ')}`;
    return { added, summary };
  });

  handle<QueueCancelRequest, { cancelled: number }>(
    CHANNELS.queueCancel,
    ({ sessionId, id, discard }) => {
      const cancelled = requireSession(sessionId).manager.cancel(id, discard ?? false);
      storeDirty = true;
      publish(true);
      return { cancelled };
    },
  );

  handle<SessionRequest, { removed: number }>(CHANNELS.queueClean, ({ sessionId }) => {
    const removed = requireSession(sessionId).manager.clearFinished();
    storeDirty = true;
    publish(true);
    return { removed };
  });

  handle<CommandRequest, undefined>(CHANNELS.command, ({ sessionId, line, target }) => {
    requireSession(sessionId).handleInput(line, target);
    storeDirty = true;
    publish(true);
    return undefined;
  });

  handle<JoinChannelRequest, JoinChannelResponse>(
    CHANNELS.joinChannel,
    ({ sessionId, channel, key }) => {
      const joined = requireSession(sessionId).joinChannel(channel, key);
      storeDirty = true;
      publish(true);
      return { channel: joined };
    },
  );

  handle<PartChannelRequest, undefined>(CHANNELS.partChannel, ({ sessionId, channel }) => {
    requireSession(sessionId).partChannel(channel);
    storeDirty = true;
    publish(true);
    return undefined;
  });

  handle<ConversationRequest, OpenConversationResponse>(
    CHANNELS.openConversation,
    ({ sessionId, nick }) => {
      const opened = requireSession(sessionId).openConversation(nick);
      storeDirty = true;
      publish(true);
      return { nick: opened };
    },
  );

  handle<ConversationRequest, undefined>(CHANNELS.closeConversation, ({ sessionId, nick }) => {
    requireSession(sessionId).closeConversation(nick);
    storeDirty = true;
    publish(true);
    return undefined;
  });

  handle<ListPacksRequest, undefined>(CHANNELS.listPacks, ({ sessionId, bot }) => {
    if (!bot.trim()) throw new Error('Enter a bot name first.');
    requireSession(sessionId).client.say(bot.trim(), 'xdcc list');
    return undefined;
  });

  handle<void, { path: string | null }>(CHANNELS.chooseDir, async () => {
    if (!window) return { path: null };
    const result = await dialog.showOpenDialog(window, {
      title: 'Choose a download folder',
      defaultPath: config?.downloadDir,
      properties: ['openDirectory', 'createDirectory'],
    });
    if (result.canceled || result.filePaths.length === 0) return { path: null };
    return { path: result.filePaths[0]! };
  });

  handle<void, undefined>(CHANNELS.openDir, async () => {
    const dir = path.resolve(config?.downloadDir ?? app.getPath('downloads'));
    const error = await shell.openPath(dir);
    if (error) throw new Error(error);
    return undefined;
  });

  handle<string, undefined>(CHANNELS.browserNavigate, (url) => {
    requireBrowser().navigate(url);
    return undefined;
  });
  handle<void, undefined>(CHANNELS.browserBack, () => {
    requireBrowser().back();
    return undefined;
  });
  handle<void, undefined>(CHANNELS.browserForward, () => {
    requireBrowser().forward();
    return undefined;
  });
  handle<void, undefined>(CHANNELS.browserReload, () => {
    requireBrowser().reload();
    return undefined;
  });
  handle<void, undefined>(CHANNELS.browserStop, () => {
    requireBrowser().stop();
    return undefined;
  });
  handle<Rect, undefined>(CHANNELS.browserSetBounds, (rect) => {
    requireBrowser().setBounds(rect);
    return undefined;
  });
  handle<boolean, undefined>(CHANNELS.browserSetVisible, (visible) => {
    requireBrowser().setVisible(visible);
    return undefined;
  });
  handle<string, undefined>(CHANNELS.followIrcLink, async (url) => {
    await followIrcLink(url);
    return undefined;
  });

  handle<RevealRequest, undefined>(CHANNELS.revealFile, ({ path: target }) => {
    // Only ever reveal a path the main process itself produced for a finished transfer.
    const known = [...sessions.values()].some((session) =>
      session.items.some((item) => item.finalPath === target),
    );
    if (!known) throw new Error('That file is not one of this session’s downloads.');
    shell.showItemInFolder(target);
    return undefined;
  });
}

function requireBrowser(): EmbeddedBrowser {
  if (!browser) throw new Error('The browser tab is not ready yet.');
  return browser;
}

async function createWindow(): Promise<void> {
  window = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 900,
    minHeight: 560,
    show: false,
    backgroundColor: '#14171c',
    title: 'fastxdcc',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // The renderer is a local page; it has no business navigating or opening windows.
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => event.preventDefault());

  browser = new EmbeddedBrowser(window, {
    onState: (state) => {
      if (window && !window.isDestroyed()) window.webContents.send(CHANNELS.browserState, state);
    },
    onIrcLink: (url) => void followIrcLink(url),
    onNotice: (text) => notify('info', text),
  });

  window.once('ready-to-show', () => window?.show());
  window.on('closed', () => {
    browser?.destroy();
    browser = undefined;
    window = undefined;
  });

  await window.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  publish(true);
}

async function bootstrap(): Promise<void> {
  configPath = path.join(app.getPath('userData'), 'config.json');
  const downloads = path.join(app.getPath('downloads'), 'fastxdcc');

  try {
    const loaded = await readConfigFile(configPath, downloads);
    config = loaded.config;
  } catch (err) {
    // A corrupt config must not stop the app from opening; the user needs the settings
    // pane to fix it, and that pane lives inside the app.
    config = defaultConfig(downloads);
    dialog.showErrorBox('fastxdcc settings', (err as Error).message);
  }

  registerHandlers();
  await createWindow();
  startPublishing();

  if (process.env.FASTXDCC_SMOKE === '1') await runSmokeCheck();
}

/**
 * Prove the app actually works end to end without a human looking at it: the React tree
 * mounted, the preload bridge is reachable, an IPC round trip answers, and the renderer
 * logged no errors. Loading the page successfully does not establish any of that.
 */
async function runSmokeCheck(): Promise<void> {
  const consoleErrors: string[] = [];
  window?.webContents.on('console-message', (event) => {
    if (event.level === 'error') consoleErrors.push(event.message);
  });

  // Give React a moment to mount and the first snapshot to arrive.
  await new Promise((resolve) => setTimeout(resolve, 1500));

  const probe = await window?.webContents.executeJavaScript(`(async () => {
    const api = window.fastxdcc;
    let configOk = false;
    try {
      configOk = (await api.getConfig()).ok === true;
    } catch {}
    return {
      mounted: document.querySelectorAll('.app').length,
      bridge: typeof api,
      methods: api ? Object.keys(api).length : 0,
      configOk,
      buttons: document.querySelectorAll('button').length,
      text: (document.body.innerText || '').slice(0, 120),
    };
  })()`);

  // Order matters: the links run first because the later checks need the tabs they
  // create, and the pop-under check reads the notice bar last so nothing overwrites it.
  const link = await smokeCheckIrcLinks();
  const tabs = await smokeCheckTabSwitching();
  const clip = await smokeCheckClipboard();
  const whisper = await smokeCheckWhisper();
  const popup = await smokeCheckPopup();

  process.stdout.write(
    `fastxdcc smoke: ${JSON.stringify({ ...probe, popup, tabs, link, clip, whisper, consoleErrors })}\n`,
  );

  const failures: string[] = [];
  if (!probe || probe.mounted !== 1) failures.push('React tree did not mount');
  if (probe?.bridge !== 'object') failures.push('preload bridge missing');
  if (!probe?.configOk) failures.push('config IPC round trip failed');
  if (!popup.urlUnchanged) failures.push(`a pop-up navigated the page (${popup.url})`);
  if (!popup.blocked) failures.push('the pop-up was not reported as blocked');
  if (!tabs.shownOnBrowse) failures.push('the page did not appear on the Browse tab');
  if (tabs.shownOnTransfers) failures.push('the page stayed on top after leaving the Browse tab');
  if (link !== '127.0.0.1:1,127.0.0.1:2') {
    failures.push(`the two irc:// links did not open two connections (got ${link})`);
  }
  if (tabs.sessionTabs !== 2) failures.push(`expected 2 connection tabs, saw ${tabs.sessionTabs}`);
  for (const [what, outcome] of Object.entries(whisper)) {
    if (outcome !== 'ok') failures.push(`whisper ${what}: ${outcome}`);
  }
  for (const [what, outcome] of Object.entries(clip)) {
    if (outcome !== 'ok') failures.push(`clipboard ${what}: ${outcome}`);
  }
  if (consoleErrors.length > 0) failures.push(`renderer errors: ${consoleErrors.join(' | ')}`);

  if (failures.length > 0) {
    process.stdout.write(`fastxdcc smoke: FAILED - ${failures.join('; ')}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write('fastxdcc smoke: OK\n');
  }
  app.quit();
}

/**
 * A private message has to open a tab the user can actually see.
 *
 * The session tests already prove the conversation is opened, so what is checked here is
 * everything after that: the snapshot carrying it across the IPC boundary, the renderer
 * receiving it, and the channel bar drawing a tab for it. A real connection to a real
 * socket, so nothing between the wire and the DOM is stubbed.
 */
async function smokeCheckWhisper(): Promise<Record<string, string>> {
  const net = await import('node:net');
  const WHISPERER = 'whisperer';
  const MESSAGE = 'this is a private message';

  let socket: import('node:net').Socket | undefined;
  let nick = '*';

  const server = net.createServer((conn) => {
    socket = conn;
    let buffer = '';
    conn.on('error', () => {});
    conn.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let index: number;
      while ((index = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, index).replace(/\r$/, '');
        buffer = buffer.slice(index + 1);
        if (/^CAP LS/i.test(line)) conn.write(':fake CAP * LS :\r\n');
        else if (/^NICK /i.test(line)) nick = line.split(' ')[1] ?? '*';
        else if (/^CAP END/i.test(line)) {
          conn.write(`:fake 001 ${nick} :Welcome\r\n`);
          conn.write(`:fake 376 ${nick} :End of MOTD\r\n`);
        }
      }
    });
  });

  const ask = async (code: string): Promise<string> =>
    String(await window!.webContents.executeJavaScript(code));

  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;

    const id = startSession({ host: '127.0.0.1', port, tls: false, isNick: false });
    await new Promise((resolve) => setTimeout(resolve, 2000));

    const out: Record<string, string> = {};
    out.connected = sessions.get(id)?.client.connectionState === 'registered'
      ? 'ok'
      : `connection state was ${sessions.get(id)?.client.connectionState}`;
    if (out.connected !== 'ok') return out;

    // Bring that server's tab forward, the way the user would be looking at it.
    await window!.webContents.executeJavaScript(
      `[...document.querySelectorAll('.tabbar .tab')].find((t) => t.title === '127.0.0.1:${port}')?.click()`,
    );
    await new Promise((resolve) => setTimeout(resolve, 600));

    socket?.write(`:${WHISPERER}!u@h PRIVMSG ${nick} :${MESSAGE}\r\n`);
    await new Promise((resolve) => setTimeout(resolve, 1200));

    // Desktop notifications are raised only while the window is not focused, which is
    // the state this reproduces; without it the check would pass for the wrong reason.
    const alertsBefore = whisperAlertsShown;
    window!.blur();
    await new Promise((resolve) => setTimeout(resolve, 300));
    socket?.write(`:offscreen!u@h PRIVMSG ${nick} :you were away\r\n`);
    await new Promise((resolve) => setTimeout(resolve, 800));
    out.notifiesWhenUnfocused =
      whisperAlertsShown > alertsBefore ? 'ok' : 'no desktop notification was raised';
    window!.focus();
    await new Promise((resolve) => setTimeout(resolve, 300));

    out.sessionOpenedIt = sessions.get(id)?.store.state.conversations.includes(WHISPERER)
      ? 'ok'
      : `session conversations were ${JSON.stringify(sessions.get(id)?.store.state.conversations)}`;

    const tabs = await ask(
      `JSON.stringify([...document.querySelectorAll('.chanbar .chan')].map((t) => t.textContent))`,
    );
    out.tabIsDrawn = tabs.includes(WHISPERER) ? 'ok' : `channel bar showed ${tabs}`;

    // And the message has to be readable once that tab is selected.
    await window!.webContents.executeJavaScript(
      `[...document.querySelectorAll('.chanbar .chan')].find((t) => t.textContent.includes('${WHISPERER}'))?.click()`,
    );
    await new Promise((resolve) => setTimeout(resolve, 400));
    const shown = await ask(`document.querySelector('.logpane')?.innerText || ''`);
    out.messageIsReadable = shown.includes(MESSAGE) ? 'ok' : `log pane showed ${JSON.stringify(shown)}`;

    // Plenty of clients send a private message as a NOTICE rather than a PRIVMSG, and
    // those have to open a tab too — while the server's own announcements must not.
    socket?.write(`:noticer!u@h NOTICE ${nick} :sent as a notice\r\n`);
    socket?.write(`:fake NOTICE ${nick} :*** this is a server announcement\r\n`);
    await new Promise((resolve) => setTimeout(resolve, 1200));

    const after = await ask(
      `JSON.stringify([...document.querySelectorAll('.chanbar .chan')].map((t) => t.textContent))`,
    );
    out.noticeOpensATab = after.includes('noticer') ? 'ok' : `channel bar showed ${after}`;
    out.serverGetsNoTab = after.includes('fake') ? `channel bar showed ${after}` : 'ok';

    return out;
  } catch (err) {
    return { setup: `error: ${(err as Error).message}` };
  } finally {
    socket?.destroy();
    server.close();
  }
}

/**
 * Pack sites put the request line behind a "copy" button, so copying has to work in the
 * browser tab or much of the point of that tab is lost.
 *
 * Verified by reading the system clipboard afterwards rather than by trusting the page's
 * own report, because `navigator.clipboard.writeText()` can resolve without anything
 * reaching the clipboard. Both routes a page might take are covered, since which one it
 * uses depends on whether it was served over a secure origin, and plain-http pack lists
 * are common:
 *
 *  - `navigator.clipboard.writeText()`, which needs a permission, and which does not
 *    exist at all on an insecure origin;
 *  - `document.execCommand('copy')`, the older route sites fall back to.
 *
 * The user's own clipboard is put back afterwards; a smoke run should not cost them
 * whatever they had copied.
 */
async function smokeCheckClipboard(): Promise<Record<string, string>> {
  const { createServer } = await import('node:http');
  // Electron's clipboard module is promise-based, matching the W3C API.
  const saved = await clipboard.readText();

  const page = `<!doctype html><meta charset="utf-8"><body>
    <button id="api">copy with the clipboard API</button>
    <button id="exec">copy with execCommand</button>
    <script>
      window.outcome = {};
      document.getElementById('api').addEventListener('click', async () => {
        try {
          if (!navigator.clipboard) throw new Error('navigator.clipboard is undefined');
          await navigator.clipboard.writeText(window.token);
          window.outcome.api = 'ok';
        } catch (err) { window.outcome.api = 'threw: ' + err.message; }
      });
      document.getElementById('exec').addEventListener('click', () => {
        try {
          const box = document.createElement('textarea');
          box.value = window.token;
          document.body.appendChild(box);
          box.select();
          window.outcome.exec = document.execCommand('copy') ? 'ok' : 'returned false';
          box.remove();
        } catch (err) { window.outcome.exec = 'threw: ' + err.message; }
      });
    <\/script>
  </body>`;

  const server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(page);
  });

  /** Press one button with a real user gesture, then see what reached the clipboard. */
  const copyVia = async (which: 'api' | 'exec', origin: string): Promise<string> => {
    const token = `fastxdcc-${which}-${Date.now()}`;
    await clipboard.writeText('');
    browser?.navigate(origin);
    browser?.setVisible(true);
    await new Promise((resolve) => setTimeout(resolve, 1800));
    const reported = await browser?.probe(
      `(async () => {
        window.token = ${JSON.stringify(token)};
        document.getElementById(${JSON.stringify(which)}).click();
        await new Promise((r) => setTimeout(r, 500));
        return window.outcome[${JSON.stringify(which)}] || 'nothing happened';
      })()`,
    );
    if (reported !== 'ok') return String(reported);
    return (await clipboard.readText()) === token
      ? 'ok'
      : 'reported success but nothing was copied';
  };

  try {
    await new Promise<void>((resolve) => server.listen(0, '0.0.0.0', resolve));
    const address = server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;

    const out: Record<string, string> = {};
    // Loopback counts as a secure origin, so this is where the modern API exists at all.
    out.secureApi = await copyVia('api', `http://127.0.0.1:${port}/`);
    out.secureExec = await copyVia('exec', `http://127.0.0.1:${port}/`);

    // Plain http on any other host is not a secure origin, which is what most pack lists
    // are actually served over.
    const lan = Object.values(networkInterfaces())
      .flat()
      .find((face) => face && face.family === 'IPv4' && !face.internal)?.address;
    if (lan) {
      out.insecureApi = await copyVia('api', `http://${lan}:${port}/`);
      out.insecureExec = await copyVia('exec', `http://${lan}:${port}/`);
    }
    return out;
  } catch (err) {
    return { setup: `error: ${(err as Error).message}` };
  } finally {
    await clipboard.writeText(saved);
    server.close();
  }
}

/**
 * Guard against a regression that was reported from the field: pack sites carry
 * pop-under ads that call `window.open` with a URL of their own on the first click. An
 * earlier version loaded that URL into the current view, so the page appeared to reload
 * whenever the user clicked into its search box.
 *
 * The page here opens a *different* path than the one it is served at, so a regression
 * shows up as a changed URL rather than an invisible reload.
 */
async function smokeCheckPopup(): Promise<{ urlUnchanged: boolean; blocked: boolean; url: string }> {
  const { createServer } = await import('node:http');
  // A button rather than an anchor: an <a href="#"> would append a fragment and look
  // like a navigation all by itself.
  const page = `<!doctype html><meta charset="utf-8"><body>
    <button id="l">focus me</button>
    <script>
      document.getElementById('l').addEventListener('click', () => window.open('/popup'));
      setTimeout(() => document.getElementById('l').click(), 150);
    </script>
  </body>`;

  const server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(page);
  });

  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    const expected = `http://127.0.0.1:${port}/`;

    browser?.navigate(expected);
    await new Promise((resolve) => setTimeout(resolve, 2500));

    const url = browser?.state().url ?? '';
    // The block is reported through the normal notice path, so reading the rendered
    // notice proves the whole chain and not just the handler.
    const notice: string = await window?.webContents.executeJavaScript(
      "(document.querySelector('.notice') || {}).innerText || ''",
    );

    return {
      urlUnchanged: url === expected,
      blocked: notice.includes('Blocked a pop-up'),
      url,
    };
  } catch (err) {
    return { urlUnchanged: false, blocked: false, url: `error: ${(err as Error).message}` };
  } finally {
    server.close();
  }
}

/**
 * Guard against another reported regression: the page is a native view floated over the
 * window, so it does not disappear just because React stopped rendering the tab that owns
 * it. Leaving the Browse tab has to hide it explicitly, or it covers the transfer list.
 *
 * Expects a page to already be loaded, since a blank view is hidden either way.
 */
async function smokeCheckTabSwitching(): Promise<{
  shownOnBrowse: boolean;
  shownOnTransfers: boolean;
  sessionTabs: number;
}> {
  // Tabs are named after the server, so they are picked by position: the connection tabs
  // come first and the browser tab is always last.
  const clickTab = async (which: 'first' | 'last') => {
    await window?.webContents.executeJavaScript(
      `(() => {
        const tabs = [...document.querySelectorAll('.tabbar .tab')];
        const tab = ${which === 'last' ? 'tabs[tabs.length - 1]' : 'tabs[0]'};
        if (tab) tab.click();
        return tabs.length;
      })()`,
    );
    // Let the click become a React render, an IPC call and a layout pass.
    await new Promise((resolve) => setTimeout(resolve, 600));
  };

  const sessionTabs: number = await window?.webContents.executeJavaScript(
    "document.querySelectorAll('.tabbar .tab').length - 1",
  );

  await clickTab('last');
  const shownOnBrowse = browser?.showing ?? false;

  await clickTab('first');
  const shownOnTransfers = browser?.showing ?? false;

  return { shownOnBrowse, shownOnTransfers, sessionTabs };
}

/**
 * Drive the browser tab the way a user would: load a page over http, click two `irc://`
 * links for different servers, and check that each one opened its own connection rather
 * than replacing the other.
 *
 * The links point at ports nothing listens on, so the attempts stay on this machine and
 * fail harmlessly — what is being checked is that the clicks reached the app.
 *
 * Returns the connection ids that ended up open, in order.
 */
async function smokeCheckIrcLinks(): Promise<string> {
  const { createServer } = await import('node:http');
  const page = `<!doctype html><meta charset="utf-8"><body>
    <a id="a" href="irc://127.0.0.1:1/first">one</a>
    <a id="b" href="irc://127.0.0.1:2/second">two</a>
  </body>`;

  const server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(page);
  });

  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;

    browser?.navigate(`http://127.0.0.1:${port}/`);
    await new Promise((resolve) => setTimeout(resolve, 1500));

    // Clicking a link navigates away from the page, so each click needs the page back.
    for (const id of ['a', 'b']) {
      await window?.webContents.executeJavaScript(
        `(async () => {
          await window.fastxdcc.browserNavigate('http://127.0.0.1:${port}/');
        })()`,
      );
      await new Promise((resolve) => setTimeout(resolve, 1200));
      await window?.webContents.executeJavaScript(
        `window.fastxdcc.followIrcLink('irc://127.0.0.1:${id === 'a' ? 1 : 2}/${id}')`,
      );
      await new Promise((resolve) => setTimeout(resolve, 1200));
    }

    return [...sessions.keys()].join(',') || 'no session';
  } catch (err) {
    return `error: ${(err as Error).message}`;
  } finally {
    server.close();
  }
}

// A second instance would fight over the config file and the DCC listen ports.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!window) return;
    if (window.isMinimized()) window.restore();
    window.focus();
  });

  app.whenReady().then(bootstrap, (err: unknown) => {
    dialog.showErrorBox('fastxdcc failed to start', String(err));
    app.quit();
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow();
  });

  app.on('before-quit', () => {
    if (publishTimer) clearInterval(publishTimer);
    closeAllSessions();
    // The browser view is a child of the window with its own live webContents. Quitting
    // without tearing it down leaves the process running after the window has gone.
    browser?.destroy();
    browser = undefined;
  });
}
