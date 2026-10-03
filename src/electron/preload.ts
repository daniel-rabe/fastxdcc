/**
 * The bridge between the renderer and the main process.
 *
 * This is the renderer's entire surface area: a fixed set of functions, each forwarding
 * to one named channel. No Node module, no ipcRenderer, and no event object is exposed.
 */

import { contextBridge, ipcRenderer } from 'electron';
import type { AppSnapshot } from '../app/snapshot.js';
import type { BrowserState, Rect } from './browserView.js';
import type { Config } from '../config.js';
import {
  CHANNELS,
  type CommandRequest,
  type ConfigPayload,
  type ConnectResponse,
  type ConversationRequest,
  type FastxdccApi,
  type JoinChannelRequest,
  type JoinChannelResponse,
  type ListPacksRequest,
  type NoticeEvent,
  type OpenConversationResponse,
  type QueueAddRequest,
  type QueueAddResponse,
  type PartChannelRequest,
  type QueueCancelRequest,
  type Result,
  type RevealRequest,
  type SessionRequest,
} from './ipc.js';

/** Subscribe to a main -> renderer channel, dropping the raw event object. */
function subscribe<T>(channel: string, listener: (payload: T) => void): () => void {
  const wrapped = (_event: unknown, payload: T) => listener(payload);
  ipcRenderer.on(channel, wrapped);
  return () => {
    ipcRenderer.off(channel, wrapped);
  };
}

const api: FastxdccApi = {
  onState: (listener) => subscribe<AppSnapshot>(CHANNELS.state, listener),
  onBrowserState: (listener) => subscribe<BrowserState>(CHANNELS.browserState, listener),
  onNotice: (listener) => subscribe<NoticeEvent>(CHANNELS.notice, listener),

  getConfig: () => ipcRenderer.invoke(CHANNELS.configGet) as Promise<Result<ConfigPayload>>,

  saveConfig: (config: Config) =>
    ipcRenderer.invoke(CHANNELS.configSave, config) as Promise<Result<ConfigPayload>>,

  connect: () => ipcRenderer.invoke(CHANNELS.connect) as Promise<Result<ConnectResponse>>,

  disconnect: (request: SessionRequest) =>
    ipcRenderer.invoke(CHANNELS.disconnect, request) as Promise<Result>,

  closeSession: (request: SessionRequest) =>
    ipcRenderer.invoke(CHANNELS.closeSession, request) as Promise<Result>,

  queueAdd: (request: QueueAddRequest) =>
    ipcRenderer.invoke(CHANNELS.queueAdd, request) as Promise<Result<QueueAddResponse>>,

  queueCancel: (request: QueueCancelRequest) =>
    ipcRenderer.invoke(CHANNELS.queueCancel, request) as Promise<Result<{ cancelled: number }>>,

  queueClean: (request: SessionRequest) =>
    ipcRenderer.invoke(CHANNELS.queueClean, request) as Promise<Result<{ removed: number }>>,

  command: (request: CommandRequest) =>
    ipcRenderer.invoke(CHANNELS.command, request) as Promise<Result>,

  joinChannel: (request: JoinChannelRequest) =>
    ipcRenderer.invoke(CHANNELS.joinChannel, request) as Promise<Result<JoinChannelResponse>>,

  partChannel: (request: PartChannelRequest) =>
    ipcRenderer.invoke(CHANNELS.partChannel, request) as Promise<Result>,

  openConversation: (request: ConversationRequest) =>
    ipcRenderer.invoke(CHANNELS.openConversation, request) as Promise<
      Result<OpenConversationResponse>
    >,

  closeConversation: (request: ConversationRequest) =>
    ipcRenderer.invoke(CHANNELS.closeConversation, request) as Promise<Result>,

  listPacks: (request: ListPacksRequest) =>
    ipcRenderer.invoke(CHANNELS.listPacks, request) as Promise<Result>,

  chooseDir: () => ipcRenderer.invoke(CHANNELS.chooseDir) as Promise<Result<{ path: string | null }>>,

  openDir: () => ipcRenderer.invoke(CHANNELS.openDir) as Promise<Result>,

  revealFile: (request: RevealRequest) =>
    ipcRenderer.invoke(CHANNELS.revealFile, request) as Promise<Result>,

  browserNavigate: (url: string) =>
    ipcRenderer.invoke(CHANNELS.browserNavigate, url) as Promise<Result>,
  browserBack: () => ipcRenderer.invoke(CHANNELS.browserBack) as Promise<Result>,
  browserForward: () => ipcRenderer.invoke(CHANNELS.browserForward) as Promise<Result>,
  browserReload: () => ipcRenderer.invoke(CHANNELS.browserReload) as Promise<Result>,
  browserStop: () => ipcRenderer.invoke(CHANNELS.browserStop) as Promise<Result>,
  browserSetBounds: (rect: Rect) =>
    ipcRenderer.invoke(CHANNELS.browserSetBounds, rect) as Promise<Result>,
  browserSetVisible: (visible: boolean) =>
    ipcRenderer.invoke(CHANNELS.browserSetVisible, visible) as Promise<Result>,
  followIrcLink: (url: string) =>
    ipcRenderer.invoke(CHANNELS.followIrcLink, url) as Promise<Result>,
};

contextBridge.exposeInMainWorld('fastxdcc', api);
