/**
 * Scorecard: the docs/validation.md pilot metrics computed from LOCAL state, so the
 * 14-day pilot is a command, not a spreadsheet. Works with Cortex unreachable: every
 * input is a local event, the outbox, or local state.
 *
 * Descriptive numbers only (docs/validation.md §3). These are counts and ratios of
 * observed events. They support no causal claim and no cost-saving claim. `unknown` is
 * a valid outcome; missing feedback is never read as success.
 *
 * What is counted:
 *   - One `delivery` event per memory-delivery run: a briefing build, a recall, a jit
 *     injection, or a confirmed-only render. Hits and misses both count — the retrieval
 *     rate denominator is every run, not only the runs that found something.
 *   - One `feedback` event per report that reached Cortex. A replay ("already on
 *     record", 409) is not a new event and is not counted twice.
 *   - Outbox resolutions: entries that were INDETERMINATE and later resolved.
 */

import { existsSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { listOutbox, outboxSummary } from "./outbox.ts";
import { loadState, journalTo, stateDir, type LocalState, type MetricEvent, type MetricSource } from "./state.ts";
import type { Runtime } from "./runtime.ts";

// ---------- recording (called from the delivery/feedback/outbox paths) ----------

export interface DeliveryMetric {
  source: MetricSource;
  sessionId: string;
  /** Records actually delivered in this run — 0 for a miss (still a run). */
  records: number;
  approxTokens?: number;
  tokenBudget?: number;
  omittedForBudget?: number;
}

/** One memory-delivery run, hit or miss. Counts nothing else; purely accounting. */
export function journalDelivery(rt: Runtime, d: DeliveryMetric): void {
  journalTo(rt, {
    kind: "delivery",
    at: new Date().toISOString(),
    runtime: rt.runtimeName,
    sessionId: d.sessionId,
    source: d.source,
    records: d.records,
    approxTokens: d.approxTokens,
    tokenBudget: d.tokenBudget,
    omittedForBudget: d.omittedForBudget,
  });
}

export interface FeedbackMetric {
  report: "application" | "non_applicability" | "consideration" | "outcome";
  sessionId: string;
  memoryId: string;
  status?: string;
  /** Cortex answered "already on record": recorded, but never counted as a new event. */
  replay?: boolean;
}

export function journalFeedback(rt: Runtime, f: FeedbackMetric): void {
  journalTo(rt, {
    kind: "feedback",
    at: new Date().toISOString(),
    runtime: rt.runtimeName,
    sessionId: f.sessionId,
    report: f.report,
    memoryId: f.memoryId,
    status: f.status,
    replay: f.replay,
  });
}

// ---------- computation ----------

export interface Scorecard {
  generatedAt: string;
  window: { days: number; from: string; to: string };
  /** Metric events recorded in the window (all kinds). */
  events: number;
  deliveries: {
    /** Memory-delivery runs (briefing · recall · jit · render). */
    runs: number;
    withRecords: number;
    /** Runs that delivered ≥1 record / runs. null = no runs yet (unknown, not 0). */
    retrievalRate: number | null;
    deliveredRecords: number;
    bySource: Record<MetricSource, { runs: number; withRecords: number; deliveredRecords: number }>;
  };
  feedback: {
    application: number;
    nonApplicability: number;
    consideration: number;
    outcome: number;
    outcomesByStatus: Record<string, number>;
    /** application events / delivered records. null = no delivered records (unknown). */
    applicationRate: number | null;
    /** non_applicability events / delivered records. null = no delivered records (unknown). */
    nonApplicabilityRate: number | null;
  };
  outbox: {
    queued: number;
    indeterminate: number;
    quarantined: number;
    total: number;
    capacity: number;
    /** Age of the oldest entry in days; null = outbox is empty. */
    oldestAgeDays: number | null;
    /** Entries that were INDETERMINATE and later resolved, in the window (across the tenant's profiles). */
    indeterminateResolved: { saved: number; quarantined: number };
  };
  briefingBudget: {
    /** Briefing builds that reported token stats. */
    briefings: number;
    meanApproxTokens: number | null;
    /** approxTokens / tokenBudget per briefing, averaged. null = no briefings yet. */
    meanBudgetShare: number | null;
    withinBudget: number;
    omittedForBudget: number;
    tokenEstimator: "utf8-bytes/4";
  };
  /** Always 0 here: the CLI refuses success/failure reports without an evidence ref, before anything is recorded. */
  unsupportedClaims: { count: number; note: string };
  /** Not tracked automatically; "unknown" is a valid outcome (docs/validation.md §3). */
  interruptions: { count: null; note: string };
}

const SOURCES: MetricSource[] = ["briefing", "recall", "jit", "render"];

/** Metric events recorded under this tenant's profiles (for per-tenant outbox accounting). */
function tenantMetricEvents(tenantId: string): MetricEvent[] {
  const dir = stateDir(tenantId);
  if (!existsSync(dir)) return [];
  const out: MetricEvent[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".json") || f === "control.json") continue;
    const profileId = basename(f, ".json");
    const st: LocalState = loadState(tenantId, profileId);
    out.push(...(st.metrics ?? []));
  }
  return out;
}

export function computeScorecard(rt: Runtime, opts: { days?: number } = {}): Scorecard {
  const days = opts.days ?? 14;
  const to = new Date();
  const from = new Date(to.getTime() - days * 86_400_000);
  const fromIso = from.toISOString();
  const toIso = to.toISOString();
  const inWindow = (e: MetricEvent) => e.at >= fromIso && e.at <= toIso;

  const events = (rt.state.metrics ?? []).filter(inWindow);
  const deliveries = events.filter((e): e is Extract<MetricEvent, { kind: "delivery" }> => e.kind === "delivery");
  const withRecords = deliveries.filter((d) => d.records > 0);
  const deliveredRecords = deliveries.reduce((n, d) => n + d.records, 0);

  const bySource = {} as Scorecard["deliveries"]["bySource"];
  for (const s of SOURCES) {
    const mine = deliveries.filter((d) => d.source === s);
    bySource[s] = {
      runs: mine.length,
      withRecords: mine.filter((d) => d.records > 0).length,
      deliveredRecords: mine.reduce((n, d) => n + d.records, 0),
    };
  }

  const feedbackEvents = events.filter((e): e is Extract<MetricEvent, { kind: "feedback" }> => e.kind === "feedback");
  // A replay ("already on record") is not a new fact and must not multiply the count.
  const fresh = feedbackEvents.filter((f) => !f.replay);
  const countReports = (report: string) => fresh.filter((f) => f.report === report).length;
  const application = countReports("application");
  const nonApplicability = countReports("non_applicability");
  const outcomesByStatus: Record<string, number> = {};
  for (const f of fresh) if (f.report === "outcome" && f.status) outcomesByStatus[f.status] = (outcomesByStatus[f.status] ?? 0) + 1;

  const ob = outboxSummary(rt.cfg.tenantId);
  const entries = listOutbox(rt.cfg.tenantId);
  const resolutions = tenantMetricEvents(rt.cfg.tenantId).filter(
    (e): e is Extract<MetricEvent, { kind: "outbox_resolved" }> => e.kind === "outbox_resolved" && inWindow(e),
  );

  const budgeted = deliveries.filter((d) => typeof d.tokenBudget === "number" && d.tokenBudget > 0 && typeof d.approxTokens === "number");
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  const shares = budgeted.map((d) => (d.approxTokens as number) / (d.tokenBudget as number));

  return {
    generatedAt: toIso,
    window: { days, from: fromIso, to: toIso },
    events: events.length,
    deliveries: {
      runs: deliveries.length,
      withRecords: withRecords.length,
      retrievalRate: deliveries.length ? withRecords.length / deliveries.length : null,
      deliveredRecords,
      bySource,
    },
    feedback: {
      application,
      nonApplicability,
      consideration: countReports("consideration"),
      outcome: countReports("outcome"),
      outcomesByStatus,
      applicationRate: deliveredRecords > 0 ? application / deliveredRecords : null,
      nonApplicabilityRate: deliveredRecords > 0 ? nonApplicability / deliveredRecords : null,
    },
    outbox: {
      queued: ob.queued,
      indeterminate: ob.indeterminate,
      quarantined: ob.quarantined,
      total: ob.total,
      capacity: ob.capacity,
      oldestAgeDays: ob.oldest ? (to.getTime() - Date.parse(ob.oldest)) / 86_400_000 : null,
      indeterminateResolved: {
        saved: resolutions.filter((r) => r.resolution === "saved").length,
        quarantined: resolutions.filter((r) => r.resolution === "quarantined").length,
      },
    },
    briefingBudget: {
      briefings: budgeted.length,
      meanApproxTokens: mean(budgeted.map((d) => d.approxTokens as number)),
      meanBudgetShare: mean(shares),
      withinBudget: budgeted.filter((d) => (d.approxTokens as number) <= (d.tokenBudget as number)).length,
      omittedForBudget: deliveries.reduce((n, d) => n + (d.omittedForBudget ?? 0), 0),
      tokenEstimator: "utf8-bytes/4",
    },
    unsupportedClaims: {
      count: 0,
      note: "0 by construction: the CLI refuses success/failure reports without an evidence ref before anything is recorded",
    },
    interruptions: {
      count: null,
      note: "not tracked automatically; note them manually during the pilot — unknown is a valid outcome",
    },
  };
}

// ---------- human rendering ----------

const pct = (x: number | null) => (x === null ? "unknown" : `${(x * 100).toFixed(1)}%`);
const num = (x: number | null, digits = 1) => (x === null ? "unknown" : x.toFixed(digits));
const DASH = "—";

export function formatScorecard(s: Scorecard): string {
  const d = s.deliveries;
  const f = s.feedback;
  const o = s.outbox;
  const b = s.briefingBudget;
  const src = (k: MetricSource) => `${k} ${d.bySource[k].withRecords}/${d.bySource[k].runs}`;
  const oldest = o.oldestAgeDays === null ? DASH : `${num(o.oldestAgeDays, 2)}d`;
  return [
    `kontinuity scorecard — window ${s.window.from.slice(0, 10)} → ${s.window.to.slice(0, 10)} (${s.window.days} days) · ${s.events} metric event(s) recorded locally`,
    ``,
    `retrieval rate          ${pct(d.retrievalRate)}  (${d.withRecords} of ${d.runs} delivery runs carried ≥1 record)`,
    `  ${SOURCES.map(src).join(" · ")}`,
    `delivered records       ${d.deliveredRecords}  (denominator for the rates below)`,
    `application rate        ${pct(f.applicationRate)}  (${f.application} application event(s) / ${d.deliveredRecords} delivered records)`,
    `non-applicability rate  ${pct(f.nonApplicabilityRate)}  (${f.nonApplicability} non_applicability event(s) / ${d.deliveredRecords} delivered records)`,
    `  also recorded: consideration ${f.consideration} · outcome ${f.outcome}${Object.keys(f.outcomesByStatus).length ? ` (${Object.entries(f.outcomesByStatus).map(([k, v]) => `${k} ${v}`).join(", ")})` : ""} — recorded facts, never scored`,
    `outbox health           ${o.queued} queued · ${o.indeterminate} unconfirmed · ${o.quarantined} refused · oldest ${oldest} (capacity ${o.capacity})`,
    `  indeterminate resolutions: ${o.indeterminateResolved.saved} saved · ${o.indeterminateResolved.quarantined} quarantined`,
    `briefing budget share   ${b.briefings} briefing(s) · mean ${num(b.meanApproxTokens, 0)} tokens ≈ ${pct(b.meanBudgetShare)} of budget · ${b.withinBudget}/${b.briefings} within budget`,
    `  ${b.omittedForBudget} record(s) left out to stay in budget · estimator ${b.tokenEstimator}`,
    `unsupported claims      ${s.unsupportedClaims.count} — ${s.unsupportedClaims.note}`,
    `interruptions           unknown — ${s.interruptions.note}`,
    ``,
    `Descriptive numbers only (docs/validation.md §3): no causal or cost claims. A delivery run is one`,
    `briefing build, recall, jit injection or render; "already on record" replays are not new events.`,
  ].join("\n");
}
