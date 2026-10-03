import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { BrowserState } from '../../electron/browserView.js';
import { api, unwrap } from '../api.js';

interface Props {
  state: BrowserState;
  onError: (message: string) => void;
}

/**
 * Chrome for the embedded browser.
 *
 * The page itself is not rendered by React: it lives in a native view that the main
 * process floats over this component. The empty box below the address bar is the hole it
 * is positioned into, so its measurements have to be reported whenever they change.
 */
export function BrowserTab({ state, onError }: Props): React.ReactElement {
  const [address, setAddress] = useState('');
  const [editing, setEditing] = useState(false);
  const holeRef = useRef<HTMLDivElement>(null);
  const lastRect = useRef('');

  // Follow the real URL unless the user is part-way through typing a new one.
  useEffect(() => {
    if (!editing) setAddress(state.url);
  }, [state.url, editing]);

  const report = useCallback(() => {
    const element = holeRef.current;
    if (!element) return;
    const box = element.getBoundingClientRect();
    const rect = {
      x: Math.round(box.left),
      y: Math.round(box.top),
      width: Math.round(box.width),
      height: Math.round(box.height),
    };
    // Position changes do not trigger a ResizeObserver, so this runs on every render;
    // sending only on an actual change keeps it off the IPC channel the rest of the time.
    const key = `${rect.x},${rect.y},${rect.width},${rect.height}`;
    if (key === lastRect.current) return;
    lastRect.current = key;
    void api.browserSetBounds(rect);
  }, []);

  useEffect(report);

  useEffect(() => {
    const element = holeRef.current;
    if (!element) return;
    const observer = new ResizeObserver(report);
    observer.observe(element);
    window.addEventListener('resize', report);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', report);
    };
  }, [report]);

  const go = () => {
    setEditing(false);
    void unwrap(api.browserNavigate(address)).catch((err: Error) => onError(err.message));
  };

  return (
    <div className="browser">
      <div className="browser-bar">
        <button
          className="nav"
          disabled={!state.canGoBack}
          onClick={() => void api.browserBack()}
          title="Back"
        >
          ←
        </button>
        <button
          className="nav"
          disabled={!state.canGoForward}
          onClick={() => void api.browserForward()}
          title="Forward"
        >
          →
        </button>
        <button
          className="nav"
          onClick={() => void (state.loading ? api.browserStop() : api.browserReload())}
          title={state.loading ? 'Stop' : 'Reload'}
        >
          {state.loading ? '×' : '⟳'}
        </button>
        <input
          className="address"
          value={address}
          spellCheck={false}
          placeholder="Search page or address — then click an irc:// link on the page"
          onChange={(e) => {
            setEditing(true);
            setAddress(e.target.value);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') go();
            if (e.key === 'Escape') {
              setEditing(false);
              setAddress(state.url);
            }
          }}
        />
        <button className="primary" onClick={go}>
          Go
        </button>
      </div>

      {state.error ? <div className="browser-error">{state.error}</div> : null}

      <div className="browser-hole" ref={holeRef}>
        {state.url === '' ? (
          <div className="empty">
            <p>Open a site that lists XDCC packs.</p>
            <p>
              Clicking an <code>irc://</code> link on the page connects to that server and
              joins the channel — for example{' '}
              <code>irc://irc.abandoned-irc.net/zombie-warez</code>.
            </p>
            <p className="faint">
              Downloads from this tab are blocked; files arrive over XDCC in the Transfers
              tab.
            </p>
          </div>
        ) : null}
      </div>
    </div>
  );
}
