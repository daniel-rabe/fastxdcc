/**
 * One DCC file transfer, covering both connection directions.
 *
 * Active offer  (port != 0): the bot listens, we connect out.
 * Passive offer (port == 0): the bot is firewalled, so we listen and answer the offer
 *                            with our own DCC SEND carrying the bot's token.
 *
 * Resume negotiation, when it applies, happens before either of those: we send
 * DCC RESUME and wait for the bot's DCC ACCEPT, because connecting first and seeking
 * afterwards is what produces corrupted files.
 */

import { EventEmitter } from 'node:events';
import { createWriteStream, type WriteStream } from 'node:fs';
import { rename, truncate, unlink } from 'node:fs/promises';
import net from 'node:net';
import { pipeline } from 'node:stream/promises';
import {
  encodeAck,
  formatDccResume,
  formatDccSend,
  type DccAccept,
  type DccSend,
} from './ctcp.js';
import { planTarget, type TargetPlan } from './paths.js';

export type TransferState =
  | 'queued'
  | 'negotiating'
  | 'connecting'
  | 'listening'
  | 'transferring'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface PassiveOptions {
  /** Address advertised to the bot. Falls back to the IRC socket's local address. */
  externalIp?: string;
  /** Inclusive range of local ports to bind for reverse DCC. */
  portRange: [number, number];
  listenTimeoutMs: number;
}

export interface TransferOptions {
  offer: DccSend;
  botNick: string;
  downloadDir: string;
  /** Sends a CTCP PRIVMSG to the bot; used for DCC RESUME and the passive DCC SEND reply. */
  sendCtcpRaw: (target: string, ctcpBody: string) => void;
  passive: PassiveOptions;
  /** Address to advertise when `passive.externalIp` is unset. */
  fallbackLocalIp?: string;
  resumeTimeoutMs?: number;
  connectTimeoutMs?: number;
  /** Abort if no bytes arrive for this long. */
  stallTimeoutMs?: number;
  /** How often to send acknowledgements and emit progress. */
  ackIntervalMs?: number;
  /** Socket read buffer size; large buffers keep the receive path cheap. */
  highWaterMark?: number;
}

export interface TransferProgress {
  bytesReceived: number;
  size: number;
  /** Bytes per second, exponentially smoothed. */
  speed: number;
  /** Seconds remaining, or null when it cannot be estimated yet. */
  eta: number | null;
}

export interface TransferEvents {
  state: [TransferState];
  progress: [TransferProgress];
  /** Emitted once the file is renamed into place. */
  completed: [string];
  failed: [Error];
  status: [string];
}

export declare interface Transfer {
  on<K extends keyof TransferEvents>(event: K, listener: (...args: TransferEvents[K]) => void): this;
  emit<K extends keyof TransferEvents>(event: K, ...args: TransferEvents[K]): boolean;
}

let nextId = 1;

export class Transfer extends EventEmitter {
  readonly id = `t${nextId++}`;
  readonly botNick: string;
  readonly offer: DccSend;

  state: TransferState = 'queued';
  filename: string;
  size: number;
  bytesReceived = 0;
  /** Offset the current connection started at; bytes below it came from a previous run. */
  startOffset = 0;
  speed = 0;
  error?: Error;
  finalPath?: string;

  private plan?: TargetPlan;
  private socket?: net.Socket;
  private server?: net.Server;
  private stream?: WriteStream;
  private ackTimer?: NodeJS.Timeout;
  private stallTimer?: NodeJS.Timeout;
  private acceptWaiter?: (accept: DccAccept) => void;
  private lastTickBytes = 0;
  private lastTickAt = 0;
  private lastProgressAt = 0;
  private cancelled = false;

  private readonly resumeTimeoutMs: number;
  private readonly connectTimeoutMs: number;
  private readonly stallTimeoutMs: number;
  private readonly ackIntervalMs: number;
  private readonly highWaterMark: number;

  constructor(private readonly options: TransferOptions) {
    super();
    this.offer = options.offer;
    this.botNick = options.botNick;
    this.filename = options.offer.filename;
    this.size = options.offer.size;
    this.resumeTimeoutMs = options.resumeTimeoutMs ?? 10_000;
    this.connectTimeoutMs = options.connectTimeoutMs ?? 30_000;
    this.stallTimeoutMs = options.stallTimeoutMs ?? 60_000;
    this.ackIntervalMs = options.ackIntervalMs ?? 100;
    this.highWaterMark = options.highWaterMark ?? 1024 * 1024;
  }

  get isPassive(): boolean {
    return this.offer.port === 0;
  }

  get progress(): TransferProgress {
    const remaining = this.size - this.bytesReceived;
    return {
      bytesReceived: this.bytesReceived,
      size: this.size,
      speed: this.speed,
      eta: this.speed > 0 && remaining > 0 ? remaining / this.speed : null,
    };
  }

  private setState(state: TransferState): void {
    if (this.state === state) return;
    this.state = state;
    this.emit('state', state);
  }

  async start(): Promise<void> {
    try {
      await this.run();
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      await this.cleanup();
      if (this.cancelled) {
        this.setState('cancelled');
      } else {
        this.error = error;
        this.setState('failed');
        this.emit('failed', error);
      }
    }
  }

  private async run(): Promise<void> {
    const plan = await planTarget(this.options.downloadDir, this.offer.filename, this.size);
    this.plan = plan;
    this.filename = plan.filename;
    this.finalPath = plan.finalPath;

    if (plan.alreadyComplete) {
      this.bytesReceived = this.size;
      this.setState('completed');
      this.emit('status', `${plan.filename} is already downloaded`);
      this.emit('completed', plan.finalPath);
      return;
    }

    const offset = plan.resumeFrom > 0 ? await this.negotiateResume(plan.resumeFrom) : 0;
    this.startOffset = offset;
    this.bytesReceived = offset;

    const socket = this.isPassive ? await this.acceptPassive() : await this.connectActive();
    if (this.cancelled) throw new Error('cancelled');

    this.socket = socket;
    socket.setNoDelay(true);

    this.stream = createWriteStream(plan.partPath, {
      flags: offset > 0 ? 'r+' : 'w',
      start: offset,
      highWaterMark: this.highWaterMark,
    });

    this.setState('transferring');
    this.lastTickAt = Date.now();
    this.lastProgressAt = Date.now();
    this.lastTickBytes = offset;
    this.startTimers();

    socket.on('data', (chunk: Buffer) => {
      this.bytesReceived += chunk.length;
      this.lastProgressAt = Date.now();
      if (this.bytesReceived > this.size) {
        socket.destroy(new Error('Sender exceeded the announced file size'));
        return;
      }
      // Acknowledge the last byte from here rather than after the stream ends: senders
      // wait for the final ack to consider the transfer successful, and by the time the
      // pipeline resolves the socket is usually already closed. It also covers small
      // files, which finish well inside one ack interval.
      if (this.bytesReceived === this.size) this.sendAck();
    });

    // `pipeline` gives us backpressure and a single place for socket/disk errors.
    await pipeline(socket, this.stream);

    this.stopTimers();
    this.sendAck();

    if (this.cancelled) throw new Error('cancelled');

    if (this.bytesReceived !== this.size) {
      throw new Error(
        `Incomplete transfer: got ${this.bytesReceived} of ${this.size} bytes ` +
          `(partial file kept at ${plan.partPath} for resuming)`,
      );
    }

    await rename(plan.partPath, plan.finalPath);
    this.setState('completed');
    this.emit('completed', plan.finalPath);
  }

  /**
   * Ask the bot to start from `position`. Returns the offset actually agreed; 0 when the
   * bot does not answer, which means restarting the file from scratch.
   */
  private async negotiateResume(position: number): Promise<number> {
    this.setState('negotiating');
    this.emit('status', `Requesting resume of ${this.filename} at ${position} bytes`);

    const accepted = await new Promise<DccAccept | null>((resolve) => {
      const timer = setTimeout(() => {
        this.acceptWaiter = undefined;
        resolve(null);
      }, this.resumeTimeoutMs);
      timer.unref?.();

      this.acceptWaiter = (accept) => {
        clearTimeout(timer);
        this.acceptWaiter = undefined;
        resolve(accept);
      };

      // For passive offers the port field is 0 and the token identifies the transfer.
      const body = formatDccResume({
        filename: this.offer.filename,
        port: this.offer.port,
        position,
        ...(this.offer.token !== undefined ? { token: this.offer.token } : {}),
      });
      this.options.sendCtcpRaw(this.botNick, body);
    });

    if (!accepted) {
      this.emit('status', 'No DCC ACCEPT from the bot; restarting the file from the beginning');
      return 0;
    }

    // The bot may accept a different offset than we asked for.
    if (accepted.position > position) {
      // We would have to invent the bytes in between, so start over instead.
      this.emit('status', 'Bot accepted a later offset than we have; restarting from the beginning');
      return 0;
    }
    if (accepted.position < position && this.plan) {
      await truncate(this.plan.partPath, accepted.position);
    }

    this.emit('status', `Resuming ${this.filename} at ${accepted.position} bytes`);
    return accepted.position;
  }

  /** Called by the manager when a DCC ACCEPT arrives from this transfer's bot. */
  handleAccept(accept: DccAccept): boolean {
    if (!this.acceptWaiter) return false;
    // Match on token for passive transfers, port for active ones.
    if (this.offer.token !== undefined) {
      if (accept.token !== undefined && accept.token !== this.offer.token) return false;
    } else if (accept.port !== 0 && accept.port !== this.offer.port) {
      return false;
    }
    this.acceptWaiter(accept);
    return true;
  }

  private connectActive(): Promise<net.Socket> {
    this.setState('connecting');
    this.emit('status', `Connecting to ${this.offer.ip}:${this.offer.port}`);

    return new Promise((resolve, reject) => {
      const socket = net.connect({ host: this.offer.ip, port: this.offer.port });
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error(`Timed out connecting to ${this.offer.ip}:${this.offer.port}`));
      }, this.connectTimeoutMs);
      timer.unref?.();

      socket.once('connect', () => {
        clearTimeout(timer);
        resolve(socket);
      });
      socket.once('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  /**
   * Reverse DCC: bind a local port, tell the bot where to find us, and wait for it to
   * connect in. The listener is always torn down, so a bot that never shows up does not
   * leak a bound port.
   */
  private async acceptPassive(): Promise<net.Socket> {
    this.setState('listening');

    const { server, port } = await listenInRange(this.options.passive.portRange);
    this.server = server;

    const ip = this.options.passive.externalIp ?? this.options.fallbackLocalIp;
    if (!ip) {
      server.close();
      throw new Error(
        'Reverse DCC needs an address to advertise; set passive.externalIp in the config',
      );
    }

    this.emit('status', `Listening on ${ip}:${port} for a reverse DCC connection`);

    return new Promise<net.Socket>((resolve, reject) => {
      const timer = setTimeout(() => {
        server.close();
        reject(new Error('Bot did not connect back for the reverse DCC transfer'));
      }, this.options.passive.listenTimeoutMs);
      timer.unref?.();

      server.once('connection', (socket) => {
        clearTimeout(timer);
        // Stop accepting, but keep the established socket alive.
        server.close();
        this.server = undefined;
        resolve(socket);
      });
      server.once('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });

      this.options.sendCtcpRaw(
        this.botNick,
        formatDccSend({
          filename: this.offer.filename,
          ip,
          port,
          size: this.size,
          ...(this.offer.token !== undefined ? { token: this.offer.token } : {}),
        }),
      );
    });
  }

  private startTimers(): void {
    this.ackTimer = setInterval(() => this.tick(), this.ackIntervalMs);
    this.ackTimer.unref?.();

    const stallCheck = Math.max(1000, Math.floor(this.stallTimeoutMs / 4));
    this.stallTimer = setInterval(() => {
      if (Date.now() - this.lastProgressAt > this.stallTimeoutMs) {
        this.socket?.destroy(new Error(`Transfer stalled for ${this.stallTimeoutMs}ms`));
      }
    }, stallCheck);
    this.stallTimer.unref?.();
  }

  private stopTimers(): void {
    if (this.ackTimer) clearInterval(this.ackTimer);
    if (this.stallTimer) clearInterval(this.stallTimer);
    this.ackTimer = undefined;
    this.stallTimer = undefined;
  }

  /**
   * Acknowledge and measure, on a timer rather than per chunk.
   *
   * Classic DCC has the receiver echo a 4-byte count after every chunk. Doing that
   * literally makes throughput a function of round-trip time; senders tolerate periodic
   * acks, and every fast client does it this way.
   */
  private tick(): void {
    const now = Date.now();
    const elapsed = (now - this.lastTickAt) / 1000;
    if (elapsed > 0) {
      const instant = (this.bytesReceived - this.lastTickBytes) / elapsed;
      // Exponentially smoothed so the displayed rate does not flicker.
      this.speed = this.speed === 0 ? instant : this.speed * 0.7 + instant * 0.3;
      this.lastTickBytes = this.bytesReceived;
      this.lastTickAt = now;
    }
    this.sendAck();
    this.emit('progress', this.progress);
  }

  private sendAck(): void {
    const socket = this.socket;
    if (!socket || socket.destroyed || !socket.writable) return;
    socket.write(encodeAck(this.bytesReceived));
  }

  /** Stop the transfer, keeping the partial file so it can be resumed later. */
  cancel(): void {
    this.cancelled = true;
    this.acceptWaiter?.({ type: 'ACCEPT', filename: this.filename, port: 0, position: 0 });
    this.socket?.destroy();
    this.server?.close();
    this.stopTimers();
    this.setState('cancelled');
  }

  /**
   * Delete the partial file, for a cancel where the user does not intend to resume.
   *
   * Retried briefly: the socket and write stream are torn down asynchronously, and on
   * Windows the file stays locked until the handle is actually closed.
   */
  async discardPartial(): Promise<boolean> {
    if (!this.plan) return false;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        await unlink(this.plan.partPath);
        return true;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') return false;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    return false;
  }

  private async cleanup(): Promise<void> {
    this.stopTimers();
    this.socket?.destroy();
    this.server?.close();
    this.server = undefined;
    if (this.stream && !this.stream.destroyed) this.stream.destroy();
  }
}

/** Bind the first free port in `[from, to]`, so reverse DCC works behind a fixed rule. */
async function listenInRange(range: [number, number]): Promise<{ server: net.Server; port: number }> {
  const [from, to] = range;
  let lastError: Error | undefined;

  for (let port = from; port <= to; port++) {
    try {
      const server = await new Promise<net.Server>((resolve, reject) => {
        const srv = net.createServer();
        const onError = (err: Error) => {
          srv.close();
          reject(err);
        };
        srv.once('error', onError);
        srv.listen(port, () => {
          srv.off('error', onError);
          resolve(srv);
        });
      });
      // Read the bound port back rather than trusting the requested one, so a range of
      // `[0, 0]` (let the OS choose) advertises the real port to the bot.
      const address = server.address();
      const boundPort = typeof address === 'object' && address !== null ? address.port : port;
      return { server, port: boundPort };
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
    }
  }

  throw new Error(
    `No free port in ${from}-${to} for reverse DCC${lastError ? `: ${lastError.message}` : ''}`,
  );
}
