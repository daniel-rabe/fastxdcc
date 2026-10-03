import React, { useEffect, useRef } from 'react';
import type { LogSnapshot } from '../../app/snapshot.js';
import { formatClock } from '../../tui/format.js';
import { ALL_VIEW, SERVER_VIEW, isFixedView, type LogView } from '../logView.js';

interface Props {
  lines: LogSnapshot[];
  /** Which conversation these lines were filtered to, for the empty state. */
  view?: LogView;
}

function emptyHint(view: LogView): string {
  if (view === SERVER_VIEW) return 'No server messages yet.';
  if (view === ALL_VIEW) return 'Nothing logged yet.';
  return `Nothing said in ${view} yet. Type below to send a message.`;
}

export function LogPane({ lines, view = ALL_VIEW }: Props): React.ReactElement {
  const ref = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);

  // Follow the tail, but stop fighting the user the moment they scroll up to read.
  const onScroll = () => {
    const el = ref.current;
    if (!el) return;
    pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
  };

  // Switching conversations starts at the newest line, however far up the previous one was
  // scrolled: the scroll offset belongs to the view being left, not the one arriving.
  useEffect(() => {
    pinned.current = true;
  }, [view]);

  useEffect(() => {
    const el = ref.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [lines.length, view]);

  return (
    <div className="logpane" ref={ref} onScroll={onScroll}>
      {lines.length === 0 ? (
        <div className="logline info">
          <span className="msg faint">{emptyHint(view)}</span>
        </div>
      ) : (
        lines.map((line, index) => (
          <div className={`logline ${line.level}`} key={`${line.at}-${index}`}>
            <span className="at">{formatClock(line.at)}</span>
            {/* In a single channel's view the source is the same on every line, so it is
                dropped to give the message itself the width. */}
            {isFixedView(view) ? (
              <span className="src" title={line.source}>
                {line.source}
              </span>
            ) : null}
            <span className="msg">{line.text}</span>
          </div>
        ))
      )}
    </div>
  );
}
