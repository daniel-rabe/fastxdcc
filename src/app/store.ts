/**
 * Observable application state for the UI.
 *
 * Deliberately not reactive per field: the transfer code writes progress numbers many
 * times a second, and turning each of those into a React update would make the terminal
 * the bottleneck. Writers bump a revision counter; the UI samples on a timer.
 */

export type LogLevel = 'info' | 'error' | 'irc' | 'bot' | 'self';

export interface LogLine {
  at: number;
  level: LogLevel;
  /** Channel, nick, or `*` for client-level messages. */
  source: string;
  text: string;
}

export interface UiState {
  connection: string;
  network: string;
  nick: string;
  channels: string[];
  /** Each joined channel's topic, keyed by lower-cased name. Absent when it has none. */
  topics: Record<string, string>;
  /** Nicks with a private message view open, in the order they were opened. */
  conversations: string[];
}

const MAX_LOG_LINES = 1000;

/**
 * How many sources get a running total of their own before new ones are left to the
 * remainder. Far above any real session; it exists so that a flood of strangers messaging
 * you cannot grow the map without bound. A source past the limit still counts towards the
 * server view, which is where it would be shown anyway.
 */
const MAX_TRACKED_SOURCES = 2_000;

/** True for a source that names a channel rather than a person or the client itself. */
export function isChannelSource(source: string): boolean {
  return /^[#&+!]/.test(source);
}

export class Store {
  private readonly listeners = new Set<() => void>();
  private readonly lines: LogLine[] = [];

  /*
   * Running totals per source, kept beside the lines themselves.
   *
   * The log is trimmed to the last MAX_LOG_LINES, so counting rows would make the unread
   * badges drift downwards in a busy session. The server view's share is worked out by
   * subtraction rather than counted, because which sources have a view of their own
   * changes as channels and conversations are opened and closed.
   */
  private readonly sourceLines = new Map<string, number>();
  private totalLines = 0;

  revision = 0;

  state: UiState = {
    connection: 'disconnected',
    network: '',
    nick: '',
    channels: [],
    topics: {},
    conversations: [],
  };

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Mark state dirty. Listeners decide when to actually read it. */
  touch(): void {
    this.revision++;
    for (const listener of this.listeners) listener();
  }

  setState(patch: Partial<UiState>): void {
    this.state = { ...this.state, ...patch };
    this.touch();
  }

  log(level: LogLevel, source: string, text: string): void {
    const parts = text.split('\n');
    for (const part of parts) {
      this.lines.push({ at: Date.now(), level, source, text: part });
    }
    this.totalLines += parts.length;
    const key = source.toLowerCase();
    const counted = this.sourceLines.get(key);
    if (counted !== undefined) this.sourceLines.set(key, counted + parts.length);
    else if (this.sourceLines.size < MAX_TRACKED_SOURCES) this.sourceLines.set(key, parts.length);
    if (this.lines.length > MAX_LOG_LINES) {
      this.lines.splice(0, this.lines.length - MAX_LOG_LINES);
    }
    this.touch();
  }

  /** The most recent `count` lines, oldest first. */
  tail(count: number): LogLine[] {
    return count >= this.lines.length ? [...this.lines] : this.lines.slice(-count);
  }

  get lineCount(): number {
    return this.lines.length;
  }

  /**
   * Start counting a source separately, before anything has been logged for it. Used when
   * a conversation is opened, so its first message is counted in its own view.
   */
  track(source: string): void {
    const key = source.toLowerCase();
    if (!this.sourceLines.has(key)) this.sourceLines.set(key, 0);
  }

  /** Lines ever logged for one channel or conversation, used for the unread badges. */
  activityFor(source: string): number {
    return this.sourceLines.get(source.toLowerCase()) ?? 0;
  }

  /**
   * Lines belonging to no view of their own: client status, DCC progress, notices, and
   * anyone whose conversation is not open. Derived from the total rather than counted, so
   * it keeps matching what the server view actually shows as conversations come and go.
   */
  serverActivity(conversations: string[] = this.state.conversations): number {
    const claimed = new Set(conversations.map((nick) => nick.toLowerCase()));
    let taken = 0;
    for (const [source, count] of this.sourceLines) {
      if (isChannelSource(source) || claimed.has(source)) taken += count;
    }
    return Math.max(0, this.totalLines - taken);
  }

  clearLog(): void {
    this.lines.length = 0;
    this.touch();
  }
}
