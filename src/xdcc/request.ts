/**
 * Parsing the ways people express "download this pack".
 *
 * XDCC search sites and channel topics hand out request lines in a dozen shapes, and
 * pasting one verbatim is the normal way to start a download. All of these mean the same
 * thing:
 *
 *   /msg SomeBot xdcc send #123
 *   /ctcp SomeBot XDCC SEND 123
 *   SomeBot xdcc send #123
 *   SomeBot #123
 *   SomeBot 1,3-5
 */

export interface DownloadRequest {
  bot: string;
  packs: number[];
}

/**
 * Parse a pack list: `1,3-5` -> `[1, 3, 4, 5]`. Ranges are inclusive and `#` is optional,
 * because that is how bots print pack lists and how people paste them.
 */
export function parsePackList(spec: string): number[] {
  const packs: number[] = [];
  for (const part of spec.split(',')) {
    const token = part.trim().replace(/^#/, '');
    if (token === '') continue;
    const range = /^(\d+)\s*-\s*#?(\d+)$/.exec(token);
    if (range) {
      const from = Number(range[1]);
      const to = Number(range[2]);
      if (to < from) throw new Error(`Inverted pack range: ${token}`);
      if (to - from > 1000) throw new Error(`Pack range too large: ${token}`);
      for (let n = from; n <= to; n++) packs.push(n);
      continue;
    }
    if (!/^\d+$/.test(token)) throw new Error(`Not a pack number: ${token}`);
    packs.push(Number(token));
  }
  return [...new Set(packs)];
}

/** Command prefixes a pasted request may carry, stripped before the bot name. */
const LEADING_COMMAND = /^\/(?:msg|privmsg|ctcp|quote)\s+/i;
/**
 * The `xdcc send` part between the bot name and the pack numbers. `\b\s*` rather than
 * `\s+` so a request with the verb but no number still reports the missing pack number
 * instead of complaining that "xdcc send" is not a number.
 */
const XDCC_VERB = /^(?:xdcc\s+)?(?:send|get|batch)\b\s*/i;

/**
 * Parse a request in any of the accepted shapes. Throws with a message meant to be shown
 * to the user, since this runs on whatever they pasted.
 */
export function parseDownloadRequest(input: string): DownloadRequest {
  let rest = input.trim().replace(/^[\s|]+|[\s|]+$/g, '');
  if (rest === '') throw new Error("Expected '<bot> <packs>', e.g. SomeBot #1,3-5");

  rest = rest.replace(LEADING_COMMAND, '').trim();

  // A quoted bot name, which a few sites emit for nicks containing punctuation.
  let bot: string;
  if (rest.startsWith('"')) {
    const close = rest.indexOf('"', 1);
    if (close === -1) throw new Error('Unterminated quote around the bot name');
    bot = rest.slice(1, close);
    rest = rest.slice(close + 1).trim();
  } else {
    const sp = rest.search(/\s/);
    if (sp === -1) {
      throw new Error(`Expected '<bot> <packs>', got: ${input.trim()}`);
    }
    bot = rest.slice(0, sp);
    rest = rest.slice(sp + 1).trim();
  }

  if (bot === '') throw new Error("Expected '<bot> <packs>', e.g. SomeBot #1,3-5");

  // Drop `xdcc send` / `send` / `get` if present; what remains is the pack list.
  rest = rest.replace(XDCC_VERB, '').trim();
  if (rest === '') throw new Error(`No pack numbers in: ${input.trim()}`);

  const packs = parsePackList(rest);
  if (packs.length === 0) throw new Error(`No pack numbers in: ${input.trim()}`);

  return { bot, packs };
}

/**
 * Parse several requests, one per line, skipping blanks. Lets the GUI accept a whole
 * block pasted from a search page.
 */
export function parseDownloadRequests(input: string): DownloadRequest[] {
  const out: DownloadRequest[] = [];
  const errors: string[] = [];
  for (const line of input.split(/\r?\n/)) {
    if (line.trim() === '') continue;
    try {
      out.push(parseDownloadRequest(line));
    } catch (err) {
      errors.push((err as Error).message);
    }
  }
  if (out.length === 0) {
    throw new Error(errors[0] ?? "Expected '<bot> <packs>', e.g. SomeBot #1,3-5");
  }
  return out;
}
