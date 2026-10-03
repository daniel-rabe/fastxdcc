# Changelog

Notable changes to fastxdcc. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[semantic versioning](https://semver.org/spec/v2.0.0.html).

## 0.2.0 — 2026-10-03

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

### Changed

- **Typed text goes to the view you are looking at**, not to the first joined
  channel. Bare `/part` leaves that channel. With more than one channel open on
  a server, the old behaviour sent messages to the wrong place.
- **The Server view now means "everything with no view of its own."** Opening a
  conversation with an XDCC bot moves its notices out of Server and into that
  tab; closing it moves them back. Every line belongs to exactly one view.
- Notices deliberately do not open a conversation. XDCC bots announce every
  queue position that way, and a tab per bot would bury the real ones.

### Fixed

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
