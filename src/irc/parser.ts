/**
 * RFC 1459 / RFC 2812 message parsing, with IRCv3 message-tags.
 *
 * Wire format:  [@tags] [:prefix] COMMAND [params...] [:trailing]
 */

export interface Prefix {
  /** Nick, or the server name when the prefix is a server. */
  nick: string;
  user?: string;
  host?: string;
  /** True when the prefix had no `!user` / `@host` part. */
  isServer: boolean;
}

export interface Message {
  raw: string;
  tags: Record<string, string | true>;
  prefix?: Prefix;
  command: string;
  params: string[];
}

const TAG_UNESCAPE: Record<string, string> = {
  ':': ';',
  s: ' ',
  '\\': '\\',
  r: '\r',
  n: '\n',
};

const TAG_ESCAPE: Record<string, string> = {
  ';': '\\:',
  ' ': '\\s',
  '\\': '\\\\',
  '\r': '\\r',
  '\n': '\\n',
};

/** Unescape an IRCv3 tag value. A trailing lone backslash is dropped, per spec. */
export function unescapeTagValue(value: string): string {
  let out = '';
  for (let i = 0; i < value.length; i++) {
    if (value[i] !== '\\') {
      out += value[i];
      continue;
    }
    const next = value[i + 1];
    if (next === undefined) break; // lone trailing backslash: drop it
    // An undefined escape sequence drops the backslash and keeps the character.
    out += TAG_UNESCAPE[next] ?? next;
    i++;
  }
  return out;
}

export function escapeTagValue(value: string): string {
  let out = '';
  for (const ch of value) out += TAG_ESCAPE[ch] ?? ch;
  return out;
}

function parseTags(segment: string): Record<string, string | true> {
  const tags: Record<string, string | true> = {};
  for (const part of segment.split(';')) {
    if (part === '') continue;
    const eq = part.indexOf('=');
    if (eq === -1) {
      tags[part] = true;
    } else {
      const key = part.slice(0, eq);
      const value = part.slice(eq + 1);
      // `key=` with an empty value is equivalent to a valueless tag.
      tags[key] = value === '' ? true : unescapeTagValue(value);
    }
  }
  return tags;
}

export function parsePrefix(source: string): Prefix {
  const bang = source.indexOf('!');
  const at = source.indexOf('@', bang === -1 ? 0 : bang);

  if (bang === -1 && at === -1) {
    // Could be a bare nick or a server name; a dot is the usual giveaway.
    return { nick: source, isServer: source.includes('.') };
  }
  if (bang === -1) {
    return { nick: source.slice(0, at), host: source.slice(at + 1), isServer: false };
  }
  if (at === -1) {
    return { nick: source.slice(0, bang), user: source.slice(bang + 1), isServer: false };
  }
  return {
    nick: source.slice(0, bang),
    user: source.slice(bang + 1, at),
    host: source.slice(at + 1),
    isServer: false,
  };
}

/**
 * Parse one line (without its CRLF). Returns null for blank lines.
 *
 * Lenient by design: malformed input from a server should never throw, because a
 * single bad line must not tear down a connection mid-transfer.
 */
export function parseMessage(line: string): Message | null {
  const raw = line;
  let rest = line;

  // Some servers pad with spaces; leading whitespace is not significant.
  rest = rest.replace(/^[ ]+/, '');
  if (rest === '') return null;

  let tags: Record<string, string | true> = {};
  if (rest.startsWith('@')) {
    const sp = rest.indexOf(' ');
    if (sp === -1) return null;
    tags = parseTags(rest.slice(1, sp));
    rest = rest.slice(sp + 1).replace(/^[ ]+/, '');
  }

  let prefix: Prefix | undefined;
  if (rest.startsWith(':')) {
    const sp = rest.indexOf(' ');
    if (sp === -1) return null;
    prefix = parsePrefix(rest.slice(1, sp));
    rest = rest.slice(sp + 1).replace(/^[ ]+/, '');
  }

  if (rest === '') return null;

  const params: string[] = [];
  let command = '';

  // Command is the first token.
  {
    const sp = rest.indexOf(' ');
    if (sp === -1) {
      command = rest;
      rest = '';
    } else {
      command = rest.slice(0, sp);
      rest = rest.slice(sp + 1);
    }
  }

  while (rest !== '') {
    if (rest.startsWith(':')) {
      params.push(rest.slice(1));
      break;
    }
    const sp = rest.indexOf(' ');
    if (sp === -1) {
      params.push(rest);
      break;
    }
    if (sp > 0) params.push(rest.slice(0, sp));
    rest = rest.slice(sp + 1);
  }

  return { raw, tags, prefix, command: command.toUpperCase(), params };
}

/**
 * Build a wire line (without CRLF). The final parameter is prefixed with `:` when it is
 * empty, contains a space, or starts with `:` — otherwise it would not round-trip.
 */
export function formatMessage(command: string, params: string[] = []): string {
  const parts = [command];
  params.forEach((param, index) => {
    const isLast = index === params.length - 1;
    const needsTrailing = param === '' || param.includes(' ') || param.startsWith(':');
    if (needsTrailing) {
      if (!isLast) {
        throw new Error(`IRC parameter ${index} must be last: ${JSON.stringify(param)}`);
      }
      parts.push(`:${param}`);
    } else {
      parts.push(param);
    }
  });
  return parts.join(' ');
}

/** Parse the key/value pairs of an ISUPPORT (005) reply's parameters. */
export function parseIsupport(params: string[]): Record<string, string | true> {
  const out: Record<string, string | true> = {};
  // params[0] is our nick; the last param is the human-readable "are supported by..."
  for (const token of params.slice(1, -1)) {
    if (token === '') continue;
    const eq = token.indexOf('=');
    if (eq === -1) out[token.toUpperCase()] = true;
    else out[token.slice(0, eq).toUpperCase()] = token.slice(eq + 1);
  }
  return out;
}
