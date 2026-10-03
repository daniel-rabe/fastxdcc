/**
 * Queue and lifecycle for XDCC requests.
 *
 * Scheduling rules:
 *  - at most `maxConcurrent` requests are in flight at once;
 *  - requests to the *same* bot are serialised, because most bots accept only one
 *    pending request per user and answer the second with a denial;
 *  - an item sitting in a bot's own queue keeps its slot, since giving it up would mean
 *    losing the queue position we already waited for.
 */

import { EventEmitter } from 'node:events';
import { parseDcc, type DccAccept, type DccSend } from './ctcp.js';
import { Transfer, type PassiveOptions, type TransferProgress } from './transfer.js';
import { isTerminalFailure, parseBotNotice } from '../xdcc/notices.js';

export type ItemState =
  | 'waiting'
  | 'requested'
  | 'botQueued'
  | 'transferring'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface QueueItem {
  id: string;
  bot: string;
  pack: number;
  state: ItemState;
  attempts: number;
  /** Position in the bot's queue, when it has told us. */
  position?: number;
  total?: number;
  filename?: string;
  size?: number;
  bytesReceived?: number;
  speed?: number;
  eta?: number | null;
  error?: string;
  note?: string;
  /** Where the finished file landed; lets a UI reveal it on disk. */
  finalPath?: string;
  /** True when the offer was a reverse/passive one. */
  passive?: boolean;
  /**
   * The live transfer. Holds sockets and streams, so it is not serialisable - anything
   * crossing a process boundary must use `snapshotItem` instead of this object.
   */
  transfer?: Transfer;
}

export interface ManagerOptions {
  downloadDir: string;
  maxConcurrent: number;
  passive: PassiveOptions;
  sendMessage: (target: string, text: string) => void;
  sendCtcpRaw: (target: string, body: string) => void;
  fallbackLocalIp?: () => string | undefined;
  /** Give up waiting for a DCC offer this long after requesting. */
  requestTimeoutMs?: number;
  /** Retries per pack after a failed transfer. */
  maxRetries?: number;
  resumeTimeoutMs?: number;
  connectTimeoutMs?: number;
  stallTimeoutMs?: number;
}

export interface ManagerEvents {
  /** Any change worth re-rendering for. */
  update: [];
  status: [string];
}

export declare interface TransferManager {
  on<K extends keyof ManagerEvents>(event: K, listener: (...args: ManagerEvents[K]) => void): this;
  emit<K extends keyof ManagerEvents>(event: K, ...args: ManagerEvents[K]): boolean;
}

const IN_FLIGHT: ReadonlySet<ItemState> = new Set<ItemState>([
  'requested',
  'botQueued',
  'transferring',
]);

let nextItemId = 1;

export class TransferManager extends EventEmitter {
  readonly items: QueueItem[] = [];
  private readonly requestTimers = new Map<string, NodeJS.Timeout>();

  constructor(private readonly options: ManagerOptions) {
    super();
  }

  private lc(nick: string): string {
    return nick.toLowerCase();
  }

  /** Queue one or more packs; duplicates already in flight are ignored. */
  enqueue(bot: string, packs: number[]): QueueItem[] {
    const added: QueueItem[] = [];
    for (const pack of packs) {
      const existing = this.items.find(
        (i) =>
          this.lc(i.bot) === this.lc(bot) &&
          i.pack === pack &&
          (IN_FLIGHT.has(i.state) || i.state === 'waiting'),
      );
      if (existing) {
        this.emit('status', `${bot} #${pack} is already queued`);
        continue;
      }
      const item: QueueItem = {
        id: `q${nextItemId++}`,
        bot,
        pack,
        state: 'waiting',
        attempts: 0,
      };
      this.items.push(item);
      added.push(item);
    }
    this.emit('update');
    this.pump();
    return added;
  }

  private inFlightCount(): number {
    return this.items.filter((i) => IN_FLIGHT.has(i.state)).length;
  }

  private hasInFlightFor(bot: string): boolean {
    return this.items.some((i) => IN_FLIGHT.has(i.state) && this.lc(i.bot) === this.lc(bot));
  }

  /** Start any waiting items the scheduling rules allow. */
  pump(): void {
    for (const item of this.items) {
      if (item.state !== 'waiting') continue;
      if (this.inFlightCount() >= this.options.maxConcurrent) break;
      if (this.hasInFlightFor(item.bot)) continue;
      this.request(item);
    }
  }

  private request(item: QueueItem): void {
    item.state = 'requested';
    item.attempts++;
    item.note = undefined;
    item.error = undefined;
    this.options.sendMessage(item.bot, `xdcc send #${item.pack}`);
    this.emit('status', `Requested ${item.bot} pack #${item.pack}`);

    const timeout = this.options.requestTimeoutMs ?? 60_000;
    if (timeout > 0) {
      const timer = setTimeout(() => {
        if (item.state === 'requested') {
          this.fail(item, new Error('Bot did not answer the request'));
        }
      }, timeout);
      timer.unref?.();
      this.requestTimers.set(item.id, timer);
    }
    this.emit('update');
  }

  private clearRequestTimer(item: QueueItem): void {
    const timer = this.requestTimers.get(item.id);
    if (timer) clearTimeout(timer);
    this.requestTimers.delete(item.id);
  }

  /** Feed every CTCP the client receives through here. */
  handleCtcp(from: string, command: string, args: string): void {
    if (command !== 'DCC') return;

    let msg;
    try {
      msg = parseDcc(args);
    } catch (err) {
      this.emit('status', `Unparsable DCC from ${from}: ${(err as Error).message}`);
      return;
    }
    if (!msg) return;

    if (msg.type === 'SEND') this.onOffer(from, msg);
    else if (msg.type === 'ACCEPT') this.onAccept(from, msg);
  }

  /** Feed every NOTICE from a bot through here so queue positions stay current. */
  handleNotice(from: string, text: string): void {
    const item = this.items.find(
      (i) => this.lc(i.bot) === this.lc(from) && IN_FLIGHT.has(i.state),
    );
    if (!item) return;

    const notice = parseBotNotice(text);
    switch (notice.kind) {
      case 'queued':
        item.state = 'botQueued';
        if (notice.position !== undefined) item.position = notice.position;
        if (notice.total !== undefined) item.total = notice.total;
        item.note = notice.total
          ? `queued ${notice.position}/${notice.total}`
          : `queued at ${notice.position}`;
        // The bot has taken the request; it may sit here for a long time legitimately.
        this.clearRequestTimer(item);
        break;
      case 'alreadyQueued':
      case 'alreadyRequested':
        item.state = 'botQueued';
        item.note = notice.text;
        this.clearRequestTimer(item);
        break;
      case 'sending':
        // The offer itself follows; just stop the request timer.
        this.clearRequestTimer(item);
        item.note = 'bot is sending';
        break;
      case 'removedFromQueue':
        this.fail(item, new Error(notice.text), { retry: false });
        return;
      default:
        if (isTerminalFailure(notice.kind)) {
          this.fail(item, new Error(notice.reason || notice.text), { retry: false });
          return;
        }
        // 'unknown' and 'completed' need no state change.
        break;
    }
    this.emit('update');
  }

  private onOffer(from: string, offer: DccSend): void {
    const item =
      this.items.find(
        (i) => this.lc(i.bot) === this.lc(from) && (i.state === 'requested' || i.state === 'botQueued'),
      ) ?? undefined;

    if (!item) {
      // An unsolicited offer. Ignoring it is the safe default: accepting files we never
      // asked for is how a client becomes a delivery mechanism.
      this.emit('status', `Ignoring unsolicited DCC SEND from ${from} (${offer.filename})`);
      return;
    }

    this.clearRequestTimer(item);
    item.state = 'transferring';
    item.filename = offer.filename;
    item.size = offer.size;
    item.passive = offer.port === 0;
    item.note = offer.port === 0 ? 'reverse DCC' : undefined;

    const transfer = new Transfer({
      offer,
      botNick: from,
      downloadDir: this.options.downloadDir,
      sendCtcpRaw: this.options.sendCtcpRaw,
      passive: this.options.passive,
      ...(this.options.fallbackLocalIp
        ? { fallbackLocalIp: this.options.fallbackLocalIp() }
        : {}),
      ...(this.options.resumeTimeoutMs !== undefined
        ? { resumeTimeoutMs: this.options.resumeTimeoutMs }
        : {}),
      ...(this.options.connectTimeoutMs !== undefined
        ? { connectTimeoutMs: this.options.connectTimeoutMs }
        : {}),
      ...(this.options.stallTimeoutMs !== undefined
        ? { stallTimeoutMs: this.options.stallTimeoutMs }
        : {}),
    });

    item.transfer = transfer;

    transfer.on('progress', (p: TransferProgress) => {
      item.bytesReceived = p.bytesReceived;
      item.size = p.size;
      item.speed = p.speed;
      item.eta = p.eta;
      // No 'update' here: progress fires several times a second and the UI polls.
    });
    transfer.on('status', (text) => this.emit('status', `[${item.bot} #${item.pack}] ${text}`));
    transfer.on('completed', (path) => {
      item.state = 'completed';
      item.finalPath = path;
      item.filename = transfer.filename;
      item.bytesReceived = transfer.size;
      item.size = transfer.size;
      item.note = undefined;
      this.emit('status', `Completed ${path}`);
      this.emit('update');
      this.pump();
    });
    transfer.on('failed', (err) => this.fail(item, err));

    this.emit('update');
    void transfer.start();
  }

  private onAccept(from: string, accept: DccAccept): void {
    for (const item of this.items) {
      if (this.lc(item.bot) !== this.lc(from) || !item.transfer) continue;
      if (item.transfer.handleAccept(accept)) return;
    }
  }

  private fail(item: QueueItem, error: Error, opts: { retry?: boolean } = {}): void {
    this.clearRequestTimer(item);
    item.transfer = undefined;
    item.error = error.message;

    const retriesAllowed = this.options.maxRetries ?? 2;
    const canRetry = (opts.retry ?? true) && item.attempts <= retriesAllowed;

    if (canRetry) {
      item.state = 'waiting';
      item.note = `retrying (attempt ${item.attempts + 1})`;
      this.emit('status', `${item.bot} #${item.pack} failed: ${error.message} - retrying`);
      const delay = Math.min(30_000, 3_000 * 2 ** (item.attempts - 1));
      const timer = setTimeout(() => this.pump(), delay);
      timer.unref?.();
    } else {
      item.state = 'failed';
      item.note = undefined;
      this.emit('status', `${item.bot} #${item.pack} failed: ${error.message}`);
    }

    this.emit('update');
    this.pump();
  }

  /**
   * Cancel by queue id, or every in-flight item when no id is given.
   * With `discardPartial`, the half-downloaded file is deleted instead of kept for a
   * later resume.
   */
  cancel(id?: string, discardPartial = false): number {
    const targets = id
      ? this.items.filter((i) => i.id === id)
      : this.items.filter((i) => IN_FLIGHT.has(i.state) || i.state === 'waiting');

    for (const item of targets) {
      this.clearRequestTimer(item);
      if (item.transfer) {
        const transfer = item.transfer;
        transfer.cancel();
        item.transfer = undefined;
        if (discardPartial) {
          void transfer.discardPartial().then((removed) => {
            if (removed) this.emit('status', `Discarded the partial file for ${item.bot} #${item.pack}`);
          });
        }
      } else if (item.state === 'botQueued' || item.state === 'requested') {
        // Tell the bot too, so we do not leave a stale slot in its queue.
        this.options.sendMessage(item.bot, `xdcc remove #${item.pack}`);
      }
      item.state = 'cancelled';
      item.note = undefined;
    }

    this.emit('update');
    this.pump();
    return targets.length;
  }

  /** Drop finished rows from the list. */
  clearFinished(): number {
    const before = this.items.length;
    for (let i = this.items.length - 1; i >= 0; i--) {
      const state = this.items[i]!.state;
      if (state === 'completed' || state === 'failed' || state === 'cancelled') {
        this.items.splice(i, 1);
      }
    }
    this.emit('update');
    return before - this.items.length;
  }

  shutdown(): void {
    for (const timer of this.requestTimers.values()) clearTimeout(timer);
    this.requestTimers.clear();
    for (const item of this.items) item.transfer?.cancel();
  }
}
