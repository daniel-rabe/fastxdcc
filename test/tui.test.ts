/**
 * Renders the real Ink tree against stub streams. TypeScript cannot catch an invalid Ink
 * prop or a crash inside a component, so this asserts that a frame actually comes out and
 * contains what the panes are supposed to show.
 */

import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Session } from '../src/app/session.js';
import { ConfigSchema } from '../src/config.js';
import { App } from '../src/tui/app.js';
import {
  ellipsize,
  formatBytes,
  formatEta,
  formatPercent,
  formatSpeed,
  progressBar,
} from '../src/tui/format.js';

describe('formatting helpers', () => {
  it('scales byte counts', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1023)).toBe('1023 B');
    expect(formatBytes(1024)).toBe('1.0 KiB');
    expect(formatBytes(1536)).toBe('1.5 KiB');
    expect(formatBytes(1024 ** 3 * 2)).toBe('2.0 GiB');
  });

  it('formats speeds and unknown speeds', () => {
    expect(formatSpeed(1024)).toBe('1.0 KiB/s');
    expect(formatSpeed(0)).toBe('--');
  });

  it('formats an ETA, including hours and the unknown case', () => {
    expect(formatEta(0)).toBe('00:00');
    expect(formatEta(65)).toBe('01:05');
    expect(formatEta(3725)).toBe('1:02:05');
    expect(formatEta(null)).toBe('--:--');
    expect(formatEta(Infinity)).toBe('--:--');
  });

  it('draws a bar of the requested width and clamps out-of-range fractions', () => {
    expect(progressBar(0, 10)).toHaveLength(10);
    expect(progressBar(0.5, 10)).toBe('█████░░░░░');
    expect(progressBar(2, 10)).toBe('██████████');
    expect(progressBar(-1, 10)).toBe('░░░░░░░░░░');
  });

  it('formats a percentage in a fixed width', () => {
    expect(formatPercent(0, 100)).toBe('  0%');
    expect(formatPercent(50, 100)).toBe(' 50%');
    expect(formatPercent(100, 100)).toBe('100%');
    expect(formatPercent(0, 0)).toBe('  0%');
  });

  it('shortens long names from the middle, keeping the extension', () => {
    const short = ellipsize('a-very-long-file-name-indeed.mkv', 20);
    expect(short.length).toBeLessThanOrEqual(20);
    expect(short.endsWith('.mkv')).toBe(true);
    expect(ellipsize('short.mkv', 20)).toBe('short.mkv');
  });
});

/** Minimal stdout/stdin doubles that satisfy Ink outside a real terminal. */
function makeStreams() {
  const frames: string[] = [];

  // `isTTY` matters: without it Ink treats the stream as a log file and writes a single
  // frame at unmount instead of rendering incrementally.
  const stdout = Object.assign(new EventEmitter(), {
    write: (chunk: string) => {
      frames.push(chunk);
      return true;
    },
    isTTY: true,
    columns: 120,
    rows: 30,
  });

  const stdin = Object.assign(new EventEmitter(), {
    isTTY: true,
    setRawMode: () => stdin,
    setEncoding: () => stdin,
    resume: () => stdin,
    pause: () => stdin,
    read: () => null,
    ref: () => {},
    unref: () => {},
  });

  // Ink's last write is just the show-cursor escape, so join everything it emitted.
  return { stdout, stdin, frames, output: () => frames.join('') };
}

describe('App rendering', () => {
  let dir: string;
  let session: Session;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'fastxdcc-tui-'));
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

  async function renderApp() {
    const { render } = await import('ink');
    const streams = makeStreams();
    const instance = render(React.createElement(App, { session }), {
      stdout: streams.stdout as never,
      stdin: streams.stdin as never,
      exitOnCtrlC: false,
      patchConsole: false,
    });
    // Let Ink flush a frame, then unmount so the final frame is written too.
    await new Promise((resolve) => setTimeout(resolve, 100));
    instance.unmount();
    return { ...streams, instance };
  }

  it('renders a frame with the status bar and the prompt', async () => {
    const frame = (await renderApp()).output();

    expect(frame).toContain('fastxdcc');
    expect(frame).toContain('127.0.0.1:6667');
    expect(frame).toContain('disconnected');
  });

  it('tells the user how to start when the queue is empty', async () => {
    const frame = (await renderApp()).output();
    expect(frame).toContain('/get');
  });

  it('shows queued items and log lines', async () => {
    session.store.log('info', '*', 'a log line for the pane');
    session.manager.enqueue('packbot', [7]);

    const frame = (await renderApp()).output();

    expect(frame).toContain('packbot #7');
    expect(frame).toContain('a log line for the pane');
  });

  it('renders a progress bar for a running transfer', async () => {
    const [item] = session.manager.enqueue('packbot', [1]);
    Object.assign(item!, {
      state: 'transferring',
      filename: 'episode.mkv',
      size: 1024 * 1024,
      bytesReceived: 512 * 1024,
      speed: 2 * 1024 * 1024,
      eta: 30,
    });

    const frame = (await renderApp()).output();

    expect(frame).toContain('episode.mkv');
    expect(frame).toContain('50%');
    expect(frame).toContain('2.0 MiB/s');
    expect(frame).toContain('█');
  });
});
