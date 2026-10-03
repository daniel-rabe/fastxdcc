import { Box, Text, useApp, useInput, useStdout } from 'ink';
import React, { useCallback, useRef, useState } from 'react';
import type { Session } from '../app/session.js';
import type { ItemState, QueueItem } from '../dcc/manager.js';
import type { LogLevel, LogLine } from '../app/store.js';
import {
  ellipsize,
  formatBytes,
  formatClock,
  formatEta,
  formatPercent,
  formatSpeed,
  progressBar,
} from './format.js';
import { useThrottledStore } from './useThrottledStore.js';

const STATE_COLOR: Record<ItemState, string> = {
  waiting: 'gray',
  requested: 'yellow',
  botQueued: 'yellow',
  transferring: 'cyan',
  completed: 'green',
  failed: 'red',
  cancelled: 'gray',
};

const LEVEL_COLOR: Record<LogLevel, string | undefined> = {
  info: 'gray',
  error: 'red',
  irc: undefined,
  bot: 'magenta',
  self: 'cyan',
};

function StatusBar({ session, width }: { session: Session; width: number }): React.ReactElement {
  const { connection, network, nick, channels } = session.store.state;
  const active = session.items.filter((i) => i.state === 'transferring').length;
  const total = session.items.filter((i) => i.state !== 'completed').length;

  const color =
    connection === 'registered' ? 'green' : connection === 'disconnected' ? 'red' : 'yellow';

  return (
    <Box width={width} justifyContent="space-between">
      <Text>
        <Text bold color="blueBright">
          fastxdcc{' '}
        </Text>
        <Text color={color}>{connection}</Text>
        <Text color="gray"> {network}</Text>
        {nick ? <Text> as {nick}</Text> : null}
        {channels.length > 0 ? <Text color="gray"> {channels.join(' ')}</Text> : null}
      </Text>
      <Text color="gray">
        {active} active / {total} queued
      </Text>
    </Box>
  );
}

function TransferRow({ item, width }: { item: QueueItem; width: number }): React.ReactElement {
  const label = `${item.bot} #${item.pack}`;
  const name = item.filename ?? '(waiting for offer)';

  if (item.state !== 'transferring' || !item.size) {
    const detail = item.error ?? item.note ?? name;
    return (
      <Text>
        <Text color="gray">{item.id.padEnd(4)}</Text>
        <Text color={STATE_COLOR[item.state]}>{item.state.padEnd(13)}</Text>
        <Text>{ellipsize(`${label}  ${detail}`, Math.max(10, width - 18))}</Text>
      </Text>
    );
  }

  const received = item.bytesReceived ?? 0;
  const barWidth = Math.max(8, Math.min(24, width - 62));
  return (
    <Text>
      <Text color="gray">{item.id.padEnd(4)}</Text>
      <Text color="cyan">{progressBar(received / item.size, barWidth)}</Text>
      <Text> {formatPercent(received, item.size)}</Text>
      <Text color="gray">
        {' '}
        {formatBytes(received)}/{formatBytes(item.size)}
      </Text>
      <Text color="greenBright"> {formatSpeed(item.speed ?? 0).padStart(11)}</Text>
      <Text color="gray"> ETA {formatEta(item.eta)}</Text>
      <Text> {ellipsize(name, Math.max(8, width - barWidth - 58))}</Text>
    </Text>
  );
}

const MAX_TRANSFER_ROWS = 12;

/**
 * Unfinished work first, then the most recent finished rows, so the pane stays useful in a
 * long session without growing without bound. Shared with the height calculation so the
 * log pane is sized against the rows that are actually drawn.
 */
function visibleItems(items: QueueItem[]): QueueItem[] {
  const isDone = (i: QueueItem) => i.state === 'completed' || i.state === 'cancelled';
  const live = items.filter((i) => !isDone(i));
  const done = items.filter(isDone).slice(-3);
  return [...live, ...done].slice(0, MAX_TRANSFER_ROWS);
}

function TransferPane({
  shown,
  width,
}: {
  shown: QueueItem[];
  width: number;
}): React.ReactElement {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="gray" width={width} flexShrink={0}>
      {shown.length === 0 ? (
        <Text color="gray"> nothing queued - try /get &lt;bot&gt; #1 </Text>
      ) : (
        shown.map((item) => <TransferRow key={item.id} item={item} width={width - 2} />)
      )}
    </Box>
  );
}

function LogPane({
  lines,
  width,
  height,
}: {
  lines: LogLine[];
  width: number;
  height: number;
}): React.ReactElement {
  return (
    <Box flexDirection="column" width={width} height={height} overflow="hidden">
      {lines.map((line, index) => (
        <Text key={`${line.at}-${index}`} wrap="truncate-end">
          <Text color="gray">{formatClock(line.at)} </Text>
          <Text color="blue">{ellipsize(line.source, 12).padEnd(12)} </Text>
          <Text color={LEVEL_COLOR[line.level]}>{line.text}</Text>
        </Text>
      ))}
    </Box>
  );
}

export function App({ session }: { session: Session }): React.ReactElement {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [input, setInput] = useState('');
  const history = useRef<string[]>([]);
  const historyIndex = useRef<number>(-1);

  const hasActive = session.items.some((i) => i.state === 'transferring');
  useThrottledStore(session.store, hasActive);

  const width = Math.max(60, stdout?.columns ?? 100);
  const height = Math.max(12, stdout?.rows ?? 30);

  const submit = useCallback(
    (line: string) => {
      if (line.trim() === '') return;
      history.current.push(line);
      historyIndex.current = -1;
      if (line.trim() === '/quit' || line.trim() === '/exit') {
        session.shutdown();
        exit();
        return;
      }
      session.handleInput(line);
    },
    [session, exit],
  );

  useInput((char, key) => {
    if (key.ctrl && char === 'c') {
      session.shutdown();
      exit();
      return;
    }
    if (key.return) {
      submit(input);
      setInput('');
      return;
    }
    if (key.backspace || key.delete) {
      setInput((value) => value.slice(0, -1));
      return;
    }
    if (key.ctrl && char === 'u') {
      setInput('');
      return;
    }
    if (key.upArrow) {
      const items = history.current;
      if (items.length === 0) return;
      historyIndex.current =
        historyIndex.current === -1
          ? items.length - 1
          : Math.max(0, historyIndex.current - 1);
      setInput(items[historyIndex.current] ?? '');
      return;
    }
    if (key.downArrow) {
      const items = history.current;
      if (historyIndex.current === -1) return;
      const next = historyIndex.current + 1;
      if (next >= items.length) {
        historyIndex.current = -1;
        setInput('');
      } else {
        historyIndex.current = next;
        setInput(items[next] ?? '');
      }
      return;
    }
    // Ignore control sequences; only printable input reaches the buffer.
    if (!key.ctrl && !key.meta && char && !key.tab && !key.escape) {
      setInput((value) => value + char);
    }
  });

  // Reserve rows for the status bar, the bordered transfer pane, and the prompt.
  const shown = visibleItems(session.items);
  const transferRows = Math.max(1, shown.length) + 2; // +2 for the border
  const logHeight = Math.max(3, height - transferRows - 3);

  return (
    <Box flexDirection="column" width={width}>
      <StatusBar session={session} width={width} />
      <TransferPane shown={shown} width={width} />
      <LogPane lines={session.store.tail(logHeight)} width={width} height={logHeight} />
      <Box width={width}>
        <Text color="greenBright">&gt; </Text>
        <Text>{input}</Text>
        <Text color="gray">▌</Text>
      </Box>
    </Box>
  );
}
