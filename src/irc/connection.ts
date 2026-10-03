/**
 * The raw socket half of an IRC connection: TCP or TLS, CRLF line framing, and a
 * rate-limited outbound queue.
 */

import { EventEmitter } from 'node:events';
import net from 'node:net';
import tls from 'node:tls';

export interface ConnectionOptions {
  host: string;
  port: number;
  tls: boolean;
  /** Accept self-signed / mismatched certificates. Off by default, for good reason. */
  rejectUnauthorized?: boolean;
  /** Messages per burst before the queue starts pacing. */
  burst?: number;
  /** Milliseconds between messages once the burst is spent. */
  messageInterval?: number;
  /** Drop the connection if nothing arrives for this long. */
  idleTimeoutMs?: number;
}

export interface ConnectionEvents {
  connect: [];
  line: [string];
  close: [hadError: boolean];
  error: [Error];
}

/** Longest line we will buffer before assuming the peer is not speaking IRC. */
const MAX_LINE_BYTES = 16 * 1024;

export declare interface Connection {
  on<K extends keyof ConnectionEvents>(
    event: K,
    listener: (...args: ConnectionEvents[K]) => void,
  ): this;
  emit<K extends keyof ConnectionEvents>(event: K, ...args: ConnectionEvents[K]): boolean;
}

export class Connection extends EventEmitter {
  private socket?: net.Socket;
  private buffer: Buffer = Buffer.alloc(0);
  private readonly queue: string[] = [];
  private tokens: number;
  private pump?: NodeJS.Timeout;
  private closed = false;

  private readonly burst: number;
  private readonly interval: number;

  constructor(private readonly options: ConnectionOptions) {
    super();
    this.burst = options.burst ?? 5;
    this.interval = options.messageInterval ?? 400;
    this.tokens = this.burst;
  }

  get connected(): boolean {
    return this.socket !== undefined && !this.socket.destroyed;
  }

  /** The address the server sees us as, needed to advertise a reverse-DCC listener. */
  get localAddress(): string | undefined {
    return this.socket?.localAddress ?? undefined;
  }

  connect(): void {
    this.closed = false;
    this.buffer = Buffer.alloc(0);

    const onReady = () => this.emit('connect');

    if (this.options.tls) {
      this.socket = tls.connect({
        host: this.options.host,
        port: this.options.port,
        servername: this.options.host,
        rejectUnauthorized: this.options.rejectUnauthorized ?? true,
      }, onReady);
    } else {
      this.socket = net.connect({ host: this.options.host, port: this.options.port }, onReady);
    }

    this.socket.setNoDelay(true);
    if (this.options.idleTimeoutMs) this.socket.setTimeout(this.options.idleTimeoutMs);

    this.socket.on('data', (chunk: Buffer) => this.onData(chunk));
    this.socket.on('timeout', () => {
      this.emit('error', new Error('Connection idle timeout'));
      this.socket?.destroy();
    });
    this.socket.on('error', (err: Error) => this.emit('error', err));
    this.socket.on('close', (hadError: boolean) => {
      this.stopPump();
      this.queue.length = 0;
      this.emit('close', hadError);
    });

    this.startPump();
  }

  private onData(chunk: Buffer): void {
    // Accumulate as bytes and split on CRLF, so a multi-byte character straddling two
    // TCP segments is never decoded as two broken halves.
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);

    let start = 0;
    for (;;) {
      const nl = this.buffer.indexOf(0x0a, start); // \n
      if (nl === -1) break;
      let end = nl;
      if (end > start && this.buffer[end - 1] === 0x0d) end--; // \r
      const line = this.buffer.toString('utf8', start, end);
      start = nl + 1;
      if (line !== '') this.emit('line', line);
    }

    this.buffer = start === 0 ? this.buffer : this.buffer.subarray(start);

    if (this.buffer.length > MAX_LINE_BYTES) {
      this.emit('error', new Error('Oversized line from server; dropping connection'));
      this.socket?.destroy();
    }
  }

  /**
   * Queue a line for sending. Queuing many packs at once would otherwise trip the
   * server's flood protection and get us killed mid-session.
   */
  send(line: string): void {
    if (this.closed) return;
    // A newline inside a parameter would let the caller inject a second command.
    this.queue.push(line.replace(/[\r\n]/g, ' '));
    this.drain();
  }

  /** Bypass the queue, for time-critical lines such as PONG. */
  sendImmediate(line: string): void {
    if (!this.socket || this.socket.destroyed) return;
    this.socket.write(`${line.replace(/[\r\n]/g, ' ')}\r\n`);
  }

  private startPump(): void {
    this.stopPump();
    this.pump = setInterval(() => {
      if (this.tokens < this.burst) this.tokens++;
      this.drain();
    }, this.interval);
    this.pump.unref?.();
  }

  private stopPump(): void {
    if (this.pump) clearInterval(this.pump);
    this.pump = undefined;
  }

  private drain(): void {
    if (!this.socket || this.socket.destroyed) return;
    while (this.queue.length > 0 && this.tokens > 0) {
      const line = this.queue.shift()!;
      this.tokens--;
      this.socket.write(`${line}\r\n`);
    }
  }

  close(): void {
    this.closed = true;
    this.stopPump();
    this.queue.length = 0;
    this.socket?.destroy();
  }
}
