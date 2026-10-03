import { describe, expect, it } from 'vitest';
import { formatIrcTarget, isIrcUrl, parseIrcUrl } from '../src/irc/url.js';
import { planIrcLink, sessionIdFor, type SessionSummary } from '../src/app/ircLink.js';

describe('isIrcUrl', () => {
  it('recognises the IRC schemes', () => {
    expect(isIrcUrl('irc://host/chan')).toBe(true);
    expect(isIrcUrl('ircs://host/chan')).toBe(true);
    expect(isIrcUrl('IRC://host/chan')).toBe(true);
    expect(isIrcUrl('  irc://host/chan  ')).toBe(true);
  });

  it('rejects everything else', () => {
    expect(isIrcUrl('https://host/chan')).toBe(false);
    expect(isIrcUrl('javascript:alert(1)')).toBe(false);
    expect(isIrcUrl('file:///etc/passwd')).toBe(false);
    expect(isIrcUrl('ircx://host')).toBe(false);
    expect(isIrcUrl('not a url')).toBe(false);
  });
});

describe('parseIrcUrl', () => {
  it('parses the form in the original request', () => {
    expect(parseIrcUrl('irc://irc.abandoned-irc.net/zombie-warez')).toEqual({
      host: 'irc.abandoned-irc.net',
      port: 6667,
      tls: false,
      channel: '#zombie-warez',
      isNick: false,
    });
  });

  it('adds the # the URL form leaves out', () => {
    expect(parseIrcUrl('irc://host/packs').channel).toBe('#packs');
  });

  it('keeps an escaped # and other channel prefixes', () => {
    expect(parseIrcUrl('irc://host/%23packs').channel).toBe('#packs');
    expect(parseIrcUrl('irc://host/&local').channel).toBe('&local');
    expect(parseIrcUrl('irc://host/!secret').channel).toBe('!secret');
  });

  it('defaults the port by scheme', () => {
    expect(parseIrcUrl('irc://host/c').port).toBe(6667);
    expect(parseIrcUrl('ircs://host/c').port).toBe(6697);
  });

  it('honours an explicit port', () => {
    expect(parseIrcUrl('ircs://host:7000/c')).toMatchObject({ port: 7000, tls: true });
  });

  it('treats ircs and the needssl flag as the same thing', () => {
    expect(parseIrcUrl('ircs://host/c').tls).toBe(true);
    const flagged = parseIrcUrl('irc://host/c,needssl');
    expect(flagged.tls).toBe(true);
    // The flag must not end up glued to the channel name.
    expect(flagged.channel).toBe('#c');
    // ...and it moves the default port too.
    expect(flagged.port).toBe(6697);
  });

  it('reads a channel key from either query form', () => {
    expect(parseIrcUrl('irc://host/c?sekrit').key).toBe('sekrit');
    expect(parseIrcUrl('irc://host/c?key=sekrit').key).toBe('sekrit');
    expect(parseIrcUrl('irc://host/c?password=sekrit').key).toBe('sekrit');
    expect(parseIrcUrl('irc://host/c').key).toBeUndefined();
  });

  it('decodes percent-escapes in the channel', () => {
    expect(parseIrcUrl('irc://host/my%20channel').channel).toBe('#my channel');
  });

  it('flags a link that names a person', () => {
    const target = parseIrcUrl('irc://host/someone,isnick');
    expect(target.isNick).toBe(true);
    expect(target.channel).toBeUndefined();
  });

  it('accepts a server-only link', () => {
    expect(parseIrcUrl('irc://host').host).toBe('host');
    expect(parseIrcUrl('irc://host').channel).toBeUndefined();
    expect(parseIrcUrl('irc://host/').channel).toBeUndefined();
  });

  it('still finds the channel when the link writes a literal #', () => {
    // The # makes it a URL fragment, but links in the wild are written this way.
    expect(parseIrcUrl('irc://host/#packs').channel).toBe('#packs');
    expect(parseIrcUrl('ircs://host:7000/#packs')).toMatchObject({
      channel: '#packs',
      port: 7000,
      tls: true,
    });
  });

  it('refuses links it cannot act on', () => {
    expect(() => parseIrcUrl('https://host/c')).toThrow(/Not an IRC link/);
    expect(() => parseIrcUrl('irc://')).toThrow(/no server|Malformed/);
    // Out-of-range ports are rejected by the URL parser before the range check.
    expect(() => parseIrcUrl('irc://host:99999/c')).toThrow(/Malformed|invalid port/);
  });

  it('round-trips through formatIrcTarget', () => {
    for (const link of ['irc://host/#chan', 'ircs://host:7000/#chan', 'ircs://host/#chan']) {
      expect(formatIrcTarget(parseIrcUrl(link))).toBe(link);
    }
  });
});

describe('planIrcLink', () => {
  const target = parseIrcUrl('irc://irc.example.net/packs');

  const session = (over: Partial<SessionSummary> = {}): SessionSummary => ({
    id: sessionIdFor('irc.example.net', 6667),
    host: 'irc.example.net',
    port: 6667,
    channels: [],
    ...over,
  });

  it('opens a new connection when that server is not open', () => {
    expect(planIrcLink(target, [])).toEqual({ action: 'open', target });
  });

  it('opens a new connection alongside an unrelated one', () => {
    const other = session({ id: sessionIdFor('other.example.net', 6667), host: 'other.example.net' });
    // The point of tabs per server: an unrelated connection is left alone.
    expect(planIrcLink(target, [other])).toEqual({ action: 'open', target });
  });

  it('joins in the existing connection, matching the host case-insensitively', () => {
    const existing = session({ host: 'IRC.EXAMPLE.NET' });
    expect(planIrcLink(target, [existing])).toEqual({
      action: 'join',
      sessionId: existing.id,
      channel: '#packs',
    });
  });

  it('carries the channel key into the join', () => {
    const keyed = parseIrcUrl('irc://irc.example.net/packs?sekrit');
    expect(planIrcLink(keyed, [session()])).toEqual({
      action: 'join',
      sessionId: sessionIdFor('irc.example.net', 6667),
      channel: '#packs',
      key: 'sekrit',
    });
  });

  it('does nothing when the channel is already joined', () => {
    expect(planIrcLink(target, [session({ channels: ['#packs'] })])).toEqual({
      action: 'alreadyThere',
      sessionId: sessionIdFor('irc.example.net', 6667),
      channel: '#packs',
    });
  });

  it('picks the right connection out of several', () => {
    const others = [
      session({ id: sessionIdFor('a.example.net', 6667), host: 'a.example.net' }),
      session(),
      session({ id: sessionIdFor('b.example.net', 6667), host: 'b.example.net' }),
    ];
    expect(planIrcLink(target, others)).toMatchObject({
      action: 'join',
      sessionId: sessionIdFor('irc.example.net', 6667),
    });
  });

  it('treats a different port on the same host as a different server', () => {
    const tlsPort = session({ id: sessionIdFor('irc.example.net', 6697), port: 6697 });
    expect(planIrcLink(target, [tlsPort])).toEqual({ action: 'open', target });
  });

  it('declines a link that points at a person', () => {
    const nick = parseIrcUrl('irc://irc.example.net/someone,isnick');
    expect(planIrcLink(nick, [])).toMatchObject({ action: 'unsupported' });
  });
});
