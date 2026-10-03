/** Generic CTCP framing: `\x01COMMAND args\x01` carried inside PRIVMSG/NOTICE text. */

export const CTCP_DELIM = '\x01';

export interface Ctcp {
  /** Uppercased command, e.g. `DCC`, `VERSION`, `ACTION`. */
  command: string;
  /** Everything after the command, untrimmed at the end but with no delimiters. */
  args: string;
}

/**
 * Low-level CTCP dequoting (\x10 as the quote character). Rarely used by XDCC bots, but
 * cheap to support and harmless when absent.
 */
export function ctcpDequote(text: string): string {
  if (!text.includes('\x10')) return text;
  let out = '';
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '\x10') {
      out += text[i];
      continue;
    }
    const next = text[i + 1];
    if (next === undefined) break;
    if (next === '0') out += '\0';
    else if (next === 'n') out += '\n';
    else if (next === 'r') out += '\r';
    else if (next === '\x10') out += '\x10';
    else out += next;
    i++;
  }
  return out;
}

/** Extract every CTCP block in a message body. Returns [] when there are none. */
export function extractCtcp(text: string): Ctcp[] {
  if (!text.includes(CTCP_DELIM)) return [];
  const out: Ctcp[] = [];
  let index = 0;
  while (index < text.length) {
    const start = text.indexOf(CTCP_DELIM, index);
    if (start === -1) break;
    let end = text.indexOf(CTCP_DELIM, start + 1);
    // An unterminated block runs to the end of the line; mIRC tolerates this.
    if (end === -1) end = text.length;
    const body = ctcpDequote(text.slice(start + 1, end)).trim();
    index = end + 1;
    if (body === '') continue;
    const sp = body.indexOf(' ');
    if (sp === -1) out.push({ command: body.toUpperCase(), args: '' });
    else out.push({ command: body.slice(0, sp).toUpperCase(), args: body.slice(sp + 1) });
  }
  return out;
}

/** Strip CTCP blocks from a message body, leaving the plain-text remainder. */
export function stripCtcp(text: string): string {
  return text.replace(/\x01[^\x01]*(\x01|$)/g, '').trim();
}

export function formatCtcp(command: string, args = ''): string {
  return args === ''
    ? `${CTCP_DELIM}${command}${CTCP_DELIM}`
    : `${CTCP_DELIM}${command} ${args}${CTCP_DELIM}`;
}
