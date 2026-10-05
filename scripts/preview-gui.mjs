/**
 * Renders the GUI in a plain browser with a stubbed bridge and sample data.
 *
 * The renderer is ordinary web code, so it can be looked at without launching Electron.
 * Useful for working on layout and styling: run `npm run gui:preview` and open the file
 * it prints. Nothing here ships inside the app.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'dist-gui', 'preview');

const now = Date.now();

const firstSession = {
  id: 'irc.example.net:6697',
  label: 'irc.example.net',
  connection: 'registered',
  network: 'irc.example.net:6697',
  nick: 'yournick',
  channels: [
    {
      name: '#packs',
      activity: 2,
      topic:
        'Welcome to #packs | Full list at https://packs.example.net/search | ' +
        'Mirror (https://mirror.example.net/list) | Network: irc://irc.example.net/help | ' +
        'No requests in channel, /msg the bot directly. Be patient, slots fill up fast.',
    },
    { name: '#movies', activity: 1 },
  ],
  conversations: [
    { name: 'packbot', activity: 2 },
    { name: 'Carol', activity: 4 },
  ],
  serverActivity: 7,
  activeTransfers: 2,
  items: [
    {
      id: 'q1',
      bot: 'packbot',
      pack: 7,
      state: 'transferring',
      attempts: 1,
      filename: 'Some.Show.S01E01.1080p.WEB-DL.mkv',
      size: 2_400_000_000,
      bytesReceived: 1_465_000_000,
      speed: 8_600_000,
      eta: 108,
    },
    {
      id: 'q2',
      bot: 'packbot',
      pack: 8,
      state: 'botQueued',
      attempts: 1,
      position: 2,
      total: 7,
      note: 'queued 2/7',
    },
    {
      id: 'q3',
      bot: 'otherbot',
      pack: 12,
      state: 'transferring',
      attempts: 2,
      filename: 'A Film With Spaces (2019).mkv',
      size: 900_000_000,
      bytesReceived: 121_000_000,
      speed: 1_250_000,
      eta: 622,
      passive: true,
    },
    {
      id: 'q4',
      bot: 'packbot',
      pack: 3,
      state: 'completed',
      attempts: 1,
      filename: 'Archive.tar.gz',
      size: 314_572_800,
      bytesReceived: 314_572_800,
      finalPath: 'C:\\Users\\you\\Downloads\\fastxdcc\\Archive.tar.gz',
    },
    {
      id: 'q5',
      bot: 'deadbot',
      pack: 1,
      state: 'failed',
      attempts: 3,
      error: 'Timed out connecting to 203.0.113.9:5001',
    },
  ],
  log: [
    { at: now - 42_000, level: 'info', source: '*', text: 'Connected to irc.example.net:6697' },
    { at: now - 41_000, level: 'info', source: '*', text: 'SASL authentication succeeded' },
    { at: now - 40_000, level: 'info', source: '*', text: 'Joined #packs' },
    { at: now - 32_000, level: 'irc', source: '#packs', text: '<someone> anyone got pack 8?' },
    { at: now - 25_000, level: 'info', source: 'dcc', text: 'Requested packbot pack #7' },
    {
      at: now - 24_000,
      level: 'bot',
      source: 'packbot',
      text: '-packbot- ** Sending you pack #7 ("Some.Show.S01E01.1080p.WEB-DL.mkv")',
    },
    {
      at: now - 23_000,
      level: 'info',
      source: 'dcc',
      text: '[packbot #7] Resuming Some.Show.S01E01.1080p.WEB-DL.mkv at 912261120 bytes',
    },
    { at: now - 8_000, level: 'self', source: '#packs', text: '<yournick> thanks!' },
    { at: now - 7_000, level: 'irc', source: 'packbot', text: '<packbot> slot free, go ahead' },
    {
      at: now - 6_000,
      level: 'irc',
      source: '#movies',
      text: '<cinephile> any 4k remuxes tonight?',
    },
    {
      at: now - 3_000,
      level: 'error',
      source: 'dcc',
      text: 'deadbot #1 failed: Timed out connecting to 203.0.113.9:5001',
    },
  ],
};

const secondSession = {
  id: 'irc.abandoned-irc.net:6667',
  label: 'irc.abandoned-irc.net',
  connection: 'registered',
  network: 'irc.abandoned-irc.net:6667',
  nick: 'yournick',
  channels: [{ name: '#zombie-warez', activity: 0, topic: 'nothing here any more' }],
  conversations: [{ name: 'stranger', activity: 2 }],
  serverActivity: 3,
  activeTransfers: 1,
  items: [
    {
      id: 'q6',
      bot: 'zombiebot',
      pack: 42,
      state: 'transferring',
      attempts: 1,
      filename: 'Another.Pack.2024.mkv',
      size: 1_200_000_000,
      bytesReceived: 260_000_000,
      speed: 3_400_000,
      eta: 276,
    },
    { id: 'q7', bot: 'zombiebot', pack: 43, state: 'waiting', attempts: 0 },
  ],
  log: [
    {
      at: now - 20_000,
      level: 'info',
      source: '*',
      text: 'Connected to irc.abandoned-irc.net:6667',
    },
    { at: now - 19_000, level: 'info', source: '*', text: 'Joined #zombie-warez' },
    { at: now - 15_000, level: 'info', source: 'dcc', text: 'Requested zombiebot pack #42' },
  ],
};

const sample = {
  revision: 1,
  downloadDir: 'C:\\Users\\you\\Downloads\\fastxdcc',
  sessions: [firstSession, secondSession],
};

const config = {
  network: {
    host: 'irc.example.net',
    port: 6697,
    tls: true,
    rejectUnauthorized: true,
    nick: 'yournick',
    channels: ['#packs', { name: '#movies', key: 'sekrit' }],
    maxReconnectAttempts: 10,
  },
  downloadDir: 'C:\\Users\\you\\Downloads\\fastxdcc',
  maxConcurrent: 2,
  maxRetries: 2,
  passive: { portRange: [59000, 59100], listenTimeoutMs: 60000 },
  timeouts: { requestMs: 60000, resumeMs: 10000, connectMs: 30000, stallMs: 60000 },
  autoGet: [],
};

const stub = `/* Preview-only stub of the preload bridge. */
const SAMPLE = ${JSON.stringify(sample, null, 2)};
const CONFIG = ${JSON.stringify(config, null, 2)};

const ok = (value) => Promise.resolve({ ok: true, value });
let listener = null;
let noticeListener = null;
let browserListener = null;
let state = structuredClone(SAMPLE);
let browserState = {
  url: '', title: '', loading: false, canGoBack: false, canGoForward: false,
};

const pushBrowser = (patch) => {
  browserState = { ...browserState, ...patch };
  if (browserListener) browserListener(browserState);
};

// Animate the running transfers so progress bars and speeds can be judged in motion.
setInterval(() => {
  if (!listener) return;
  state = structuredClone(state);
  for (const session of state.sessions) {
    for (const item of session.items) {
      if (item.state !== 'transferring') continue;
      item.bytesReceived = Math.min(item.size, item.bytesReceived + item.speed / 8);
      item.speed *= 0.97 + Math.random() * 0.06;
      item.eta = (item.size - item.bytesReceived) / item.speed;
    }
  }
  state.revision++;
  listener(state);
}, 125);

// Trickle chat into a channel, which is the only way to watch an unread badge count up.
let chatter = 0;
setInterval(() => {
  if (!listener) return;
  const session = state.sessions[0];
  const channel = session.channels.find((c) => c.name === '#movies');
  if (!channel) return;
  state = structuredClone(state);
  const live = state.sessions[0];
  live.log = [
    ...live.log,
    {
      at: Date.now(),
      level: 'irc',
      source: '#movies',
      text: '<cinephile> message ' + ++chatter,
    },
  ].slice(-400);
  live.channels.find((c) => c.name === '#movies').activity += 1;
  listener(state);
}, 3_000);

// A whisper arriving on the connection the user is not looking at, which is the case the
// badge on the connection tab exists for.
let background = 0;
setInterval(() => {
  if (!listener) return;
  state = structuredClone(state);
  const other = state.sessions[1];
  if (!other || !other.conversations[0]) return;
  other.log = [
    ...other.log,
    {
      at: Date.now(),
      level: 'irc',
      source: other.conversations[0].name,
      text: '<' + other.conversations[0].name + '> are you there? (' + ++background + ')',
    },
  ].slice(-400);
  other.conversations[0].activity += 1;
  listener(state);
}, 4_000);

// And a private message, so the other kind of badge can be watched too.
let whispers = 0;
setInterval(() => {
  if (!listener) return;
  const pm = state.sessions[0].conversations[0];
  if (!pm) return;
  state = structuredClone(state);
  const live = state.sessions[0];
  const name = live.conversations[0].name;
  live.log = [
    ...live.log,
    {
      at: Date.now(),
      level: 'irc',
      source: name,
      text: '<' + name + '> pack ' + ++whispers + ' is ready',
    },
  ].slice(-400);
  live.conversations[0].activity += 1;
  listener(state);
}, 5_000);

window.fastxdcc = {
  onState(fn) {
    listener = fn;
    fn(state);
    return () => { listener = null; };
  },
  onBrowserState(fn) {
    browserListener = fn;
    fn(browserState);
    return () => { browserListener = null; };
  },
  onNotice(fn) {
    noticeListener = fn;
    return () => { noticeListener = null; };
  },
  getConfig: () => ok({ config: CONFIG, path: 'C:\\\\Users\\\\you\\\\AppData\\\\Roaming\\\\fastxdcc\\\\config.json' }),
  saveConfig: (config) => ok({ config, path: 'preview' }),
  connect: () => ok({ sessionId: SAMPLE.sessions[0].id }),
  disconnect: () => ok(undefined),
  closeSession({ sessionId }) {
    state = structuredClone(state);
    state.sessions = state.sessions.filter((s) => s.id !== sessionId);
    if (listener) listener(state);
    return ok(undefined);
  },
  queueAdd: () => ok({ added: 1, summary: 'Queued 1 pack(s) from packbot' }),
  queueCancel: () => ok({ cancelled: 1 }),
  queueClean: () => ok({ removed: 2 }),
  command: () => ok(undefined),
  joinChannel({ sessionId, channel }) {
    const name = /^[#&+!]/.test(channel) ? channel.toLowerCase() : '#' + channel.toLowerCase();
    state = structuredClone(state);
    const session = state.sessions.find((s) => s.id === sessionId);
    if (!session) return Promise.resolve({ ok: false, error: 'That connection is no longer open.' });
    if (session.channels.some((c) => c.name === name)) {
      return Promise.resolve({ ok: false, error: 'Already in ' + name + '.' });
    }
    session.channels.push({ name, activity: 0 });
    session.log = [
      ...session.log,
      { at: Date.now(), level: 'info', source: '*', text: 'Joined ' + name },
    ];
    if (listener) listener(state);
    return ok({ channel: name });
  },
  openConversation({ sessionId, nick }) {
    state = structuredClone(state);
    const session = state.sessions.find((s) => s.id === sessionId);
    if (!session) return Promise.resolve({ ok: false, error: 'That connection is no longer open.' });
    if (/^[#&+!]/.test(nick)) {
      return Promise.resolve({ ok: false, error: nick + ' is a channel; join it instead.' });
    }
    const open = session.conversations.find((c) => c.name.toLowerCase() === nick.toLowerCase());
    if (open) return ok({ nick: open.name });
    session.conversations.push({ name: nick, activity: 0 });
    if (listener) listener(state);
    return ok({ nick });
  },
  closeConversation({ sessionId, nick }) {
    state = structuredClone(state);
    const session = state.sessions.find((s) => s.id === sessionId);
    if (!session) return Promise.resolve({ ok: false, error: 'That connection is no longer open.' });
    session.conversations = session.conversations.filter((c) => c.name !== nick);
    if (listener) listener(state);
    return ok(undefined);
  },
  partChannel({ sessionId, channel }) {
    state = structuredClone(state);
    const session = state.sessions.find((s) => s.id === sessionId);
    if (!session) return Promise.resolve({ ok: false, error: 'That connection is no longer open.' });
    session.channels = session.channels.filter((c) => c.name !== channel);
    session.log = [
      ...session.log,
      { at: Date.now(), level: 'info', source: '*', text: 'Left ' + channel },
    ];
    if (listener) listener(state);
    return ok(undefined);
  },
  listPacks: () => ok(undefined),
  chooseDir: () => ok({ path: null }),
  openDir: () => ok(undefined),
  revealFile: () => ok(undefined),
  browserNavigate(url) {
    // No real page in the preview; just reflect the address so the chrome can be judged.
    pushBrowser({ url, title: url, canGoBack: true });
    return ok(undefined);
  },
  browserBack: () => ok(undefined),
  browserForward: () => ok(undefined),
  browserReload: () => ok(undefined),
  browserStop: () => ok(undefined),
  browserSetBounds: () => ok(undefined),
  browserSetVisible: () => ok(undefined),
  followIrcLink(url) {
    if (noticeListener) {
      noticeListener({
        kind: 'info',
        text: 'Connecting to ' + url + '\\u2026',
        activateTab: SAMPLE.sessions[1].id,
      });
    }
    return ok(undefined);
  },
};
`;

// Everything is inlined into one file so the preview survives being opened from any
// location, including viewers that snapshot the page rather than serving the folder.
const rendererDir = path.join(root, 'dist-gui', 'renderer');
const css = await readFile(path.join(rendererDir, 'styles.css'), 'utf8');
const bundle = await readFile(path.join(rendererDir, 'index.js'), 'utf8');

const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>fastxdcc — preview</title>
    <style>
${css}
    </style>
  </head>
  <body>
    <div id="root"></div>
    <script>
${stub}
    </script>
    <script>
${bundle}
    </script>
  </body>
</html>
`;

await mkdir(outDir, { recursive: true });
await writeFile(path.join(outDir, 'index.html'), html, 'utf8');
process.stdout.write(`${path.join(outDir, 'index.html')}\n`);
