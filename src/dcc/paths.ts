/**
 * Turning a bot-supplied filename into a path we are willing to write to.
 *
 * The filename in a DCC SEND is attacker-controlled: it can contain path separators,
 * `..`, NUL bytes, or Windows device names. Everything here is deliberately paranoid,
 * and `resolveTarget` re-checks containment after resolution rather than trusting the
 * sanitiser alone.
 */

import { stat } from 'node:fs/promises';
import path from 'node:path';

/** Windows device names are unusable as filenames even with an extension appended. */
const RESERVED = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
]);

const MAX_NAME_BYTES = 200;

export const FALLBACK_FILENAME = 'download.bin';

/** Split `name.tar.gz` into `['name', '.tar.gz']`, but only for short, sane extensions. */
function splitExtension(name: string): [string, string] {
  const match = /^(.*?)((?:\.[A-Za-z0-9]{1,8}){1,2})$/.exec(name);
  if (!match || match[1] === '') return [name, ''];
  return [match[1]!, match[2]!];
}

/** Truncate to a byte budget without splitting a multi-byte character. */
function truncateBytes(value: string, limit: number): string {
  if (Buffer.byteLength(value, 'utf8') <= limit) return value;
  let out = value;
  while (out.length > 0 && Buffer.byteLength(out, 'utf8') > limit) {
    out = out.slice(0, -1);
  }
  return out;
}

/**
 * Reduce an arbitrary string to a single safe path component.
 * Never returns an empty string, `.`, or `..`.
 */
export function sanitizeFilename(raw: string): string {
  let name = raw;

  // Cut at the first NUL; anything past it is not part of the intended name.
  const nul = name.indexOf('\0');
  if (nul !== -1) name = name.slice(0, nul);

  // Drop any directory component, for both separator conventions.
  name = name.replace(/\\/g, '/');
  const lastSlash = name.lastIndexOf('/');
  if (lastSlash !== -1) name = name.slice(lastSlash + 1);

  // Strip control characters and the characters Windows forbids outright.
  // eslint-disable-next-line no-control-regex
  name = name.replace(/[\u0000-\u001f\u007f]/g, '');
  name = name.replace(/[<>:"|?*]/g, '_');

  // Windows silently drops trailing dots and spaces, which would desynchronise the
  // name we think we wrote from the name on disk.
  name = name.replace(/[. ]+$/, '');
  name = name.replace(/^[ ]+/, '');

  if (name === '' || name === '.' || name === '..') return FALLBACK_FILENAME;

  const [stem, ext] = splitExtension(name);
  if (RESERVED.has(stem.toUpperCase())) {
    name = `_${name}`;
  }

  if (Buffer.byteLength(name, 'utf8') > MAX_NAME_BYTES) {
    const [longStem, longExt] = splitExtension(name);
    const budget = Math.max(1, MAX_NAME_BYTES - Buffer.byteLength(longExt, 'utf8'));
    name = truncateBytes(longStem, budget) + longExt;
  }

  // Truncation can reintroduce a trailing dot or empty the name entirely.
  name = name.replace(/[. ]+$/, '');
  return name === '' ? FALLBACK_FILENAME : name;
}

export class UnsafePathError extends Error {}

export interface Target {
  /** Sanitised filename, with no directory component. */
  filename: string;
  /** Absolute path the completed file is renamed to. */
  finalPath: string;
  /** Absolute path bytes are written to while the transfer runs. */
  partPath: string;
}

/**
 * Resolve `rawFilename` inside `downloadDir` and prove the result stays inside it.
 * The containment check is what actually stops traversal; sanitising is belt and braces.
 */
export function resolveTarget(downloadDir: string, rawFilename: string): Target {
  const filename = sanitizeFilename(rawFilename);
  const root = path.resolve(downloadDir);
  const finalPath = path.resolve(root, filename);

  const rel = path.relative(root, finalPath);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new UnsafePathError(`Refusing to write outside the download directory: ${rawFilename}`);
  }

  return { filename, finalPath, partPath: `${finalPath}.part` };
}

/** Insert ` (n)` before the extension: `show.mkv` -> `show (2).mkv`. */
export function withSuffix(filename: string, n: number): string {
  const [stem, ext] = splitExtension(filename);
  return `${stem} (${n})${ext}`;
}

async function sizeOf(file: string): Promise<number | null> {
  try {
    const info = await stat(file);
    return info.isFile() ? info.size : null;
  } catch {
    return null;
  }
}

export interface TargetPlan extends Target {
  /** Byte offset to resume from; 0 for a fresh transfer. */
  resumeFrom: number;
  /** The file is already on disk at the announced size, so there is nothing to do. */
  alreadyComplete: boolean;
}

/**
 * Decide where a transfer of `expectedSize` bytes should write, and whether an existing
 * `.part` file can be resumed.
 *
 * Rules:
 *  - a `.part` whose size is in `(0, expectedSize)` is resumable;
 *  - a `.part` at or beyond `expectedSize` is stale, so the transfer restarts at 0;
 *  - a completed file of exactly `expectedSize` is reported as already complete;
 *  - a completed file of a different size gets a ` (n)` suffix instead of being clobbered.
 */
export async function planTarget(
  downloadDir: string,
  rawFilename: string,
  expectedSize: number,
): Promise<TargetPlan> {
  const base = resolveTarget(downloadDir, rawFilename);

  for (let n = 1; n < 1000; n++) {
    const filename = n === 1 ? base.filename : withSuffix(base.filename, n);
    const target = resolveTarget(downloadDir, filename);

    const finalSize = await sizeOf(target.finalPath);
    if (finalSize !== null) {
      if (finalSize === expectedSize) {
        return { ...target, resumeFrom: 0, alreadyComplete: true };
      }
      // A different file already owns this name; try the next suffix.
      continue;
    }

    const partSize = await sizeOf(target.partPath);
    const resumeFrom = partSize !== null && partSize > 0 && partSize < expectedSize ? partSize : 0;
    return { ...target, resumeFrom, alreadyComplete: false };
  }

  throw new UnsafePathError(`Too many name collisions for ${base.filename}`);
}
