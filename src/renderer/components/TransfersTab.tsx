import React, { useMemo, useRef, useState } from 'react';
import type { SessionSnapshot, TransferSnapshot, ViewSnapshot } from '../../app/snapshot.js';
import { api, unwrap } from '../api.js';
import { ALL_VIEW, filterLog, resolveView, viewTarget, type LogView } from '../logView.js';
import { ChannelBar } from './ChannelBar.js';
import { LogPane } from './LogPane.js';
import { TopicBar } from './TopicBar.js';
import { TransferTable } from './TransferTable.js';

interface Props {
  session: SessionSnapshot;
  /** The conversation on screen. Held above this component so it survives a tab switch. */
  view: LogView;
  onSelectView: (view: LogView) => void;
  unreadOf: (view: ViewSnapshot) => number;
  onNotice: (kind: 'info' | 'error', text: string) => void;
  onBrowse: () => void;
}

/**
 * Everything belonging to one server: its request bar, transfer list, log and command
 * line. Each connected server gets its own instance, so nothing here is shared.
 */
export function TransfersTab({
  session,
  view: selected,
  onSelectView: setSelected,
  unreadOf,
  onNotice,
  onBrowse,
}: Props): React.ReactElement {
  const [request, setRequest] = useState('');
  const [botName, setBotName] = useState('');
  const [command, setCommand] = useState('');
  const history = useRef<string[]>([]);
  const historyIndex = useRef(-1);

  const sessionId = session.id;
  const connected = session.connection === 'registered';

  const { channels, conversations } = session;
  const views = useMemo(() => [...channels, ...conversations], [channels, conversations]);

  // A view can vanish under us: a part, a kick, a closed conversation, or a reconnect that
  // has not rejoined yet.
  const view = resolveView(selected, views);
  const target = viewTarget(view);
  // Only a channel has a topic, and only the one being read is worth the line it takes.
  const topicOf = channels.find((channel) => channel.name === view);
  const lines = useMemo(
    () => filterLog(session.log, view, conversations),
    [session.log, view, conversations],
  );

  const run = async (action: () => Promise<unknown>) => {
    try {
      await action();
    } catch (err) {
      onNotice('error', (err as Error).message);
    }
  };

  const addRequest = () => {
    const input = request.trim();
    if (!input) return;
    void run(async () => {
      const { summary } = await unwrap(api.queueAdd({ sessionId, input }));
      setRequest('');
      onNotice('info', summary);
    });
  };

  const submitCommand = () => {
    const line = command.trim();
    if (!line) return;
    history.current.push(line);
    historyIndex.current = -1;
    setCommand('');
    void run(() => unwrap(api.command({ sessionId, line, ...(target ? { target } : {}) })));
  };

  const join = (channel: string, key?: string) =>
    void run(async () => {
      const result = await unwrap(
        api.joinChannel({ sessionId, channel, ...(key ? { key } : {}) }),
      );
      // Follow the user into the channel they asked for; waiting for the server's JOIN
      // would leave them looking at the view they started from.
      setSelected(result.channel.toLowerCase());
    });

  const part = (channel: string) =>
    void run(async () => {
      await unwrap(api.partChannel({ sessionId, channel }));
      if (channel === view) setSelected(ALL_VIEW);
    });

  const message = (nick: string) =>
    void run(async () => {
      const result = await unwrap(api.openConversation({ sessionId, nick }));
      setSelected(result.nick);
    });

  const closeConversation = (nick: string) =>
    void run(async () => {
      await unwrap(api.closeConversation({ sessionId, nick }));
      if (nick === view) setSelected(ALL_VIEW);
    });

  const onCommandKey = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      submitCommand();
      return;
    }
    if (event.key === 'ArrowUp') {
      const items = history.current;
      if (items.length === 0) return;
      event.preventDefault();
      historyIndex.current =
        historyIndex.current === -1 ? items.length - 1 : Math.max(0, historyIndex.current - 1);
      setCommand(items[historyIndex.current] ?? '');
      return;
    }
    if (event.key === 'ArrowDown') {
      if (historyIndex.current === -1) return;
      event.preventDefault();
      const next = historyIndex.current + 1;
      if (next >= history.current.length) {
        historyIndex.current = -1;
        setCommand('');
      } else {
        historyIndex.current = next;
        setCommand(history.current[next] ?? '');
      }
    }
  };

  const cancel = (item: TransferSnapshot, discard: boolean) =>
    void run(() => unwrap(api.queueCancel({ sessionId, id: item.id, discard })));

  const reveal = (item: TransferSnapshot) =>
    void run(() => unwrap(api.revealFile({ path: item.finalPath! })));

  return (
    <>
      <div className="addbar">
        <input
          className="request"
          placeholder="Paste a request:  /msg SomeBot xdcc send #1   ·   or  SomeBot #1,3-5"
          value={request}
          onChange={(e) => setRequest(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && addRequest()}
        />
        <button className="primary" onClick={addRequest} disabled={!connected}>
          Add
        </button>
        <input
          className="bot"
          placeholder="bot name"
          value={botName}
          onChange={(e) => setBotName(e.target.value)}
        />
        <button
          disabled={!connected || !botName.trim()}
          onClick={() => void run(() => unwrap(api.listPacks({ sessionId, bot: botName })))}
          title="Ask the bot to send its pack list"
        >
          List packs
        </button>
        <button
          onClick={() =>
            void run(async () => {
              const { removed } = await unwrap(api.queueClean({ sessionId }));
              onNotice('info', `Removed ${removed} finished row(s)`);
            })
          }
        >
          Clear finished
        </button>
      </div>

      <div className="transfers">
        <TransferTable
          items={session.items}
          connected={connected}
          onCancel={cancel}
          onReveal={reveal}
          onBrowse={onBrowse}
        />
      </div>

      <ChannelBar
        channels={channels}
        conversations={conversations}
        serverActivity={session.serverActivity}
        view={view}
        unreadOf={unreadOf}
        connected={connected}
        onSelect={setSelected}
        onJoin={join}
        onPart={part}
        onMessage={message}
        onCloseConversation={closeConversation}
      />

      {topicOf?.topic ? (
        <TopicBar
          channel={topicOf.name}
          topic={topicOf.topic}
          onOpenPage={(url) =>
            void run(async () => {
              await unwrap(api.browserNavigate(url));
              onBrowse();
            })
          }
          onOpenIrc={(url) => void run(() => unwrap(api.followIrcLink(url)))}
        />
      ) : null}

      <LogPane lines={lines} view={view} />

      <div className="cmdbar">
        <input
          placeholder={
            !connected
              ? 'Not connected to this server'
              : target
                ? `Message ${target}, or a command:  /query nick   ·   /part   ·   /help`
                : 'IRC command:  /join #chan   ·   /msg Bot text   ·   /raw WHOIS nick   ·   /help'
          }
          value={command}
          disabled={!connected}
          onChange={(e) => setCommand(e.target.value)}
          onKeyDown={onCommandKey}
        />
        <button onClick={submitCommand} disabled={!connected || !command.trim()}>
          Send
        </button>
      </div>
    </>
  );
}
