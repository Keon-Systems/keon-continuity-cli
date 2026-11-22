/**
 * "Since you were last here" delta: diff what this runtime was already delivered
 * (state.deliveries) against the current briefing, so the briefing can LEAD with what
 * changed since this runtime's last visit — closed open loops and supersedes (old → new
 * text) first, then new decisions.
 *
 * Rules, because this section steers what an agent trusts:
 *   - Per runtime: deliveries are attributed to the runtime that received them, so one
 *     harness's last visit never hides a change from another harness's.
 *   - Evidence only: a supersede is reported when a replacement record exists in this
 *     briefing (local state recorded the chain, or the lineage of a fresh record points at
 *     an ancestor that is genuinely superseded). A record merely missing from one recall is
 *     never called superseded — derivation (`share`) leaves its source ACTIVE on purpose.
 *   - Announced once: a change is reported only while its replacement has not been
 *     delivered to this runtime yet. The delta delivers the replacement, so the change
 *     retires itself on the next visit.
 *   - No scoring, no ranking: the delta leads the briefing text and changes nothing else.
 */

import { oneLine } from "./guard.ts";
import { stripTag, tagOf, type Runtime } from "./runtime.ts";

/** Structurally satisfied by core/briefing.ts's BriefingShard; kept local to avoid a module cycle. */
export interface DeltaShard {
  id: string;
  content: string;
  tag: string;
  status: string;
  occurredAt?: string;
}

export interface DeltaItem {
  id: string;
  tag: string;
  /** Flattened one-line text without the leading tag. */
  text: string;
  occurredAt?: string;
}

export interface DeltaChange {
  /** The record that is no longer current: quoted so the agent knows what NOT to trust. */
  from: DeltaItem;
  /** The live record that took its place. */
  to: DeltaItem;
}

export interface BriefingDelta {
  /** Date (YYYY-MM-DD) of this runtime's previous delivery — its last visit. */
  since: string;
  newDecisions: DeltaItem[];
  supersedes: DeltaChange[];
  closedLoops: DeltaChange[];
}

export interface DeliveryBaseline {
  /** Every record id this runtime has already been delivered (plus unattributable legacy ones). */
  seen: Set<string>;
  /** ISO time of this runtime's most recent delivery; undefined = first visit. */
  lastVisitAt?: string;
}

const MAX_LINEAGE_PROBES = 12;
const MAX_CHAIN_HOPS = 8;
const TEXT_CAP = 240;

/**
 * What this runtime has already been shown. Deliveries recorded before runtime
 * attribution existed cannot be assigned to a harness; they count as seen by everyone on
 * this machine — under-reporting a change is safer than re-announcing one that was
 * already shown here.
 */
export function baselineFor(rt: Runtime): DeliveryBaseline {
  const mine = (rt.state.deliveries ?? []).filter((d) => d.runtime === undefined || d.runtime === rt.runtimeName);
  const seen = new Set<string>();
  let lastVisitAt: string | undefined;
  for (const d of mine) {
    for (const id of d.ids) seen.add(id);
    // Summarized records (hint/overflow counts) were SHOWN too — their changes are not news.
    for (const id of d.summarizedIds ?? []) seen.add(id);
    if (!lastVisitAt || d.at > lastVisitAt) lastVisitAt = d.at;
  }
  return { seen, lastVisitAt };
}

const itemOf = (id: string, content: string, occurredAt?: string): DeltaItem => ({
  id,
  tag: tagOf(content),
  text: oneLine(stripTag(content), TEXT_CAP),
  occurredAt,
});

const byRecency = (a: DeltaItem, b: DeltaItem): number =>
  (Date.parse(b.occurredAt ?? "") || 0) - (Date.parse(a.occurredAt ?? "") || 0) || a.id.localeCompare(b.id);

const isGone = (status: string): boolean => status === "superseded" || status === "archived";

/**
 * What changed since this runtime's last visit, or undefined when there was no last visit
 * (first time here) or nothing it has not already been shown.
 */
export async function computeDelta(rt: Runtime, shared: DeltaShard[], all: DeltaShard[]): Promise<BriefingDelta | undefined> {
  const base = baselineFor(rt);
  if (!base.lastVisitAt) return undefined; // first visit: there is no "last time" to diff against
  const fresh = shared.filter((d) => !base.seen.has(d.id));
  const freshById = new Map(fresh.map((d) => [d.id, d]));
  const byId = new Map(all.map((d) => [d.id, d]));
  const pairs: DeltaChange[] = [];
  const pairedTo = new Set<string>();
  const pairedFrom = new Set<string>();

  // (a) supersede chains Continuity itself recorded (core/memory.ts supersede()). A chain
  // A→B→C with several seen links pairs the FRESHEST seen link to C: that is the text this
  // runtime last knew, which is exactly what "old → new" must show.
  const chainFrom = new Map<string, { id: string; content: string; at?: string }>();
  for (const s of rt.state.shared) {
    if (!s.supersededBy || !base.seen.has(s.derivedId)) continue;
    let terminal = s.supersededBy;
    for (let hop = 0; hop < MAX_CHAIN_HOPS; hop++) {
      const next = rt.state.shared.find((x) => x.derivedId === terminal && x.supersededBy);
      if (!next) break;
      terminal = next.supersededBy!;
    }
    if (base.seen.has(terminal)) continue;
    const prev = chainFrom.get(terminal);
    if (!prev || (s.approvedAt ?? "") > (prev.at ?? "")) chainFrom.set(terminal, { id: s.derivedId, content: s.content, at: s.approvedAt });
  }
  for (const [terminal, from] of chainFrom) {
    const to = freshById.get(terminal);
    if (!to) continue; // the replacement is not in this briefing; nothing honest to deliver here
    pairs.push({ from: itemOf(from.id, from.content, from.at), to: itemOf(to.id, to.content, to.occurredAt) });
    pairedTo.add(to.id);
    pairedFrom.add(from.id);
  }

  // (b) lineage fallback for replacements local state does not know (another machine or
  // worktree superseded them). KNOWN LIMIT: this depends on Cortex populating `ancestor_ids`;
  // as of Cortex fba159b GET /v1/shards/{id}/lineage always returns [] (api.py), so today a
  // cross-machine supersede shows up as a plain "new decision" instead of an old → new pair.
  // Left as is on purpose — it starts working the moment Cortex fills the field. The fake Cortex
  // (smoke/fake-cortex.ts `ancestors`) returns what tests feed it, so tests cannot see this gap. Only a genuinely superseded/archived ancestor counts as
  // "old" — derivation keeps its source ACTIVE, and absence from a recall proves nothing.
  const probes = [...fresh]
    .sort((a, b) => (Date.parse(b.occurredAt ?? "") || 0) - (Date.parse(a.occurredAt ?? "") || 0) || a.id.localeCompare(b.id))
    .slice(0, MAX_LINEAGE_PROBES);
  for (const d of probes) {
    if (pairedTo.has(d.id)) continue;
    let ancestors: string[];
    try {
      ancestors = (await rt.agent.lineage(d.id)).ancestor_ids ?? [];
    } catch {
      continue; // no lineage available: local state already had its say, never guess
    }
    const olds: DeltaShard[] = [];
    for (const id of ancestors) {
      if (!base.seen.has(id) || pairedFrom.has(id)) continue;
      let shard = byId.get(id);
      if (!shard) {
        const det = await rt.agent.getShard(id).catch(() => undefined);
        if (det) shard = { id, content: det.content, tag: tagOf(det.content), status: det.status, occurredAt: det.provenance?.checkpoint_at ?? det.created_at };
      }
      if (shard && isGone(shard.status)) olds.push(shard);
    }
    if (olds.length === 0) continue; // derivation or unknown history: not a replacement
    olds.sort((a, b) => (Date.parse(b.occurredAt ?? "") || 0) - (Date.parse(a.occurredAt ?? "") || 0) || a.id.localeCompare(b.id));
    const from = olds[0];
    pairs.push({ from: itemOf(from.id, from.content, from.occurredAt), to: itemOf(d.id, d.content, d.occurredAt) });
    pairedTo.add(d.id);
    pairedFrom.add(from.id);
  }

  // A supersede of an open loop by anything else closes the loop; an open loop rewritten as
  // an open loop (claim, release, re-scope) is an ordinary supersede.
  const supersedes: DeltaChange[] = [];
  const closedLoops: DeltaChange[] = [];
  for (const p of pairs) (p.from.tag === "open-loop" && p.to.tag !== "open-loop" ? closedLoops : supersedes).push(p);

  const newDecisions = fresh
    .filter((d) => d.tag === "decision" && !pairedTo.has(d.id))
    .map((d) => itemOf(d.id, d.content, d.occurredAt));

  if (newDecisions.length === 0 && pairs.length === 0) return undefined;
  return {
    since: base.lastVisitAt.slice(0, 10),
    newDecisions: newDecisions.sort(byRecency),
    supersedes: supersedes.sort((a, b) => byRecency(a.to, b.to)),
    closedLoops: closedLoops.sort((a, b) => byRecency(a.to, b.to)),
  };
}
