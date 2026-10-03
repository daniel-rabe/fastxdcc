/**
 * Converting between the config's channel list and the one-per-line text a form shows.
 * Pure and shared, so the GUI and the tests agree on what `#chan key` means.
 */

import type { NormalisedChannel } from '../config.js';

export type ChannelEntry = string | { name: string; key?: string };

export function channelsToText(channels: ChannelEntry[]): string {
  return channels
    .map((channel) =>
      typeof channel === 'string'
        ? channel
        : channel.key
          ? `${channel.name} ${channel.key}`
          : channel.name,
    )
    .join('\n');
}

/**
 * Parse one channel per line, `#name` or `#name key`. A leading `#` is added when the
 * user omits it, since every network in practice uses it and forgetting it is a silent
 * failure to join.
 */
export function textToChannels(text: string): NormalisedChannel[] {
  const out: NormalisedChannel[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '') continue;
    const [rawName, key] = line.split(/\s+/, 2);
    if (!rawName) continue;
    const name = /^[#&+!]/.test(rawName) ? rawName : `#${rawName}`;
    out.push(key ? { name, key } : { name });
  }
  return out;
}
