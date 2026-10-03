/**
 * A stand-in for an XDCC bot's DCC side: it streams bytes and collects the 4-byte
 * acknowledgements the receiver sends back. Speaks real DCC over a real socket, so the
 * tests exercise the same code path a live transfer would.
 */

import net from 'node:net';

export interface SenderHandle {
  port: number;
  /** Offset the next connection starts streaming from; set when honouring a RESUME. */
  offset: number;
  /** Every acknowledgement value received, in order. */
  acks: number[];
  /** Resolves once the sender has finished writing (or the socket died). */
  done: Promise<void>;
  close(): Promise<void>;
  /** Drop the connection after this many bytes, to simulate an interrupted transfer. */
  cutAfter?: number;
}

function collectAcks(socket: net.Socket, acks: number[]): void {
  let pending = Buffer.alloc(0);
  socket.on('data', (chunk) => {
    pending = Buffer.concat([pending, chunk]);
    while (pending.length >= 4) {
      acks.push(pending.readUInt32BE(0));
      pending = pending.subarray(4);
    }
  });
}

/** Active DCC: the bot listens, the client connects in. */
export async function startActiveSender(
  payload: Buffer,
  options: { chunkSize?: number; cutAfter?: number; chunkDelayMs?: number } = {},
): Promise<SenderHandle> {
  const chunkSize = options.chunkSize ?? 64 * 1024;
  const chunkDelayMs = options.chunkDelayMs ?? 0;
  const acks: number[] = [];
  let resolveDone!: () => void;
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });

  const handle: SenderHandle = {
    port: 0,
    offset: 0,
    acks,
    done,
    ...(options.cutAfter !== undefined ? { cutAfter: options.cutAfter } : {}),
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
      }),
  };

  const server = net.createServer((socket) => {
    collectAcks(socket, acks);
    void streamTo(socket, payload, handle, chunkSize, chunkDelayMs).then(resolveDone, resolveDone);
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  handle.port = typeof address === 'object' && address !== null ? address.port : 0;
  return handle;
}

/** Reverse DCC: the client listens, the bot connects out to it. */
export async function connectPassiveSender(
  host: string,
  port: number,
  payload: Buffer,
  options: { chunkSize?: number; cutAfter?: number } = {},
): Promise<SenderHandle> {
  const chunkSize = options.chunkSize ?? 64 * 1024;
  const acks: number[] = [];

  const socket = await new Promise<net.Socket>((resolve, reject) => {
    const s = net.connect({ host, port }, () => resolve(s));
    s.once('error', reject);
  });

  const handle: SenderHandle = {
    port,
    offset: 0,
    acks,
    done: Promise.resolve(),
    ...(options.cutAfter !== undefined ? { cutAfter: options.cutAfter } : {}),
    close: async () => {
      socket.destroy();
    },
  };

  collectAcks(socket, acks);
  handle.done = streamTo(socket, payload, handle, chunkSize);
  return handle;
}

async function streamTo(
  socket: net.Socket,
  payload: Buffer,
  handle: SenderHandle,
  chunkSize: number,
  chunkDelayMs = 0,
): Promise<void> {
  const limit = handle.cutAfter ?? payload.length;
  let sent = 0;

  for (let pos = handle.offset; pos < payload.length; pos += chunkSize) {
    if (socket.destroyed) return;
    const remaining = Math.min(chunkSize, payload.length - pos, limit - sent);
    if (remaining <= 0) break;
    const chunk = payload.subarray(pos, pos + remaining);
    sent += chunk.length;

    const ok = socket.write(chunk);
    if (!ok) await new Promise<void>((resolve) => socket.once('drain', resolve));
    // Pacing, so a test can observe a transfer while it is still running.
    if (chunkDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, chunkDelayMs));
    if (handle.cutAfter !== undefined && sent >= handle.cutAfter) {
      socket.destroy();
      return;
    }
  }

  await new Promise<void>((resolve) => socket.end(resolve));
}
