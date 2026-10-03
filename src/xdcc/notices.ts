/**
 * Interpreting XDCC bot NOTICEs.
 *
 * There is no standard here — iroffer, XDCC klipper, and the various forks all phrase
 * things differently — so this is deliberately heuristic. Anything unrecognised is
 * classified as `unknown` and logged rather than treated as an error: a bot saying
 * something we did not anticipate must never fail a download that is otherwise fine.
 */

export type BotNoticeKind =
  | 'queued'
  | 'sending'
  | 'denied'
  | 'invalidPack'
  | 'alreadyQueued'
  | 'alreadyRequested'
  | 'queueFull'
  | 'removedFromQueue'
  | 'completed'
  | 'unknown';

export interface BotNotice {
  kind: BotNoticeKind;
  /** Position in the bot's queue, when it told us one. */
  position?: number;
  /** Queue length, when it told us one. */
  total?: number;
  /** Pack number, when the notice mentions one. */
  pack?: number;
  /** The reason text for a denial, trimmed of decoration. */
  reason?: string;
  text: string;
}

/** Bots pad notices with `**`, `-`, and similar decoration. */
function clean(text: string): string {
  return text.replace(/\x02|\x1f|\x0f|\x03\d{0,2}(,\d{1,2})?/g, '').replace(/^[\s*\-]+/, '').trim();
}

const RULES: Array<{
  kind: BotNoticeKind;
  re: RegExp;
  map?: (m: RegExpMatchArray) => Partial<BotNotice>;
}> = [
  {
    // "Added you to the main queue for pack 12 in position 3." / "queued ... position 3 of 10"
    kind: 'queued',
    re: /(?:queue|queued).*?position\s+(\d+)(?:\s+of\s+(\d+))?/i,
    map: (m) => ({
      position: Number(m[1]),
      ...(m[2] ? { total: Number(m[2]) } : {}),
    }),
  },
  {
    // Some bots omit the word "position": "You are in queue slot 4"
    kind: 'queued',
    re: /queue\s+slot\s+(\d+)/i,
    map: (m) => ({ position: Number(m[1]) }),
  },
  {
    kind: 'queueFull',
    re: /(?:queue is full|all slots full and the queue is full|too many people in queue)/i,
  },
  {
    kind: 'alreadyQueued',
    re: /already (?:have|has) (?:that|this) (?:item|pack|file) queued/i,
  },
  {
    kind: 'alreadyRequested',
    re: /already requested that (?:pack|file)|you already have a (?:transfer|dcc) (?:running|pending)/i,
  },
  {
    kind: 'removedFromQueue',
    re: /removed (?:you )?from (?:the )?queue|removed your (?:queue|request)/i,
  },
  {
    kind: 'invalidPack',
    re: /pack number .* is invalid|invalid pack(?: number)?|that pack does not exist/i,
  },
  {
    kind: 'sending',
    re: /sending\s+you\s+(?:pack\s*#?(\d+))?/i,
    map: (m) => (m[1] ? { pack: Number(m[1]) } : {}),
  },
  {
    kind: 'completed',
    re: /transfer completed|closing connection: transfer completed/i,
  },
  {
    kind: 'denied',
    re: /^(?:xdcc\s+)?(?:send\s+)?denied[,:]?\s*(.*)$/i,
    map: (m) => ({ reason: (m[1] ?? '').trim() || undefined }),
  },
  {
    // "You must be on a known channel to request a pack"
    kind: 'denied',
    re: /you (?:must|need to) be (?:on|in) (?:a )?(?:known )?channel/i,
    map: (m) => ({ reason: m[0] }),
  },
];

export function parseBotNotice(raw: string): BotNotice {
  const text = clean(raw);
  for (const rule of RULES) {
    const match = rule.re.exec(text);
    if (match) {
      return { kind: rule.kind, text, ...(rule.map ? rule.map(match) : {}) };
    }
  }
  return { kind: 'unknown', text };
}

/** Kinds that mean the request will never produce a transfer, so stop waiting. */
export function isTerminalFailure(kind: BotNoticeKind): boolean {
  return kind === 'denied' || kind === 'invalidPack' || kind === 'queueFull';
}
