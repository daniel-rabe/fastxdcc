/**
 * Turning what someone typed in the browser tab's address bar into a URL to load.
 *
 * Kept out of the Electron layer so it can be tested directly, and so the rule about
 * which schemes are allowed lives in one obvious place.
 */

import { isIrcUrl } from '../irc/url.js';

export const ALLOWED_SCHEMES = new Set(['http:', 'https:']);

/**
 * Anything without a scheme becomes https, which is the safe direction to guess in.
 * `irc://` is returned untouched: the caller follows it instead of loading it.
 */
export function normaliseUrl(input: string): string {
  const trimmed = input.trim();
  if (trimmed === '') throw new Error('Enter an address first.');
  if (isIrcUrl(trimmed)) return trimmed;

  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`;

  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new Error(`That is not a valid address: ${input}`);
  }

  if (!ALLOWED_SCHEMES.has(url.protocol)) {
    throw new Error(`Only http and https addresses can be opened here (got ${url.protocol}).`);
  }
  return url.toString();
}
