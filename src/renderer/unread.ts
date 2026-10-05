/**
 * Working out what has arrived somewhere the user is not looking.
 *
 * Counts come from the running totals in the snapshot rather than from rows on screen:
 * the log is capped, so counting what is displayed would make a badge drift downwards in
 * a busy session. What is stored here is the total each view stood at when it was last
 * read; the difference is the unread count.
 *
 * This state deliberately lives above the tab that shows it. The transfers pane is
 * unmounted whenever another connection is brought forward, so anything kept inside it
 * would be lost on every tab switch — and a connection in the background is exactly the
 * one whose unread count matters.
 */

import type { SessionSnapshot, ViewSnapshot } from '../app/snapshot.js';
import { ALL_VIEW, SERVER_VIEW, type LogView } from './logView.js';

/** Identifies one view of one connection; two servers may both have a `#packs`. */
export function viewKey(sessionId: string, view: LogView): string {
  return `${sessionId}\u0000${view.toLowerCase()}`;
}

/** Every view of one connection with the total it stands at, keyed by view name. */
export function totalsFor(session: SessionSnapshot): Map<LogView, number> {
  const totals = new Map<LogView, number>([[SERVER_VIEW, session.serverActivity]]);
  for (const one of [...session.channels, ...session.conversations]) {
    totals.set(one.name, one.activity);
  }
  return totals;
}

/**
 * Bring the seen marks up to date for one connection.
 *
 * A view on screen is read by definition, and `All` shows everything, so looking at it
 * marks the whole connection read. A view met for the first time is recorded at its
 * current total, so a conversation that opens mid-backlog does not arrive with a badge
 * counting messages it never hid. Marks for views that have gone are dropped, so one
 * reopened later is not measured against a mark from its previous life.
 */
export function syncSeen(
  seen: Map<string, number>,
  session: SessionSnapshot,
  isActive: boolean,
  activeView: LogView,
): void {
  const totals = totalsFor(session);

  for (const [name, total] of totals) {
    const key = viewKey(session.id, name);
    const read = isActive && (activeView === ALL_VIEW || activeView.toLowerCase() === name.toLowerCase());
    if (!seen.has(key) || read) seen.set(key, total);
  }

  const live = new Set([...totals.keys()].map((name) => viewKey(session.id, name)));
  const mine = `${session.id}\u0000`;
  for (const key of seen.keys()) {
    if (key.startsWith(mine) && !live.has(key)) seen.delete(key);
  }
}

/**
 * Lines added to one view since it was last read. A view with no mark has only just
 * appeared and counts as nothing.
 */
export function unreadFor(seen: Map<string, number>, sessionId: string, one: ViewSnapshot): number {
  const mark = seen.get(viewKey(sessionId, one.name));
  return mark === undefined ? 0 : Math.max(0, one.activity - mark);
}

/**
 * Unread private messages across a whole connection, for the badge on its tab.
 *
 * Only conversations count. Channel traffic is ambient — a busy channel would leave the
 * badge permanently lit and say nothing — whereas somebody messaging you directly is the
 * thing worth pulling you back to a connection you are not looking at.
 */
export function unreadWhispers(seen: Map<string, number>, session: SessionSnapshot): number {
  let total = 0;
  for (const one of session.conversations) total += unreadFor(seen, session.id, one);
  return total;
}
