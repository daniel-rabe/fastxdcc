import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { formatDccAccept, formatDccSend, parseDcc } from '../src/dcc/ctcp.js';
import { TransferManager, type QueueItem } from '../src/dcc/manager.js';
import { startActiveSender, type SenderHandle } from './helpers/fakeBot.js';

let dir: string;
let sent: Array<{ target: string; text: string }>;
let ctcps: Array<{ target: string; body: string }>;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'fastxdcc-mgr-'));
  sent = [];
  ctcps = [];
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function makeManager(overrides: Partial<ConstructorParameters<typeof TransferManager>[0]> = {}) {
  return new TransferManager({
    downloadDir: dir,
    maxConcurrent: 2,
    maxRetries: 0,
    passive: { portRange: [0, 0], listenTimeoutMs: 2_000 },
    sendMessage: (target, text) => sent.push({ target, text }),
    sendCtcpRaw: (target, body) => ctcps.push({ target, body }),
    requestTimeoutMs: 0,
    ...overrides,
  });
}

/** Wait until `predicate` holds, polling briefly. */
async function until(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Like `until`, for a condition that has to be awaited. */
async function untilAsync(predicate: () => Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error('Condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function offerFor(port: number, size: number, filename = 'payload.bin'): string {
  return formatDccSend({ filename, ip: '127.0.0.1', port, size }).slice('DCC '.length);
}

describe('queueing', () => {
  it('sends an xdcc request for each queued pack', () => {
    const manager = makeManager();
    manager.enqueue('bot', [1]);
    expect(sent).toEqual([{ target: 'bot', text: 'xdcc send #1' }]);
  });

  it('expands and deduplicates a multi-pack request', () => {
    const manager = makeManager({ maxConcurrent: 10 });
    manager.enqueue('bot', [1, 2, 3]);
    // Same bot, so the requests are serialised: only the first goes out now.
    expect(sent).toHaveLength(1);
    expect(manager.items).toHaveLength(3);

    manager.enqueue('bot', [1]);
    expect(manager.items).toHaveLength(3);
  });

  it('serialises requests to the same bot', () => {
    const manager = makeManager({ maxConcurrent: 5 });
    manager.enqueue('bot', [1, 2]);
    expect(sent.filter((m) => m.target === 'bot')).toHaveLength(1);
  });

  it('runs requests to different bots in parallel, up to the limit', () => {
    const manager = makeManager({ maxConcurrent: 2 });
    manager.enqueue('botA', [1]);
    manager.enqueue('botB', [1]);
    manager.enqueue('botC', [1]);
    expect(sent.map((m) => m.target)).toEqual(['botA', 'botB']);
  });
});

describe('bot notices', () => {
  it('records a queue position without failing the item', () => {
    const manager = makeManager();
    const [item] = manager.enqueue('bot', [1]) as [QueueItem];
    manager.handleNotice('bot', '** All Slots Full, Added you to the queue in position 4 of 9');
    expect(item.state).toBe('botQueued');
    expect(item.position).toBe(4);
    expect(item.total).toBe(9);
  });

  it('fails an item outright when the bot denies it', () => {
    const manager = makeManager();
    const [item] = manager.enqueue('bot', [1]) as [QueueItem];
    manager.handleNotice('bot', '** XDCC SEND denied, you must be on a known channel');
    expect(item.state).toBe('failed');
    expect(item.error).toMatch(/known channel/);
  });

  it('fails an item when the pack number is invalid', () => {
    const manager = makeManager();
    const [item] = manager.enqueue('bot', [999]) as [QueueItem];
    manager.handleNotice('bot', '** The Pack Number You Requested Is Invalid');
    expect(item.state).toBe('failed');
  });

  it('leaves state alone for chatter it does not recognise', () => {
    const manager = makeManager();
    const [item] = manager.enqueue('bot', [1]) as [QueueItem];
    manager.handleNotice('bot', '** Bandwidth limit reached, please be patient');
    expect(item.state).toBe('requested');
  });

  it('starts the next item once one is denied', () => {
    const manager = makeManager({ maxConcurrent: 1 });
    manager.enqueue('bot', [1, 2]);
    manager.handleNotice('bot', '** XDCC SEND denied, no reason given');
    expect(sent.map((m) => m.text)).toEqual(['xdcc send #1', 'xdcc send #2']);
  });
});

describe('offers', () => {
  it('downloads a pack end to end', async () => {
    const payload = randomBytes(128 * 1024);
    const sender = await startActiveSender(payload);

    const manager = makeManager();
    const [item] = manager.enqueue('bot', [1]) as [QueueItem];
    manager.handleCtcp('bot', 'DCC', offerFor(sender.port, payload.length));

    await until(() => item.state === 'completed' || item.state === 'failed');
    await sender.close();

    expect(item.state).toBe('completed');
    const written = await readFile(path.join(dir, 'payload.bin'));
    expect(written.equals(payload)).toBe(true);
  });

  it('ignores an offer nobody asked for', () => {
    const manager = makeManager();
    const status = vi.fn();
    manager.on('status', status);
    manager.handleCtcp('stranger', 'DCC', offerFor(1234, 10));
    expect(manager.items).toHaveLength(0);
    expect(status).toHaveBeenCalledWith(expect.stringMatching(/unsolicited/i));
  });

  it('matches the offer to the bot that was asked, not another one', () => {
    const manager = makeManager();
    const [item] = manager.enqueue('botA', [1]) as [QueueItem];
    manager.handleCtcp('botB', 'DCC', offerFor(1234, 10));
    expect(item.state).toBe('requested');
  });

  it('starts the next queued pack after one finishes', async () => {
    const payload = randomBytes(32 * 1024);
    const sender = await startActiveSender(payload);

    const manager = makeManager({ maxConcurrent: 1 });
    manager.enqueue('bot', [1, 2]);
    manager.handleCtcp('bot', 'DCC', offerFor(sender.port, payload.length));

    await until(() => sent.length === 2);
    await sender.close();
    expect(sent.map((m) => m.text)).toEqual(['xdcc send #1', 'xdcc send #2']);
  });

  it('survives an unparsable DCC message', () => {
    const manager = makeManager();
    const status = vi.fn();
    manager.on('status', status);
    manager.enqueue('bot', [1]);
    manager.handleCtcp('bot', 'DCC', 'SEND onlyafilename');
    expect(status).toHaveBeenCalledWith(expect.stringMatching(/Unparsable DCC/));
    expect(manager.items[0]!.state).toBe('requested');
  });
});

describe('cancelling', () => {
  it('tells the bot to drop a pack that is still queued there', () => {
    const manager = makeManager();
    const [item] = manager.enqueue('bot', [1]) as [QueueItem];
    manager.handleNotice('bot', '** Added you to the queue in position 2');

    expect(manager.cancel(item.id)).toBe(1);
    expect(item.state).toBe('cancelled');
    expect(sent.at(-1)).toEqual({ target: 'bot', text: 'xdcc remove #1' });
  });

  it('cancels everything when no id is given', () => {
    const manager = makeManager();
    manager.enqueue('botA', [1]);
    manager.enqueue('botB', [2]);
    expect(manager.cancel()).toBe(2);
    expect(manager.items.every((i) => i.state === 'cancelled')).toBe(true);
  });

  it('keeps the partial file by default, and deletes it when asked to discard', async () => {
    const payload = randomBytes(200 * 1024);
    // Paced so the transfer is still running when it is cancelled.
    const sender = await startActiveSender(payload, { chunkSize: 4 * 1024, chunkDelayMs: 15 });

    const manager = makeManager();
    const [item] = manager.enqueue('bot', [1]) as [QueueItem];
    manager.handleCtcp('bot', 'DCC', offerFor(sender.port, payload.length));

    // Cancel once bytes have actually reached the .part file.
    await untilAsync(async () => {
      const info = await stat(path.join(dir, 'payload.bin.part')).catch(() => null);
      return info !== null && info.size > 0;
    });
    const transfer = item.transfer;
    manager.cancel(item.id);
    await sender.close();

    expect(item.state).toBe('cancelled');
    const partPath = path.join(dir, 'payload.bin.part');
    await expect(stat(partPath)).resolves.toBeTruthy();

    // Now discard it explicitly.
    expect(await transfer!.discardPartial()).toBe(true);
    await expect(stat(partPath)).rejects.toThrow();
  });

  it('clears finished rows', () => {
    const manager = makeManager();
    manager.enqueue('botA', [1]);
    manager.cancel();
    expect(manager.clearFinished()).toBe(1);
    expect(manager.items).toHaveLength(0);
  });
});

describe('retries', () => {
  it('retries a failed transfer and resumes rather than starting over', async () => {
    const payload = randomBytes(200 * 1024);
    const cutAfter = 60 * 1024;

    let manager!: TransferManager;
    let good: SenderHandle | undefined;

    // Answer DCC RESUME the way a bot does: accept the offset and stream from there.
    const respondToResume = (body: string) => {
      const msg = parseDcc(body.slice('DCC '.length));
      if (msg?.type !== 'RESUME' || !good) return;
      good.offset = msg.position;
      const accept = formatDccAccept({
        filename: msg.filename,
        port: msg.port,
        position: msg.position,
      });
      setImmediate(() => manager.handleCtcp('bot', 'DCC', accept.slice('DCC '.length)));
    };

    manager = makeManager({
      maxRetries: 1,
      resumeTimeoutMs: 2_000,
      sendCtcpRaw: (target, body) => {
        ctcps.push({ target, body });
        respondToResume(body);
      },
    });

    // First attempt: the sender hangs up part-way through.
    const broken = await startActiveSender(payload, { chunkSize: 8 * 1024, cutAfter });
    const [item] = manager.enqueue('bot', [1]) as [QueueItem];

    manager.handleCtcp('bot', 'DCC', offerFor(broken.port, payload.length));
    await until(() => sent.length === 2, 10_000);
    await broken.close();

    // Second attempt: a healthy sender that honours the resume offset.
    good = await startActiveSender(payload, { chunkSize: 8 * 1024 });
    manager.handleCtcp('bot', 'DCC', offerFor(good.port, payload.length));
    await until(() => item.state === 'completed' || item.state === 'failed', 10_000);
    await good.close();

    expect(item.state).toBe('completed');
    expect(ctcps.some((c) => c.body.startsWith('DCC RESUME'))).toBe(true);
    // The resumed half must line up with the half already on disk.
    const written = await readFile(path.join(dir, 'payload.bin'));
    expect(written.equals(payload)).toBe(true);
  });
});
