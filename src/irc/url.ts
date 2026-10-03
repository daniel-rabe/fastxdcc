/**
 * Parsing `irc://` and `ircs://` links.
 *
 * The scheme was never formally standardised, so this follows what clients actually
 * emit and accept:
 *
 *   irc://irc.example.net/channel            -> #channel on port 6667, plain
 *   ircs://irc.example.net:7000/channel      -> #channel on port 7000, TLS
 *   irc://irc.example.net/channel,needssl    -> TLS via a flag rather than the scheme
 *   irc://irc.example.net/channel?key        -> channel key in the query
 *   irc://irc.example.net/nick,isnick        -> a person, not a channel
 *
 * The `#` is normally left out of the path, because in a URL it would start a fragment;
 * a link that wants it literal has to write `%23`. Both forms are accepted here.
 */

export interface IrcTarget {
  host: string;
  port: number;
  tls: boolean;
  /** Channel including its prefix character, absent when the link only names a server. */
  channel?: string;
  /** Channel key, when the link carries one. */
  key?: string;
  /** The link points at a nickname rather than a channel, so there is nothing to join. */
  isNick: boolean;
}

export class IrcUrlError extends Error {}

const SCHEMES = new Set(['irc:', 'ircs:', 'irc6:', 'ircs6:']);
const TLS_SCHEMES = new Set(['ircs:', 'ircs6:']);
const CHANNEL_PREFIXES = new Set(['#', '&', '+', '!']);

export function isIrcUrl(raw: string): boolean {
  const match = /^([a-z0-9+.-]+:)/i.exec(raw.trim());
  return match ? SCHEMES.has(match[1]!.toLowerCase()) : false;
}

function decode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    // A malformed escape is better shown literally than turned into an error.
    return value;
  }
}

/**
 * Pull the channel key out of the query. Links use both `?key` on its own and the
 * `?key=value` form, so both are accepted.
 */
function keyFromSearch(search: string): string | undefined {
  const query = search.startsWith('?') ? search.slice(1) : search;
  if (query === '') return undefined;
  if (!query.includes('=')) return decode(query);
  const params = new URLSearchParams(query);
  const named = params.get('key') ?? params.get('password') ?? params.get('pass');
  return named ?? undefined;
}

export function parseIrcUrl(raw: string): IrcTarget {
  const trimmed = raw.trim();
  if (!isIrcUrl(trimmed)) throw new IrcUrlError(`Not an IRC link: ${raw}`);

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new IrcUrlError(`Malformed IRC link: ${raw}`);
  }

  const host = url.hostname;
  if (host === '') throw new IrcUrlError(`IRC link has no server: ${raw}`);

  const scheme = url.protocol.toLowerCase();
  let tls = TLS_SCHEMES.has(scheme);

  // The path is `target,flag,flag`; flags are case-insensitive and mostly advisory.
  let path = url.pathname.replace(/^\/+/, '');

  // `irc://host/#chan` is common in the wild even though the `#` makes the channel a URL
  // fragment. Without this the link would connect and then silently join nothing.
  if (path === '' && url.hash !== '') path = url.hash;

  const [rawTarget = '', ...flags] = path.split(',');
  const normalisedFlags = flags.map((flag) => flag.toLowerCase());

  if (normalisedFlags.includes('needssl')) tls = true;
  const isNick = normalisedFlags.includes('isnick') || normalisedFlags.includes('isuser');

  const port = url.port ? Number(url.port) : tls ? 6697 : 6667;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new IrcUrlError(`IRC link has an invalid port: ${url.port}`);
  }

  const target: IrcTarget = { host, port, tls, isNick };

  const name = decode(rawTarget).trim();
  if (name !== '' && !isNick) {
    target.channel = CHANNEL_PREFIXES.has(name[0]!) ? name : `#${name}`;
  }

  const key = keyFromSearch(url.search);
  if (key !== undefined && key !== '') target.key = key;

  return target;
}

/** Render a target back as a link, mainly for logging and for showing the user. */
export function formatIrcTarget(target: IrcTarget): string {
  const scheme = target.tls ? 'ircs' : 'irc';
  const defaultPort = target.tls ? 6697 : 6667;
  const port = target.port === defaultPort ? '' : `:${target.port}`;
  return `${scheme}://${target.host}${port}${target.channel ? `/${target.channel}` : ''}`;
}
