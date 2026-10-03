/**
 * The snapshot is what crosses the Electron IPC boundary, so the tests that matter are
 * "does it survive structured cloning" and "does it carry no live objects".
 */

import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Session } from '../src/app/session.js';
import { emptySnapshot, snapshotItem, snapshotSession } from '../src/app/snapshot.js';
import { ConfigSchema } from '../src/config.js';
import { Transfer } from '../src/dcc/transfer.js';
import type { QueueItem } from '../src/dcc/manager.js';

let dir: string;
let session: Session;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'fastxdcc-snap-'));
  session = new Session(
    ConfigSchema.parse({
      network: { host: '127.0.0.1', port: 6667, tls: false, nick: 'tester' },
      downloadDir: dir,
    }),
  );
});

afterEach(async () => {
  session.shutdown();
  await rm(dir, { recursive: true, force: true });
});

describe('snapshotItem', () => {
  it('drops the live transfer object', () => {
    const transfer = new Transfer({
      offer: { type: 'SEND', filename: 'a.bin', ip: '127.0.0.1', port: 1, size: 10 },
      botNick: 'bot',
      downloadDir: dir,
      sendCtcpRaw: () => {},
      passive: { portRange: [0, 0], listenTimeoutMs: 100 },
    });

    const item: QueueItem = {
      id: 'q1',
      bot: 'bot',
      pack: 1,
      state: 'transferring',
      attempts: 1,
      filename: 'a.bin',
      size: 100,
      bytesReceived: 50,
      speed: 1024,
      eta: 3,
      transfer,
    };

    const snap = snapshotItem(item);
    expect('transfer' in snap).toBe(false);
    expect(snap).toMatchObject({ id: 'q1', bot: 'bot', pack: 1, bytesReceived: 50 });
  });

  it('produces something structured-clone can carry over IPC', () => {
    const transfer = new Transfer({
      offer: { type: 'SEND', filename: 'a.bin', ip: '127.0.0.1', port: 1, size: 10 },
      botNick: 'bot',
      downloadDir: dir,
      sendCtcpRaw: () => {},
      passive: { portRange: [0, 0], listenTimeoutMs: 100 },
    });
    const item: QueueItem = { id: 'q1', bot: 'b', pack: 1, state: 'waiting', attempts: 0, transfer };

    // The raw item cannot cross the boundary; the snapshot must.
    expect(() => structuredClone(item)).toThrow();
    expect(() => structuredClone(snapshotItem(item))).not.toThrow();
  });

  it('carries the fields a GUI row needs', () => {
    const item: QueueItem = {
      id: 'q2',
      bot: 'bot',
      pack: 5,
      state: 'completed',
      attempts: 2,
      filename: 'show.mkv',
      finalPath: path.join(dir, 'show.mkv'),
      passive: true,
      position: 3,
      total: 8,
      note: 'reverse DCC',
      error: undefined,
    };
    const snap = snapshotItem(item);
    expect(snap.finalPath).toBe(item.finalPath);
    expect(snap.passive).toBe(true);
    expect(snap.position).toBe(3);
    expect(snap.total).toBe(8);
    expect('error' in snap).toBe(false);
  });
});

describe('snapshotSession', () => {
  const ID = 'irc.example.net:6667';

  it('captures connection state, queue, and log', () => {
    session.store.log('info', '*', 'hello from the log');
    session.manager.enqueue('packbot', [1, 2]);

    const snap = snapshotSession(session, ID);
    expect(snap.id).toBe(ID);
    expect(snap.label).toBe('127.0.0.1');
    expect(snap.items).toHaveLength(2);
    expect(snap.items[0]).toMatchObject({ bot: 'packbot', pack: 1 });
    expect(snap.log.some((l) => l.text === 'hello from the log')).toBe(true);
    expect(() => structuredClone(snap)).not.toThrow();
  });

  it('counts the transfers that are actually moving', () => {
    const [a, b] = session.manager.enqueue('packbot', [1, 2]);
    expect(snapshotSession(session, ID).activeTransfers).toBe(0);
    a!.state = 'transferring';
    b!.state = 'botQueued';
    expect(snapshotSession(session, ID).activeTransfers).toBe(1);
  });

  it('limits how much log it ships', () => {
    for (let i = 0; i < 50; i++) session.store.log('info', '*', `line ${i}`);
    expect(snapshotSession(session, ID, 10).log).toHaveLength(10);
  });
});

describe('emptySnapshot', () => {
  it('describes a GUI with no connections yet', () => {
    const snap = emptySnapshot('/downloads');
    expect(snap.sessions).toEqual([]);
    expect(snap.downloadDir).toBe('/downloads');
    expect(() => structuredClone(snap)).not.toThrow();
  });
});
