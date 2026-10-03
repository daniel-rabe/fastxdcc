/**
 * Naming the connection tabs.
 *
 * A host name alone is the readable choice, but the same host can be connected twice on
 * different ports (a plain and a TLS one), which would give two tabs the same name. Those
 * get the port added; everything else stays short.
 */

export interface LabelledSession {
  id: string;
  /** Preferred short name, normally the host. */
  label: string;
  /** Unambiguous name, normally `host:port`. */
  network: string;
}

export function tabLabels(sessions: LabelledSession[]): Map<string, string> {
  const counts = new Map<string, number>();
  for (const session of sessions) {
    counts.set(session.label, (counts.get(session.label) ?? 0) + 1);
  }

  return new Map(
    sessions.map((session) => [
      session.id,
      (counts.get(session.label) ?? 0) > 1 ? session.network || session.id : session.label,
    ]),
  );
}
