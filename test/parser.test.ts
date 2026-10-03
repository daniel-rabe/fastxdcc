import { describe, expect, it } from 'vitest';
import {
  escapeTagValue,
  formatMessage,
  parseIsupport,
  parseMessage,
  parsePrefix,
  unescapeTagValue,
} from '../src/irc/parser.js';

describe('parseMessage', () => {
  it('parses a plain command', () => {
    const msg = parseMessage('PING :12345')!;
    expect(msg.command).toBe('PING');
    expect(msg.params).toEqual(['12345']);
    expect(msg.prefix).toBeUndefined();
  });

  it('parses a prefix with user and host', () => {
    const msg = parseMessage(':nick!user@host.example PRIVMSG #chan :hello world')!;
    expect(msg.prefix).toEqual({
      nick: 'nick',
      user: 'user',
      host: 'host.example',
      isServer: false,
    });
    expect(msg.params).toEqual(['#chan', 'hello world']);
  });

  it('treats a dotted bare prefix as a server', () => {
    expect(parsePrefix('irc.example.net').isServer).toBe(true);
    expect(parsePrefix('somenick').isServer).toBe(false);
  });

  it('keeps a trailing parameter intact, including colons and spaces', () => {
    const msg = parseMessage(':a!b@c PRIVMSG #x :look: a b  c')!;
    expect(msg.params[1]).toBe('look: a b  c');
  });

  it('preserves an empty trailing parameter', () => {
    const msg = parseMessage('PRIVMSG #x :')!;
    expect(msg.params).toEqual(['#x', '']);
  });

  it('parses IRCv3 tags and unescapes their values', () => {
    const msg = parseMessage('@id=abc;msg=a\\sb\\:c;flag :n!u@h PRIVMSG #c :hi')!;
    expect(msg.tags.id).toBe('abc');
    expect(msg.tags.msg).toBe('a b;c');
    expect(msg.tags.flag).toBe(true);
    expect(msg.command).toBe('PRIVMSG');
  });

  it('treats an empty tag value as valueless', () => {
    const msg = parseMessage('@a= PING :x')!;
    expect(msg.tags.a).toBe(true);
  });

  it('uppercases the command so callers can switch on it safely', () => {
    expect(parseMessage('privmsg #x :y')!.command).toBe('PRIVMSG');
  });

  it('returns null instead of throwing for junk', () => {
    expect(parseMessage('')).toBeNull();
    expect(parseMessage('   ')).toBeNull();
    expect(parseMessage(':only-a-prefix')).toBeNull();
    expect(parseMessage('@only-tags')).toBeNull();
  });

  it('tolerates repeated spaces between parameters', () => {
    const msg = parseMessage('MODE  #chan   +o   someone')!;
    expect(msg.command).toBe('MODE');
    expect(msg.params).toEqual(['#chan', '+o', 'someone']);
  });
});

describe('tag escaping', () => {
  it('round-trips', () => {
    const value = 'a b;c\\d\r\ne';
    expect(unescapeTagValue(escapeTagValue(value))).toBe(value);
  });

  it('drops a lone trailing backslash', () => {
    expect(unescapeTagValue('abc\\')).toBe('abc');
  });
});

describe('formatMessage', () => {
  it('adds a colon only where it is needed', () => {
    expect(formatMessage('JOIN', ['#chan'])).toBe('JOIN #chan');
    expect(formatMessage('PRIVMSG', ['#chan', 'hello world'])).toBe('PRIVMSG #chan :hello world');
    expect(formatMessage('PRIVMSG', ['#chan', ''])).toBe('PRIVMSG #chan :');
    expect(formatMessage('PRIVMSG', ['#chan', ':wink'])).toBe('PRIVMSG #chan ::wink');
  });

  it('refuses a space-bearing parameter that is not last', () => {
    expect(() => formatMessage('X', ['a b', 'c'])).toThrow(/must be last/);
  });

  it('round-trips through the parser', () => {
    const line = formatMessage('PRIVMSG', ['#chan', 'a b :c']);
    expect(parseMessage(line)!.params).toEqual(['#chan', 'a b :c']);
  });
});

describe('parseIsupport', () => {
  it('reads keys and values, ignoring nick and the trailing text', () => {
    const msg = parseMessage(
      ':srv 005 me CHANTYPES=# PREFIX=(ov)@+ SAFELIST :are supported by this server',
    )!;
    const supported = parseIsupport(msg.params);
    expect(supported.CHANTYPES).toBe('#');
    expect(supported.PREFIX).toBe('(ov)@+');
    expect(supported.SAFELIST).toBe(true);
  });
});
