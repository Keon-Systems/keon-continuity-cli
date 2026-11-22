/**
 * [milestone] — a first-class kind (TASK-69): the moment things shifted. The owner's
 * 2026-11-03 ask: "that little shining light where things suddenly shifted from great to
 * legendary" — pivotal shifts must be findable at a glance.
 *
 * Confirmed-only capture (`continuity milestone <text> --user-confirmed`), the `remember`
 * pipeline under a dedicated name: the user names the shift, it is shared immediately. The
 * command itself never stages anything — and like any kind, a [milestone] may still arrive
 * as a staged candidate (private + pending) through the ordinary review flow; what makes it
 * to shared memory always carries the user's confirmation. The deck graph renders [milestone]
 * records as highlighted "shining light" nodes on the timeline
 * (deck/web/src/lenses/graph-view.ts + MemoryGraph.tsx) — the glow is the findability.
 *
 * The kind is a registry, the core/offering.ts pattern (registry const + one line in the Tag
 * list, core/runtime.ts) — cosmetic names over one pipeline. A milestone is NOT a proposal
 * kind (core/offering.ts PROPOSAL_TAGS is the never-work registry): it is confirmed memory.
 */

import { share, writePrivate } from "./memory.ts";
import type { Runtime } from "./runtime.ts";

/** Registry of milestone kinds. */
export const MILESTONE_TAGS = ["milestone"] as const;
export type MilestoneTag = (typeof MILESTONE_TAGS)[number];
export const MILESTONE_TAG: MilestoneTag = "milestone";

const tagRe = (t: string) => new RegExp(`^\\[${t}\\]\\s*`, "i");

/** Content for a milestone capture: the tag is forced; a stray copy is never doubled. */
export function milestoneContent(text: string): string {
  let s = text.trim();
  for (const t of MILESTONE_TAGS) s = s.replace(tagRe(t), "");
  return `[${MILESTONE_TAG}] ${s}`;
}

/**
 * Record a user-named milestone. The write is the remember pipeline in one confirmed
 * action: store + share immediately — nothing lands in the pending queue and nothing is
 * ever promoted automatically.
 */
export async function addMilestone(rt: Runtime, text: string, sessionId: string, via: string): Promise<{ sourceId: string; derivedId: string; content: string }> {
  const content = milestoneContent(text);
  const sourceId = await writePrivate(rt, { content, sourceKind: "user_said", sessionId, entryRef: "milestone", occurredAt: new Date().toISOString() });
  const derivedId = await share(rt, sourceId, content, `user marked a milestone (via ${via})`, sessionId);
  return { sourceId, derivedId, content };
}
