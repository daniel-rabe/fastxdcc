/**
 * DCC handshake messages, carried as CTCP inside PRIVMSG.
 *
 *   DCC SEND   <filename> <ip> <port> <size> [token]
 *   DCC RESUME <filename> <port> <position> [token]
 *   DCC ACCEPT <filename> <port> <position> [token]
 *
 * Three details break naive implementations, so they are handled explicitly here:
 *
 *  - The IP is a **decimal uint32 in network byte order** (`3232235777` = 192.168.1.1),
 *    not a dotted quad. Some bots send a dotted quad or an IPv6 literal anyway.
 *  - Filenames may contain spaces. They are usually `"quoted"`, but not always, so the
 *    trailing numeric fields are matched from the right and everything before them is
 *    taken as the filename.
 *  - `port == 0` means **reverse (passive) DCC**: the sender is firewalled and the final
 *    field is a token. The receiver listens instead and answers with its own DCC SEND.
 */

import { isIPv4, isIPv6 } from 'node:net';

export interface DccSend {
  type: 'SEND';
  filename: string;
  /** Dotted quad or IPv6 literal, already decoded from whatever form was on the wire. */
  ip: string;
  /** 0 for reverse/passive DCC. */
  port: number;
  size: number;
  /** Present for reverse DCC; the sender echoes it back to correlate the connection. */
  token?: string;
}

export interface DccResume {
  type: 'RESUME';
  filename: string;
  port: number;
  position: number;
  token?: string;
}

export interface DccAccept {
  type: 'ACCEPT';
  filename: string;
  port: number;
  position: number;
  token?: string;
}

export type DccMessage = DccSend | DccResume | DccAccept;

export class DccParseError extends Error {}

/** `3232235777` -> `192.168.1.1`. */
export function intToIp(value: number | bigint): string {
  const n = BigInt(value);
  if (n < 0n || n > 0xffffffffn) throw new DccParseError(`IP out of uint32 range: ${value}`);
  return [(n >> 24n) & 0xffn, (n >> 16n) & 0xffn, (n >> 8n) & 0xffn, n & 0xffn].join('.');
}

/** `192.168.1.1` -> `3232235777`. */
export function ipToInt(ip: string): number {
  const parts = ip.split('.');
  if (parts.length !== 4) throw new DccParseError(`Not an IPv4 address: ${ip}`);
  let out = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) throw new DccParseError(`Not an IPv4 address: ${ip}`);
    const octet = Number(part);
    if (octet > 255) throw new DccParseError(`Not an IPv4 address: ${ip}`);
    out = out * 256 + octet;
  }
  return out;
}

/** Accept every IP encoding seen in the wild: uint32, dotted quad, or IPv6 literal. */
export function decodeIp(field: string): string {
  if (/^\d+$/.test(field)) {
    const n = BigInt(field);
    // A bare integer that is too large to be a uint32 is not an address we can use.
    if (n > 0xffffffffn) throw new DccParseError(`IP out of uint32 range: ${field}`);
    return intToIp(n);
  }
  if (isIPv4(field)) return field;
  const unbracketed = field.startsWith('[') && field.endsWith(']') ? field.slice(1, -1) : field;
  if (isIPv6(unbracketed)) return unbracketed;
  throw new DccParseError(`Unrecognised IP field: ${field}`);
}

function isUnsignedInt(field: string): boolean {
  return /^\d+$/.test(field);
}

function isIpField(field: string): boolean {
  try {
    decodeIp(field);
    return true;
  } catch {
    return false;
  }
}

/**
 * Split `<filename> <rest...>` where the filename may be quoted or may contain spaces.
 *
 * `tailPatterns` describes the fields that follow the filename, longest arity first; the
 * first arity whose trailing fields all validate wins. This is how clients disambiguate
 * `My Movie 2024.mkv 3232235777 5000 1234` without quotes.
 */
function splitFilename(
  args: string,
  tailPatterns: ReadonlyArray<ReadonlyArray<(field: string) => boolean>>,
): { filename: string; tail: string[] } {
  const trimmed = args.trim();

  if (trimmed.startsWith('"')) {
    const close = trimmed.indexOf('"', 1);
    if (close !== -1) {
      const filename = trimmed.slice(1, close);
      const tail = trimmed.slice(close + 1).trim().split(/\s+/).filter((f) => f !== '');
      return { filename, tail };
    }
    // Unterminated quote: fall through to positional matching.
  }

  const fields = trimmed.split(/\s+/).filter((f) => f !== '');
  for (const pattern of tailPatterns) {
    const arity = pattern.length;
    if (fields.length <= arity) continue;
    const tail = fields.slice(-arity);
    if (tail.every((field, i) => pattern[i]!(field!))) {
      return { filename: fields.slice(0, -arity).join(' '), tail };
    }
  }

  throw new DccParseError(`Cannot separate filename from fields: ${JSON.stringify(args)}`);
}

const SEND_TAILS = [
  [isIpField, isUnsignedInt, isUnsignedInt, () => true], // ip port size token
  [isIpField, isUnsignedInt, isUnsignedInt], //             ip port size
] as const;

const OFFSET_TAILS = [
  [isUnsignedInt, isUnsignedInt, () => true], // port position token
  [isUnsignedInt, isUnsignedInt], //            port position
] as const;

/**
 * Parse the arguments of a `DCC` CTCP (i.e. everything after the word `DCC`).
 * Returns null for DCC subcommands this client does not handle (CHAT, XMIT, ...).
 */
export function parseDcc(args: string): DccMessage | null {
  const trimmed = args.trim();
  const sp = trimmed.indexOf(' ');
  if (sp === -1) return null;
  const sub = trimmed.slice(0, sp).toUpperCase();
  const rest = trimmed.slice(sp + 1);

  if (sub === 'SEND') {
    const { filename, tail } = splitFilename(rest, SEND_TAILS);
    const [ipField, portField, sizeField, token] = tail as [string, string, string, string?];
    const size = Number(sizeField);
    if (!Number.isSafeInteger(size)) throw new DccParseError(`Bad size: ${sizeField}`);
    const msg: DccSend = {
      type: 'SEND',
      filename,
      ip: decodeIp(ipField),
      port: Number(portField),
      size,
    };
    if (token !== undefined) msg.token = token;
    return msg;
  }

  if (sub === 'RESUME' || sub === 'ACCEPT') {
    const { filename, tail } = splitFilename(rest, OFFSET_TAILS);
    const [portField, positionField, token] = tail as [string, string, string?];
    const position = Number(positionField);
    if (!Number.isSafeInteger(position)) throw new DccParseError(`Bad position: ${positionField}`);
    const msg: DccResume | DccAccept = {
      type: sub,
      filename,
      port: Number(portField),
      position,
    };
    if (token !== undefined) msg.token = token;
    return msg;
  }

  return null;
}

/** Quote a filename only when it needs it, matching what other clients emit. */
function quoteFilename(filename: string): string {
  return /\s/.test(filename) ? `"${filename}"` : filename;
}

/** Build the CTCP argument string for a DCC SEND (used when answering a reverse offer). */
export function formatDccSend(send: Omit<DccSend, 'type'>): string {
  const ipField = isIPv6(send.ip) ? send.ip : String(ipToInt(send.ip));
  const fields = [quoteFilename(send.filename), ipField, String(send.port), String(send.size)];
  if (send.token !== undefined) fields.push(send.token);
  return `DCC SEND ${fields.join(' ')}`;
}

export function formatDccResume(resume: Omit<DccResume, 'type'>): string {
  const fields = [quoteFilename(resume.filename), String(resume.port), String(resume.position)];
  if (resume.token !== undefined) fields.push(resume.token);
  return `DCC RESUME ${fields.join(' ')}`;
}

export function formatDccAccept(accept: Omit<DccAccept, 'type'>): string {
  const fields = [quoteFilename(accept.filename), String(accept.port), String(accept.position)];
  if (accept.token !== undefined) fields.push(accept.token);
  return `DCC ACCEPT ${fields.join(' ')}`;
}

/**
 * The 4-byte big-endian acknowledgement a DCC receiver sends back.
 *
 * It is only 32 bits wide, so it wraps for files larger than 4 GiB. Wrapping (rather
 * than clamping or widening the field) is what mIRC does and what senders expect.
 */
export function encodeAck(bytesReceived: number): Buffer {
  const buf = Buffer.allocUnsafe(4);
  buf.writeUInt32BE(bytesReceived % 0x1_0000_0000, 0);
  return buf;
}
