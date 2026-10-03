import { describe, expect, it } from 'vitest';
import { normaliseUrl } from '../src/app/browserUrl.js';
import { channelsForTarget } from '../src/app/ircLink.js';
import { parseIrcUrl } from '../src/irc/url.js';
import { tabLabels } from '../src/renderer/tabLabel.js';

describe('normaliseUrl', () => {
  it('assumes https when no scheme is given', () => {
    expect(normaliseUrl('example.com')).toBe('https://example.com/');
    expect(normaliseUrl('example.com/packs?q=1')).toBe('https://example.com/packs?q=1');
  });

  it('keeps an explicit http or https scheme', () => {
    expect(normaliseUrl('http://example.com')).toBe('http://example.com/');
    expect(normaliseUrl('https://example.com/x')).toBe('https://example.com/x');
  });

  it('passes irc links straight through for the caller to follow', () => {
    expect(normaliseUrl('irc://host/chan')).toBe('irc://host/chan');
    expect(normaliseUrl('  ircs://host/chan  ')).toBe('ircs://host/chan');
  });

  it('refuses schemes that have no business in the browser tab', () => {
    expect(() => normaliseUrl('file:///etc/passwd')).toThrow(/Only http and https/);
    expect(() => normaliseUrl('javascript:alert(1)')).toThrow(/Only http and https/);
    expect(() => normaliseUrl('data:text/html,<b>x')).toThrow(/Only http and https/);
  });

  it('asks for something to open when given nothing', () => {
    expect(() => normaliseUrl('   ')).toThrow(/Enter an address/);
  });
});

describe('channelsForTarget', () => {
  const configured = {
    host: 'irc.example.net',
    port: 6667,
    channels: [{ name: '#packs' }, { name: '#private', key: 'k' }],
  };

  it('joins only the linked channel on a server that is not the configured one', () => {
    const target = parseIrcUrl('irc://other.example.net/zombie-warez');
    expect(channelsForTarget(configured, target)).toEqual([{ name: '#zombie-warez' }]);
  });

  it('keeps the configured channels when the link is for that same server', () => {
    const target = parseIrcUrl('irc://irc.example.net/newchan');
    expect(channelsForTarget(configured, target)).toEqual([
      { name: '#packs' },
      { name: '#private', key: 'k' },
      { name: '#newchan' },
    ]);
  });

  it('does not add a channel that is already configured', () => {
    const target = parseIrcUrl('irc://irc.example.net/PACKS');
    expect(channelsForTarget(configured, target)).toEqual(configured.channels);
  });

  it('carries a channel key from the link', () => {
    const target = parseIrcUrl('irc://other.example.net/secret?sekrit');
    expect(channelsForTarget(configured, target)).toEqual([{ name: '#secret', key: 'sekrit' }]);
  });

  it('treats a different port on the configured host as another server', () => {
    const target = parseIrcUrl('ircs://irc.example.net:6697/chan');
    expect(channelsForTarget(configured, target)).toEqual([{ name: '#chan' }]);
  });

  it('joins nothing when the link only names a server', () => {
    expect(channelsForTarget(configured, parseIrcUrl('irc://other.example.net'))).toEqual([]);
  });

  it('ignores an unset configured host', () => {
    const empty = { host: '', port: 6697, channels: [] };
    expect(channelsForTarget(empty, parseIrcUrl('irc://host/chan'))).toEqual([
      { name: '#chan' },
    ]);
  });
});

describe('tabLabels', () => {
  it('uses the short host name when it is unambiguous', () => {
    const labels = tabLabels([
      { id: 'a:6667', label: 'a.example.net', network: 'a.example.net:6667' },
      { id: 'b:6667', label: 'b.example.net', network: 'b.example.net:6667' },
    ]);
    expect(labels.get('a:6667')).toBe('a.example.net');
    expect(labels.get('b:6667')).toBe('b.example.net');
  });

  it('adds the port when one host is connected twice', () => {
    const labels = tabLabels([
      { id: 'a:6667', label: 'a.example.net', network: 'a.example.net:6667' },
      { id: 'a:6697', label: 'a.example.net', network: 'a.example.net:6697' },
      { id: 'b:6667', label: 'b.example.net', network: 'b.example.net:6667' },
    ]);
    expect(labels.get('a:6667')).toBe('a.example.net:6667');
    expect(labels.get('a:6697')).toBe('a.example.net:6697');
    // The unambiguous one is left short.
    expect(labels.get('b:6667')).toBe('b.example.net');
  });

  it('falls back to the id when there is no network string yet', () => {
    const labels = tabLabels([
      { id: 'a:6667', label: 'a', network: '' },
      { id: 'a:6697', label: 'a', network: '' },
    ]);
    expect(labels.get('a:6667')).toBe('a:6667');
  });
});
