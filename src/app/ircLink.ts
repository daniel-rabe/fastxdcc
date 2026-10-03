/**
 * Deciding what clicking an `irc://` link should do.
 *
 * Several servers can be connected at once, each with its own tab, so a link to a server
 * that is not open yet simply opens another one. Nothing is ever torn down to follow a
 * link, which is why there is no "are you sure" case here.
 *
 * Kept separate from Electron so the rules can be tested on their own.
 */

import type { NormalisedChannel } from '../config.js';
import type { IrcTarget } from '../irc/url.js';

/** Identity of a connection: one per host and port. */
export function sessionIdFor(host: string, port: number): string {
  return `${host.trim().toLowerCase()}:${port}`;
}

export interface SessionSummary {
  id: string;
  host: string;
  port: number;
  /** Channels already joined, lower-cased. */
  channels: string[];
}

export type IrcLinkPlan =
  /** That server is open and the channel still needs joining. */
  | { action: 'join'; sessionId: string; channel: string; key?: string }
  /** That server is open and the channel is already joined. */
  | { action: 'alreadyThere'; sessionId: string; channel: string }
  /** Not connected to that server yet, so open a tab for it. */
  | { action: 'open'; target: IrcTarget }
  /** The link names a person, which this client has nothing useful to do with. */
  | { action: 'unsupported'; reason: string };

export function planIrcLink(target: IrcTarget, sessions: SessionSummary[]): IrcLinkPlan {
  if (target.isNick) {
    return {
      action: 'unsupported',
      reason: 'That link points at a person, not a channel.',
    };
  }

  const wanted = sessionIdFor(target.host, target.port);
  // The port matters as well as the host: one machine can serve both a plain and a TLS
  // port, and they are separate connections.
  const existing = sessions.find((session) => session.id === wanted);

  if (!existing) return { action: 'open', target };

  if (!target.channel) {
    return { action: 'alreadyThere', sessionId: existing.id, channel: '' };
  }
  if (existing.channels.includes(target.channel.toLowerCase())) {
    return { action: 'alreadyThere', sessionId: existing.id, channel: target.channel };
  }

  const plan: IrcLinkPlan = {
    action: 'join',
    sessionId: existing.id,
    channel: target.channel,
  };
  if (target.key !== undefined) plan.key = target.key;
  return plan;
}

/**
 * Which channels to join when opening a connection because of a link.
 *
 * On the server the user already configured, their own channels are kept and the linked
 * one is added — losing them would be surprising. On any other server only the linked
 * channel is joined, since the configured list belongs to a different network.
 */
export function channelsForTarget(
  configured: { host: string; port: number; channels: NormalisedChannel[] },
  target: IrcTarget,
): NormalisedChannel[] {
  const linked: NormalisedChannel | undefined = target.channel
    ? { name: target.channel, ...(target.key ? { key: target.key } : {}) }
    : undefined;

  const isConfiguredServer =
    configured.host.trim() !== '' &&
    sessionIdFor(configured.host, configured.port) === sessionIdFor(target.host, target.port);

  if (!isConfiguredServer) return linked ? [linked] : [];
  if (!linked) return configured.channels;

  const already = configured.channels.some(
    (channel) => channel.name.toLowerCase() === linked.name.toLowerCase(),
  );
  return already ? configured.channels : [...configured.channels, linked];
}
