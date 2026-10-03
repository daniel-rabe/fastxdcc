/**
 * Splitting one server's log into the views the channel bar switches between.
 *
 * Every line already carries the source it belongs to — a channel, a nick, or `*` for the
 * client itself — so no second copy of the log is needed per view. This decides which
 * lines belong to the view the user picked, and is kept pure so the rules are testable
 * without a browser.
 *
 * The one rule that holds everything together: every line is in exactly one view. A
 * channel's lines are its own, a nick's lines are its own once that conversation is open,
 * and whatever is left over is the server view.
 */

import type { LogSnapshot, ViewSnapshot } from '../app/snapshot.js';
import { isChannelSource } from '../app/store.js';

/** Everything from this server, which is what the pane showed before views existed. */
export const ALL_VIEW = 'all';
/** The client, the DCC machinery, and anyone without a conversation open. */
export const SERVER_VIEW = 'server';

/** `ALL_VIEW`, `SERVER_VIEW`, a channel name, or a nick. */
export type LogView = string;

/**
 * Safe to collide-check: IRC channel names always start with `#`, `&`, `+` or `!`, and a
 * nick may not, so neither can be mistaken for one of the two fixed views. A person called
 * `server` would be, which is why `all` and `server` are spelled in lower case and nicks
 * are compared in the case the server gave them — see `isFixedView` callers, which only
 * ever ask about a view they chose themselves.
 */
export function isFixedView(view: LogView): boolean {
  return view === ALL_VIEW || view === SERVER_VIEW;
}

export function filterLog(
  lines: LogSnapshot[],
  view: LogView,
  conversations: ViewSnapshot[] = [],
): LogSnapshot[] {
  if (view === ALL_VIEW) return lines;

  if (view === SERVER_VIEW) {
    const claimed = new Set(conversations.map((one) => one.name.toLowerCase()));
    return lines.filter(
      (line) => !isChannelSource(line.source) && !claimed.has(line.source.toLowerCase()),
    );
  }

  const wanted = view.toLowerCase();
  return lines.filter((line) => line.source.toLowerCase() === wanted);
}

/**
 * The view to fall back to when the selected one disappears — which happens on a part, a
 * kick, a closed conversation, or a reconnect that has not rejoined yet.
 */
export function resolveView(view: LogView, views: ViewSnapshot[]): LogView {
  if (isFixedView(view)) return view;
  return views.some((one) => one.name.toLowerCase() === view.toLowerCase()) ? view : ALL_VIEW;
}

/**
 * Lines added since this view was last on screen. `seen` being absent means the view has
 * only just appeared, and a conversation we have never looked at should not open with a
 * badge counting the backlog it was opened on.
 */
export function unreadCount(activity: number, seen: number | undefined): number {
  if (seen === undefined) return 0;
  return Math.max(0, activity - seen);
}

/** The target a message typed into a view should be sent to, if any. */
export function viewTarget(view: LogView): string | undefined {
  return isFixedView(view) ? undefined : view;
}
