# fastxdcc

An IRC client built for one job: downloading files from XDCC bots. It connects to a
network, joins channels, asks a bot for packs, accepts the DCC offer, and writes the file
to disk — showing progress, speed, and ETA per transfer.

It ships two front ends over one shared core:

- a **desktop GUI** (Electron) — `npm run gui`
- a **terminal UI** — `npm run dev`

Both drive the same IRC and DCC code; neither has protocol logic of its own.

## Install

```bash
npm install
```

Requires Node 20 or newer.

## The desktop app

```bash
npm run gui
```

The app starts without any configuration. There are two ways to get onto a network:

- **Settings → Connect** — fill in server, nickname and channels, then press **Connect**.
- **The Browse tab** — open a site that lists XDCC packs and click an `irc://` link on it,
  for example `irc://irc.abandoned-irc.net/zombie-warez`. fastxdcc connects to that server
  and joins that channel, using the nickname and download folder from your settings.

### Several servers at once

Each server you connect to gets its own tab, with its own transfer list, log and command
line. Following an `irc://` link to a server that is not open yet adds a tab rather than
replacing anything, so downloads already running elsewhere are never disturbed.

The dot on each tab shows that connection's state and the number counts its running
transfers. **Disconnect** (top right) leaves the tab in place so its history stays
readable; the **×** on the tab closes it for good, and asks first if transfers are still
running.

One thing worth knowing: `maxConcurrent` applies **per server**, not in total. With the
default of 2 and three servers connected you can have six transfers running at once.

### Channels and private messages on one server

A server tab can hold as many channels and conversations as you like. The bar above the
log switches which one it shows:

- **All** — every line from this server, the way the log has always looked. Useful for
  watching a transfer and the chat that led to it side by side.
- **Server** — connection status, DCC progress, and bot notices. This is where XDCC
  announcements land, since bots reply to you directly rather than in a channel.
- **One tab per channel**, showing only what was said there.
- **One tab per conversation**, after the divider, for private messages.

Every line is in exactly one of these: a channel's lines are its own, a person's lines are
their own once you have a conversation open with them, and whatever is left over is the
**Server** view. Open a conversation with an XDCC bot and its notices move out of
**Server** and into that tab; close it again and they move back.

Use the box on the right to add either kind. **Join** treats what you typed as a channel —
the `#` is added for you, and `#chan key` joins a keyed channel — and **Message** treats it
as a person. Pressing Enter joins, because a channel name typed without its `#` is the
common slip and silently failing to join is the worse outcome. The **×** beside a tab
leaves the channel, or closes the conversation; closing one sends nothing and loses
nothing. A number on a tab counts what has arrived there since you last looked at it.

A channel's **topic** appears on its own line above the chat, with the channel tab's
tooltip carrying it too so it can be read without switching view. Links in it are
clickable: `http`and `https` ones open in the Browse tab, `irc://` ones connect or join.
That is usually where a pack network publishes its site, which is the whole reason the
Browse tab exists. Topics on these networks run long, so the line is clipped to one by
default — the **▾** on the right opens the rest.

A conversation also opens by itself the moment somebody messages you directly, so nothing
private gets lost in the server log. Notices deliberately do not open one: XDCC bots
announce every queue position that way, and a tab per bot would bury the real ones.

Whatever you are looking at is where typed text goes, a bare `/part` leaves that channel,
and a bare `/close` closes that conversation — so two channels on the same server never get
each other's messages.

### The Browse tab

A small browser with an address bar, built for finding packs. Clicking an `irc://` link
connects and joins; typing one into the address bar does the same thing.

A link to a server that is already open just joins the channel there; a link to a new one
opens another tab for it.

The tab is deliberately restricted, because it is the only part of the app that loads
pages nobody vetted: it runs in its own isolated session with no Node access, only
`http` and `https` can be opened, permission requests (camera, microphone, notifications)
are refused, and **downloads are blocked** — files are meant to arrive over XDCC, in
the Transfers tab.

The one permission that is granted is putting text on the clipboard, because pack sites
put the request line behind a **copy** button. Only writing is allowed; reading would
expose whatever you last copied anywhere else. Sites served over plain `http` have no
clipboard API at all — Chromium withholds it from insecure origins — so the tab supplies a
stand-in built on the older copy command, which gives those pages nothing they could not
already do.

To start a download, paste a request line into the bar at the top. All of these work, so
whatever a search site or channel topic gives you can go straight in:

```
/msg SomeBot xdcc send #123
/ctcp SomeBot XDCC SEND 123
SomeBot xdcc send #123
SomeBot #1,3-5
```

Paste several lines at once to queue them all. The table shows each transfer's progress,
size, speed, ETA, and state — including the position in a bot's own queue while you wait.
**Cancel** stops a transfer but keeps the partial file so it can resume later; **Discard**
stops it and deletes the partial. **Show** reveals a finished file in your file manager.

The command box at the bottom takes the same slash commands as the terminal UI, for the
things the buttons do not cover (`/query`, `/raw`, `/help`). Anything not starting with `/`
is sent to the channel or person whose view is open.

The Windows builds are unsigned, so SmartScreen warns on first run; see
[docs/signing.md](docs/signing.md) for what that would take.

Settings are stored in your user data folder (the path is shown in the settings dialog),
not in the project.

### GUI development

```bash
npm run gui:dev       # unminified build, then launch
npm run gui:watch     # rebuild on change (run `npx electron .` alongside)
npm run gui:preview   # render the UI in a normal browser with sample data
```

`gui:preview` writes a single self-contained HTML file with a stubbed bridge and fake
transfers. It is the quickest way to work on layout without starting Electron.

### Building a standalone app

```bash
npm run dist
```

That produces, in `release/`:

| File | What it is |
| --- | --- |
| `fastxdcc Setup <version>.exe` | Installer. Installs for the current user, so no administrator rights are needed, and offers a folder choice. |
| `fastxdcc-<version>-portable.exe` | Single file, runs with no installation. |
| `win-unpacked/fastxdcc.exe` | The plain app folder the two above are made from. |

For a quick check without building installers:

```bash
npm run pack
```

That writes only `release/win-unpacked/`, which is much faster.

The build is unsigned, so Windows SmartScreen will warn the first time it runs — "More
info" then "Run anyway". Signing needs a certificate, which has to come from you.

`electron-builder.yml` also has macOS (dmg) and Linux (AppImage) targets, but each has to
be built on its own platform; only the Windows ones have been tried here.

The icon is generated rather than committed as a binary:

```bash
npm run icon
```

That redraws `build/icon.png`, which electron-builder converts to the per-platform icon
formats.

## The terminal app

```bash
npm run build
node dist/index.js --server irc.example.net --nick yournick --channel '#packs' --get 'packbot #1'
```

Or write a config file so credentials stay out of your shell history:

```bash
node dist/index.js --init > fastxdcc.config.json
node dist/index.js
```

`fastxdcc.config.json` in the working directory is picked up automatically, followed by
`~/.config/fastxdcc/config.json`. The terminal UI needs a real TTY.

### Command-line options

| Flag | Meaning |
| --- | --- |
| `-c, --config <file>` | Config file to load |
| `-s, --server <host>` | IRC server hostname |
| `-p, --port <n>` | Port (6697 with TLS, 6667 without) |
| `--no-tls` | Connect in plain text |
| `--insecure` | Accept invalid TLS certificates |
| `-n, --nick <nick>` | Nickname |
| `-j, --channel <name>` | Join a channel; repeatable, `'#chan key'` for a keyed one |
| `-d, --dir <path>` | Download directory |
| `-m, --max <n>` | Maximum concurrent transfers |
| `-g, --get <spec>` | Request packs on connect, e.g. `'packbot #1,3-5'`; repeatable |
| `--init` | Print an example config and exit |

Flags override the config file.

### Commands

| Command | Meaning |
| --- | --- |
| `/get <bot> <packs>` | Request packs — `#1`, `1,3-5`, `#2-#4` all work |
| `/list <bot>` | Ask a bot for its pack list |
| `/queue` | Print the transfer queue |
| `/cancel [id\|all] [discard]` | Cancel a transfer; `discard` also deletes the partial file |
| `/clean` | Remove finished rows from the queue |
| `/join #chan [key]`, `/part [#chan]` | Channel membership; bare `/part` leaves the channel you are looking at |
| `/msg <target> <text>` | Send a message, opening a tab for a person |
| `/query <nick> [text]` | Open a private message tab, optionally sending a line |
| `/close [nick]` | Close a private message tab, or the one you are looking at |
| `/raw <line>` | Send a raw IRC line |
| `/clear` | Clear the log pane |
| `/quit` | Disconnect and exit |

In the terminal UI, anything not starting with `/` is sent to the first joined channel; in
the GUI it goes to the channel or person whose view is open.
Up and down arrows walk the command history; ctrl-C quits.

## Configuration

The GUI writes this file for you; the terminal app reads the same shape.

```jsonc
{
  "network": {
    "host": "irc.example.net",
    "port": 6697,
    "tls": true,
    "nick": "yournick",
    "channels": ["#packs", { "name": "#private", "key": "channelkey" }],
    "sasl": { "account": "yournick", "password": "secret" },
    "nickserv": { "password": "secret" }
  },
  "downloadDir": "./downloads",
  "maxConcurrent": 2,
  "maxRetries": 2,
  "passive": {
    "externalIp": "203.0.113.9",
    "portRange": [59000, 59100],
    "listenTimeoutMs": 60000
  },
  "timeouts": {
    "requestMs": 60000,
    "resumeMs": 10000,
    "connectMs": 30000,
    "stallMs": 60000
  },
  "autoGet": [{ "bot": "packbot", "packs": [1, 2] }],
  "logFile": "./fastxdcc.log"
}
```

`sasl` is preferred when the server supports it; `nickserv` is the fallback and is skipped
entirely if SASL succeeded. Both are optional.

## How transfers work

Both DCC directions are supported:

- **Active** (`DCC SEND ... <port> ...`) — the bot listens and fastxdcc connects out.
- **Reverse / passive** (`port 0` plus a token) — the bot is firewalled, so fastxdcc binds
  a port from `passive.portRange` and answers with its own `DCC SEND` carrying the token.
  Set `passive.externalIp` if you are behind NAT, and forward that port range; without it
  fastxdcc advertises the local address of the IRC socket, which only works on a directly
  routable host.

**Resume** is negotiated before connecting, not after. An interrupted download leaves a
`<name>.part` file; on the next attempt fastxdcc sends `DCC RESUME` and waits for the
bot's `DCC ACCEPT` before opening the data connection, so the two ends always agree on the
offset. If the bot never answers, the file restarts from the beginning rather than risking
a corrupt result. Completed files are renamed from `.part` only after the byte count
matches the announced size.

**Queueing** runs at most `maxConcurrent` requests at once, and serialises requests to the
same bot, because most bots reject a second pending request from the same user. When a bot
replies that you are queued on its side, that position is shown in the transfer list and
the slot is held rather than given up.

### Notes on speed

The receive path is a plain socket-to-file pipe with no per-chunk string work, and
acknowledgements are sent on a timer rather than after every chunk — acking per chunk makes
throughput a function of round-trip time. Both UIs redraw at a bounded rate for the same
reason: a running transfer updates its byte counter thousands of times a second, so the
GUI samples state 10 times a second instead of sending an IPC message per update, and the
terminal UI re-renders at most 8 times a second.

### Safety

Filenames from bots are treated as hostile input: path separators, `..`, NUL bytes,
control characters, Windows device names, and trailing dots are all neutralised, and the
resolved path is verified to be inside the download directory before anything is written.
Offers from bots you did not ask for are logged and ignored.

In the desktop app the renderer runs with `contextIsolation` on, `nodeIntegration` off and
`sandbox` on, under a content security policy that permits only its own bundled assets. It
reaches the Node side solely through the fixed list of methods in `src/electron/ipc.ts`,
and state crosses that boundary as plain serialisable snapshots — never as live objects.

## Development

```bash
npm test          # unit + integration tests
npm run typecheck # node, electron and renderer contexts
npm run build     # terminal app -> dist/
npm run build:gui # desktop app  -> dist-gui/
```

The test suite runs entirely on loopback: a fake IRC server and a fake XDCC bot speak the
real wire protocol, so active transfers, resume, reverse DCC, queueing, and the TUI render
are all covered without touching the network.

```
src/
  irc/        parser, socket/framing, client, irc:// link parsing
  dcc/        CTCP SEND/RESUME/ACCEPT, path safety, transfer engine, queue manager
  xdcc/       bot NOTICE interpretation, request-line parsing
  app/        session wiring, UI state, config file, IPC snapshots, link handling
  tui/        Ink components (terminal UI)
  electron/   main process, preload bridge, IPC contract, embedded browser view
  renderer/   React UI (desktop app)
```

There are three TypeScript configs because the code runs in three places: `tsconfig.json`
(Node, and what `npm run build` emits), `tsconfig.electron.json`, and
`tsconfig.renderer.json`, which is the only one with the DOM library so browser globals
cannot leak into Node-side code.
