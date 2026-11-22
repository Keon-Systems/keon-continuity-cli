/**
 * Baton / handoff records: `continuity handoff --to <runtime> <text>` maps onto the Cortex
 * `handoff` curation kind (shards/1.1). The contract, verified in smoke/smoke.ts §9 against
 * the live protocol:
 *
 *   - visible only to the target role (plus its author, who can read what it sent)
 *   - shown in the target's next briefing as "a baton from <runtime>"
 *   - consumed once via the access event that delivery reports (Cortex re-delivers,
 *     so consumption is enforced in core/briefing.ts, never assumed from the protocol)
 *   - never promoted to shared memory (core/memory.ts refuses share/supersede on batons)
 *
 * Classification is pure: content tag and/or curation provenance. This module imports
 * nothing from core, so memory.ts and briefing.ts can both depend on it.
 */

/** What a baton record says about itself. */
export interface BatonInfo {
  /** Runtime name that sent the baton, derived from the recorded actor/role id. */
  from: string;
  /** Role id the baton is addressed to. Undefined = not addressed (never shown: fail closed). */
  toRole?: string;
}

const BATON_TAG = /^\[handoff\]\s/;

export function isBatonContent(content: string): boolean {
  return BATON_TAG.test(content);
}

/**
 * Classify a record as a baton from its content tag and/or its curation provenance.
 * Returns undefined for ordinary memory. When the provenance is unavailable (hydration
 * failed) a [handoff]-tagged record still classifies as a baton with an unknown target —
 * which the briefing refuses to show.
 */
export function batonInfo(content: string, extra: Record<string, unknown> | undefined): BatonInfo | undefined {
  const scoped = extra?.scope_class === "handoff" || extra?.curation_kind === "handoff";
  if (!scoped && !isBatonContent(content)) return undefined;
  const actor = typeof extra?.agent_id === "string" ? extra.agent_id : undefined;
  const role = typeof extra?.role_id === "string" ? extra.role_id : undefined;
  const raw = actor ?? role;
  const from = raw ? raw.replace(/^(agent|role)_/, "") : "another agent";
  const toRole = typeof extra?.handoff_to_role_id === "string" ? extra.handoff_to_role_id : undefined;
  return { from, toRole };
}
