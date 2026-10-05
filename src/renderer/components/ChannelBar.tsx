import React, { useState } from 'react';
import type { ViewSnapshot } from '../../app/snapshot.js';
import { ALL_VIEW, SERVER_VIEW, type LogView } from '../logView.js';

interface Props {
  channels: ViewSnapshot[];
  conversations: ViewSnapshot[];
  serverActivity: number;
  view: LogView;
  /** How much has arrived in a view since it was last read. */
  unreadOf: (view: ViewSnapshot) => number;
  /** True once registered, which is when joining and talking become possible. */
  connected: boolean;
  onSelect: (view: LogView) => void;
  onJoin: (channel: string, key?: string) => void;
  onPart: (channel: string) => void;
  onMessage: (nick: string) => void;
  onCloseConversation: (nick: string) => void;
}

/**
 * Switches which conversation the chat pane shows, and opens or closes them.
 *
 * One server can hold several channels and several private messages at once, and a single
 * merged log makes any of them unreadable, so each gets its own view here. `All` is kept
 * as the first choice because it is what the pane showed before views existed, and it is
 * still the right thing for watching a transfer and the chat that led to it at once.
 */
export function ChannelBar({
  channels,
  conversations,
  serverActivity,
  view,
  unreadOf,
  connected,
  onSelect,
  onJoin,
  onPart,
  onMessage,
  onCloseConversation,
}: Props): React.ReactElement {
  const [draft, setDraft] = useState('');

  const submitJoin = () => {
    const text = draft.trim();
    if (text === '') return;
    // `#chan key` is the same spelling the settings pane and the CLI accept.
    const [name, key] = text.split(/\s+/, 2);
    onJoin(name!, key);
    setDraft('');
  };

  const submitMessage = () => {
    const nick = draft.trim();
    if (nick === '') return;
    onMessage(nick);
    setDraft('');
  };

  const tab = (id: LogView, label: string, unread: number, title: string) => (
    <button
      className={`chan ${view === id ? 'active' : ''}`}
      onClick={() => onSelect(id)}
      title={title}
    >
      {label}
      {unread > 0 ? <span className="unread">{unread > 99 ? '99+' : unread}</span> : null}
    </button>
  );

  /** A tab with its own close button, which does different things for the two kinds. */
  const closeable = (
    one: ViewSnapshot,
    kind: 'channel' | 'pm',
    title: string,
    closeLabel: string,
    onClose: (name: string) => void,
  ) => (
    <span
      key={`${kind}:${one.name}`}
      className={`chan-wrap ${kind} ${view === one.name ? 'active' : ''}`}
    >
      {tab(one.name, one.name, unreadOf(one), title)}
      <span
        className="close"
        role="button"
        aria-label={`${closeLabel} ${one.name}`}
        title={`${closeLabel} ${one.name}`}
        onClick={(event) => {
          // Without this the click would also select the view being closed.
          event.stopPropagation();
          onClose(one.name);
        }}
      >
        ×
      </span>
    </span>
  );

  return (
    <div className="chanbar">
      {tab(ALL_VIEW, 'All', 0, 'Every line from this server')}
      {tab(
        SERVER_VIEW,
        'Server',
        unreadOf({ name: SERVER_VIEW, activity: serverActivity }),
        'Status, transfers, and bot notices',
      )}

      {channels.map((channel) =>
        closeable(
          channel,
          'channel',
          // The topic goes in the tooltip too, so it can be read without switching view.
          channel.topic ? `${channel.name} — ${channel.topic}` : `Chat in ${channel.name}`,
          'Leave',
          onPart,
        ),
      )}

      {conversations.length > 0 ? <span className="sep" /> : null}

      {conversations.map((nick) =>
        closeable(
          nick,
          'pm',
          `Private messages with ${nick.name}`,
          'Close the conversation with',
          onCloseConversation,
        ),
      )}

      <span className="spacer" />

      <input
        className="join"
        placeholder="#channel or nick"
        aria-label="Channel to join, or nick to message"
        value={draft}
        disabled={!connected}
        onChange={(event) => setDraft(event.target.value)}
        // Enter joins rather than messages, because a name typed without its `#` is the
        // common slip and silently failing to join is the worse of the two outcomes.
        onKeyDown={(event) => event.key === 'Enter' && submitJoin()}
      />
      <button onClick={submitJoin} disabled={!connected || draft.trim() === ''} title="Join a channel">
        Join
      </button>
      <button
        onClick={submitMessage}
        disabled={!connected || draft.trim() === ''}
        title="Open a private message tab with this person"
      >
        Message
      </button>
    </div>
  );
}
