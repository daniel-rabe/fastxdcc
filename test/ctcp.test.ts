import { describe, expect, it } from 'vitest';
import {
  decodeIp,
  encodeAck,
  formatDccResume,
  formatDccSend,
  intToIp,
  ipToInt,
  parseDcc,
  type DccSend,
} from '../src/dcc/ctcp.js';
import { extractCtcp, formatCtcp, stripCtcp } from '../src/irc/ctcp.js';

describe('CTCP framing', () => {
  it('extracts a DCC block', () => {
    const [ctcp] = extractCtcp('\x01DCC SEND file.bin 3232235777 5000 123\x01');
    expect(ctcp!.command).toBe('DCC');
    expect(ctcp!.args).toBe('SEND file.bin 3232235777 5000 123');
  });

  it('tolerates an unterminated block', () => {
    const [ctcp] = extractCtcp('\x01VERSION');
    expect(ctcp!.command).toBe('VERSION');
  });

  it('returns nothing for plain text', () => {
    expect(extractCtcp('just a message')).toEqual([]);
  });

  it('strips blocks from surrounding text', () => {
    expect(stripCtcp('before \x01ACTION waves\x01 after')).toBe('before  after');
  });

  it('round-trips through formatCtcp', () => {
    const [ctcp] = extractCtcp(formatCtcp('DCC', 'SEND a 1 2 3'));
    expect(ctcp!.args).toBe('SEND a 1 2 3');
  });
});

describe('IP encoding', () => {
  it('decodes the decimal uint32 form used by DCC', () => {
    expect(intToIp(3232235777)).toBe('192.168.1.1');
    expect(intToIp(2130706433)).toBe('127.0.0.1');
    expect(intToIp(0)).toBe('0.0.0.0');
    expect(intToIp(4294967295)).toBe('255.255.255.255');
  });

  it('round-trips', () => {
    for (const ip of ['192.168.1.1', '10.0.0.7', '255.255.255.255', '0.0.0.0']) {
      expect(intToIp(ipToInt(ip))).toBe(ip);
    }
  });

  it('also accepts a dotted quad or an IPv6 literal on the wire', () => {
    expect(decodeIp('3232235777')).toBe('192.168.1.1');
    expect(decodeIp('192.168.1.1')).toBe('192.168.1.1');
    expect(decodeIp('2001:db8::1')).toBe('2001:db8::1');
    expect(decodeIp('[2001:db8::1]')).toBe('2001:db8::1');
  });

  it('rejects an out-of-range integer', () => {
    expect(() => decodeIp('99999999999')).toThrow();
  });
});

describe('parseDcc SEND', () => {
  it('parses the common form', () => {
    const msg = parseDcc('SEND movie.mkv 3232235777 5000 734003200') as DccSend;
    expect(msg).toMatchObject({
      type: 'SEND',
      filename: 'movie.mkv',
      ip: '192.168.1.1',
      port: 5000,
      size: 734003200,
    });
    expect(msg.token).toBeUndefined();
  });

  it('handles a quoted filename with spaces', () => {
    const msg = parseDcc('SEND "My Show - 01 [1080p].mkv" 2130706433 4000 123') as DccSend;
    expect(msg.filename).toBe('My Show - 01 [1080p].mkv');
    expect(msg.ip).toBe('127.0.0.1');
    expect(msg.port).toBe(4000);
  });

  it('handles an unquoted filename with spaces by matching from the right', () => {
    const msg = parseDcc('SEND My Show 01.mkv 2130706433 4000 999') as DccSend;
    expect(msg.filename).toBe('My Show 01.mkv');
    expect(msg.size).toBe(999);
    expect(msg.token).toBeUndefined();
  });

  it('recognises reverse DCC: port 0 plus a token', () => {
    const msg = parseDcc('SEND file.bin 2130706433 0 1024 77') as DccSend;
    expect(msg.port).toBe(0);
    expect(msg.token).toBe('77');
    expect(msg.size).toBe(1024);
  });

  it('keeps a token on a normal offer', () => {
    const msg = parseDcc('SEND file.bin 2130706433 6000 1024 42') as DccSend;
    expect(msg.port).toBe(6000);
    expect(msg.token).toBe('42');
  });

  it('parses sizes past 4 GiB', () => {
    const msg = parseDcc('SEND big.iso 2130706433 5000 8589934592') as DccSend;
    expect(msg.size).toBe(8589934592);
  });

  it('ignores DCC subcommands it does not implement', () => {
    expect(parseDcc('CHAT chat 2130706433 5000')).toBeNull();
    expect(parseDcc('XMIT file 2130706433 5000')).toBeNull();
  });
});

describe('parseDcc RESUME and ACCEPT', () => {
  it('parses ACCEPT', () => {
    expect(parseDcc('ACCEPT file.bin 5000 4096')).toEqual({
      type: 'ACCEPT',
      filename: 'file.bin',
      port: 5000,
      position: 4096,
    });
  });

  it('parses a passive ACCEPT carrying a token', () => {
    expect(parseDcc('ACCEPT "my file.bin" 0 4096 77')).toEqual({
      type: 'ACCEPT',
      filename: 'my file.bin',
      port: 0,
      position: 4096,
      token: '77',
    });
  });

  it('parses RESUME', () => {
    expect(parseDcc('RESUME file.bin 5000 128')).toEqual({
      type: 'RESUME',
      filename: 'file.bin',
      port: 5000,
      position: 128,
    });
  });
});

describe('formatting', () => {
  it('writes the IP back as a decimal uint32 and quotes only when needed', () => {
    expect(formatDccSend({ filename: 'a.bin', ip: '127.0.0.1', port: 5000, size: 10 })).toBe(
      'DCC SEND a.bin 2130706433 5000 10',
    );
    expect(
      formatDccSend({ filename: 'a b.bin', ip: '127.0.0.1', port: 0, size: 10, token: '7' }),
    ).toBe('DCC SEND "a b.bin" 2130706433 0 10 7');
  });

  it('round-trips a reverse-DCC reply through the parser', () => {
    const body = formatDccSend({
      filename: 'my file.bin',
      ip: '10.1.2.3',
      port: 51000,
      size: 4096,
      token: '99',
    });
    const parsed = parseDcc(body.slice('DCC '.length)) as DccSend;
    expect(parsed).toMatchObject({
      filename: 'my file.bin',
      ip: '10.1.2.3',
      port: 51000,
      size: 4096,
      token: '99',
    });
  });

  it('includes the token on a passive RESUME', () => {
    expect(formatDccResume({ filename: 'a.bin', port: 0, position: 512, token: '7' })).toBe(
      'DCC RESUME a.bin 0 512 7',
    );
  });
});

describe('encodeAck', () => {
  it('writes a 4-byte big-endian count', () => {
    expect([...encodeAck(1)]).toEqual([0, 0, 0, 1]);
    expect([...encodeAck(4096)]).toEqual([0, 0, 0x10, 0]);
  });

  it('wraps past 4 GiB instead of overflowing, as mIRC does', () => {
    expect(encodeAck(0x1_0000_0000).readUInt32BE(0)).toBe(0);
    expect(encodeAck(0x1_0000_0001).readUInt32BE(0)).toBe(1);
    expect(encodeAck(0xffff_ffff).readUInt32BE(0)).toBe(0xffff_ffff);
    // A 6 GiB file, a size real XDCC packs reach.
    expect(encodeAck(6 * 1024 ** 3).readUInt32BE(0)).toBe((6 * 1024 ** 3) % 0x1_0000_0000);
  });
});
