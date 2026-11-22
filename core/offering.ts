/**
 * Proposal kinds — records that are NEVER work (TASK-58/63, docs/quiescent-compute.md §6;
 * TASK-79). The registry entry point is `PROPOSAL_TAGS` below; the shared meaning of
 * membership: the record gets ZERO briefing budget and nothing turns it into work except the
 * user. Staging visibility is per kind:
 *
 *   - `[offering]` — Idle Insights proposals ("Dream Offerings"). Staged PRIVATE + pending
 *     only — never shared, never in a briefing, never on the board. Grounded: every proposal
 *     cites why ("because your records show X (date)" / "newly announced: Y") — no grounding,
 *     no offering. The user alone turns one into a task (promote → normal TASK-nn flow).
 *   - `[thought]` — the thought stream (core/thought.ts): the user's own drops and agents'
 *     riffs, living in the SHARED stream so many agents may contribute to one thread — but
 *     still browsed, never injected, never claimed, never executed, and promoted to work only
 *     by the user.
 *
 * A future kind (e.g. [accelerators]) is one line here plus one in the Tag list — cosmetic
 * names over one pipeline.
 */

import { addedContent, type NewTask } from "./board.ts";

/** Registry of proposal kinds. */
export const PROPOSAL_TAGS = ["offering", "thought"] as const;
export type ProposalTag = (typeof PROPOSAL_TAGS)[number];
export const OFFERING_TAG: ProposalTag = "offering";

const tagRe = (t: string) => new RegExp(`^\\[${t}\\]\\s*`, "i");

export function isProposalContent(content: string): boolean {
  return PROPOSAL_TAGS.some((t) => tagRe(t).test(content.trim()));
}

/** The proposal text without its tag. */
export function offeringBody(content: string): string {
  let s = content.trim();
  for (const t of PROPOSAL_TAGS) s = s.replace(tagRe(t), "");
  return s.trim();
}

/**
 * The proposal sentence alone — no tag, no grounding tail, no `kw:` tokens. This is the
 * Idle Insights card's title (`offeringBody` keeps the tail on purpose: the grounding
 * travels with the text when a proposal is promoted to a task).
 */
export function offeringText(content: string): string {
  return offeringBody(content)
    .replace(/\s*— why: .*?(?= kw:|$)/, "")
    .replace(/\s*kw:[a-z0-9-]+/g, "")
    .trim();
}

/** The grounding from itemContent's " — why: …" tail, if present. */
export function offeringGrounding(content: string): string | undefined {
  const m = / — why: (.*?)(?: kw:|$)/.exec(content);
  return m?.[1]?.trim() || undefined;
}

/** A staged proposal must carry grounding: no grounding, no offering. */
export function hasGrounding(content: string): boolean {
  return Boolean(offeringGrounding(content));
}

/**
 * Board content for a user-promoted offering: the composer owns the TASK-nn id and status
 * segment (core/board.ts) — a proposal becomes a task only through this user-confirmed path.
 */
export function promotedTaskContent(n: number, content: string, size?: string, next?: string): string {
  const task: NewTask = { text: offeringBody(content), ...(size ? { size } : {}), ...(next ? { next } : {}) };
  return addedContent(n, task);
}
