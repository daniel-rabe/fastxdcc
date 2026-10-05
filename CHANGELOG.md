# Changelog

Notable changes to fastxdcc. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[semantic versioning](https://semver.org/spec/v2.0.0.html).

## 0.3.0 — 2026-10-05

A server tab used to show one undivided log for everything that happened on
that connection. This release splits it into the conversations it was actually
made of.

### Added

- **A chat view per channel.** The bar above the log switches between **All**
  (everything, as before), **Server** (status, transfers and bot notices), and
  one tab per joined channel. An unread count on each tab counts what has
  arrived there since it was last on screen.
- **Joining and leaving from the GUI.** A box in the channel bar joins a
  channel — `#` is supplied if you forget it, and `#chan key` works — and the
  **×** beside a tab leaves.
- **Private message tabs.** A conversation opens by itself when somebody
  messages you directly, or on demand with the **Message** button, `/query` or
  `/msg`. `/close` closes one, and bare `/close` closes the one you are
  reading.
- **Channel topics**, shown on their own line above the chat and in the
  channel tab's tooltip. Links in a topic are clickable: `http` and `https`
  open in the Browse tab, `irc://` connects or joins. Long topics are clipped
  to one line with a control to expand them.

- **An unread count on the connection tab**, so a private message arriving on a
  server you are not looking at is visible. It counts conversations only —
  channel traffic is ambient and would leave the badge permanently lit — and is
  tinted like the conversation tabs to tell it apart from the transfer count
  beside it.
- **A desktop notification** when somebody messages you and the window is not
  focused. Clicking it brings the window forward on that connection. One alert
  per sender per five seconds, so a burst of lines does not stack up.

### Changed

- **Typed text goes to the view you are looking at**, not to the first joined
  channel. Bare `/part` leaves that channel. With more than one channel open on
  a server, the old behaviour sent messages to the wrong place.
- **The Server view now means "everything with no view of its own."** Opening a
  conversation with an XDCC bot moves its notices out of Server and into that
  tab; closing it moves them back. Every line belongs to exactly one view.
- **A private message sent as a `NOTICE` now opens a tab too.** Plenty of
  clients and scripts whisper that way rather than with `PRIVMSG`, and
  refusing to open a tab for one lost real conversations. What stays in the
  Server view instead is everything that is not a person: the server's own
  announcements, services robots such as NickServ, and the queue-position
  chatter from a bot you have a transfer in flight with.

### Fixed

- **Unread counts survive switching between connections.** They were held
  inside the transfers pane, which is unmounted whenever another connection is
  brought forward — so the counts were lost on every switch, for exactly the
  connections whose counts matter. They now live above it.
- **A message is only treated as coming from a person when it carries a full
  `nick!user@host` prefix.** Whether a bare prefix is a server name was
  previously a guess based on it containing a dot, so a server whose name had
  none could have opened a conversation tab for itself.

- **Copy buttons work in the Browse tab.** The tab denied every browser
  permission, including the one `navigator.clipboard.writeText()` needs, so
  "copy the request line" buttons on pack sites failed silently. Writing to the
  clipboard is now allowed; reading still is not, as that would expose whatever
  you last copied anywhere else. Pages served over plain `http` have no
  clipboard API at all — Chromium withholds it from insecure origins — so the
  tab supplies a stand-in built on the older copy command, which gives those
  pages nothing they could not already do.
- **Channel membership follows `PART` and `KICK`.** Leaving a channel, or being
  removed from one, previously left it listed as joined.
- Topics and channels are cleared on reconnect, rather than lingering from the
  previous connection.

### Development

- The repository is now under version control, MIT licensed, with a GitHub
  Actions workflow that builds the Windows installers. See
  [docs/signing.md](docs/signing.md) for the code signing situation.
- The built-in smoke check (`FASTXDCC_SMOKE=1`) now drives a real page and
  reads the system clipboard back, so a regression in copying is caught by the
  build rather than by a user.

## 0.1.0 — 2026-09-26

First release: an IRC client specialised for XDCC transfers, as an Electron
desktop application and an Ink terminal UI over a shared headless core.
Connects to a network with SASL or NickServ, joins channels, requests packs,
accepts DCC offers both active and passive, resumes interrupted transfers, and
includes a locked-down browser tab for finding pack listings.
