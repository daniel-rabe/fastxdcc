/**
 * The contract between the Electron main process and the renderer.
 *
 * Every call is a named channel with an explicit request and response type. The renderer
 * gets no Node access at all — it can only reach the things listed here, through the
 * preload bridge.
 *
 * Several servers can be connected at once, so anything touching a connection carries the
 * session id it applies to.
 */

import type { BrowserState, Rect } from './browserView.js';
import type { AppSnapshot } from '../app/snapshot.js';
import type { Config } from '../config.js';

export const CHANNELS = {
  /** Main -> renderer: a full state snapshot. */
  state: 'fastxdcc:state',
  /** Main -> renderer: the embedded browser's navigation state. */
  browserState: 'fastxdcc:browser:state',
  /** Main -> renderer: something to show the user, raised outside a request. */
  notice: 'fastxdcc:notice',

  configGet: 'fastxdcc:config:get',
  configSave: 'fastxdcc:config:save',
  connect: 'fastxdcc:session:connect',
  disconnect: 'fastxdcc:session:disconnect',
  closeSession: 'fastxdcc:session:close',
  queueAdd: 'fastxdcc:queue:add',
  queueCancel: 'fastxdcc:queue:cancel',
  queueClean: 'fastxdcc:queue:clean',
  command: 'fastxdcc:irc:command',
  joinChannel: 'fastxdcc:irc:join',
  partChannel: 'fastxdcc:irc:part',
  openConversation: 'fastxdcc:irc:query',
  closeConversation: 'fastxdcc:irc:unquery',
  listPacks: 'fastxdcc:irc:list',
  chooseDir: 'fastxdcc:dir:choose',
  openDir: 'fastxdcc:dir:open',
  revealFile: 'fastxdcc:file:reveal',

  browserNavigate: 'fastxdcc:browser:navigate',
  browserBack: 'fastxdcc:browser:back',
  browserForward: 'fastxdcc:browser:forward',
  browserReload: 'fastxdcc:browser:reload',
  browserStop: 'fastxdcc:browser:stop',
  browserSetBounds: 'fastxdcc:browser:bounds',
  browserSetVisible: 'fastxdcc:browser:visible',
  /** Follow an irc:// link, as if the user had clicked one on a page. */
  followIrcLink: 'fastxdcc:irc:follow',
} as const;

/** Every handler answers with this shape, so the renderer has one error path. */
export type Result<T = undefined> = { ok: true; value: T } | { ok: false; error: string };

export interface ConfigPayload {
  config: Config;
  /** Where the config is stored, shown in the settings pane. */
  path: string;
}

/** The tab showing the embedded browser, which is not a session. */
export const BROWSE_TAB = 'browse';

/** Either `BROWSE_TAB` or a session id. */
export type TabId = string;

export interface SessionRequest {
  sessionId: string;
}

export interface QueueAddRequest extends SessionRequest {
  /** A pasted request line, or several separated by newlines. */
  input: string;
}

export interface QueueAddResponse {
  added: number;
  /** Human-readable summary, e.g. "Queued 3 pack(s) from SomeBot". */
  summary: string;
}

export interface QueueCancelRequest extends SessionRequest {
  /** Queue id, or omitted for everything still in flight. */
  id?: string;
  /** Delete the partial file instead of keeping it for a later resume. */
  discard?: boolean;
}

export interface CommandRequest extends SessionRequest {
  line: string;
  /**
   * The conversation the line was typed into. Plain text goes here, and a bare `/part`
   * leaves here. Omitted by callers that show one undivided log.
   */
  target?: string;
}

export interface JoinChannelRequest extends SessionRequest {
  /** `#name`, or a bare name the main process will prefix. */
  channel: string;
  key?: string;
}

export interface JoinChannelResponse {
  /** The name actually joined, so the renderer can switch to its view. */
  channel: string;
}

export interface PartChannelRequest extends SessionRequest {
  channel: string;
}

export interface ConversationRequest extends SessionRequest {
  nick: string;
}

export interface OpenConversationResponse {
  /** The nick as it is now listed, so the renderer can switch to its view. */
  nick: string;
}

export interface ListPacksRequest extends SessionRequest {
  bot: string;
}

export interface RevealRequest {
  path: string;
}

export interface ConnectResponse {
  /** The session that is now open, so the renderer can bring its tab forward. */
  sessionId: string;
}

export interface NoticeEvent {
  kind: 'info' | 'error';
  text: string;
  /** Ask the renderer to bring a tab forward: `BROWSE_TAB` or a session id. */
  activateTab?: TabId;
}

/** The API the preload script exposes on `window.fastxdcc`. */
export interface FastxdccApi {
  onState(listener: (snapshot: AppSnapshot) => void): () => void;
  onBrowserState(listener: (state: BrowserState) => void): () => void;
  onNotice(listener: (notice: NoticeEvent) => void): () => void;

  getConfig(): Promise<Result<ConfigPayload>>;
  saveConfig(config: Config): Promise<Result<ConfigPayload>>;
  /** Connect to the server in the settings, opening a session for it. */
  connect(): Promise<Result<ConnectResponse>>;
  /** Disconnect but keep the tab, so its transfer history stays visible. */
  disconnect(request: SessionRequest): Promise<Result>;
  /** Disconnect and drop the tab entirely. */
  closeSession(request: SessionRequest): Promise<Result>;
  queueAdd(request: QueueAddRequest): Promise<Result<QueueAddResponse>>;
  queueCancel(request: QueueCancelRequest): Promise<Result<{ cancelled: number }>>;
  queueClean(request: SessionRequest): Promise<Result<{ removed: number }>>;
  command(request: CommandRequest): Promise<Result>;
  /** Join another channel on an already-connected server. */
  joinChannel(request: JoinChannelRequest): Promise<Result<JoinChannelResponse>>;
  partChannel(request: PartChannelRequest): Promise<Result>;
  /** Open a private message view for a nick. Local only; nothing is sent. */
  openConversation(request: ConversationRequest): Promise<Result<OpenConversationResponse>>;
  closeConversation(request: ConversationRequest): Promise<Result>;
  listPacks(request: ListPacksRequest): Promise<Result>;
  chooseDir(): Promise<Result<{ path: string | null }>>;
  openDir(): Promise<Result>;
  revealFile(request: RevealRequest): Promise<Result>;

  browserNavigate(url: string): Promise<Result>;
  browserBack(): Promise<Result>;
  browserForward(): Promise<Result>;
  browserReload(): Promise<Result>;
  browserStop(): Promise<Result>;
  browserSetBounds(rect: Rect): Promise<Result>;
  browserSetVisible(visible: boolean): Promise<Result>;
  followIrcLink(url: string): Promise<Result>;
}
