import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { AppSnapshot, SessionSnapshot, ViewSnapshot } from '../app/snapshot.js';
import type { BrowserState } from '../electron/browserView.js';
import type { TabId } from '../electron/ipc.js';
import { BROWSE_TAB } from '../electron/ipc.js';
import type { DraftConfig } from '../app/configFile.js';
import { api, bridgeAvailable, BRIDGE_MISSING, unwrap } from './api.js';
import { BrowserTab } from './components/BrowserTab.js';
import { SettingsDialog } from './components/SettingsDialog.js';
import { TransfersTab } from './components/TransfersTab.js';
import { tabLabels } from './tabLabel.js';
import { ALL_VIEW, type LogView } from './logView.js';
import { syncSeen, unreadFor, unreadWhispers } from './unread.js';

type Notice = { kind: 'error' | 'info'; text: string } | undefined;

const CONNECTING_STATES = new Set(['connecting', 'registering']);

const EMPTY_BROWSER: BrowserState = {
  url: '',
  title: '',
  loading: false,
  canGoBack: false,
  canGoForward: false,
};

function StatusPill({ connection }: { connection: string }): React.ReactElement {
  const label =
    connection === 'registered'
      ? 'connected'
      : connection === 'registering'
        ? 'registering'
        : connection;
  return (
    <span className={`pill ${connection}`}>
      <span className="dot" />
      {label}
    </span>
  );
}

export function App(): React.ReactElement {
  const [snapshot, setSnapshot] = useState<AppSnapshot>();
  const [browserState, setBrowserState] = useState<BrowserState>(EMPTY_BROWSER);
  const [tab, setTab] = useState<TabId>(BROWSE_TAB);
  const [config, setConfig] = useState<DraftConfig>();
  const [configPath, setConfigPath] = useState('');
  const [showSettings, setShowSettings] = useState(false);
  const [notice, setNotice] = useState<Notice>();
  /** The conversation open on each connection, kept here so a tab switch does not lose it. */
  const [viewBySession, setViewBySession] = useState<Record<string, LogView>>({});
  /** What each view stood at when it was last read, across every connection. */
  const seen = useRef(new Map<string, number>());

  const sessions: SessionSnapshot[] = snapshot?.sessions ?? [];
  const active = sessions.find((session) => session.id === tab);
  const labels = tabLabels(sessions);

  const viewOf = (sessionId: string): LogView => viewBySession[sessionId] ?? ALL_VIEW;

  /*
   * Keep the seen marks up to date for every connection, not just the one on screen.
   *
   * No dependency list: snapshots arrive on a timer, so this already runs at a bounded
   * rate, and it has to see each one to notice what arrived.
   */
  useEffect(() => {
    for (const session of sessions) {
      syncSeen(seen.current, session, session.id === tab && !showSettings, viewOf(session.id));
    }
  });

  useEffect(() => api.onState(setSnapshot), []);
  useEffect(() => api.onBrowserState(setBrowserState), []);

  useEffect(
    () =>
      api.onNotice((event) => {
        setNotice({ kind: event.kind, text: event.text });
        if (event.activateTab) setTab(event.activateTab);
      }),
    [],
  );

  useEffect(() => {
    if (!bridgeAvailable) {
      setNotice({ kind: 'error', text: BRIDGE_MISSING });
      return;
    }
    void (async () => {
      try {
        const payload = await unwrap(api.getConfig());
        setConfig(payload.config as DraftConfig);
        setConfigPath(payload.path);
      } catch (err) {
        setNotice({ kind: 'error', text: (err as Error).message });
      }
    })();
  }, []);

  /*
   * Show or hide the page.
   *
   * This lives here rather than in BrowserTab because the page is a native view floating
   * above the window: leaving the tab unmounts BrowserTab, so an effect inside it never
   * gets to run with "inactive" and the view would stay on top of the transfer list.
   * App is mounted for the whole session, so it can always have the last word.
   */
  useEffect(() => {
    void api.browserSetVisible(tab === BROWSE_TAB && !showSettings);
  }, [tab, showSettings]);

  // A tab can disappear from under us when its connection is closed.
  useEffect(() => {
    if (tab === BROWSE_TAB || active) return;
    setTab(sessions[0]?.id ?? BROWSE_TAB);
  }, [tab, active, sessions]);

  const run = useCallback(async (action: () => Promise<unknown>, success?: string) => {
    // Clear any stale message before acting, not after: some actions set their own notice
    // (the queue summary, for one), and clearing afterwards would wipe it immediately.
    setNotice(undefined);
    try {
      await action();
      if (success) setNotice({ kind: 'info', text: success });
    } catch (err) {
      setNotice({ kind: 'error', text: (err as Error).message });
    }
  }, []);

  const showNotice = useCallback(
    (kind: 'info' | 'error', text: string) => setNotice({ kind, text }),
    [],
  );

  const configuredHost = config?.network.host
    ? `${config.network.host}:${config.network.port}`
    : '';

  const connect = () =>
    void run(async () => {
      const { sessionId } = await unwrap(api.connect());
      setTab(sessionId);
    });

  const canDisconnect = active?.connection === 'registered';
  const connecting = active ? CONNECTING_STATES.has(active.connection) : false;

  return (
    <div className="app">
      <div className="topbar">
        <span className="brand">fastxdcc</span>
        {active ? (
          <>
            <StatusPill connection={active.connection} />
            <span className="where">{active.network}</span>
            {active.nick ? <span className="where">as {active.nick}</span> : null}
            {active.channels.length ? (
              <span className="where">
                {active.channels.map((channel) => channel.name).join(' ')}
              </span>
            ) : null}
          </>
        ) : (
          <span className="where">
            {sessions.length === 0
              ? 'no connections'
              : `${sessions.length} connection${sessions.length === 1 ? '' : 's'}`}
          </span>
        )}
        <span className="spacer" />
        {canDisconnect ? (
          <button
            className="danger"
            onClick={() => void run(() => unwrap(api.disconnect({ sessionId: active!.id })))}
          >
            Disconnect
          </button>
        ) : (
          <button
            className="primary"
            disabled={!configuredHost || connecting}
            title={
              configuredHost
                ? `Connect to ${configuredHost}`
                : 'Set a server in Settings, or follow an irc:// link'
            }
            onClick={connect}
          >
            Connect
          </button>
        )}
        <button onClick={() => void run(() => unwrap(api.openDir()))} title={snapshot?.downloadDir}>
          Open folder
        </button>
        <button onClick={() => setShowSettings(true)}>Settings</button>
      </div>

      <div className="tabbar">
        {sessions.map((session) => {
          const whispers = unreadWhispers(seen.current, session);
          return (
          <button
            key={session.id}
            className={`tab ${tab === session.id ? 'active' : ''}`}
            onClick={() => setTab(session.id)}
            title={
              whispers > 0
                ? `${session.network} — ${whispers} unread private message(s)`
                : session.network
            }
          >
            <span className={`tabdot ${session.connection}`} />
            {labels.get(session.id) ?? session.label}
            {/* Two different things, so two different badges: transfers in flight, and
                people waiting for a reply. */}
            {session.activeTransfers > 0 ? (
              <span className="count">{session.activeTransfers}</span>
            ) : null}
            {whispers > 0 ? (
              <span className="count whispers">{whispers > 99 ? '99+' : whispers}</span>
            ) : null}
            <span
              className="close"
              role="button"
              aria-label={`Close ${session.label}`}
              onClick={(event) => {
                // Without this the click would also select the tab being closed.
                event.stopPropagation();
                void run(() => unwrap(api.closeSession({ sessionId: session.id })));
              }}
            >
              ×
            </span>
          </button>
          );
        })}
        <button
          className={`tab ${tab === BROWSE_TAB ? 'active' : ''}`}
          onClick={() => setTab(BROWSE_TAB)}
        >
          Browse
        </button>
      </div>

      {notice ? (
        <div className={`notice ${notice.kind}`}>
          <span>{notice.text}</span>
          <span className="spacer" />
          <button className="link" onClick={() => setNotice(undefined)}>
            Dismiss
          </button>
        </div>
      ) : null}

      {tab === BROWSE_TAB ? (
        <BrowserTab state={browserState} onError={(text) => showNotice('error', text)} />
      ) : active ? (
        <TransfersTab
          // Keyed by session, so switching tabs cannot carry one server's half-typed
          // input over to another.
          key={active.id}
          session={active}
          view={viewOf(active.id)}
          onSelectView={(view) =>
            setViewBySession((current) => ({ ...current, [active.id]: view }))
          }
          unreadOf={(one: ViewSnapshot) => unreadFor(seen.current, active.id, one)}
          onNotice={showNotice}
          onBrowse={() => setTab(BROWSE_TAB)}
        />
      ) : (
        <div className="empty">
          <p>That connection is no longer open.</p>
        </div>
      )}

      {showSettings && config ? (
        <SettingsDialog
          config={config}
          configPath={configPath}
          onSaved={setConfig}
          onClose={() => setShowSettings(false)}
        />
      ) : null}
    </div>
  );
}
