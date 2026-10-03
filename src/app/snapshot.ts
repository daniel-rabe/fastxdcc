/**
 * Serialisable projections of the application state.
 *
 * Sessions hold live `Transfer` objects with sockets and file handles attached, which
 * cannot be structured-cloned across an IPC boundary. Everything the UI needs is copied
 * into plain objects here, so the renderer never holds a reference to anything live.
 */

import type { ItemState, QueueItem } from '../dcc/manager.js';
import type { LogLevel, LogLine } from './store.js';
import type { Session } from './session.js';

export interface TransferSnapshot {
  id: string;
  bot: string;
  pack: number;
  state: ItemState;
  attempts: number;
  filename?: string;
  size?: number;
  bytesReceived?: number;
  speed?: number;
  eta?: number | null;
  position?: number;
  total?: number;
  error?: string;
  note?: string;
  finalPath?: string;
  passive?: boolean;
}

export interface LogSnapshot {
  at: number;
  level: LogLevel;
  source: string;
  text: string;
}

/** One conversation the UI shows as its own view: a joined channel, or a private message. */
export interface ViewSnapshot {
  /** Channel name as joined, or a nick in the spelling it was first seen in. */
  name: string;
  /** The channel's topic, when it has one. Conversations never have one. */
  topic?: string;
  /**
   * Lines ever logged for this channel. The UI subtracts what it had already shown to get
   * an unread count, which a plain "number of lines on screen" could not give it.
   */
  activity: number;
}

/** One connected (or connecting) server, which the UI shows as its own tab. */
export interface SessionSnapshot {
  /** `host:port`, stable for the life of the connection. */
  id: string;
  /** Short name for the tab. */
  label: string;
  connection: string;
  network: string;
  nick: string;
  /** Joined channels, in the order they were joined. */
  channels: ViewSnapshot[];
  /** Nicks with a private message view open, in the order they were opened. */
  conversations: ViewSnapshot[];
  /** Activity on everything with no view of its own: the client, DCC, and loose notices. */
  serverActivity: number;
  items: TransferSnapshot[];
  log: LogSnapshot[];
  /** Transfers currently moving bytes, for the tab badge. */
  activeTransfers: number;
}

export interface AppSnapshot {
  /** Bumped on every state change; lets a consumer skip redundant work. */
  revision: number;
  downloadDir: string;
  sessions: SessionSnapshot[];
}

export function snapshotItem(item: QueueItem): TransferSnapshot {
  // Written out field by field rather than spread-and-delete, so adding a live object to
  // QueueItem later cannot silently leak it across the IPC boundary.
  const out: TransferSnapshot = {
    id: item.id,
    bot: item.bot,
    pack: item.pack,
    state: item.state,
    attempts: item.attempts,
  };
  if (item.filename !== undefined) out.filename = item.filename;
  if (item.size !== undefined) out.size = item.size;
  if (item.bytesReceived !== undefined) out.bytesReceived = item.bytesReceived;
  if (item.speed !== undefined) out.speed = item.speed;
  if (item.eta !== undefined) out.eta = item.eta;
  if (item.position !== undefined) out.position = item.position;
  if (item.total !== undefined) out.total = item.total;
  if (item.error !== undefined) out.error = item.error;
  if (item.note !== undefined) out.note = item.note;
  if (item.finalPath !== undefined) out.finalPath = item.finalPath;
  if (item.passive !== undefined) out.passive = item.passive;
  return out;
}

function snapshotLog(line: LogLine): LogSnapshot {
  return { at: line.at, level: line.level, source: line.source, text: line.text };
}

export function snapshotSession(session: Session, id: string, logLines = 500): SessionSnapshot {
  const { store } = session;
  return {
    id,
    label: session.client.host,
    connection: store.state.connection,
    network: store.state.network,
    nick: store.state.nick,
    channels: store.state.channels.map((name) => {
      const view: ViewSnapshot = { name, activity: store.activityFor(name) };
      const topic = store.state.topics[name];
      if (topic) view.topic = topic;
      return view;
    }),
    conversations: store.state.conversations.map((name) => ({
      name,
      activity: store.activityFor(name),
    })),
    serverActivity: store.serverActivity(),
    items: session.items.map(snapshotItem),
    log: store.tail(logLines).map(snapshotLog),
    activeTransfers: session.items.filter((item) => item.state === 'transferring').length,
  };
}

/** The state with no server connected. */
export function emptySnapshot(downloadDir: string): AppSnapshot {
  return { revision: 0, downloadDir, sessions: [] };
}
