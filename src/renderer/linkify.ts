/**
 * Picking the links out of a channel topic.
 *
 * Worth doing rather than showing the topic as dead text: an XDCC channel's topic is
 * nearly always where the pack site and the network's own `irc://` links are published,
 * which is exactly what the Browse tab is for.
 *
 * Pure, so the awkward parts — trailing punctuation, bare `www.`, a topic that is one long
 * URL — can be pinned down without a browser.
 */

export interface TopicPart {
  text: string;
  /** Present when this part should be a link; absent for ordinary text. */
  href?: string;
}

/**
 * Only the schemes this app can actually act on. Anything else stays plain text rather
 * than becoming a link that does nothing, or hands an unexpected scheme to the shell.
 */
const LINK_PATTERN = /(?:https?|ircs?):\/\/\S+|\bwww\.\S+/gi;

/** Punctuation that ends a sentence far more often than it ends a URL. */
const TRAILING = /[.,;:!?'"]+$/;

/**
 * Trim what the pattern over-matched: topics are prose, so a URL is usually followed by a
 * full stop, and is often wrapped in brackets.
 */
function trimUrl(raw: string): string {
  let url = raw.replace(TRAILING, '');
  // Drop a closing bracket only when the URL does not open one itself, so the parenthesised
  // paths some sites use survive.
  for (const [open, close] of [
    ['(', ')'],
    ['[', ']'],
    ['{', '}'],
  ] as const) {
    while (url.endsWith(close) && !url.includes(open)) url = url.slice(0, -1);
  }
  return url.replace(TRAILING, '');
}

export function linkify(text: string): TopicPart[] {
  const parts: TopicPart[] = [];
  let at = 0;

  for (const match of text.matchAll(LINK_PATTERN)) {
    const start = match.index;
    const url = trimUrl(match[0]);
    if (url === '') continue;

    if (start > at) parts.push({ text: text.slice(at, start) });
    // A bare `www.` host is a link in every other client, so it is one here too.
    parts.push({ text: url, href: /^www\./i.test(url) ? `https://${url}` : url });
    at = start + url.length;
  }

  if (at < text.length) parts.push({ text: text.slice(at) });
  return parts;
}

/** True for a link that opens a connection rather than a page. */
export function isIrcLink(href: string): boolean {
  return /^ircs?:\/\//i.test(href);
}
