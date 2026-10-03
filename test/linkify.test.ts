/**
 * Picking links out of a channel topic. Topics are prose written by hand, so the cases
 * that matter are the messy ones: trailing punctuation, brackets, and a topic that is
 * nothing but a URL.
 */

import { describe, expect, it } from 'vitest';
import { isIrcLink, linkify } from '../src/renderer/linkify.js';

/** The link hrefs a topic produces, in order. */
function hrefs(topic: string): string[] {
  return linkify(topic)
    .filter((part) => part.href !== undefined)
    .map((part) => part.href!);
}

/** Everything put back together, which must always equal what went in. */
function rejoined(topic: string): string {
  return linkify(topic)
    .map((part) => part.text)
    .join('');
}

describe('linkify', () => {
  it('leaves a topic with no links as one piece of text', () => {
    const parts = linkify('Welcome to #packs - be nice');
    expect(parts).toEqual([{ text: 'Welcome to #packs - be nice' }]);
  });

  it('finds the pack site in a typical topic', () => {
    expect(hrefs('Packs at https://packs.example.net/search | no requests')).toEqual([
      'https://packs.example.net/search',
    ]);
  });

  it('does not swallow the full stop that ends the sentence', () => {
    expect(hrefs('List is at https://example.net/list.')).toEqual(['https://example.net/list']);
  });

  it('keeps punctuation that is part of the path', () => {
    expect(hrefs('see https://example.net/a_(b)/c for details')).toEqual([
      'https://example.net/a_(b)/c',
    ]);
  });

  it('drops a bracket the topic opened around the link', () => {
    expect(hrefs('mirror (https://example.net/m) is faster')).toEqual(['https://example.net/m']);
  });

  it('treats a bare www host as a link', () => {
    expect(hrefs('www.example.net has the list')).toEqual(['https://www.example.net']);
  });

  it('finds several links in one topic', () => {
    expect(hrefs('https://a.example | irc://irc.example.net/packs | http://b.example')).toEqual([
      'https://a.example',
      'irc://irc.example.net/packs',
      'http://b.example',
    ]);
  });

  it('ignores schemes this app cannot act on', () => {
    // A link that would do nothing is worse than plain text.
    expect(hrefs('mail us at mailto:ops@example.net or ftp://files.example.net')).toEqual([]);
  });

  it('never loses or duplicates a character of the topic', () => {
    for (const topic of [
      'Packs at https://packs.example.net/search | no requests',
      'List is at https://example.net/list.',
      'mirror (https://example.net/m) is faster',
      'https://only.example.net',
      '',
      'no links here at all',
    ]) {
      expect(rejoined(topic)).toBe(topic);
    }
  });

  it('handles a topic that is nothing but a link', () => {
    expect(linkify('https://only.example.net')).toEqual([
      { text: 'https://only.example.net', href: 'https://only.example.net' },
    ]);
  });
});

describe('isIrcLink', () => {
  it('separates the links that connect from the ones that browse', () => {
    expect(isIrcLink('irc://irc.example.net/packs')).toBe(true);
    expect(isIrcLink('ircs://irc.example.net/packs')).toBe(true);
    expect(isIrcLink('https://example.net')).toBe(false);
  });
});
