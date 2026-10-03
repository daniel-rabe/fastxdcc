import React, { useState } from 'react';
import { isIrcLink, linkify } from '../linkify.js';

interface Props {
  channel: string;
  topic: string;
  /** Open a page in the Browse tab, and bring that tab forward. */
  onOpenPage: (url: string) => void;
  /** Follow an `irc://` link, which connects or joins rather than browsing. */
  onOpenIrc: (url: string) => void;
}

/**
 * Shows the topic of the channel being read, directly above its chat.
 *
 * Kept to one line by default because topics on pack networks run to several hundred
 * characters and would otherwise push the chat off the screen; the whole thing is one
 * click away, and is there in the tooltip either way.
 */
export function TopicBar({ channel, topic, onOpenPage, onOpenIrc }: Props): React.ReactElement {
  const [expanded, setExpanded] = useState(false);
  const parts = linkify(topic);

  return (
    <div className={`topicbar ${expanded ? 'expanded' : ''}`} title={`${channel} — ${topic}`}>
      <span className="label">Topic</span>
      <span className="text">
        {parts.map((part, index) =>
          part.href ? (
            <button
              key={index}
              className="link inline"
              title={part.href}
              onClick={() => (isIrcLink(part.href!) ? onOpenIrc(part.href!) : onOpenPage(part.href!))}
            >
              {part.text}
            </button>
          ) : (
            <React.Fragment key={index}>{part.text}</React.Fragment>
          ),
        )}
      </span>
      <button
        className="link more"
        aria-expanded={expanded}
        title={expanded ? 'Show one line' : 'Show the whole topic'}
        onClick={() => setExpanded((shown) => !shown)}
      >
        {expanded ? '▴' : '▾'}
      </button>
    </div>
  );
}
