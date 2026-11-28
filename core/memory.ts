// Adapted from Keon Kontinuity for the standalone CLI.
/**
 * The memory operations Kontinuity performs, mapped onto Cortex primitives:
 *   writePrivate  → POST /v1/shards as the agent role (role_private)
 *   share         → propose (agent) + approve (owner) → derived profile_shared record
 *   supersede     → propose (agent) + supersede (owner) → replacement record, history kept
 *   sendBaton     → propose kind=handoff (agent) + approve (owner) → derived handoff record,
 *                   addressed to one role (handoff_to_role_id), shown to it once, never shared
 */

import { CortexError, type CurationKind, type MemoryType, type ProvenanceKind, type RememberInput } from "../src/cortex.ts";
import { mintId } from "../src/ids.ts";
import { noteMadeOn, withCaptureBranch } from "./blame.ts";
import { MIN_SHARED_TOKENS, OVERLAP_MIN, contentTokens, overlapScore } from "./compare.ts";
import { assertWritable, oneLine } from "./guard.ts";
import { batonInfo, isBatonContent } from "./handoff.ts";
import { warnEventFailure } from "./feedback.ts";
import { tagOf, sessionUrn, type Runtime } from "./runtime.ts";
import { writeStamp } from "./state.ts";
import { BOARD_DISPLAY_CAPTURE, boardDisplaySubjectKey, captureDisplayMetadata, hasBoardDisplayMarker } from "./board-display.ts";
import { splitBoardDisplay, type BoardDisplayMetadata } from "../shared/board-edit.ts";

export function memoryTypeFor(content: string): MemoryType {
  switch (tagOf(content)) {
    case "decision":
    case "rejected":
      return "decision";
    case "lesson":
      return "lesson";
    case "imported":
      return "story";
    case "open-loop":
    case "closed":
    case "note":
    case "preference":
    default:
      return "observation";
  }
}

export interface WriteInput {
  content: string;
  sourceKind: ProvenanceKind;
  sessionId: string;
  entryRef: string;
  /** Event time. Pin once per item — retries must be byte-identical. */
  occurredAt: string;
  source?: string;
  /** Additional searchable references attached to the private source shard. */
  subjectKeys?: string[];
  /**
   * ccm-atomic-batch-v1 claimable keys bound to this write (the (tenant, profile, key) keyspace).
   * A taken key is a 409 naming the key and nothing is written — the mint path uses this to make
   * a task number single-issue across processes (core/board.ts `taskUniqueKey`).
   */
  uniqueKeys?: string[];
  /**
   * Git branch this capture happens on (provenance `extra.branch` + the local madeOn ledger).
   * Filled once by the write entry points and frozen with the write: it survives branch
   * deletion, which is what makes "this decision was made on a deleted branch" detectable
   * later (core/blame.ts).
   */
  branch?: string;
}

/**
 * Write a role-private shard. Cortex derives shard identity from content+scope and
 * binds it to the FIRST request's idempotency key; a later request with the same
 * content but a different receipt/provenance is a 409 (first writer wins — the
 * receipt chain stays honest). We treat that 409 as "already remembered" and
 * resolve the existing shard by exact content match.
 */
export async function writePrivate(rt: Runtime, w: WriteInput): Promise<string> {
  assertWritable(w.content);
  w = await withCaptureBranch(w);
  const keep = (id: string) => {
    if (noteMadeOn(rt.state, id, w.branch)) rt.persist();
    return id;
  };
  try {
    return keep(await writePrivateOnce(rt, w));
  } catch (e) {
    if (e instanceof CortexError && e.status === 409) {
      const existing = await findExisting(rt, w.content);
      if (existing) return keep(existing);
    }
    throw e;
  }
}

export async function findExisting(rt: Runtime, content: string): Promise<string | undefined> {
  const res = await rt.agent.search(content.slice(0, 200));
  return res.shards.find((s) => s.content === content && s.provenance?.extra?.scope_class === "role_private")?.shard_id;
}

/**
 * True when a write refusal is a taken unique key (ccm-atomic-batch-v1 §2.2: a 409 naming the
 * key, nothing written). Covers both transports: direct Cortex (`CortexError` 409 with the
 * FastAPI `detail`) and the Keon MCP Gateway (`GatewayRefusedError` whose `httpStatus` is 409 —
 * checked structurally, because importing core/gateway-client.ts here would close an import
 * cycle through core/briefing.ts).
 */
export function isUniqueKeyConflict(e: unknown, key: string): boolean {
  const err = e as { status?: number; httpStatus?: number; message?: string; detail?: unknown };
  const status = err?.status ?? err?.httpStatus;
  if (status !== 409) return false;
  const detail = typeof err?.detail === "string" ? err.detail : JSON.stringify(err?.detail ?? "");
  const text = `${err?.message ?? ""} ${detail}`;
  return text.includes(key) || /unique key/i.test(text);
}

/**
 * The exact Cortex request for a private write. Pure: the same input always yields the same
 * request, which is what lets the outbox freeze an operation and replay it byte-identically.
 */
export function buildRemember(rt: Runtime, w: WriteInput, ids: { receiptId: string; idempotencyKey?: string } = { receiptId: mintId("rcpt") }): RememberInput {
  return {
    content: w.content,
    memoryType: memoryTypeFor(w.content),
    source: w.source ?? "continuity/pi",
    subjectKeys: ["continuity", tagOf(w.content), rt.profileId, ...(w.subjectKeys ?? [])],
    ...(w.uniqueKeys?.length ? { uniqueKeys: [...w.uniqueKeys] } : {}),
    receiptId: ids.receiptId,
    idempotencyKey: ids.idempotencyKey,
    provenance: {
      source: w.source ?? "continuity/pi",
      agentId: rt.agent.identity.actorId,
      sourceKind: w.sourceKind,
      sourceUri: sessionUrn(rt.runtimeName, w.sessionId, w.entryRef),
      checkpointAt: w.occurredAt,
      // role ≠ generation ≠ session: generation names a replacement agent in the same role (attribution only).
      extra: { captured_by: rt.runtimeName, continuity_version: "0.1", ...(w.branch ? { branch: w.branch } : {}), ...(rt.generation ? { generation: rt.generation } : {}) },
    },
  };
}

async function writePrivateOnce(rt: Runtime, w: WriteInput): Promise<string> {
  const res = await rt.agent.remember(buildRemember(rt, w));
  return res.shard_id;
}

/** Promote a private shard to profile_shared. Returns the derived record id (existing one if already shared).
 * `sessionId` is stamped on the row (writer/session forensics); it may be omitted outside a session context. */
export async function share(rt: Runtime, sourceId: string, content: string, reason: string, sessionId?: string, kind: CurationKind = "lesson", uniqueKeys?: string[]): Promise<string> {
  // Shaped items may be shared only while their exact schema is approved.
  // Check at promotion too: pending items can outlive a private or retired schema.
  const source = await rt.agent.getShard(sourceId);
  // Fail closed when the transport could not report provenance/subject keys (TASK-196, G-7): the
  // schema-citation guard below would otherwise silently have nothing to check.
  if (source.provenance_complete === false) {
    throw new Error(
      "cannot verify this record's provenance and schema citations through the current transport " +
        "(the gateway read surface did not return them, and the shard listing cannot show this record). " +
        "Nothing was shared.",
    );
  }
  // Generic promotion has no display intent. In particular, remember's exact-content
  // deduplication must not turn a previously marked capture into a new literal source.
  if (hasBoardDisplayMarker(source)) {
    throw new Error("Display capture cannot be reused by a generic share; nothing was shared.");
  }
  // A baton is never promoted to shared memory: it is addressed to one role and consumed on delivery.
  if (batonInfo(source.content, source.provenance?.extra)) {
    throw new Error("a baton is never promoted to shared memory: it is addressed to one role and consumed on delivery");
  }
  const keys = Array.isArray(source.subject_keys) ? source.subject_keys : [];
  const refs = keys.filter((key): key is string => typeof key === "string" && key.startsWith("schema:"));
  if (refs.length) {
    const { assertItemMatchesSchemas } = await import("./schema.ts");
    // The reference is enforced, not decorative: the item must match the schema it cites.
    await assertItemMatchesSchemas(rt, source.content, refs);
  }
  const already = rt.state.shared.find((s) => s.sourceId === sourceId && !s.supersededBy);
  if (already) {
    rt.state.pending = rt.state.pending.filter((p) => p.shardId !== sourceId);
    rt.persist();
    await refreshRenderedFiles(rt);
    return already.derivedId;
  }
  const prop = await rt.agent.propose({
    kind,
    sourceRecordIds: [sourceId],
    content,
    reason,
  });
  const disp = await rt.owner.dispose({ proposalId: prop.proposal_id, action: "approve", approvalReceiptRef: mintId("rcpt_approve"), ...(uniqueKeys ? { uniqueKeys } : {}) });
  const derivedId = disp.derived_shard_id;
  if (!derivedId) throw new Error(`approval returned no derived_shard_id (status=${disp.status})`);
  // Attribution for "confirmed-from-it" accounting (deck Agents lens): the runtime whose
  // staged inference this was, since share runs AS that runtime (its role owns the source).
  rt.state.shared.push({ derivedId, sourceId, content, approvedAt: new Date().toISOString(), runtime: rt.runtimeName, written: writeStamp(rt.runtimeName, sessionId ?? "") });
  rt.state.pending = rt.state.pending.filter((p) => p.shardId !== sourceId);
  rt.persist();
  await refreshRenderedFiles(rt);
  await dropBoardCacheForTask(rt, content);
  return derivedId;
}

/** Replace a shared record with new text. The old one stays inspectable as history.
 * Refreshes any managed briefing block (AGENTS.md & co. — see core/render.ts) that exists. */
export async function supersede(rt: Runtime, oldDerivedId: string, sessionId: string, newContent: string, reason: string, options: { sourceKind?: ProvenanceKind; boardDisplay?: BoardDisplayMetadata } = {}): Promise<string> {
  // Same rule as share: carrying a baton into shared history would leak it to every agent.
  const old = await rt.agent.getShard(oldDerivedId).catch(() => undefined);
  if (old && batonInfo(old.content, old.provenance?.extra)) {
    throw new Error("a baton is never promoted to shared memory: superseding it would carry its content into shared history");
  }
  // Only bounded server-owned edit/transition callers may choose display intent for
  // THIS operation. Arbitrary full-source replacement never inherits it from `old`.
  const display = options.boardDisplay;
  if (display && !splitBoardDisplay(newContent, display).fields) {
    throw new Error("Display intent does not match the replacement content; nothing was superseded.");
  }
  const occurredAt = new Date().toISOString();
  // First-writer provenance is immutable under content deduplication. A unique capture
  // operation lets us detect stale reuse even if remember returns 200 rather than 409.
  const entryRef = `supersede:${oldDerivedId}:${mintId("display_op")}`;
  const sourceId = await writePrivate(rt, {
    content: newContent,
    ...(display ? { source: BOARD_DISPLAY_CAPTURE, subjectKeys: [boardDisplaySubjectKey(display)] } : {}),
    sourceKind: options.sourceKind ?? "user_confirmed",
    sessionId,
    entryRef,
    occurredAt,
  });
  // Validate the ACTUAL capture in both directions, before any shared proposal. A
  // marked write requires this operation's exact bytes/scope/metadata/provenance; an
  // unmarked write must not link to any reserved display marker (even malformed).
  const capture = await rt.agent.getShard(sourceId);
  if (capture.provenance_complete === false || capture.content !== newContent
    || capture.provenance?.extra?.scope_class !== "role_private"
    || capture.provenance.extra.profile_id !== rt.profileId
    || capture.provenance.extra.role_id !== rt.agent.identity.roleId
    || (display
      ? captureDisplayMetadata(capture)?.footerHash !== display.footerHash
        || capture.provenance.source_uri !== sessionUrn(rt.runtimeName, sessionId, entryRef)
      : hasBoardDisplayMarker(capture))) {
    throw new Error("Display capture intent was not retained for this operation; nothing was superseded.");
  }
  const prop = await rt.agent.propose({
    kind: "lesson",
    sourceRecordIds: [sourceId],
    content: newContent,
    reason,
  });
  const disp = await rt.owner.dispose({
    proposalId: prop.proposal_id,
    action: "supersede",
    supersedesRecordId: oldDerivedId,
    approvalReceiptRef: mintId("rcpt_supersede"),
    reason,
  });
  const derivedId = disp.derived_shard_id;
  if (!derivedId) throw new Error(`supersede returned no derived_shard_id (status=${disp.status})`);
  // Honest trail: a correction event on the old record, self-reported, in Cortex's CorrectionEventIn
  // shape. The supersede disposition above is the record of truth, so a failure here is not fatal —
  // but it is never silent: the audit event is missing and the user should know.
  await rt.agent
    .reportCorrection({ sessionId, correctsRef: oldDerivedId, newContentRef: derivedId, reason, occurredAt })
    .catch((e) => warnEventFailure("correction", e, "the supersede itself succeeded; only its audit event is missing"));
  for (const s of rt.state.shared) {
    if (s.derivedId === oldDerivedId) {
      s.supersededBy = derivedId;
      s.written = writeStamp(rt.runtimeName, sessionId); // this row was just rewritten: stamp the editor
    }
  }
  rt.state.shared.push({ derivedId, sourceId, content: newContent, approvedAt: occurredAt, written: writeStamp(rt.runtimeName, sessionId) });
  rt.persist();
  await refreshRenderedFiles(rt);
  await dropBoardCacheForTask(rt, newContent, old?.content);
  return derivedId;
}

/**
 * A share or supersede that carried task content invalidates this identity's cached board
 * (core/board-read-cache.ts). Dynamic import keeps the module graph acyclic (board.ts imports this file).
 */
async function dropBoardCacheForTask(rt: Runtime, ...contents: Array<string | undefined>): Promise<void> {
  const { invalidateBoardForTaskContent } = await import("./board.ts");
  invalidateBoardForTaskContent(rt, ...contents);
}

/**
 * Keep the managed briefing block in AGENTS.md & co. current after shared memory changed.
 * Dynamic import (like schema.ts above) to keep the module graph acyclic; a rendering problem
 * never fails the memory operation itself.
 */
async function refreshRenderedFiles(rt: Runtime): Promise<void> {
  try {
    const { refreshRender } = await import("./render.ts");
    await refreshRender(rt);
  } catch {
    /* rendering is a convenience; the memory stands even if the files cannot be updated */
  }
}

/** Keep locally as "an agent inferred this, you haven't confirmed it yet". */
/** Pending items this runtime's role can actually promote (it owns the private source shard). */
export function ownPending(rt: Runtime) {
  return rt.state.pending.filter((p) => (p.runtime ?? "pi") === rt.runtimeName);
}

export function addPending(rt: Runtime, shardId: string, content: string, sessionId: string): void {
  if (!rt.state.pending.some((p) => p.shardId === shardId)) {
    rt.state.pending.push({ shardId, content, createdAt: new Date().toISOString(), sessionId, runtime: rt.runtimeName, written: writeStamp(rt.runtimeName, sessionId) });
  }
  rt.persist();
}

export interface BatonResult {
  sourceId: string;
  derivedId: string;
  content: string;
  from: string;
  toRuntime: string;
  toRole: string;
}

/**
 * Send a baton to one other runtime's role — the `handoff` curation kind end to end:
 * propose as the agent role, approve as the owner role (the proposer never approves its own).
 * The approval materializes a derived record scoped to handoff_to_role_id at the protocol
 * level (shards/1.1), which is what keeps it invisible to every other role and un-promotable.
 * Never staged as pending: a baton is a message, not a promotion candidate.
 */
export async function sendBaton(rt: Runtime, w: { toRuntime: string; toRole: string; content: string; sessionId: string }): Promise<BatonResult> {
  const content = isBatonContent(w.content) ? w.content : `[handoff] ${w.content}`;
  const sourceId = await writePrivate(rt, {
    content,
    sourceKind: "agent_inferred",
    sessionId: w.sessionId,
    entryRef: `handoff:${w.toRuntime}`,
    occurredAt: new Date().toISOString(),
  });
  const prop = await rt.agent.propose({
    kind: "handoff",
    sourceRecordIds: [sourceId],
    content,
    reason: `baton from ${rt.runtimeName} to ${w.toRuntime}`,
    toRoleId: w.toRole,
  });
  const disp = await rt.owner.dispose({ proposalId: prop.proposal_id, action: "approve", approvalReceiptRef: mintId("rcpt_approve") });
  const derivedId = disp.derived_shard_id;
  if (!derivedId) throw new Error(`handoff approval returned no derived_shard_id (status=${disp.status})`);
  return { sourceId, derivedId, content, from: rt.runtimeName, toRuntime: w.toRuntime, toRole: w.toRole };
}

// ---------- pre-write contradiction check ----------

/**
 * Pre-write contradiction check (TASK-15): warn-only, threshold-configurable, NEVER SILENT.
 *
 * On remember / stage / share — the three write paths that can put a new record in front of
 * every agent — the incoming content is scored against the LIVE shared records of this
 * project first. A heavy lexical overlap earns the one question worth asking before shared
 * history is polluted: "may conflict with [decision] X (date); supersede instead?".
 *
 * - Lexical, never semantic — the same contract as core/compare.ts (whose tokeniser and
 *   overlap coefficient this reuses, so both views agree on "overlapping"): a hint is where
 *   to look, not a verdict that two records contradict. The hint quotes the LIVE record's
 *   own tag and id, so `kontinuity supersede <id> <text>` is the offered next step.
 * - Warn-only: the write always proceeds. The hint is a question for the human, not a block
 *   (memory grants no authority; a blocking check would also break byte-identical outbox
 *   replays and automated capture).
 * - Never silent: every write path prints the verdict — hints, clear, or "could not run".
 *   A check that cannot reach its records says so; it never fails quietly into "no conflict".
 * - Called BY the write commands, never inside writePrivate(): supersede deliberately
 *   overlaps the record it replaces, and the outbox replays frozen writes unchanged.
 * - "Recall overlapping tokens" here is the internal `search` read (same choice as
 *   core/board.ts), not `recall`: a pre-write lookup delivers nothing to an agent and must
 *   not create delivery events — access accounting is for records that actually reach one.
 */

/** How many distinctive tokens form the lookup query. Enough to describe a topic, bounded. */
const PREWRITE_QUERY_TOKENS = 12;
/** Candidates scored per write. The overlap test is client-side; more candidates = fewer missed conflicts. */
const PREWRITE_SEARCH_LIMIT = 25;

export interface ConflictHint {
  /** The live shared record to supersede (its local derived id when known). */
  recordId: string;
  /** The live record's own tag: decision | rejected | open-loop | lesson | note | … */
  tag: string;
  /** Event date of the live record (YYYY-MM-DD), when known. */
  date?: string;
  /** Overlap coefficient over the smaller token side (0–1, two decimals). */
  overlap: number;
  /** The live record's text, flattened to one line — data, not instructions. */
  content: string;
  /** "may conflict with [decision] X (date); supersede instead?" */
  message: string;
}

export interface PreWriteReport {
  /** hints = a live record overlaps heavily · clear = none did · unavailable = the lookup could not run. */
  status: "clear" | "hints" | "unavailable";
  /** Distinctive tokens compared (0 → nothing to compare, said out loud anyway). */
  tokens: number;
  /** Live shared records scored. */
  scored: number;
  /** The configured overlap threshold this write was checked against. */
  threshold: number;
  hints: ConflictHint[];
  /** Why the lookup could not run (status "unavailable", or a partial local-only comparison). */
  degraded?: string;
}

/** The configured overlap threshold (0–1); falls back to compare.ts's OVERLAP_MIN when the config value is unusable. */
export function contradictionThreshold(rt: Runtime): number {
  const v = rt.cfg.contradictionOverlap;
  return typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1 ? v : OVERLAP_MIN;
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const dateOnly = (s: string | undefined): string | undefined => (s ? s.slice(0, 10) : undefined);

/** Event time of a searched shard: checkpointAt first (the event time), created_at as fallback. */
function eventDateOf(s: { created_at?: string; provenance?: Record<string, unknown> }): string | undefined {
  const at = s.provenance?.checkpoint_at;
  return dateOnly(typeof at === "string" ? at : undefined) ?? dateOnly(s.created_at);
}

interface LiveRecord {
  id: string;
  content: string;
  date?: string;
}

/**
 * The pre-write hook itself. Read-only and side-effect free: same input, same report.
 * Never throws — a failed lookup is reported as `unavailable`, not swallowed.
 */
export async function preWriteCheck(rt: Runtime, content: string): Promise<PreWriteReport> {
  const threshold = contradictionThreshold(rt);
  const mine = contentTokens(content);
  // Local state first: one state file per tenant+profile is shared by every runtime on this
  // machine, and its derived ids are what `kontinuity supersede <id>` resolves. Keyed by
  // exact content so a record seen both locally and in Cortex is one candidate.
  const live = new Map<string, LiveRecord>();
  for (const s of rt.state.shared) {
    if (s.supersededBy) continue; // history is not a conflict
    live.set(s.content.trim(), { id: s.derivedId, content: s.content, date: dateOnly(s.approvedAt) });
  }
  let degraded: string | undefined;
  if (mine.size > 0) {
    try {
      const query = [...mine].slice(0, PREWRITE_QUERY_TOKENS).join(" ");
      const res = await rt.agent.search(query, PREWRITE_SEARCH_LIMIT);
      for (const s of res.shards) {
        const sc = s.provenance?.extra?.scope_class;
        if (sc && sc !== "profile_shared") continue; // private notes and batons are not live shared records
        if (s.status && s.status !== "active") continue; // superseded/archived = history
        const key = s.content.trim();
        if (live.has(key)) continue;
        live.set(key, { id: s.shard_id, content: s.content, date: eventDateOf(s) });
      }
    } catch (e) {
      degraded = e instanceof CortexError ? `Cortex ${e.status}` : e instanceof Error ? e.message : String(e);
    }
  }
  const hints: ConflictHint[] = [];
  if (mine.size > 0) {
    for (const rec of live.values()) {
      const { shared, score } = overlapScore(mine, contentTokens(rec.content));
      if (shared < MIN_SHARED_TOKENS || score < threshold) continue;
      const tag = tagOf(rec.content);
      hints.push({
        recordId: rec.id,
        tag,
        date: rec.date,
        overlap: round2(score),
        content: oneLine(rec.content, 200),
        message: `may conflict with [${tag}] ${rec.id.slice(0, 10)}${rec.date ? ` (${rec.date})` : ""}; supersede instead?`,
      });
    }
    hints.sort((a, b) => b.overlap - a.overlap);
  }
  const status: PreWriteReport["status"] = hints.length > 0 ? "hints" : degraded ? "unavailable" : "clear";
  return { status, tokens: mine.size, scored: live.size, threshold, hints, degraded };
}

/**
 * The verdict lines every write path prints — the check is never silent. Always at least
 * one line: hints (the exact "may conflict … supersede instead?" question), a clear
 * verdict with the threshold it was checked against, or an honest "could not run".
 */
export function formatPreWrite(r: PreWriteReport): string[] {
  const lines: string[] = [];
  if (r.hints.length > 0) {
    lines.push(`contradiction check: ${r.hints.length} heavy overlap(s) with live shared record(s) (warn-only — never a block)`);
    for (const h of r.hints) {
      lines.push(h.message);
      lines.push(`    ${h.content}`);
    }
  } else if (r.tokens === 0) {
    lines.push(`contradiction check: nothing distinctive to compare — no conflict check was possible (said out loud, never silent)`);
  } else if (r.status === "unavailable") {
    lines.push(`contradiction check: could not run (${r.degraded ?? "unknown"}) — conflicts with live records were NOT checked`);
  } else {
    lines.push(`contradiction check: clear — ${r.tokens} distinctive token(s) vs ${r.scored} live shared record(s), none ≥ ${r.threshold} overlap`);
  }
  if (r.degraded && r.status !== "unavailable") {
    lines.push(`contradiction check note: the live-record lookup could not reach Cortex (${r.degraded}) — LOCAL shared records only were compared`);
  }
  return lines;
}
