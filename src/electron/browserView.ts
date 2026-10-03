/**
 * The embedded browser tab.
 *
 * This is the one place in the app that loads pages nobody vetted, so it is deliberately
 * boxed in: its own session partition, no Node, sandboxed, no downloads, only `http`/`https`
 * navigation, and no permission granted beyond putting text on the clipboard. The single
 * thing it is allowed to hand back to the app is an `irc://` link the user clicked, which
 * is passed out as a string for the main process to act on.
 */

import { WebContentsView, type BrowserWindow, type WebContents } from 'electron';
import { ALLOWED_SCHEMES, normaliseUrl } from '../app/browserUrl.js';
import { isIrcUrl } from '../irc/url.js';

export interface BrowserState {
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  /** Set when the last navigation failed, cleared on the next successful one. */
  error?: string;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface EmbeddedBrowserEvents {
  onState: (state: BrowserState) => void;
  /** The user clicked an irc:// link on a page. */
  onIrcLink: (url: string) => void;
  /** Something the user should be told about, e.g. a blocked download. */
  onNotice: (text: string) => void;
}

/*
 * Stands in for `navigator.clipboard.writeText` where the browser does not provide it.
 *
 * Chromium exposes the clipboard API only on secure origins, so on a plain-`http` pack
 * site it is missing altogether and a copy button that relies on it fails silently — no
 * permission setting can change that. `document.execCommand('copy')` does work there, so
 * this spells the modern API on top of the old one.
 *
 * Worth being clear about what this does and does not give a page: it grants no ability
 * the page did not already have, since `execCommand` is reachable from any script with a
 * user gesture. It is one-way — there is no channel back into the app, and the read half
 * is deliberately not provided, as that would expose whatever the user last copied.
 */
const CLIPBOARD_POLYFILL = `(() => {
  if (navigator.clipboard && navigator.clipboard.writeText) return;

  const writeText = (text) =>
    new Promise((resolve, reject) => {
      try {
        const box = document.createElement('textarea');
        box.value = String(text);
        box.setAttribute('readonly', '');
        box.style.cssText = 'position:fixed;top:-9999px;left:-9999px;opacity:0';
        document.body.appendChild(box);

        // Put back whatever the user had selected; copying should not move their cursor.
        const selection = document.getSelection();
        const previous = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;

        box.select();
        let copied = false;
        try {
          copied = document.execCommand('copy');
        } finally {
          box.remove();
          if (selection && previous) {
            selection.removeAllRanges();
            selection.addRange(previous);
          }
        }

        // execCommand refuses without a user gesture, which is the real API's rule too.
        if (copied) resolve();
        else reject(new DOMException('Copying was refused.', 'NotAllowedError'));
      } catch (err) {
        reject(err);
      }
    });

  try {
    Object.defineProperty(navigator, 'clipboard', {
      value: Object.freeze({ writeText }),
      configurable: true,
    });
  } catch {
    // A page that has already sealed navigator keeps whatever it has.
  }
})();`;

export class EmbeddedBrowser {
  private view?: WebContentsView;
  private bounds: Rect = { x: 0, y: 0, width: 0, height: 0 };
  private visible = false;
  private lastError?: string;
  private lastPopupNoticeAt = 0;
  private shown = false;
  /** Nothing has been loaded yet, so the renderer shows its own empty state. */
  private blank = true;

  constructor(
    private readonly window: BrowserWindow,
    private readonly events: EmbeddedBrowserEvents,
  ) {}

  private ensureView(): WebContentsView {
    if (this.view) return this.view;

    const view = new WebContentsView({
      webPreferences: {
        // Its own partition, so nothing it stores can reach the app's own session.
        partition: 'persist:fastxdcc-browser',
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webviewTag: false,
        // No preload: the page gets no bridge of any kind.
      },
    });

    const contents = view.webContents;
    const session = contents.session;

    /*
     * Nothing is granted except putting text on the clipboard.
     *
     * A page that wants the camera, the microphone, the user's location or a notification
     * is not doing anything this app needs. Copying is the exception: pack sites put the
     * request line behind a "copy" button, and that is precisely what this tab is for.
     *
     * Only the write half is allowed. `clipboard-read` would let any page read whatever
     * the user last copied anywhere else — a password, a private message — which is a far
     * worse trade than a copy button is worth. The sanitized spelling is the one Chromium
     * asks for on `navigator.clipboard.writeText()`; the unsanitized one covers arbitrary
     * HTML payloads and is left denied.
     */
    const allowed = new Set(['clipboard-sanitized-write']);
    session.setPermissionRequestHandler((_wc, permission, callback) =>
      callback(allowed.has(permission)),
    );
    // Answers `navigator.permissions.query()`, which sites check before offering the
    // button at all; denying here hides the feature even though the write would work.
    session.setPermissionCheckHandler((_wc, permission) => allowed.has(permission));

    // The app writes files only through DCC transfers the user asked for.
    session.on('will-download', (event, item) => {
      event.preventDefault();
      this.events.onNotice(
        `Blocked a download from the browser tab (${item.getFilename()}). ` +
          'This tab is for finding packs, not for downloading files.',
      );
    });

    const handleNavigation = (
      event: { preventDefault: () => void },
      url: string,
      isMainFrame: boolean,
    ) => {
      if (isIrcUrl(url)) {
        event.preventDefault();
        this.events.onIrcLink(url);
        return;
      }
      let protocol: string;
      try {
        protocol = new URL(url).protocol;
      } catch {
        event.preventDefault();
        return;
      }
      // Ad and analytics scripts routinely create about:blank frames; blocking those
      // breaks pages for no benefit.
      if (protocol === 'about:') return;
      if (!ALLOWED_SCHEMES.has(protocol)) {
        event.preventDefault();
        if (isMainFrame) {
          this.events.onNotice(`Blocked navigation to ${protocol} from the browser tab.`);
        }
      }
    };

    void this.installClipboardPolyfill(contents);

    contents.on('will-navigate', (event, url) => handleNavigation(event, url, true));
    contents.on('will-frame-navigate', (event) => {
      // `will-navigate` already covers the main frame; without this guard every
      // main-frame navigation would be handled twice, and an irc:// link would be
      // followed twice.
      if (!event.isMainFrame) handleNavigation(event, event.url, false);
    });

    /*
     * Requests to open a new window are refused outright.
     *
     * They must never be loaded into the current view instead: pop-under ads call
     * `window.open` with the page's own URL on the first interaction, so "helpfully"
     * following it navigates the page the user is reading — which looks exactly like a
     * spontaneous reload when they click into a search box. There is no reliable way to
     * tell such a call apart from a genuine `target="_blank"` link, so neither is
     * followed and the user is told the address instead.
     */
    contents.setWindowOpenHandler(({ url }) => {
      if (isIrcUrl(url)) {
        this.events.onIrcLink(url);
        return { action: 'deny' };
      }
      this.noteBlockedPopup(url);
      return { action: 'deny' };
    });

    const push = () => this.events.onState(this.state());
    contents.on('did-start-loading', push);
    contents.on('did-stop-loading', push);
    contents.on('page-title-updated', push);
    contents.on('did-navigate', () => {
      this.lastError = undefined;
      this.blank = false;
      push();
    });
    contents.on('did-navigate-in-page', push);
    contents.on('did-fail-load', (_event, code, description, failedUrl, isMainFrame) => {
      // -3 is an aborted load, which happens routinely when a navigation is replaced.
      if (!isMainFrame || code === -3) return;
      this.lastError = `Could not load ${failedUrl}: ${description}`;
      push();
    });

    this.window.contentView.addChildView(view);
    view.setVisible(false);
    this.view = view;
    return view;
  }

  /**
   * Install the clipboard stand-in so it is in place before a page's own scripts run.
   *
   * Timing is what makes this awkward: a site that checks for the API as it loads, rather
   * than when its button is pressed, has already decided before any ordinary injection
   * point. The devtools protocol can run a script ahead of the page's own, so that is the
   * first choice, with injection on `dom-ready` as the fallback — later, but still ahead
   * of the click for every site that checks at that point.
   */
  private async installClipboardPolyfill(contents: WebContents): Promise<void> {
    try {
      contents.debugger.attach('1.3');
      await contents.debugger.sendCommand('Page.enable');
      await contents.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument', {
        source: CLIPBOARD_POLYFILL,
      });
    } catch {
      contents.on('dom-ready', () => {
        void contents.executeJavaScript(CLIPBOARD_POLYFILL).catch(() => {
          // A page that refuses the injection simply keeps no clipboard API.
        });
      });
    }
  }

  /**
   * Report a blocked pop-up, but not on every click: a pop-under script fires on each
   * interaction, and a message that reappears constantly is worse than none.
   */
  private noteBlockedPopup(url: string): void {
    const now = Date.now();
    if (now - this.lastPopupNoticeAt < 5000) return;
    this.lastPopupNoticeAt = now;

    let where = url;
    try {
      where = new URL(url).host || url;
    } catch {
      // Keep the raw string if it will not parse.
    }
    this.events.onNotice(
      `Blocked a pop-up from ${where}. Paste the address above if you meant to open it.`,
    );
  }

  state(): BrowserState {
    const contents = this.view?.webContents;
    const url = this.blank ? '' : (contents?.getURL() ?? '');
    return {
      url: url === 'about:blank' ? '' : url,
      title: this.blank ? '' : (contents?.getTitle() ?? ''),
      loading: contents?.isLoading() ?? false,
      canGoBack: contents?.navigationHistory.canGoBack() ?? false,
      canGoForward: contents?.navigationHistory.canGoForward() ?? false,
      ...(this.lastError ? { error: this.lastError } : {}),
    };
  }

  navigate(input: string): void {
    const url = normaliseUrl(input);
    if (isIrcUrl(url)) {
      // Typing an irc:// address does the same thing as clicking one on a page.
      this.events.onIrcLink(url);
      return;
    }
    const view = this.ensureView();
    this.lastError = undefined;
    this.blank = false;
    void view.webContents.loadURL(url);
    this.applyLayout();
  }

  back(): void {
    const history = this.view?.webContents.navigationHistory;
    if (history?.canGoBack()) history.goBack();
  }

  forward(): void {
    const history = this.view?.webContents.navigationHistory;
    if (history?.canGoForward()) history.goForward();
  }

  reload(): void {
    this.view?.webContents.reload();
  }

  stop(): void {
    this.view?.webContents.stop();
  }

  setBounds(rect: Rect): void {
    this.bounds = {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.max(0, Math.round(rect.width)),
      height: Math.max(0, Math.round(rect.height)),
    };
    this.applyLayout();
  }

  /**
   * The view floats above the page rather than inside it, so it has to be hidden
   * whenever the app shows something else — another tab, or a dialog over the top.
   */
  setVisible(visible: boolean): void {
    this.visible = visible;
    this.applyLayout();
  }

  /**
   * Run a snippet in the loaded page and hand back its result.
   *
   * Only for the built-in smoke check, which has to drive a real page to prove the tab
   * still works; nothing in the running app calls this. The gesture flag makes the call
   * count as a user action, which a clipboard write is required to have.
   */
  async probe(code: string): Promise<unknown> {
    if (!this.view) return undefined;
    // Chromium refuses a clipboard write from a document that is not focused, so the
    // probe has to take focus the way a real click on the page would.
    this.window.focus();
    this.view.webContents.focus();
    return this.view.webContents.executeJavaScript(code, true);
  }

  /** Whether the page is actually on screen right now. */
  get showing(): boolean {
    return this.shown;
  }

  private applyLayout(): void {
    if (!this.view) return;
    const shouldShow = this.visible && !this.blank && this.bounds.width > 0;
    this.view.setBounds(this.bounds);
    this.view.setVisible(shouldShow);
    this.shown = shouldShow;
  }

  destroy(): void {
    if (!this.view) return;
    this.window.contentView.removeChildView(this.view);
    this.view.webContents.close();
    this.view = undefined;
  }
}
