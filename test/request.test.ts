import { describe, expect, it } from 'vitest';
import {
  parseDownloadRequest,
  parseDownloadRequests,
  parsePackList,
} from '../src/xdcc/request.js';

describe('parseDownloadRequest', () => {
  it('accepts the plain form', () => {
    expect(parseDownloadRequest('SomeBot #1')).toEqual({ bot: 'SomeBot', packs: [1] });
    expect(parseDownloadRequest('SomeBot 1')).toEqual({ bot: 'SomeBot', packs: [1] });
  });

  it('accepts a pasted /msg line, which is what search sites hand out', () => {
    expect(parseDownloadRequest('/msg SomeBot xdcc send #123')).toEqual({
      bot: 'SomeBot',
      packs: [123],
    });
    expect(parseDownloadRequest('/MSG SomeBot XDCC SEND 123')).toEqual({
      bot: 'SomeBot',
      packs: [123],
    });
  });

  it('accepts /ctcp and /quote prefixes', () => {
    expect(parseDownloadRequest('/ctcp SomeBot xdcc send #7').packs).toEqual([7]);
    expect(parseDownloadRequest('/quote SomeBot xdcc get #7').packs).toEqual([7]);
  });

  it('accepts the verb without the /msg prefix', () => {
    expect(parseDownloadRequest('SomeBot xdcc send #9')).toEqual({ bot: 'SomeBot', packs: [9] });
    expect(parseDownloadRequest('SomeBot send 9')).toEqual({ bot: 'SomeBot', packs: [9] });
  });

  it('handles ranges and lists', () => {
    expect(parseDownloadRequest('SomeBot #1,3-5').packs).toEqual([1, 3, 4, 5]);
    expect(parseDownloadRequest('/msg SomeBot xdcc send 2-4').packs).toEqual([2, 3, 4]);
  });

  it('handles a quoted bot name', () => {
    expect(parseDownloadRequest('"Some Bot" #1')).toEqual({ bot: 'Some Bot', packs: [1] });
  });

  it('tolerates the pipes and padding that channel topics carry', () => {
    expect(parseDownloadRequest('  |  /msg SomeBot xdcc send #4 | ')).toEqual({
      bot: 'SomeBot',
      packs: [4],
    });
  });

  it('keeps bot names containing punctuation intact', () => {
    expect(parseDownloadRequest('[XDCC]-Bot|EU #3').bot).toBe('[XDCC]-Bot|EU');
  });

  it('explains what is wrong rather than throwing something opaque', () => {
    expect(() => parseDownloadRequest('')).toThrow(/Expected/);
    expect(() => parseDownloadRequest('SomeBot')).toThrow(/Expected/);
    expect(() => parseDownloadRequest('SomeBot xdcc send')).toThrow(/No pack numbers/);
    expect(() => parseDownloadRequest('SomeBot abc')).toThrow(/Not a pack number/);
    expect(() => parseDownloadRequest('"Unclosed #1')).toThrow(/Unterminated quote/);
  });
});

describe('parseDownloadRequests', () => {
  it('parses a pasted block, one request per line', () => {
    const requests = parseDownloadRequests(
      ['/msg BotA xdcc send #1', '', 'BotB #2,4', '  ', '/msg BotC xdcc send #9'].join('\n'),
    );
    expect(requests).toEqual([
      { bot: 'BotA', packs: [1] },
      { bot: 'BotB', packs: [2, 4] },
      { bot: 'BotC', packs: [9] },
    ]);
  });

  it('keeps the good lines and ignores the bad ones', () => {
    const requests = parseDownloadRequests(['garbage', 'BotA #1'].join('\n'));
    expect(requests).toEqual([{ bot: 'BotA', packs: [1] }]);
  });

  it('reports the first problem when nothing at all parses', () => {
    expect(() => parseDownloadRequests('garbage\nmore garbage')).toThrow(/Expected/);
  });
});

describe('parsePackList', () => {
  it('still behaves as the CLI expects', () => {
    expect(parsePackList('1,4-6,9')).toEqual([1, 4, 5, 6, 9]);
    expect(parsePackList('#1,#3-#5')).toEqual([1, 3, 4, 5]);
    expect(() => parsePackList('5-1')).toThrow(/Inverted/);
  });
});
