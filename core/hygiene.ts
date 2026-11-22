/**
 * Hygiene — a READ-ONLY review queue over what Continuity keeps showing and what feedback
 * keeps saying back:
 *
 *   stale        delivered often but never applied (access is not use)
 *   contradicted non-applicability reported repeatedly ("did not apply HERE", not "false")
 *   aged loops   [open-loop] records that have been open for N days
 *
 * Rules (each has a test in smoke/hygiene.test.ts):
 *   H-1  Nothing here writes anywhere: no access events, no deliveries, no feedback, no Cortex
 *        writes of any kind. The queue is computed from local state (state.deliveries and the
 *        locally journaled feedback of core/feedback.ts) plus one read-only shared-record
 *        search for open loops.
 *   H-2  Ranking untouched. Feedback changes no score (core/feedback.ts), and this queue
 *        changes nothing at all: it describes, it never re-orders or re-scores memory.
 *   H-3  Descriptive, never verdicts. A queue entry prompts the USER to review (supersede /
 *        done / drop); nothing is retired automatically. "Contradicted" is context-scoped
 *        non-applicability, not a claim that the record is false.
 *   H-4  Evidence only. A record is stale on recorded deliveries and recorded feedback alone;
 *        undated open loops cannot be aged and are not queued (they are counted, not hidden).
 */

import { grant, type SearchShard } from "../src/cortex.ts";
import { parseTask } from "./board.ts";
import { oneLine } from "./guard.ts";
import { stripTag, tagOf, type Runtime } from "./runtime.ts";
import type { FeedbackNote } from "./state.ts";

/** Deliveries that must have carried a record before it is "accessed often". */
export const STALE_MIN_DELIVERIES = 3;
/** Distinct non-applicability reports before a record is "repeated not-applicable". */
export const CONTRADICTED_MIN_NON_APPLICABILITY = 2;
/** Whole days an [open-loop] record must have been open before it is "aged". */
export const AGED_LOOP_DAYS = 7;

const TEXT_CAP = 160;
const SEARCH_MAX = 100;

/** An [open-loop] record as the shared-record search returns it (no delivery semantics). */
export interface LoopShard {
  id: string;
  content: string;
  occurredAt?: string;
  status?: string;
}

export interface HygieneEntry {
  id: string;
  tag: string;
  /** Flattened one-line text without the leading tag; "" when the content could not be found. */
  text: string;
  /** Recorded deliveries that carried this record (access; not use). */
  deliveries: number;
  applications: number;
  nonApplicabilities: number;
  considerations: number;
  outcomes: number;
  /** Runtimes whose deliveries carried it ("legacy" = recorded before attribution). */
  runtimes: string[];
  firstAccessAt?: string;
  lastAccessAt?: string;
  /** The reports behind "contradicted": where and why it did not apply (context-scoped). */
  notApplicable: Pick<FeedbackNote, "at" | "contextRef" | "reason" | "runtime">[];
  /** Aged open loops only. */
  openDays?: number;
  occurredAt?: string;
}

export interface HygieneReport {
  generatedAt: string;
  profile: string;
  stale: HygieneEntry[];
  contradicted: HygieneEntry[];
  agedLoops: HygieneEntry[];
  thresholds: { staleMinDeliveries: number; contradictedMinNonApplicability: number; agedLoopDays: number };
  /** Open loops the search could not cover (cap hit, or no date to age them by). */
  loopsSkipped: { truncated: boolean; undated: number };
  /** Stated so no consumer can assume otherwise: hygiene never changes ranking. */
  ranking: "untouched";
  note: string;
}

const NOTE =
  "read-only queue computed from state.deliveries and locally journaled feedback plus a read-only shared-record search; nothing was written and no ranking changed (feedback changes no ranking)";

interface IdStat {
  id: string;
  deliveries: number;
  runtimes: Set<string>;
  firstAccessAt?: string;
  lastAccessAt?: string;
  applications: number;
  nonApplicabilities: number;
  considerations: number;
  outcomes: number;
  notApplicable: Pick<FeedbackNote, "at" | "contextRef" | "reason" | "runtime">[];
}

function statFor(stats: Map<string, IdStat>, id: string): IdStat {
  let s = stats.get(id);
  if (!s) {
    s = { id, deliveries: 0, runtimes: new Set(), applications: 0, nonApplicabilities: 0, considerations: 0, outcomes: 0, notApplicable: [] };
    stats.set(id, s);
  }
  return s;
}

/**
 * The queue, computed from local state and the given open-loop records. Pure apart from reading
 * `rt.state`: it never calls Cortex and never writes (H-1). `nowMs` is injectable for tests.
 */
export function computeHygiene(rt: Runtime, loops: LoopShard[], nowMs = Date.now()): HygieneReport {
  const stats = new Map<string, IdStat>();
  for (const d of rt.state.deliveries ?? []) {
    for (const id of d.ids) {
      const s = statFor(stats, id);
      s.deliveries += 1;
      s.runtimes.add(d.runtime ?? "legacy");
      if (!s.firstAccessAt || d.at < s.firstAccessAt) s.firstAccessAt = d.at;
      if (!s.lastAccessAt || d.at > s.lastAccessAt) s.lastAccessAt = d.at;
    }
  }
  for (const n of rt.state.feedback ?? []) {
    const s = statFor(stats, n.memoryId);
    if (n.kind === "application") s.applications += 1;
    else if (n.kind === "consideration") s.considerations += 1;
    else if (n.kind === "outcome") s.outcomes += 1;
    else {
      s.nonApplicabilities += 1;
      s.notApplicable.push({ at: n.at, contextRef: n.contextRef, reason: n.reason, runtime: n.runtime });
    }
  }

  // Content for the queue lines: what local state knows, so the queue is readable offline.
  const contentOf = new Map<string, string>();
  for (const s of rt.state.shared) {
    contentOf.set(s.derivedId, s.content);
    contentOf.set(s.sourceId, s.content);
  }
  for (const p of rt.state.pending) contentOf.set(p.shardId, p.content);
  // Superseded records are history: they leave the queue (H-3 — and a replacement is its own review).
  const superseded = new Set(rt.state.shared.filter((s) => s.supersededBy).map((s) => s.derivedId));

  const entryOf = (s: IdStat): HygieneEntry => {
    const content = contentOf.get(s.id);
    return {
      id: s.id,
      tag: content ? tagOf(content) : "",
      text: content ? oneLine(stripTag(content), TEXT_CAP) : "",
      deliveries: s.deliveries,
      applications: s.applications,
      nonApplicabilities: s.nonApplicabilities,
      considerations: s.considerations,
      outcomes: s.outcomes,
      runtimes: [...s.runtimes].sort(),
      firstAccessAt: s.firstAccessAt,
      lastAccessAt: s.lastAccessAt,
      notApplicable: s.notApplicable,
    };
  };
  const byCount = (a: HygieneEntry, b: HygieneEntry) => b.deliveries - a.deliveries || a.id.localeCompare(b.id);

  // Contradicted: repeated non-applicability. A record also delivered often lands here only —
  // explicit feedback is the stronger signal, and one queue entry per record keeps this a review list.
  const contradicted = [...stats.values()]
    .filter((s) => s.nonApplicabilities >= CONTRADICTED_MIN_NON_APPLICABILITY && !superseded.has(s.id))
    .map(entryOf)
    .sort((a, b) => b.nonApplicabilities - a.nonApplicabilities || a.id.localeCompare(b.id));
  const contradictedIds = new Set(contradicted.map((e) => e.id));

  // Stale: accessed often, never applied. Considerations and outcomes are shown as context but
  // do not count as application — the feedback vocabulary is deliberate (cited is not applied).
  const stale = [...stats.values()]
    .filter((s) => s.deliveries >= STALE_MIN_DELIVERIES && s.applications === 0 && !superseded.has(s.id) && !contradictedIds.has(s.id))
    .map(entryOf)
    .sort(byCount);

  // Aged open loops: current [open-loop] records, TASK-nn excluded (the board flags those itself).
  let undated = 0;
  const agedLoops: HygieneEntry[] = [];
  for (const l of loops) {
    if (l.status === "superseded" || l.status === "archived") continue;
    if (tagOf(l.content) !== "open-loop") continue;
    if (parseTask(l.content)) continue;
    const occurredAt = l.occurredAt;
    const t = occurredAt ? Date.parse(occurredAt) : NaN;
    if (!Number.isFinite(t)) {
      undated += 1;
      continue;
    }
    const openDays = Math.floor((nowMs - t) / 86_400_000);
    if (openDays < AGED_LOOP_DAYS) continue;
    const s = stats.get(l.id);
    agedLoops.push({
      id: l.id,
      tag: "open-loop",
      text: oneLine(stripTag(l.content), TEXT_CAP),
      deliveries: s?.deliveries ?? 0,
      applications: s?.applications ?? 0,
      nonApplicabilities: s?.nonApplicabilities ?? 0,
      considerations: s?.considerations ?? 0,
      outcomes: s?.outcomes ?? 0,
      runtimes: s ? [...s.runtimes].sort() : [],
      firstAccessAt: s?.firstAccessAt,
      lastAccessAt: s?.lastAccessAt,
      notApplicable: s?.notApplicable ?? [],
      openDays,
      occurredAt,
    });
  }
  agedLoops.sort((a, b) => (b.openDays ?? 0) - (a.openDays ?? 0) || a.id.localeCompare(b.id));

  return {
    generatedAt: new Date(nowMs).toISOString(),
    profile: rt.profileId,
    stale,
    contradicted,
    agedLoops,
    thresholds: { staleMinDeliveries: STALE_MIN_DELIVERIES, contradictedMinNonApplicability: CONTRADICTED_MIN_NON_APPLICABILITY, agedLoopDays: AGED_LOOP_DAYS },
    loopsSkipped: { truncated: false, undated },
    ranking: "untouched",
    note: NOTE,
  };
}

/**
 * Current shared [open-loop] records, via the internal `search` read (no delivery semantics)
 * with the shared grant only — the same read the task board uses. READ-ONLY: unlike briefing
 * and recall, this reports no access event and records no delivery (H-1).
 */
export async function loadOpenLoops(rt: Runtime): Promise<{ loops: LoopShard[]; truncated: boolean }> {
  const shared = rt.agent.as({ ...rt.agent.identity, grants: [grant.profileShared(rt.profileId)] });
  const r = await shared.search("[open-loop]", SEARCH_MAX);
  const loops: LoopShard[] = [];
  for (const s of r.shards as SearchShard[]) {
    const prov = s.provenance as { checkpoint_at?: string } | undefined;
    loops.push({ id: s.shard_id, content: s.content, occurredAt: prov?.checkpoint_at ?? (typeof s.created_at === "string" ? s.created_at : undefined), status: s.status });
  }
  return { loops, truncated: r.truncated || r.total > r.shards.length };
}

/**
 * The full report: the pure computation, plus read-only hydration of queue lines whose content
 * is not in local state (records shared from another machine or worktree).
 */
export async function hygieneReport(rt: Runtime): Promise<HygieneReport> {
  const { loops, truncated } = await loadOpenLoops(rt);
  const rep = computeHygiene(rt, loops);
  rep.loopsSkipped.truncated = truncated;
  const missing = [...rep.stale, ...rep.contradicted].filter((e) => e.text === "");
  await Promise.all(
    missing.map(async (e) => {
      const d = await rt.agent.getShard(e.id).catch(() => undefined);
      if (d) {
        e.tag = tagOf(d.content);
        e.text = oneLine(stripTag(d.content), TEXT_CAP);
      }
    }),
  );
  return rep;
}

export function formatHygiene(rep: HygieneReport): string {
  const short = (id: string) => id.slice(0, 10);
  const body = (e: HygieneEntry) => (e.text ? `[${e.tag}] ${e.text}` : "(content unavailable)");
  const lines: string[] = [`## Continuity hygiene — ${rep.profile} (read-only · nothing written · ranking untouched)`];
  const sec = (title: string, rows: string[]) => {
    if (rows.length === 0) return;
    lines.push(``, title, ...rows);
  };
  sec(
    `stale — delivered often, never applied (≥${rep.thresholds.staleMinDeliveries} deliveries, 0 applications):`,
    rep.stale.map((e) => {
      const use = [e.applications ? `${e.applications} applied` : "", e.outcomes ? `${e.outcomes} outcome` : "", e.considerations ? `${e.considerations} cited-not-applied` : ""].filter(Boolean).join(" · ");
      return `  ${short(e.id)}  ×${e.deliveries} deliveries (${e.runtimes.join(", ")})${use ? ` · ${use}` : ""}  ${body(e)}`;
    }),
  );
  sec(
    `contradicted — repeated not-applicable (≥${rep.thresholds.contradictedMinNonApplicability}; "did not apply here", not "false"):`,
    rep.contradicted.flatMap((e) => [
      `  ${short(e.id)}  ×${e.nonApplicabilities} not-applicable  ${body(e)}`,
      ...e.notApplicable.map((n) => `      ${n.at.slice(0, 10)}${n.runtime ? ` (${n.runtime})` : ""}${n.contextRef ? ` ${n.contextRef}` : ""}${n.reason ? ` — ${oneLine(n.reason, 120)}` : ""}`),
    ]),
  );
  sec(
    `aged open loops — open ≥${rep.thresholds.agedLoopDays} days:`,
    rep.agedLoops.map((e) => `  ${short(e.id)}  open ${e.openDays} day${e.openDays === 1 ? "" : "s"}${e.occurredAt ? ` (since ${e.occurredAt.slice(0, 10)})` : ""}  ${body(e)}`),
  );
  const total = rep.stale.length + rep.contradicted.length + rep.agedLoops.length;
  lines.push(``);
  if (total === 0) lines.push(`queue is empty: nothing delivered often without being applied, nothing marked not-applicable more than once, no open loop aged ≥${rep.thresholds.agedLoopDays} days.`);
  else lines.push(`(${total} item(s) in the queue · thresholds: stale ≥${rep.thresholds.staleMinDeliveries} deliveries · contradicted ≥${rep.thresholds.contradictedMinNonApplicability} not-applicable · aged ≥${rep.thresholds.agedLoopDays} days)`);
  const skipped: string[] = [];
  if (rep.loopsSkipped.truncated) skipped.push("the open-loop search hit its cap — the loop list may be incomplete");
  if (rep.loopsSkipped.undated > 0) skipped.push(`${rep.loopsSkipped.undated} open loop(s) have no date and cannot be aged`);
  if (skipped.length) lines.push(`(${skipped.join("; ")})`);
  lines.push(`A review queue for the user, not a verdict: nothing here writes to Cortex, feedback changes no ranking, and no record is retired automatically. After review: \`continuity supersede <id> <text> --user-confirmed\`, \`continuity done <id>\`, or leave it.`);
  return lines.join("\n");
}
