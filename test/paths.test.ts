import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FALLBACK_FILENAME, planTarget, resolveTarget, sanitizeFilename } from '../src/dcc/paths.js';

describe('sanitizeFilename', () => {
  it('keeps an ordinary name unchanged', () => {
    expect(sanitizeFilename('My.Show.S01E01.1080p.mkv')).toBe('My.Show.S01E01.1080p.mkv');
  });

  it('strips directory components in both conventions', () => {
    expect(sanitizeFilename('sub/dir/file.bin')).toBe('file.bin');
    expect(sanitizeFilename('sub\\dir\\file.bin')).toBe('file.bin');
  });

  it('defuses traversal', () => {
    expect(sanitizeFilename('../../../etc/passwd')).toBe('passwd');
    expect(sanitizeFilename('..\\..\\Windows\\System32\\drivers\\etc\\hosts')).toBe('hosts');
    expect(sanitizeFilename('..')).toBe(FALLBACK_FILENAME);
    expect(sanitizeFilename('.')).toBe(FALLBACK_FILENAME);
  });

  it('cuts at a NUL byte', () => {
    expect(sanitizeFilename('safe.txt\u0000.exe')).toBe('safe.txt');
  });

  it('removes control characters', () => {
    expect(sanitizeFilename('we\u0007ird\u001bname.bin')).toBe('weirdname.bin');
  });

  it('replaces characters Windows forbids', () => {
    expect(sanitizeFilename('a<b>c:d"e|f?g*h.bin')).toBe('a_b_c_d_e_f_g_h.bin');
  });

  it('escapes Windows device names', () => {
    expect(sanitizeFilename('CON')).toBe('_CON');
    expect(sanitizeFilename('nul.txt')).toBe('_nul.txt');
    expect(sanitizeFilename('COM1.bin')).toBe('_COM1.bin');
    expect(sanitizeFilename('console.bin')).toBe('console.bin');
  });

  it('drops trailing dots and spaces, which Windows silently discards', () => {
    expect(sanitizeFilename('file.bin...')).toBe('file.bin');
    expect(sanitizeFilename('file.bin   ')).toBe('file.bin');
  });

  it('never returns an empty name', () => {
    expect(sanitizeFilename('')).toBe(FALLBACK_FILENAME);
    expect(sanitizeFilename('   ')).toBe(FALLBACK_FILENAME);
    expect(sanitizeFilename('\u0000')).toBe(FALLBACK_FILENAME);
  });

  it('truncates absurd names while keeping the extension', () => {
    const name = sanitizeFilename(`${'a'.repeat(500)}.mkv`);
    expect(Buffer.byteLength(name)).toBeLessThanOrEqual(200);
    expect(name.endsWith('.mkv')).toBe(true);
  });

  it('does not split a multi-byte character when truncating', () => {
    const name = sanitizeFilename(`${'é'.repeat(300)}.mkv`);
    expect(Buffer.from(name, 'utf8').toString('utf8')).toBe(name);
  });
});

describe('resolveTarget', () => {
  it('produces a .part sibling inside the download directory', () => {
    const target = resolveTarget('/downloads', 'file.bin');
    expect(target.finalPath).toBe(path.resolve('/downloads/file.bin'));
    expect(target.partPath).toBe(`${target.finalPath}.part`);
  });

  it('confines a traversal attempt to the download directory', () => {
    const target = resolveTarget('/downloads', '../../../../etc/passwd');
    expect(target.finalPath).toBe(path.resolve('/downloads/passwd'));
  });
});

describe('planTarget', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'fastxdcc-paths-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('starts at zero when nothing is on disk', async () => {
    const plan = await planTarget(dir, 'file.bin', 1000);
    expect(plan.resumeFrom).toBe(0);
    expect(plan.alreadyComplete).toBe(false);
  });

  it('resumes from the size of an existing .part file', async () => {
    await writeFile(path.join(dir, 'file.bin.part'), Buffer.alloc(400));
    const plan = await planTarget(dir, 'file.bin', 1000);
    expect(plan.resumeFrom).toBe(400);
  });

  it('restarts when the .part file is at or past the expected size', async () => {
    await writeFile(path.join(dir, 'file.bin.part'), Buffer.alloc(1000));
    expect((await planTarget(dir, 'file.bin', 1000)).resumeFrom).toBe(0);

    await writeFile(path.join(dir, 'file.bin.part'), Buffer.alloc(2000));
    expect((await planTarget(dir, 'file.bin', 1000)).resumeFrom).toBe(0);
  });

  it('reports an already-downloaded file rather than fetching it again', async () => {
    await writeFile(path.join(dir, 'file.bin'), Buffer.alloc(1000));
    const plan = await planTarget(dir, 'file.bin', 1000);
    expect(plan.alreadyComplete).toBe(true);
  });

  it('picks a suffixed name rather than clobbering a different file', async () => {
    await writeFile(path.join(dir, 'file.bin'), Buffer.alloc(77));
    const plan = await planTarget(dir, 'file.bin', 1000);
    expect(plan.filename).toBe('file (2).bin');
    expect(plan.alreadyComplete).toBe(false);
  });
});
