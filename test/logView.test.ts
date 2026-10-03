/**
 * The rules behind the channel bar: which lines belong to which view, what happens when a
 * view disappears, and how an unread badge is counted. Pure, so no browser is involved.
 */

import { describe, expect, it } from 'vitest';
import type { LogSnapshot, ViewSnapshot } from '../src/app/snapshot.js';
import {
  ALL_VIEW,
  SERVER_VIEW,
  filterLog,
  isFixedView,
  resolveView,
  unreadCount,
  viewTarget,
} from '../src/renderer/logView.js';

function line(source: string, text: string): LogSnapshot {
  return { at: 0, level: 'irc', source, text };
}

const LOG: LogSnapshot[] = [
  line('*', 'Connected'),
  line('#packs', '<someone> hi'),
  line('dcc', 'Requesting #1'),
  line('#chat', '<other> hello'),
  line('packbot', '-packbot- Sending you pack'),
  line('#PACKS', '<someone> back'),
];

const channels: ViewSnapshot[] = [
  { name: '#packs', activity: 2 },
  { name: '#chat', activity: 1 },
];

const conversations: ViewSnapshot[] = [{ name: 'packbot', activity: 1 }];

describe('filterLog', () => {
  it('shows everything in the All view', () => {
    expect(filterLog(LOG, ALL_VIEW)).toHaveLength(LOG.length);
  });

  it('keeps one channel to itself', () => {
    const shown = filterLog(LOG, '#chat');
    expect(shown.map((l) => l.text)).toEqual(['<other> hello']);
  });

  it('matches a channel whatever case the server used', () => {
    // Servers echo back the case they like; `#packs` and `#PACKS` are one channel.
    expect(filterLog(LOG, '#packs')).toHaveLength(2);
  });

  it('collects client, transfer and unclaimed private lines into the Server view', () => {
    const shown = filterLog(LOG, SERVER_VIEW);
    expect(shown.map((l) => l.source)).toEqual(['*', 'dcc', 'packbot']);
  });

  it('takes a nick out of the Server view once a conversation is open for them', () => {
    const shown = filterLog(LOG, SERVER_VIEW, conversations);
    expect(shown.map((l) => l.source)).toEqual(['*', 'dcc']);
  });

  it('gives that conversation the lines the Server view gave up', () => {
    // Every line belongs to exactly one view; nothing is shown twice or lost.
    const inPm = filterLog(LOG, 'packbot');
    const inServer = filterLog(LOG, SERVER_VIEW, conversations);
    const inChannels = [...filterLog(LOG, '#packs'), ...filterLog(LOG, '#chat')];
    expect(inPm.length + inServer.length + inChannels.length).toBe(LOG.length);
  });

  it('matches a nick whatever case it was typed in', () => {
    expect(filterLog(LOG, 'PACKBOT')).toHaveLength(1);
    expect(filterLog(LOG, SERVER_VIEW, [{ name: 'PACKBOT', activity: 1 }])).toHaveLength(2);
  });

  it('leaves the original array alone', () => {
    filterLog(LOG, '#chat');
    expect(LOG).toHaveLength(6);
  });
});

describe('resolveView', () => {
  it('keeps a channel that is still joined', () => {
    expect(resolveView('#chat', channels)).toBe('#chat');
  });

  it('falls back to All when the channel has gone', () => {
    // What happens on a part, a kick, or a reconnect that has not rejoined yet.
    expect(resolveView('#gone', channels)).toBe(ALL_VIEW);
  });

  it('keeps a conversation that is still open, and drops one that is not', () => {
    const views = [...channels, ...conversations];
    expect(resolveView('packbot', views)).toBe('packbot');
    expect(resolveView('someone', views)).toBe(ALL_VIEW);
  });

  it('never discards the two fixed views', () => {
    expect(resolveView(SERVER_VIEW, [])).toBe(SERVER_VIEW);
    expect(resolveView(ALL_VIEW, [])).toBe(ALL_VIEW);
  });
});

describe('unreadCount', () => {
  it('counts lines added since the view was last seen', () => {
    expect(unreadCount(12, 5)).toBe(7);
  });

  it('shows nothing for a view that has only just appeared', () => {
    // A channel joined into a backlog must not open with a badge for lines it never hid.
    expect(unreadCount(40, undefined)).toBe(0);
  });

  it('never goes negative when the log is cleared', () => {
    expect(unreadCount(0, 30)).toBe(0);
  });
});

describe('viewTarget', () => {
  it('sends typed text to the channel being looked at', () => {
    expect(viewTarget('#packs')).toBe('#packs');
  });

  it('sends typed text to the person being looked at', () => {
    expect(viewTarget('packbot')).toBe('packbot');
  });

  it('has no target for the fixed views, so the session decides', () => {
    expect(viewTarget(ALL_VIEW)).toBeUndefined();
    expect(viewTarget(SERVER_VIEW)).toBeUndefined();
    expect(isFixedView('#packs')).toBe(false);
  });
});
