import { describe, expect, it } from 'vitest';
import { isTerminalFailure, parseBotNotice } from '../src/xdcc/notices.js';

describe('parseBotNotice', () => {
  it('reads a queue position with a total', () => {
    const notice = parseBotNotice(
      '** All Slots Full, Added you to the main queue in position 3 of 10',
    );
    expect(notice.kind).toBe('queued');
    expect(notice.position).toBe(3);
    expect(notice.total).toBe(10);
  });

  it('reads a queue position without a total', () => {
    const notice = parseBotNotice('You have been queued for pack 12, position 5');
    expect(notice.kind).toBe('queued');
    expect(notice.position).toBe(5);
    expect(notice.total).toBeUndefined();
  });

  it('recognises a send starting, with the pack number', () => {
    const notice = parseBotNotice('** Sending You Pack #42 ("show.mkv")');
    expect(notice.kind).toBe('sending');
    expect(notice.pack).toBe(42);
  });

  it('recognises a send starting without a pack number', () => {
    expect(parseBotNotice('** Sending you your file').kind).toBe('sending');
  });

  it('recognises denials and keeps the reason', () => {
    const notice = parseBotNotice('** XDCC SEND denied, you must be on a known channel');
    expect(notice.kind).toBe('denied');
    expect(notice.reason).toMatch(/known channel/);
  });

  it('recognises an invalid pack', () => {
    expect(parseBotNotice('** The Pack Number You Requested Is Invalid').kind).toBe('invalidPack');
  });

  it('recognises duplicate requests', () => {
    expect(parseBotNotice('** You already have that item queued').kind).toBe('alreadyQueued');
    expect(parseBotNotice('** You already requested that pack').kind).toBe('alreadyRequested');
  });

  it('recognises a full queue', () => {
    expect(parseBotNotice('** All Slots Full, and the queue is full').kind).toBe('queueFull');
  });

  it('recognises removal from the queue', () => {
    expect(parseBotNotice('** Removed you from the queue').kind).toBe('removedFromQueue');
  });

  it('strips formatting codes before matching', () => {
    const notice = parseBotNotice('\x02**\x02 \x0304Sending You Pack #7\x03');
    expect(notice.kind).toBe('sending');
    expect(notice.pack).toBe(7);
  });

  it('classifies anything unfamiliar as unknown rather than failing', () => {
    const notice = parseBotNotice('** Bandwidth limit reached, slowing down');
    expect(notice.kind).toBe('unknown');
    expect(isTerminalFailure(notice.kind)).toBe(false);
  });

  it('marks only hopeless outcomes as terminal', () => {
    expect(isTerminalFailure('denied')).toBe(true);
    expect(isTerminalFailure('invalidPack')).toBe(true);
    expect(isTerminalFailure('queueFull')).toBe(true);
    expect(isTerminalFailure('queued')).toBe(false);
    expect(isTerminalFailure('sending')).toBe(false);
  });
});
