/**
 * Feedback an agent reports after a delivery: applied, not applicable, observed outcome.
 *
 * The vocabulary is deliberately narrow and never overloaded:
 *   access            a record was delivered into context (reported automatically by briefing/recall)
 *   consideration     the record was cited or weighed in an agent response but NOT applied (auto-reported by
 *                     the pi extension at agent_end; cited is not applied — it is weaker than application).
 *                     Currently NOT sent automatically: Cortex has no disposition for it (see AUTO_CONSIDERATION_DISPOSITION)
 *   application       the record materially informed a specific target (it does not mean the target succeeded)
 *   non_applicability the record did not apply HERE (context-scoped; it does not mean the record is false)
 *   outcome           an OBSERVED result of an executed action: success | failure | unknown | not_executed
 *
 * Rules enforced here, because Cortex records attribution as self-reported and cannot check them:
 *   - You can only give feedback on a record that was actually delivered to this runtime (a recorded delivery).
 *   - `success` / `failure` need an evidence ref; `unknown` / `not_executed` must not carry one.
 *     `unknown` = it ran but the result was never observed. `not_executed` = nothing ran. Never invent a failure.
 *   - Retrying the same INFLUENCE report reuses the same operation id (derived), so it cannot
 *     multiply influence. Read receipts (access / access_omitted) are the exception: they use
 *     fresh operation ids per report (src/cortex.ts) — a re-read is a new delivery report, and a
 *     reused id with a fresh event time is the fingerprint change Cortex refuses (409, N-21).
 *   - Feedback changes no score today; it is recorded and shown.
 */

import { CortexError, type ConsiderationDisposition } from "../src/cortex.ts";
import type { DeliveryRecord, FeedbackNote } from "./state.ts";
import { MAX_DELIVERIES, MAX_FEEDBACK_NOTES } from "./state.ts";
import { journalFeedback } from "./scorecard.ts";
import { gitExec, type Runtime } from "./runtime.ts";
import { recordApplied } from "./githooks.ts";

export type OutcomeStatus = "success" | "failure" | "unknown" | "not_executed";
export const OUTCOME_STATUSES: readonly OutcomeStatus[] = ["success", "failure", "unknown", "not_executed"];

const REF_RE = /^[^\s\u0000-\u001f\u007f]{1,256}$/;

export function assertRef(value: string | undefined, label: string): string {
  if (!value || !REF_RE.test(value)) throw new Error(`${label} must be 1-256 characters with no whitespace or control characters`);
  return value;
}

/** Remember what this runtime delivered, so feedback can reference a real delivery. Newest last, bounded. */
export function recordDelivery(rt: Runtime, d: DeliveryRecord): void {
  if (d.ids.length === 0 && (d.summarizedIds?.length ?? 0) === 0) return;
  const list = (rt.state.deliveries ??= []);
  // Attribution is stamped here, never by the caller: "since you were last here" is per runtime.
  const entry: DeliveryRecord = { ...d, runtime: d.runtime ?? rt.runtimeName };
  if (!list.some((x) => x.recallEventId === entry.recallEventId && x.sessionId === entry.sessionId)) list.push(entry);
  while (list.length > MAX_DELIVERIES) list.shift();
  rt.persist();
}

/**
 * Journal what was reported, locally and bounded, so `continuity hygiene` can compute its
 * read-only queue from state.deliveries and this feedback without reading events back from
 * Cortex (there is no such read) or writing anything. A replay (409) is never journaled:
 * the same fact is recorded once, so "repeated not-applicable" means distinct reports.
 */
export function recordFeedbackNote(rt: Runtime, note: FeedbackNote): void {
  const list = (rt.state.feedback ??= []);
  list.push(note);
  while (list.length > MAX_FEEDBACK_NOTES) list.shift();
  rt.persist();
}

/**
 * The recall event Cortex will accept as `access_ref` for this id. A briefing that recalled one
 * tag at a time records which event returned the id; older rows have only `recallEventId`.
 */
export function accessRefFor(delivery: DeliveryRecord, memoryId: string): string {
  const mapped = delivery.recallEventIds?.[memoryId];
  return typeof mapped === "string" && mapped.length > 0 ? mapped : delivery.recallEventId;
}

/** Resolve an id prefix to a delivered record and the delivery (access ref) that carried it. Newest delivery wins. */
export function resolveDelivered(rt: Runtime, prefix: string): { memoryId: string; delivery: DeliveryRecord } {
  if (prefix.length < 6) throw new Error("use at least 6 characters of the record id");
  const hits = new Map<string, DeliveryRecord>();
  for (const d of [...(rt.state.deliveries ?? [])].reverse()) {
    for (const id of d.ids) if (id.startsWith(prefix) && !hits.has(id)) hits.set(id, d);
  }
  if (hits.size === 0) throw new Error(`no record starting "${prefix}" was delivered to ${rt.runtimeName} recently (feedback needs a delivery: run briefing or recall first). Access comes before use.`);
  if (hits.size > 1) throw new Error(`"${prefix}" is ambiguous (${hits.size} delivered records); use more characters`);
  const [[memoryId, delivery]] = [...hits.entries()];
  return { memoryId, delivery };
}

export async function reportApplied(rt: Runtime, idPrefix: string, targetRef: string, sessionId?: string) {
  const { memoryId, delivery } = resolveDelivered(rt, idPrefix);
  const target = assertRef(targetRef, "target_ref");
  const r = await tolerateReplay(() => rt.agent.reportApplication({ sessionId: delivery.sessionId, accessRef: accessRefFor(delivery, memoryId), memoryId, targetRef: target }));
  if (r !== undefined) recordFeedbackNote(rt, { kind: "application", memoryId, at: new Date().toISOString(), runtime: rt.runtimeName, sessionId: delivery.sessionId, targetRef: target });
  journalFeedback(rt, { report: "application", sessionId: delivery.sessionId, memoryId, replay: r === undefined });
  // Local ledger too: the commit hook attaches a `Continuity-Applied: <id>` trailer for it.
  const worktree = await gitExec(["-C", process.cwd(), "rev-parse", "--show-toplevel"]);
  recordApplied(rt, memoryId, target, sessionId ?? delivery.sessionId, worktree);
  return { memoryId, kind: "application", alreadyRecorded: r === undefined, result: r };
}

export async function reportNotApplicable(rt: Runtime, idPrefix: string, contextRef: string, reason: string) {
  const why = reason.trim();
  if (why.length < 1 || why.length > 1024) throw new Error("reason must be 1-1024 characters");
  const { memoryId, delivery } = resolveDelivered(rt, idPrefix);
  const r = await tolerateReplay(() => rt.agent.reportNonApplicability({ sessionId: delivery.sessionId, accessRef: accessRefFor(delivery, memoryId), memoryId, contextRef: assertRef(contextRef, "context_ref"), reason: why }));
  if (r !== undefined) recordFeedbackNote(rt, { kind: "non_applicability", memoryId, at: new Date().toISOString(), runtime: rt.runtimeName, sessionId: delivery.sessionId, contextRef, reason: why });
  journalFeedback(rt, { report: "non_applicability", sessionId: delivery.sessionId, memoryId, replay: r === undefined });
  return { memoryId, kind: "non_applicability", alreadyRecorded: r === undefined, result: r };
}

export async function reportOutcome(
  rt: Runtime,
  idPrefix: string,
  targetRef: string,
  status: string,
  evidenceRef?: string,
  autoEvidence?: (memoryId: string) => Promise<string | undefined>,
) {
  if (!(OUTCOME_STATUSES as readonly string[]).includes(status)) throw new Error(`status must be one of ${OUTCOME_STATUSES.join(" | ")}`);
  const st = status as OutcomeStatus;
  if ((st === "unknown" || st === "not_executed") && evidenceRef) throw new Error(`outcome ${st} must not carry evidence: nothing was observed`);
  const { memoryId, delivery } = resolveDelivered(rt, idPrefix);
  if ((st === "success" || st === "failure") && !evidenceRef && autoEvidence) evidenceRef = await autoEvidence(memoryId);
  if ((st === "success" || st === "failure") && !evidenceRef) {
    throw new Error(
      `outcome ${st} needs --evidence <ref> (a path, URL or id someone can check). ` +
        `With 'continuity git install-hooks' the commit carrying the Continuity-Applied trailer is found automatically. ` +
        `If you did not observe the result, report "unknown"; if nothing ran, "not_executed".`,
    );
  }
  const r = await tolerateReplay(() => rt.agent.reportOutcome({
    sessionId: delivery.sessionId,
    accessRef: accessRefFor(delivery, memoryId),
    memoryId,
    targetRef: assertRef(targetRef, "target_ref"),
    status: st,
    evidenceRef: evidenceRef ? assertRef(evidenceRef, "evidence_ref") : undefined,
  }));
  if (r !== undefined) recordFeedbackNote(rt, { kind: "outcome", memoryId, at: new Date().toISOString(), runtime: rt.runtimeName, sessionId: delivery.sessionId, targetRef, status: st });
  journalFeedback(rt, { report: "outcome", sessionId: delivery.sessionId, memoryId, status: st, replay: r === undefined });
  return { memoryId, kind: "outcome", status: st, alreadyRecorded: r === undefined, result: r };
}

/**
 * Consideration: the agent response cited (or weighed) a delivered record without applying it.
 * Cited is not applied: this reports a weaker fact than `reportApplied` and never carries a target.
 * The context is the session, so citing the same record again in the same session is the same fact —
 * the derived operation id turns a repeat report into "already recorded", not a second influence.
 */
export async function reportConsideration(rt: Runtime, idPrefix: string, contextRef: string, disposition: ConsiderationDisposition) {
  const { memoryId, delivery } = resolveDelivered(rt, idPrefix);
  const r = await tolerateReplay(() => rt.agent.reportConsideration({ sessionId: delivery.sessionId, accessRef: accessRefFor(delivery, memoryId), memoryId, contextRef: assertRef(contextRef, "context_ref"), disposition }));
  if (r !== undefined) recordFeedbackNote(rt, { kind: "consideration", memoryId, at: new Date().toISOString(), runtime: rt.runtimeName, sessionId: delivery.sessionId, contextRef });
  journalFeedback(rt, { report: "consideration", sessionId: delivery.sessionId, memoryId, replay: r === undefined });
  return { memoryId, kind: "consideration", alreadyRecorded: r === undefined, result: r };
}

/**
 * Disposition the AUTO-report sends for "the reply cited a delivered record". There is deliberately
 * none: Cortex's ConsiderationEventIn requires a `disposition` and offers only "not_applicable" |
 * "considered_rejected" (services/memory_events.py), and neither means "cited or weighed, not
 * applied". Sending `considered_rejected` would overstate what happened; omitting the field is a
 * 422 that used to be swallowed. So the auto-report is a NO-OP until Cortex has a fitting value.
 * To re-enable: set this to that value (typed ConsiderationDisposition) — nothing else changes.
 */
export const AUTO_CONSIDERATION_DISPOSITION: ConsiderationDisposition | undefined = undefined;

/**
 * Report a `consideration` for every delivered record the reply cites with `id=<prefix>`. A no-op
 * (returns []) while AUTO_CONSIDERATION_DISPOSITION is undefined. When enabled, a failed report is
 * surfaced on stderr, never silently dropped, and never disturbs the turn.
 */
export async function autoReportConsiderations(
  rt: Runtime,
  replyText: string,
  contextRef: string,
  opts: { disposition?: ConsiderationDisposition } = {},
): Promise<string[]> {
  const disposition = opts.disposition ?? AUTO_CONSIDERATION_DISPOSITION;
  if (!disposition) return [];
  const reported: string[] = [];
  for (const memoryId of citedDeliveredIds(rt, replyText)) {
    try {
      await reportConsideration(rt, memoryId, contextRef, disposition);
      reported.push(memoryId);
    } catch (e) {
      warnEventFailure("consideration", e);
    }
  }
  return reported;
}

/**
 * A memory event (access_omitted, correction, consideration, ...) could not be recorded. These
 * events are advisory: the operation they accompany stands, so this does not throw — but it is
 * never silent. One line on stderr (stdout is a data/protocol channel: CLI output, MCP).
 */
export function warnEventFailure(what: string, e: unknown, note?: string): undefined {
  const why = e instanceof CortexError ? `Cortex ${e.status}: ${(typeof e.detail === "string" ? e.detail : JSON.stringify(e.detail)).slice(0, 300)}` : e instanceof Error ? e.message : String(e);
  process.stderr.write(`continuity: warning: ${what} event NOT recorded — ${why}${note ? ` (${note})` : ""}\n`);
  return undefined;
}

/** `id=<prefix>` citations, as rendered by a --ids briefing (`  id=6711be880d`). At least 6 chars, like resolveDelivered. */
const CITED_ID_RE = /\bid=([A-Za-z0-9_][A-Za-z0-9_.-]{5,63})/g;

/**
 * Records the agent output cites as `id=<prefix>` that were actually delivered to this runtime.
 * A citation is a consideration, not an application. Undelivered, too-short and ambiguous prefixes
 * are ignored — auto-reporting must never guess.
 */
export function citedDeliveredIds(rt: Runtime, text: string): string[] {
  const delivered = [...new Set((rt.state.deliveries ?? []).flatMap((d) => d.ids))];
  const cited = new Set<string>();
  for (const m of text.matchAll(CITED_ID_RE)) {
    // A citation can end at punctuation ("… id=6711be880d."); a trailing dot is not part of an id.
    const token = m[1].replace(/[.,;:)}\]]+$/, "");
    if (token.length < 6) continue;
    const hits = delivered.filter((id) => id.startsWith(token));
    if (hits.length === 1) cited.add(hits[0]);
  }
  return [...cited];
}

/**
 * Treat a replay conflict (409) as "already reported". Influence reports derive their operation
 * ids from the fact being reported, but `occurred_at` is fresh on every attempt, and Cortex refuses
 * a reused operation id whose request fingerprint changed (OPMEM N-21). So a second report of the
 * same fact is a conflict, which here means "already on record", not failure and not a second
 * influence. (Read receipts normally no longer land here: they mint fresh operation ids per
 * report, so there is no reuse to conflict; the wrappers stay as belt-and-braces. Trade: a retry
 * of the same report would record twice — acceptable, delivery counts are not influence, and the
 * real fix for duplicate deliveries is server-side dedupe by recall_event_id on Cortex.)
 */
export async function tolerateReplay<T>(fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof CortexError && e.status === 409) return undefined;
    throw e;
  }
}
