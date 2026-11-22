/**
 * Durable, bounded outbox for private writes (stage, import, autosave).
 *
 * Why: development must continue when Cortex is unreachable, but memory-dependent claims must
 * fail closed. A queued item is NOT saved. It becomes saved only when Cortex acknowledges it.
 *
 * Rules (each has a test in smoke/outbox.test.ts):
 *   O-1  the entry is committed to disk BEFORE anything is sent; a crash before commit sends and claims nothing.
 *   O-2  an entry survives a crash and is sent later with exactly its frozen identity
 *        (tenant, profile, role, actor, event time, receipt id, idempotency key).
 *   O-3  a timeout/reset after send is INDETERMINATE: never success, never re-issued under a new
 *        identity, resolved by replaying the same key.
 *   O-4  a replay Cortex reports as a duplicate/conflict resolves to the existing shard; no second write.
 *   O-5  a grant revoked or a write refused (403/404/422...) quarantines with a reason. Queued work is
 *        never re-scoped to a newer grant; it flushes under its original identity or ends with a reason.
 *   O-6  poison entries quarantine after a bounded number of server-answered failures (outage != poison:
 *        unreachable Cortex does not consume attempts). Quarantined entries count toward capacity.
 *   O-7  switching role/profile with pending work keeps each entry's original identity.
 *   O-8  status never reports queued / indeterminate work as saved.
 *
 * At-least-once transport; effectively-once commit through Cortex idempotency. NOT exactly-once.
 * One JSON file per entry (atomic rename, mode 0600) so many agents sharing a state directory
 * never contend on a single file. Entries contain memory text at rest, like `pending` state does;
 * they are guarded against credentials before they are queued.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { renameReplacing } from "../src/atomic-file.ts";
import { CortexError, grant, type CortexTransport, type Identity } from "../src/cortex.ts";
import { mintId } from "../src/ids.ts";
import { buildRemember, findExisting, type WriteInput } from "./memory.ts";
import { noteMadeOn, withCaptureBranch } from "./blame.ts";
import { assertCaptureAllowed } from "./control.ts";
import { assertWritable } from "./guard.ts";
import type { Runtime } from "./runtime.ts";
import { loadState, saveState, stateDir, journalMetricFor, writeStamp } from "./state.ts";

export const OUTBOX_MAX_ENTRIES = 200;
export const OUTBOX_MAX_ATTEMPTS = 5;

export type OutboxStatus = "queued" | "indeterminate" | "quarantined";

export interface OutboxEntry {
  version: 1;
  /** Operation id AND idempotency key. Minted once, never changes. */
  id: string;
  receiptId: string;
  tenantId: string;
  profileId: string;
  roleId: string;
  actorId: string;
  runtime: string;
  /** Frozen agent generation (attribution), if any. */
  generation?: string;
  createdAt: string;
  status: OutboxStatus;
  /** Server-answered failures only. Unreachable Cortex does not count (outage is not poison). */
  attempts: number;
  lastAttemptAt?: string;
  lastError?: string;
  /** Why it is quarantined. */
  reason?: string;
  /** Add to local pending-review state once Cortex acknowledges. */
  pending: boolean;
  sessionId: string;
  write: WriteInput;
}

export type WriteOutcome =
  | { status: "saved"; id: string }
  | { status: "queued" | "indeterminate" | "quarantined"; entryId: string; error: string };

const outboxDir = (tenantId: string) => join(stateDir(tenantId), "outbox");
const entryPath = (tenantId: string, id: string) => join(outboxDir(tenantId), `${id}.json`);

function commit(e: OutboxEntry): void {
  mkdirSync(outboxDir(e.tenantId), { recursive: true, mode: 0o700 });
  const p = entryPath(e.tenantId, e.id);
  const tmp = `${p}.tmp`;
  writeFileSync(tmp, JSON.stringify(e, null, 2), { mode: 0o600 });
  renameReplacing(tmp, p);
}

function remove(e: OutboxEntry): void {
  try {
    unlinkSync(entryPath(e.tenantId, e.id));
  } catch {
    /* already gone */
  }
}

export function listOutbox(tenantId: string): OutboxEntry[] {
  const dir = outboxDir(tenantId);
  if (!existsSync(dir)) return [];
  const out: OutboxEntry[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    try {
      const e = JSON.parse(readFileSync(join(dir, f), "utf8")) as OutboxEntry;
      if (e && e.version === 1 && typeof e.id === "string") out.push(e);
    } catch {
      /* a half-written or corrupt file is not an entry; ignore, never crash the agent */
    }
  }
  return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export interface OutboxSummary {
  queued: number;
  indeterminate: number;
  quarantined: number;
  total: number;
  oldest?: string;
  capacity: number;
}

export function outboxSummary(tenantId: string): OutboxSummary {
  const all = listOutbox(tenantId);
  const n = (s: OutboxStatus) => all.filter((e) => e.status === s).length;
  return { queued: n("queued"), indeterminate: n("indeterminate"), quarantined: n("quarantined"), total: all.length, oldest: all[0]?.createdAt, capacity: OUTBOX_MAX_ENTRIES };
}

/** Every runtime with entries in this tenant's outbox, grouped by owning runtime (TASK-259). */
export interface OutboxOwner {
  runtime: string;
  /** Distinct profiles with queued/indeterminate entries; refused-only profiles cannot be flushed. */
  profiles: string[];
  queued: number;
  indeterminate: number;
  quarantined: number;
}

export function outboxOwners(tenantId: string): OutboxOwner[] {
  const by = new Map<string, OutboxOwner>();
  for (const e of listOutbox(tenantId)) {
    const name = e.runtime || "unknown";
    let o = by.get(name);
    if (!o) by.set(name, (o = { runtime: name, profiles: [], queued: 0, indeterminate: 0, quarantined: 0 }));
    if (e.status !== "quarantined" && e.profileId && !o.profiles.includes(e.profileId)) o.profiles.push(e.profileId);
    if (e.status === "queued") o.queued += 1;
    else if (e.status === "indeterminate") o.indeterminate += 1;
    else o.quarantined += 1;
  }
  for (const o of by.values()) o.profiles.sort();
  return [...by.values()].sort((a, b) => a.runtime.localeCompare(b.runtime));
}

/** The exact command that delivers one runtime's own queued entries (TASK-259). */
export const flushCommandFor = (runtime: string): string => `continuity --as ${runtime} outbox flush`;

/**
 * "N belongs to codex (profile proj_x) — codex must run `continuity --as codex outbox flush`" —
 * one phrase per other runtime. Counts, runtime names, profiles and commands only: never entry
 * content (that stays behind `continuity outbox`).
 */
export function otherOutboxPhrases(others: { runtime: string; profiles: string[]; unsaved: number }[]): string[] {
  return others.map((o) => {
    const where = o.profiles.length > 1 ? `profiles ${o.profiles.join(", ")}` : `profile ${o.profiles[0] ?? "?"}`;
    return `${o.unsaved} ${o.unsaved === 1 ? "belongs" : "belong"} to ${o.runtime} (${where}) — ${o.runtime} must run \`${flushCommandFor(o.runtime)}\``;
  });
}

export interface UnsavedSplit {
  /** queued + indeterminate across every runtime — the "NOT saved yet" count. */
  total: number;
  /** This runtime's share of `total`. */
  mine: number;
  /**
   * This runtime's profiles with queued/indeterminate entries (TASK-259 follow-up): the status
   * fallback promises "every owner/profile/exact flush command", so the CALLING runtime's own
   * originally queued profiles must be listed too — refused-only profiles cannot be flushed and
   * are never included.
   */
  mineProfiles: string[];
  /** Every other runtime's share of `total`, named with its profile(s). */
  others: { runtime: string; profiles: string[]; unsaved: number }[];
  /**
   * The shared owner-split clause (TASK-259) shown by the briefing, `status` and `outbox flush`:
   * the unsaved count split into this runtime's entries versus each other runtime's, every other
   * runtime named with its profile and the exact command it must run. Empty when nothing is unsaved.
   */
  clause: string;
}

/**
 * Split the NOT-saved-yet count by owning runtime (TASK-259): `outbox flush` delivers only the
 * calling runtime's own entries, so every surface must say whose entries are waiting and which
 * exact command delivers them — one runtime never flushes another runtime's entries.
 */
export function unsavedSplit(tenantId: string, selfRuntime: string): UnsavedSplit {
  const owners = outboxOwners(tenantId);
  const unsavedOf = (o: OutboxOwner) => o.queued + o.indeterminate;
  const mine = owners.find((o) => o.runtime === selfRuntime);
  const others = owners.filter((o) => o.runtime !== selfRuntime && unsavedOf(o) > 0).map((o) => ({ runtime: o.runtime, profiles: [...o.profiles], unsaved: unsavedOf(o) }));
  const myUnsaved = mine ? unsavedOf(mine) : 0;
  const mineProfiles = mine ? [...mine.profiles] : [];
  const myWhere = mineProfiles.length > 1 ? `profiles ${mineProfiles.join(", ")}` : mineProfiles.length === 1 ? `profile ${mineProfiles[0]}` : "";
  const parts = [
    ...(myUnsaved > 0 ? [`${myUnsaved} ${myUnsaved === 1 ? "belongs" : "belong"} to this runtime (${selfRuntime})${myWhere ? ` (${myWhere})` : ""} — \`${flushCommandFor(selfRuntime)}\` delivers them`] : []),
    ...otherOutboxPhrases(others),
  ];
  return {
    total: myUnsaved + others.reduce((n, o) => n + o.unsaved, 0),
    mine: myUnsaved,
    mineProfiles,
    others,
    clause: parts.length > 0 ? `${parts.join("; ")}${others.length > 0 ? " (one runtime never flushes another runtime's entries)" : ""}` : "",
  };
}

function identityOf(e: OutboxEntry): Identity {
  return { actorId: e.actorId, profileId: e.profileId, roleId: e.roleId, grants: [grant.role(e.profileId, e.roleId), grant.profileShared(e.profileId)] };
}

type Failure = { kind: "unreachable" | "indeterminate" | "conflict" | "refused" | "server"; error: string };

function classify(e: unknown): Failure {
  if (e instanceof CortexError) {
    if (e.status === 0) {
      // refused = provably never sent; timeout/reset/other = it may have been processed.
      return e.transport === "refused" ? { kind: "unreachable", error: `Cortex unreachable (${e.transport})` } : { kind: "indeterminate", error: `no response (${e.transport ?? "other"}); the write may or may not have been committed` };
    }
    const detail = typeof e.detail === "string" ? e.detail : JSON.stringify(e.detail);
    const msg = `Cortex ${e.status}: ${detail.slice(0, 160)}`;
    if (e.status === 409) return { kind: "conflict", error: msg };
    if (e.status === 429 || e.status >= 500) return { kind: "server", error: msg };
    return { kind: "refused", error: msg };
  }
  return { kind: "refused", error: e instanceof Error ? e.message : String(e) };
}

/** Try to deliver one entry under its own frozen identity. Mutates `e` and persists the result. */
async function deliver(base: CortexTransport, rt: Runtime, e: OutboxEntry): Promise<WriteOutcome> {
  const client = base.as(identityOf(e));
  // Rebuild the request from the FROZEN entry, not from the current runtime.
  const frozen = { ...rt, agent: client, profileId: e.profileId, runtimeName: e.runtime, generation: e.generation } as Runtime;
  e.lastAttemptAt = new Date().toISOString();
  try {
    const res = await client.remember(buildRemember(frozen, e.write, { receiptId: e.receiptId, idempotencyKey: e.id }));
    return await acknowledge(rt, e, res.shard_id);
  } catch (err) {
    const f = classify(err);
    if (f.kind === "conflict") {
      const existing = await findExisting(frozen, e.write.content).catch(() => undefined);
      if (existing) return acknowledge(rt, e, existing);
      return settle(e, "quarantined", f.error, "conflict_unresolved: Cortex reports this content already exists under another request, but the existing shard could not be found");
    }
    if (f.kind === "unreachable") {
      e.lastError = f.error; // not an attempt
      commit(e);
      return { status: e.status === "indeterminate" ? "indeterminate" : "queued", entryId: e.id, error: f.error };
    }
    if (f.kind === "indeterminate") {
      e.status = "indeterminate";
      e.lastError = f.error;
      commit(e);
      return { status: "indeterminate", entryId: e.id, error: f.error };
    }
    e.attempts += 1;
    if (f.kind === "refused") return settle(e, "quarantined", f.error, `refused: ${f.error}`);
    if (e.attempts >= OUTBOX_MAX_ATTEMPTS) {
      // Before giving up: a gateway can surface an idempotent replay as a 5xx even though the write committed.
      const existing = await findExisting(frozen, e.write.content).catch(() => undefined);
      if (existing) return acknowledge(rt, e, existing);
    }
    if (e.attempts >= OUTBOX_MAX_ATTEMPTS) return settle(e, "quarantined", f.error, `retry_bound_exceeded after ${e.attempts} server-answered failures`);
    e.lastError = f.error;
    commit(e);
    return { status: e.status === "indeterminate" ? "indeterminate" : "queued", entryId: e.id, error: f.error };
  }
}

function settle(e: OutboxEntry, status: OutboxStatus, error: string, reason: string): WriteOutcome {
  // An entry that was INDETERMINATE has now resolved (scorecard: outbox health).
  if (e.status === "indeterminate") journalMetricFor(e.tenantId, e.profileId, { kind: "outbox_resolved", at: new Date().toISOString(), entryId: e.id, resolution: status === "quarantined" ? "quarantined" : "saved" });
  e.status = status;
  e.lastError = error;
  e.reason = reason;
  commit(e);
  return { status: "quarantined", entryId: e.id, error: reason };
}

/** Cortex acknowledged: now (and only now) it is saved. */
function acknowledge(rt: Runtime, e: OutboxEntry, shardId: string): WriteOutcome {
  // An entry that was INDETERMINATE has now resolved (scorecard: outbox health).
  if (e.status === "indeterminate") journalMetricFor(e.tenantId, e.profileId, { kind: "outbox_resolved", at: new Date().toISOString(), entryId: e.id, resolution: "saved" });
  if (e.pending) {
    const item = { shardId, content: e.write.content, createdAt: new Date().toISOString(), sessionId: e.sessionId, runtime: e.runtime, written: writeStamp(e.runtime, e.sessionId) };
    if (e.profileId === rt.profileId && e.tenantId === rt.cfg.tenantId) {
      if (!rt.state.pending.some((p) => p.shardId === shardId)) rt.state.pending.push(item);
      rt.persist();
    } else {
      const st = loadState(e.tenantId, e.profileId);
      if (!st.pending.some((p) => p.shardId === shardId)) st.pending.push(item);
      saveState(e.tenantId, e.profileId, st);
    }
  }
  // Where the record was made: the local madeOn ledger survives branch deletion (core/blame.ts).
  if (e.write.branch) {
    if (e.profileId === rt.profileId && e.tenantId === rt.cfg.tenantId) {
      if (noteMadeOn(rt.state, shardId, e.write.branch)) rt.persist();
    } else {
      const st = loadState(e.tenantId, e.profileId);
      if (noteMadeOn(st, shardId, e.write.branch)) saveState(e.tenantId, e.profileId, st);
    }
  }
  remove(e);
  return { status: "saved", id: shardId };
}

/**
 * Write a private shard durably. Commits to the outbox first, then tries to deliver.
 * Returns `saved` only after Cortex acknowledged. Anything else is NOT saved.
 */
export async function writePrivateDurable(rt: Runtime, w: WriteInput, opts: { pending: boolean }): Promise<WriteOutcome> {
  assertWritable(w.content);
  assertCaptureAllowed(rt.cfg.tenantId);
  // Freeze the capture origin into the entry: replays must be byte-identical (core/blame.ts).
  w = await withCaptureBranch(w);
  const tenantId = rt.cfg.tenantId;
  if (listOutbox(tenantId).length >= OUTBOX_MAX_ENTRIES) {
    throw new Error(`outbox is full (${OUTBOX_MAX_ENTRIES} entries, quarantined ones included). Run \`continuity outbox\` to inspect, \`continuity outbox flush\` to deliver, or \`continuity outbox drop <id>\` for quarantined entries. Nothing was captured.`);
  }
  const entry: OutboxEntry = {
    version: 1,
    id: mintId("ob"),
    receiptId: mintId("rcpt"),
    tenantId,
    profileId: rt.profileId,
    roleId: rt.agent.identity.roleId,
    actorId: rt.agent.identity.actorId,
    runtime: rt.runtimeName,
    generation: rt.generation,
    createdAt: new Date().toISOString(),
    status: "queued",
    attempts: 0,
    pending: opts.pending,
    sessionId: w.sessionId,
    write: w,
  };
  commit(entry); // O-1: durable before send
  return deliver(rt.agent, rt, entry);
}

export interface FlushResult {
  attempted: number;
  saved: number;
  stillQueued: number;
  indeterminate: number;
  quarantined: number;
  skipped?: string;
}

/**
 * Deliver waiting entries written by THIS runtime. Each keeps its original profile/role identity
 * (no re-scoping). One runtime never flushes another runtime's entries: that would be writing as a role it
 * does not hold. (Under the dev Cortex secret it could; under per-agent gateway keys it must not.)
 */
export async function flushOutbox(rt: Runtime, opts: { limit?: number } = {}): Promise<FlushResult> {
  const tenantId = rt.cfg.tenantId;
  const waiting = listOutbox(tenantId).filter((e) => e.status !== "quarantined" && e.runtime === rt.runtimeName);
  const r: FlushResult = { attempted: 0, saved: 0, stillQueued: 0, indeterminate: 0, quarantined: 0 };
  if (waiting.length === 0) return r;
  if (!(await rt.agent.healthy())) return { ...r, stillQueued: waiting.length - waiting.filter((e) => e.status === "indeterminate").length, indeterminate: waiting.filter((e) => e.status === "indeterminate").length, skipped: "Cortex unreachable" };
  for (const e of waiting.slice(0, opts.limit ?? 50)) {
    r.attempted += 1;
    const o = await deliver(rt.agent, rt, e);
    if (o.status === "saved") r.saved += 1;
    else if (o.status === "indeterminate") r.indeterminate += 1;
    else if (o.status === "quarantined") r.quarantined += 1;
    else r.stillQueued += 1;
  }
  return r;
}

/** Put a quarantined entry back in line (operator decision). Identity is unchanged. */
export function requeue(tenantId: string, idPrefix: string): OutboxEntry {
  const hit = pick(tenantId, idPrefix);
  hit.status = "queued";
  hit.attempts = 0;
  hit.reason = undefined;
  commit(hit);
  return hit;
}

/** Discard a quarantined entry (operator decision). Only quarantined entries can be dropped: queued work is never silently lost. */
export function dropQuarantined(tenantId: string, idPrefix: string): OutboxEntry {
  const hit = pick(tenantId, idPrefix);
  if (hit.status !== "quarantined") throw new Error(`${hit.id} is ${hit.status}, not quarantined. Flush it instead; queued work is never silently dropped.`);
  remove(hit);
  return hit;
}

function pick(tenantId: string, idPrefix: string): OutboxEntry {
  const hits = listOutbox(tenantId).filter((e) => e.id.startsWith(idPrefix));
  if (hits.length !== 1) throw new Error(hits.length ? `"${idPrefix}" is ambiguous (${hits.length} entries)` : `no outbox entry matches "${idPrefix}"`);
  return hits[0];
}
