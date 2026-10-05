/**
 * Unread accounting. Pure, and deliberately covering the cases that bite: a view met for
 * the first time, a view that goes away and comes back, and a connection nobody is
 * looking at — which is the whole reason this state lives above the tab that shows it.
 */

import { describe, expect, it } from 'vitest';
import type { SessionSnapshot, ViewSnapshot } from '../src/app/snapshot.js';
import { ALL_VIEW, SERVER_VIEW } from '../src/renderer/logView.js';
import { syncSeen, totalsFor, unreadFor, unreadWhispers, viewKey } from '../src/renderer/unread.js';

function session(over: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return {
    id: 'irc.example.net:6697',
    label: 'irc.example.net',
    connection: 'registered',
    network: 'irc.example.net:6697',
    nick: 'me',
    channels: [{ name: '#packs', activity: 5 }],
    conversations: [{ name: 'carol', activity: 3 }],
    serverActivity: 7,
    items: [],
    log: [],
    activeTransfers: 0,
    ...over,
  };
}

const CAROL: ViewSnapshot = { name: 'carol', activity: 3 };

describe('totalsFor', () => {
  it('covers the server view, every channel and every conversation', () => {
    expect([...totalsFor(session()).entries()]).toEqual([
      [SERVER_VIEW, 7],
      ['#packs', 5],
      ['carol', 3],
    ]);
  });
});

describe('syncSeen', () => {
  it('shows nothing unread for a view it has only just met', () => {
    const seen = new Map<string, number>();
    syncSeen(seen, session(), false, ALL_VIEW);
    // Carol may have said three things before her tab existed; none of them were hidden.
    expect(unreadFor(seen, 'irc.example.net:6697', CAROL)).toBe(0);
  });

  it('counts what arrives while the connection is in the background', () => {
    const seen = new Map<string, number>();
    const id = 'irc.example.net:6697';
    syncSeen(seen, session(), false, ALL_VIEW);

    const later = session({ conversations: [{ name: 'carol', activity: 9 }] });
    syncSeen(seen, later, false, ALL_VIEW);
    expect(unreadFor(seen, id, { name: 'carol', activity: 9 })).toBe(6);
  });

  it('clears a conversation once it is the view on screen', () => {
    const seen = new Map<string, number>();
    const id = 'irc.example.net:6697';
    syncSeen(seen, session(), false, ALL_VIEW);
    const later = session({ conversations: [{ name: 'carol', activity: 9 }] });

    syncSeen(seen, later, true, 'carol');
    expect(unreadFor(seen, id, { name: 'carol', activity: 9 })).toBe(0);
  });

  it('does not clear a conversation just because another view is on screen', () => {
    const seen = new Map<string, number>();
    const id = 'irc.example.net:6697';
    syncSeen(seen, session(), true, '#packs');
    const later = session({ conversations: [{ name: 'carol', activity: 9 }] });

    syncSeen(seen, later, true, '#packs');
    expect(unreadFor(seen, id, { name: 'carol', activity: 9 })).toBe(6);
  });

  it('treats the All view as reading everything', () => {
    const seen = new Map<string, number>();
    const id = 'irc.example.net:6697';
    syncSeen(seen, session(), true, ALL_VIEW);
    const later = session({ conversations: [{ name: 'carol', activity: 9 }] });

    syncSeen(seen, later, true, ALL_VIEW);
    expect(unreadFor(seen, id, { name: 'carol', activity: 9 })).toBe(0);
  });

  it('forgets a view that has gone, so reopening it does not inherit an old mark', () => {
    const seen = new Map<string, number>();
    const id = 'irc.example.net:6697';
    syncSeen(seen, session(), true, ALL_VIEW);
    expect(seen.has(viewKey(id, 'carol'))).toBe(true);

    syncSeen(seen, session({ conversations: [] }), false, ALL_VIEW);
    expect(seen.has(viewKey(id, 'carol'))).toBe(false);

    // Reopened later with a bigger total, it starts clean rather than showing a backlog.
    syncSeen(seen, session({ conversations: [{ name: 'carol', activity: 40 }] }), false, ALL_VIEW);
    expect(unreadFor(seen, id, { name: 'carol', activity: 40 })).toBe(0);
  });

  it('keeps two connections apart even when a view has the same name', () => {
    const seen = new Map<string, number>();
    const a = session({ id: 'a:6667' });
    const b = session({ id: 'b:6667' });
    syncSeen(seen, a, false, ALL_VIEW);
    syncSeen(seen, b, false, ALL_VIEW);

    syncSeen(seen, { ...a, conversations: [{ name: 'carol', activity: 10 }] }, true, 'carol');
    syncSeen(seen, { ...b, conversations: [{ name: 'carol', activity: 10 }] }, false, ALL_VIEW);

    expect(unreadFor(seen, 'a:6667', { name: 'carol', activity: 10 })).toBe(0);
    expect(unreadFor(seen, 'b:6667', { name: 'carol', activity: 10 })).toBe(7);
  });
});

describe('unreadWhispers', () => {
  it('counts only conversations, since channel traffic is ambient', () => {
    const seen = new Map<string, number>();
    syncSeen(seen, session(), false, ALL_VIEW);

    const busy = session({
      channels: [{ name: '#packs', activity: 500 }],
      conversations: [{ name: 'carol', activity: 5 }, { name: 'dave', activity: 3 }],
      serverActivity: 900,
    });
    syncSeen(seen, busy, false, ALL_VIEW);

    // 2 from carol; dave is new, so nothing. The 495 channel lines do not light the tab.
    expect(unreadWhispers(seen, busy)).toBe(2);
  });

  it('is nothing when there are no conversations', () => {
    const seen = new Map<string, number>();
    const quiet = session({ conversations: [] });
    syncSeen(seen, quiet, false, ALL_VIEW);
    expect(unreadWhispers(seen, quiet)).toBe(0);
  });
});
