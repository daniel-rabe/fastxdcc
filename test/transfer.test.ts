/**
 * End-to-end transfer tests over real sockets and a real filesystem, with a stand-in for
 * the bot. Nothing here touches the network beyond loopback.
 */

import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseDcc, type DccAccept, type DccSend } from '../src/dcc/ctcp.js';
import { Transfer } from '../src/dcc/transfer.js';
import { connectPassiveSender, startActiveSender } from './helpers/fakeBot.js';

const PASSIVE = { portRange: [0, 0] as [number, number], listenTimeoutMs: 5_000 };

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'fastxdcc-xfer-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function offer(over: Partial<DccSend> & { port: number; size: number }): DccSend {
  return {
    type: 'SEND',
    filename: 'payload.bin',
    ip: '127.0.0.1',
    ...over,
  } as DccSend;
}

describe('active DCC', () => {
  it('downloads a file byte for byte', async () => {
    const payload = randomBytes(512 * 1024);
    const sender = await startActiveSender(payload);

    const transfer = new Transfer({
      offer: offer({ port: sender.port, size: payload.length }),
      botNick: 'bot',
      downloadDir: dir,
      sendCtcpRaw: () => {},
      passive: PASSIVE,
    });

    await transfer.start();
    await sender.close();

    expect(transfer.state).toBe('completed');
    const written = await readFile(path.join(dir, 'payload.bin'));
    expect(written.equals(payload)).toBe(true);
  });

  it('removes the .part file once the download completes', async () => {
    const payload = randomBytes(64 * 1024);
    const sender = await startActiveSender(payload);

    const transfer = new Transfer({
      offer: offer({ port: sender.port, size: payload.length }),
      botNick: 'bot',
      downloadDir: dir,
      sendCtcpRaw: () => {},
      passive: PASSIVE,
    });

    await transfer.start();
    await sender.close();

    await expect(stat(path.join(dir, 'payload.bin.part'))).rejects.toThrow();
  });

  it('acknowledges the bytes it received', async () => {
    const payload = randomBytes(256 * 1024);
    const sender = await startActiveSender(payload, { chunkSize: 16 * 1024 });

    const transfer = new Transfer({
      offer: offer({ port: sender.port, size: payload.length }),
      botNick: 'bot',
      downloadDir: dir,
      sendCtcpRaw: () => {},
      passive: PASSIVE,
      ackIntervalMs: 10,
    });

    await transfer.start();
    await sender.done;
    await sender.close();

    expect(sender.acks.length).toBeGreaterThan(0);
    expect(sender.acks.at(-1)).toBe(payload.length);
  });

  it('keeps the partial file when the sender disappears mid-transfer', async () => {
    const payload = randomBytes(256 * 1024);
    const cutAfter = 100 * 1024;
    const sender = await startActiveSender(payload, { chunkSize: 16 * 1024, cutAfter });

    const transfer = new Transfer({
      offer: offer({ port: sender.port, size: payload.length }),
      botNick: 'bot',
      downloadDir: dir,
      sendCtcpRaw: () => {},
      passive: PASSIVE,
    });

    await transfer.start();
    await sender.close();

    expect(transfer.state).toBe('failed');
    const partial = await stat(path.join(dir, 'payload.bin.part'));
    expect(partial.size).toBeGreaterThan(0);
    expect(partial.size).toBeLessThan(payload.length);
  });
});

describe('DCC RESUME', () => {
  it('negotiates a resume and finishes the file correctly', async () => {
    const payload = randomBytes(300 * 1024);
    const alreadyHave = 120 * 1024;
    await writeFile(path.join(dir, 'payload.bin.part'), payload.subarray(0, alreadyHave));

    const sender = await startActiveSender(payload);
    const sent: string[] = [];

    const transfer = new Transfer({
      offer: offer({ port: sender.port, size: payload.length }),
      botNick: 'bot',
      downloadDir: dir,
      passive: PASSIVE,
      sendCtcpRaw: (_target, body) => {
        sent.push(body);
        const msg = parseDcc(body.slice('DCC '.length));
        if (msg?.type !== 'RESUME') return;
        // Answer like a bot would: accept the offset and stream from there.
        sender.offset = msg.position;
        setImmediate(() => {
          transfer.handleAccept({
            type: 'ACCEPT',
            filename: msg.filename,
            port: msg.port,
            position: msg.position,
          } satisfies DccAccept);
        });
      },
    });

    await transfer.start();
    await sender.close();

    expect(sent.some((s) => s.startsWith('DCC RESUME'))).toBe(true);
    expect(transfer.state).toBe('completed');
    expect(transfer.startOffset).toBe(alreadyHave);

    const written = await readFile(path.join(dir, 'payload.bin'));
    expect(written.equals(payload)).toBe(true);
  });

  it('restarts from the beginning when the bot never sends ACCEPT', async () => {
    const payload = randomBytes(64 * 1024);
    await writeFile(path.join(dir, 'payload.bin.part'), payload.subarray(0, 8 * 1024));

    const sender = await startActiveSender(payload);

    const transfer = new Transfer({
      offer: offer({ port: sender.port, size: payload.length }),
      botNick: 'bot',
      downloadDir: dir,
      passive: PASSIVE,
      sendCtcpRaw: () => {}, // deliberately silent
      resumeTimeoutMs: 150,
    });

    await transfer.start();
    await sender.close();

    expect(transfer.startOffset).toBe(0);
    expect(transfer.state).toBe('completed');
    const written = await readFile(path.join(dir, 'payload.bin'));
    expect(written.equals(payload)).toBe(true);
  });

  it('truncates the partial file when the bot accepts an earlier offset', async () => {
    const payload = randomBytes(200 * 1024);
    await writeFile(path.join(dir, 'payload.bin.part'), payload.subarray(0, 100 * 1024));
    const acceptedAt = 40 * 1024;

    const sender = await startActiveSender(payload);

    const transfer = new Transfer({
      offer: offer({ port: sender.port, size: payload.length }),
      botNick: 'bot',
      downloadDir: dir,
      passive: PASSIVE,
      sendCtcpRaw: (_target, body) => {
        const msg = parseDcc(body.slice('DCC '.length));
        if (msg?.type !== 'RESUME') return;
        sender.offset = acceptedAt;
        setImmediate(() => {
          transfer.handleAccept({
            type: 'ACCEPT',
            filename: msg.filename,
            port: msg.port,
            position: acceptedAt,
          });
        });
      },
    });

    await transfer.start();
    await sender.close();

    expect(transfer.startOffset).toBe(acceptedAt);
    const written = await readFile(path.join(dir, 'payload.bin'));
    expect(written.equals(payload)).toBe(true);
  });
});

describe('reverse (passive) DCC', () => {
  it('listens, advertises the port with the token, and receives the file', async () => {
    const payload = randomBytes(256 * 1024);
    const token = '4242';
    let reply: DccSend | undefined;

    const transfer = new Transfer({
      offer: offer({ port: 0, size: payload.length, token }),
      botNick: 'bot',
      downloadDir: dir,
      passive: PASSIVE,
      fallbackLocalIp: '127.0.0.1',
      sendCtcpRaw: (_target, body) => {
        const msg = parseDcc(body.slice('DCC '.length));
        if (msg?.type !== 'SEND') return;
        reply = msg;
        // The bot now connects to the address we advertised.
        void connectPassiveSender('127.0.0.1', msg.port, payload);
      },
    });

    await transfer.start();

    expect(reply).toBeDefined();
    expect(reply!.token).toBe(token);
    expect(reply!.port).toBeGreaterThan(0);
    expect(transfer.state).toBe('completed');

    const written = await readFile(path.join(dir, 'payload.bin'));
    expect(written.equals(payload)).toBe(true);
  });

  it('fails cleanly when the bot never connects back', async () => {
    const transfer = new Transfer({
      offer: offer({ port: 0, size: 1024, token: '1' }),
      botNick: 'bot',
      downloadDir: dir,
      passive: { portRange: [0, 0], listenTimeoutMs: 200 },
      fallbackLocalIp: '127.0.0.1',
      sendCtcpRaw: () => {},
    });

    await transfer.start();
    expect(transfer.state).toBe('failed');
    expect(transfer.error?.message).toMatch(/did not connect back/);
  });

  it('refuses reverse DCC when it has no address to advertise', async () => {
    const transfer = new Transfer({
      offer: offer({ port: 0, size: 1024, token: '1' }),
      botNick: 'bot',
      downloadDir: dir,
      passive: { portRange: [0, 0], listenTimeoutMs: 200 },
      sendCtcpRaw: () => {},
    });

    await transfer.start();
    expect(transfer.state).toBe('failed');
    expect(transfer.error?.message).toMatch(/externalIp/);
  });
});

describe('guards', () => {
  it('skips a file that is already downloaded', async () => {
    const payload = randomBytes(4096);
    await writeFile(path.join(dir, 'payload.bin'), payload);

    const transfer = new Transfer({
      offer: offer({ port: 1, size: payload.length }),
      botNick: 'bot',
      downloadDir: dir,
      passive: PASSIVE,
      sendCtcpRaw: () => {},
    });

    await transfer.start();
    expect(transfer.state).toBe('completed');
  });

  it('writes inside the download directory even when the name traverses', async () => {
    const payload = randomBytes(2048);
    const sender = await startActiveSender(payload);

    const transfer = new Transfer({
      offer: offer({ port: sender.port, size: payload.length, filename: '../../escaped.bin' }),
      botNick: 'bot',
      downloadDir: dir,
      passive: PASSIVE,
      sendCtcpRaw: () => {},
    });

    await transfer.start();
    await sender.close();

    expect(transfer.finalPath).toBe(path.join(dir, 'escaped.bin'));
    const written = await readFile(path.join(dir, 'escaped.bin'));
    expect(written.equals(payload)).toBe(true);
  });

  it('aborts when the sender exceeds the announced size', async () => {
    const payload = randomBytes(64 * 1024);
    const sender = await startActiveSender(payload, { chunkSize: 4096 });

    const transfer = new Transfer({
      // Claim the file is far smaller than what the sender will actually push.
      offer: offer({ port: sender.port, size: 8 * 1024 }),
      botNick: 'bot',
      downloadDir: dir,
      passive: PASSIVE,
      sendCtcpRaw: () => {},
    });

    await transfer.start();
    await sender.close();

    expect(transfer.state).toBe('failed');
  });
});
