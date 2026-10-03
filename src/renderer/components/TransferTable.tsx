import React from 'react';
import type { TransferSnapshot } from '../../app/snapshot.js';
import { formatBytes, formatEta, formatSpeed } from '../../tui/format.js';

interface Props {
  items: TransferSnapshot[];
  connected: boolean;
  onCancel: (item: TransferSnapshot, discard: boolean) => void;
  onReveal: (item: TransferSnapshot) => void;
  onBrowse: () => void;
}

const FINISHED = new Set(['completed', 'failed', 'cancelled']);

function Progress({ item }: { item: TransferSnapshot }): React.ReactElement {
  if (item.state === 'completed') {
    return (
      <>
        <div className="bar done">
          <span style={{ width: '100%' }} />
        </div>
        <span className="pct">100%</span>
      </>
    );
  }
  if (!item.size || item.state !== 'transferring') {
    return <span className="pct">—</span>;
  }

  const received = item.bytesReceived ?? 0;
  const fraction = Math.max(0, Math.min(1, received / item.size));
  return (
    <>
      <div className="bar">
        <span style={{ width: `${(fraction * 100).toFixed(1)}%` }} />
      </div>
      <span className="pct">{Math.floor(fraction * 100)}%</span>
    </>
  );
}

function stateDetail(item: TransferSnapshot): string | undefined {
  if (item.error) return item.error;
  if (item.note) return item.note;
  if (item.state === 'botQueued' && item.position !== undefined) {
    return item.total ? `position ${item.position} of ${item.total}` : `position ${item.position}`;
  }
  return undefined;
}

export function TransferTable({
  items,
  connected,
  onCancel,
  onReveal,
  onBrowse,
}: Props): React.ReactElement {
  if (items.length === 0) {
    // Without a connection there is nothing to request yet, so point at the two ways in
    // rather than at a paste box that cannot do anything.
    return connected ? (
      <div className="empty">
        <p>No transfers yet.</p>
        <p>
          Paste a request like <code>/msg SomeBot xdcc send #1</code> above, or just{' '}
          <code>SomeBot #1,3-5</code>.
        </p>
      </div>
    ) : (
      <div className="empty">
        <p>Not connected.</p>
        <p>
          Press <strong>Connect</strong> to use the server from Settings, or open the{' '}
          <button className="link inline" onClick={onBrowse}>
            Browse
          </button>{' '}
          tab and click an <code>irc://</code> link on a page.
        </p>
      </div>
    );
  }

  return (
    <table className="transfers-table">
      <thead>
        <tr>
          <th style={{ width: '32%' }}>File</th>
          <th style={{ width: 140 }}>Progress</th>
          <th style={{ width: 150 }}>Size</th>
          <th style={{ width: 100 }}>Speed</th>
          <th style={{ width: 74 }}>ETA</th>
          <th style={{ width: 170 }}>State</th>
          <th />
        </tr>
      </thead>
      <tbody>
        {items.map((item) => {
          const detail = stateDetail(item);
          const finished = FINISHED.has(item.state);
          return (
            <tr key={item.id}>
              <td>
                <div className="name">
                  <span className="file" title={item.filename ?? ''}>
                    {item.filename ?? <span style={{ opacity: 0.6 }}>waiting for offer…</span>}
                  </span>
                  <span className="sub">
                    {item.bot} #{item.pack}
                    {item.passive ? ' · reverse' : ''}
                    {item.attempts > 1 ? ` · try ${item.attempts}` : ''}
                  </span>
                </div>
              </td>
              <td>
                <Progress item={item} />
              </td>
              <td className="num">
                {item.size
                  ? `${formatBytes(item.bytesReceived ?? 0)} / ${formatBytes(item.size)}`
                  : '—'}
              </td>
              <td className="num speed">
                {item.state === 'transferring' ? formatSpeed(item.speed ?? 0) : '—'}
              </td>
              <td className="num">
                {item.state === 'transferring' ? formatEta(item.eta) : '—'}
              </td>
              <td>
                <span className={`state ${item.state}`}>
                  {item.state === 'botQueued' ? 'bot queue' : item.state}
                  {detail ? (
                    <span className="why" title={detail}>
                      {detail}
                    </span>
                  ) : null}
                </span>
              </td>
              <td className="actions">
                {item.state === 'completed' && item.finalPath ? (
                  <button className="link" onClick={() => onReveal(item)}>
                    Show
                  </button>
                ) : null}
                {!finished ? (
                  <>
                    <button className="link" onClick={() => onCancel(item, false)}>
                      Cancel
                    </button>
                    <button
                      className="link"
                      title="Cancel and delete the partial file"
                      onClick={() => onCancel(item, true)}
                    >
                      Discard
                    </button>
                  </>
                ) : null}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
