/**
 * Open-loop closure.
 *
 * An agent that observes evidence (test passes, a commit lands) proposes closing an
 * [open-loop] record with the ref: it stages a `[closed]` candidate (private + pending),
 * the user confirms, and `continuity close <id> --evidence <ref> --user-confirmed`
 * supersedes the loop. Closure is a supersede (core/memory.ts) so history is kept: the
 * open loop stays inspectable, and the delta announces the pair as a "closed open loop"
 * rather than an ordinary supersede (core/delta.ts).
 */

import { stripTag } from "./runtime.ts";

/** The closure record: the loop's text plus when it closed and the evidence ref. */
export function closureContent(loopContent: string, evidence: string, date = new Date().toISOString().slice(0, 10)): string {
  return `[closed] ${stripTag(loopContent.trim())} — closed ${date} ref:${evidence}`;
}

/**
 * Is this content a staged closure candidate for this loop + evidence? The date in the
 * middle drifts between staging and confirmation, so match on the text and the ref.
 */
export function isClosureCandidate(content: string, loopContent: string, evidence: string): boolean {
  const t = content.trim();
  const text = stripTag(loopContent.trim());
  return (t === `[closed] ${text}` || t.startsWith(`[closed] ${text} — `)) && t.endsWith(`ref:${evidence}`);
}
