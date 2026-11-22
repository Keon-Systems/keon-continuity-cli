/**
 * Local state. Exists only because Cortex has no `GET /v1/curation/proposals`
 * yet (SKETCH §9). Plain JSON, rebuildable by hand, one file per tenant+profile.
 */

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { renameReplacing } from "../src/atomic-file.ts";

/**
 * Who last wrote this local row, in which session and process — stamped on state rows for
 * forensics (the 2026-11-02 clobber was hard to attribute: rows carried no writer identity).
 * Absent on rows written before the stamp existed and on rows whose writer is unknown.
 */
export interface WriteStamp {
  /** Runtime (harness) whose process wrote this row. */
  runtime: string;
  /** Session the write happened in (may repeat across runs; `pid` disambiguates processes). */
  sessionId: string;
  /** OS pid of the writing process. */
  pid: number;
  at: string;
}

export function writeStamp(runtime: string, sessionId: string): WriteStamp {
  return { runtime, sessionId, pid: process.pid, at: new Date().toISOString() };
}

export interface PendingItem {
  shardId: string;
  content: string;
  createdAt: string;
  sessionId: string;
  /** Runtime whose role owns the private source shard; only it can propose sharing. Legacy entries → "pi". */
  runtime?: string;
  /** Last writer of this local row (forensics). */
  written?: WriteStamp;
}

export interface SharedItem {
  derivedId: string;
  sourceId: string;
  content: string;
  approvedAt: string;
  /** Set when this record was superseded by another derived record. */
  supersededBy?: string;
  /** Runtime whose staged inference the user confirmed into this record (absent on legacy records and on plain user supersede edits). */
  runtime?: string;
  /** Last writer of this local row (forensics). */
  written?: WriteStamp;
}

/**
 * A pending item the user deliberately dropped from review (`continuity drop`, an offerings
 * dismissal, or either Second Opinion resolution — keep the shared one drops the note;
 * superseding the shared one with the note spends it). The shard stays private in Cortex —
 * a drop is local review state — so a resync consults this ledger instead of resurrecting
 * what the user already dropped, and the Second Opinion report never re-enters it
 * (core/compare.ts). Bounded like the other logs.
 */
export interface DroppedItem {
  shardId: string;
  at: string;
  runtime: string;
  sessionId: string;
  /**
   * How the note left review when a resolution spent it (TASK-91's Second Opinion actions:
   * `kept` = kept the shared one and dropped the note; `superseded` = superseded the shared
   * one with the note). Absent on a plain drop/dismissal. So a reader can always tell
   * rejected content from content that was PROMOTED into shared memory.
   */
  resolution?: "dropped" | "dismissed" | "kept" | "superseded";
}

/**
 * A pending item the user pressed "not now" on (Idle Insights card snooze,
 * docs/quiescent-compute.md §7). Unlike a drop the item STAYS in the review queue — the
 * snooze is presentation review state: the offering panel hides the card until `until`
 * (YYYY-MM-DD) and then resurfaces it. Latest entry per shard wins (re-snoozing extends).
 * Bounded like the other logs.
 */
export interface SnoozedItem {
  shardId: string;
  /** YYYY-MM-DD the card resurfaces in the panel. */
  until: string;
  at: string;
  runtime: string;
  sessionId: string;
}

/**
 * `supersededBy` value for history rows rebuilt from Cortex whose successor is not
 * recoverable (Cortex exposes the superseded status but no successor id — see the lineage
 * limit in core/delta.ts). Truthy, so every "is this live?" check treats the row as history;
 * no chain walk can mistake it for a real derived id (ids are minted with prefixes).
 */
export const SUPERSEDED_UNKNOWN = "unresolved";

/**
 * One memory delivery this runtime made to an agent (a briefing or a recall). Feedback
 * (applied / not applicable / outcome) must reference a delivery: access is not use, and an
 * undelivered record cannot have been applied.
 */
export interface DeliveryRecord {
  recallEventId: string;
  sessionId: string;
  ids: string[];
  at: string;
  /** Runtime that received the delivery; absent on legacy entries (seen by every runtime on this machine). */
  runtime?: string;
  /**
   * Records the briefing SUMMARIZED instead of delivering — category hint counts and '+N more'
   * overflow lines (Cortex was told access_omitted for every one of them). Shown, never delivered:
   * "since you were last here" treats them as seen (their changes are not news), while feedback
   * still needs a real delivery in `ids` — access comes before use.
   */
  summarizedIds?: string[];
  /**
   * Recall event that delivered each id, when one briefing used more than one recall.
   * Absent on older rows: `recallEventId` is the event for every id in `ids`.
   */
  recallEventIds?: Record<string, string>;
}

/**
 * A record this runtime reported applied (`feedback applied`), kept locally so the git
 * prepare-commit-msg hook can attach `Continuity-Applied: <id>` trailers at commit time.
 * `worktree` is the checkout the report ran in, so parallel task workers never attach each
 * other's records when no explicit session id is available at commit time.
 */
export interface AppliedRecord {
  memoryId: string;
  sessionId: string;
  runtime: string;
  targetRef: string;
  at: string;
  worktree?: string;
}

/**
 * A baton (handoff) that was shown to its recipient exactly once. Consumption is recorded
 * at the access event the briefing reports for that delivery: Cortex re-delivers batons
 * freely, so "consumed once" is ours to enforce (see core/briefing.ts).
 */
export interface ConsumedBaton {
  id: string;
  /** The role the baton was addressed to (handoff_to_role_id); consumption is per recipient. */
  roleId: string;
  at: string;
}

/**
 * Where a record was MADE: the git branch of its capture, kept locally. Cortex does not have to
 * hand write provenance back (its shard rows carry their own extras), and commits on a deleted
 * branch are unreachable — so this ledger is what survives branch deletion and makes "this
 * decision was made on a deleted branch" detectable (core/blame.ts). Like the applied ledger:
 * local to the machine, bounded, never sent anywhere.
 */
export interface MadeOnRecord {
  memoryId: string;
  branch: string;
  at: string;
}

/**
 * One feedback report this machine made about a delivered record. The journal exists so
 * `continuity hygiene` can compute its read-only queue locally: Cortex records feedback as
 * memory events but exposes no read for them, and hygiene must not write anything to find out
 * what was already reported. Bounded like deliveries; a replay (409) is never journaled twice.
 */
export interface FeedbackNote {
  kind: "application" | "non_applicability" | "outcome" | "consideration";
  memoryId: string;
  at: string;
  /** Runtime whose report it was. */
  runtime: string;
  sessionId: string;
  targetRef?: string;
  contextRef?: string;
  reason?: string;
  status?: string;
}

export const MAX_DELIVERIES = 20;
export const MAX_FEEDBACK_NOTES = 200;
export const MAX_APPLIED = 50;
export const MAX_MADE_ON = 500;
export const MAX_DROPPED = 500;
export const MAX_SNOOZED = 500;

// ----- scorecard accounting (docs/validation.md) -----
// A local, append-only event journal so `continuity scorecard` can compute the pilot metrics
// from local state. Purely descriptive counts: it changes no ranking and no behavior.

export type MetricSource = "briefing" | "recall" | "jit" | "render";

export type MetricEvent =
  /** One memory-delivery run (a briefing build, a recall, a jit injection, or a confirmed-only render). `records` = what was actually delivered; 0 is a miss and still counts toward the retrieval rate. */
  | { kind: "delivery"; at: string; runtime: string; sessionId: string; source: MetricSource; records: number; approxTokens?: number; tokenBudget?: number; omittedForBudget?: number }
  /** One feedback report on a delivered record. `replay` = Cortex answered "already on record" (409): not a new event. */
  | { kind: "feedback"; at: string; runtime: string; sessionId: string; report: "application" | "non_applicability" | "consideration" | "outcome"; memoryId: string; status?: string; replay?: boolean }
  /** An outbox entry that was INDETERMINATE and later resolved (saved via replay, or quarantined). */
  | { kind: "outbox_resolved"; at: string; entryId: string; resolution: "saved" | "quarantined" };

export const MAX_METRICS_EVENTS = 4000;

export interface LocalState {
  version: 1;
  pending: PendingItem[];
  shared: SharedItem[];
  deliveries?: DeliveryRecord[];
  feedback?: FeedbackNote[];
  applied?: AppliedRecord[];
  madeOn?: MadeOnRecord[];
  consumedBatons?: ConsumedBaton[];
  dropped?: DroppedItem[];
  snoozed?: SnoozedItem[];
  metrics?: MetricEvent[];
  lastSave?: { sessionId: string; leafId: string; at: string };
  /**
   * Pre-compaction capture progress (CLI `capture`): the first `count` transcript messages of
   * `sessionId` were already staged. A counter, not a content filter: what the user dropped or
   * the guard withheld is never re-offered. The transcript is append-only, so counting is stable.
   */
  lastCapture?: { sessionId: string; count: number; at: string };
  lastResurfaced?: string;
  /** Session id `continuity jit --once` last delivered to, so hook harnesses get JIT on the FIRST user prompt only. */
  lastJitSession?: string;
}

const STATE_ROOT = process.env.XDG_STATE_HOME
  ? join(process.env.XDG_STATE_HOME, "continuity")
  : join(homedir(), ".local", "state", "continuity");

export function stateDir(tenantId: string): string {
  return join(STATE_ROOT, tenantId);
}

export function statePath(tenantId: string, profileId: string): string {
  return join(STATE_ROOT, tenantId, `${profileId}.json`);
}

/** Deprecated source name (one release, TASK-78): journals written before the 'briefing' rename say `passport`. */
function normalizeMetricEvent(e: MetricEvent): MetricEvent {
  return e.kind === "delivery" && (e.source as string) === "passport" ? { ...e, source: "briefing" } : e;
}

export function loadState(tenantId: string, profileId: string): LocalState {
  const p = statePath(tenantId, profileId);
  if (!existsSync(p)) return withBase({ version: 1, pending: [], shared: [] });
  try {
    const raw = JSON.parse(readFileSync(p, "utf8")) as Partial<LocalState>;
    return withBase({
      version: 1,
      pending: Array.isArray(raw.pending) ? raw.pending : [],
      shared: Array.isArray(raw.shared) ? raw.shared : [],
      deliveries: Array.isArray(raw.deliveries) ? raw.deliveries.slice(-MAX_DELIVERIES) : [],
      feedback: Array.isArray(raw.feedback) ? raw.feedback.slice(-MAX_FEEDBACK_NOTES) : [],
      applied: Array.isArray(raw.applied) ? raw.applied.slice(-MAX_APPLIED) : [],
      madeOn: Array.isArray(raw.madeOn) ? raw.madeOn.slice(-MAX_MADE_ON) : [],
      consumedBatons: Array.isArray(raw.consumedBatons) ? raw.consumedBatons : [],
      dropped: Array.isArray(raw.dropped) ? raw.dropped.slice(-MAX_DROPPED) : [],
      snoozed: Array.isArray(raw.snoozed) ? raw.snoozed.slice(-MAX_SNOOZED) : [],
      metrics: Array.isArray(raw.metrics) ? raw.metrics.map(normalizeMetricEvent).slice(-MAX_METRICS_EVENTS) : [],
      lastSave: raw.lastSave,
      lastCapture: raw.lastCapture,
      lastResurfaced: raw.lastResurfaced,
      lastJitSession: raw.lastJitSession,
    });
  } catch {
    return withBase({ version: 1, pending: [], shared: [] });
  }
}

/** Append a metric event to a local state (bounded, oldest first). Plain data: never throws past fs errors. */
export function journalMetric(state: LocalState, e: MetricEvent): void {
  const list = (state.metrics ??= []);
  // Same normalisation as loadState: a caller still passing the retired `passport` source
  // (one-release alias) is recorded under `briefing`, so a journal never mixes the two.
  list.push(normalizeMetricEvent(e));
  while (list.length > MAX_METRICS_EVENTS) list.shift();
}

/** Journal into this runtime's state and persist. Structurally typed so it takes any Runtime. */
export function journalTo(rt: { state: LocalState; persist(): void }, e: MetricEvent): void {
  journalMetric(rt.state, e);
  rt.persist();
}

/** Journal into one tenant+profile's state file directly (e.g. outbox entries written under another profile). */
export function journalMetricFor(tenantId: string, profileId: string, e: MetricEvent): void {
  const st = loadState(tenantId, profileId);
  journalMetric(st, e);
  saveState(tenantId, profileId, st);
}

// ----- concurrent-writer safety -----
// Several continuity processes share one state file (CLI runs, task workers in worktrees, the
// deck server). Each loads a snapshot at startup and persists later, so a plain whole-file
// overwrite silently destroys whatever another writer added meanwhile (lost updates: shared
// rows vanished, dropped pending rows resurrected). saveState therefore THREE-WAY MERGES the
// snapshot this object was loaded from (base) with the current file (disk) and our edits
// (mine), under a cross-process lock:
//   - rows only others added/edited (I never touched them) keep THEIR version — a stale
//     snapshot can no longer erase them;
//   - rows I added or edited win (my change is intentional and recent);
//   - rows I deleted stay deleted UNLESS I never saw them (not mine to delete).
// Append-only logs (deliveries, feedback, …) merge as a union sorted by `at`.

const BASE = Symbol("continuityStateBase");
type WithBase = LocalState & { [BASE]?: string };
type AnyRow = Record<string, unknown>;

/** Remember what this snapshot was loaded from, so saveState can tell my edits from my staleness. */
function withBase(st: LocalState): LocalState {
  (st as WithBase)[BASE] = JSON.stringify(st);
  return st;
}

const KEYED: Record<string, (r: AnyRow) => string> = {
  pending: (r) => String(r.shardId ?? ""),
  shared: (r) => String(r.derivedId ?? ""),
};
const LOG_MAX: Record<string, number> = {
  deliveries: MAX_DELIVERIES,
  feedback: MAX_FEEDBACK_NOTES,
  applied: MAX_APPLIED,
  madeOn: MAX_MADE_ON,
  metrics: MAX_METRICS_EVENTS,
  consumedBatons: Number.MAX_SAFE_INTEGER,
  dropped: MAX_DROPPED,
  snoozed: MAX_SNOOZED,
};

function rows(v: unknown): AnyRow[] {
  return Array.isArray(v) ? (v as AnyRow[]) : [];
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Keyed records (pending, shared): my intentional change wins; absent my change, theirs does. */
function mergeKeyed(base: AnyRow[], mine: AnyRow[], disk: AnyRow[], key: (r: AnyRow) => string): AnyRow[] {
  const b = new Map(base.map((r) => [key(r), r]));
  const m = new Map(mine.map((r) => [key(r), r]));
  const out: AnyRow[] = [];
  const seen = new Set<string>();
  for (const dr of disk) {
    const k = key(dr);
    seen.add(k);
    const br = b.get(k);
    const mr = m.get(k);
    if (mr === undefined) {
      if (br === undefined) out.push(dr); // existed before I loaded: not mine to delete
      continue; // my delete propagates
    }
    out.push(br !== undefined && same(mr, br) ? dr : mr);
  }
  for (const mr of mine) {
    const k = key(mr);
    if (seen.has(k)) continue;
    const br = b.get(k);
    if (br !== undefined && same(mr, br)) continue; // they deleted a row I never touched
    out.push(mr); // my add, or my edit resurrecting a row (my change wins)
  }
  return out;
}

/** Append-only journals: union of both writers, chronological, bounded. */
function mergeLog(base: AnyRow[], mine: AnyRow[], disk: AnyRow[], max: number): AnyRow[] {
  const sig = (r: AnyRow): string => JSON.stringify(r);
  // Multiset difference against the base snapshot: rows already there when I loaded are not
  // mine to add again, but two identical events I appended ARE two events (same-millisecond
  // stamps happen), so only counts, never a set, decide.
  const counts = new Map<string, number>();
  for (const r of base) counts.set(sig(r), (counts.get(sig(r)) ?? 0) + 1);
  const out = [...disk];
  for (const r of mine) {
    const s = sig(r);
    const n = counts.get(s) ?? 0;
    if (n > 0) {
      counts.set(s, n - 1);
      continue;
    }
    out.push(r);
  }
  out.sort((x, y) => String(x.at ?? "").localeCompare(String(y.at ?? "")));
  return out.slice(-max);
}

function mergeState(base: LocalState, mine: LocalState, disk: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...disk };
  const b = base as unknown as Record<string, unknown>;
  const m = mine as unknown as Record<string, unknown>;
  const keys = new Set([...Object.keys(disk), ...Object.keys(m), ...Object.keys(b)]);
  for (const k of keys) {
    if (k in KEYED) {
      out[k] = mergeKeyed(rows(b[k]), rows(m[k]), rows(disk[k]), KEYED[k]);
    } else if (k in LOG_MAX) {
      out[k] = mergeLog(rows(b[k]), rows(m[k]), rows(disk[k]), LOG_MAX[k]);
    } else if (!same(m[k], b[k])) {
      if (m[k] === undefined) delete out[k];
      else out[k] = m[k]; // my scalar change wins
    } else if (disk[k] !== undefined) {
      out[k] = disk[k]; // untouched by me: theirs (also preserves keys only another version writes)
    } else {
      delete out[k];
    }
  }
  return out;
}

function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Serialize writers across processes with a lock file; fail open after 5s so a dead lock cannot wedge the CLI. */
function withLock<T>(p: string, fn: () => T): T {
  const lock = `${p}.lock`;
  const deadline = Date.now() + 5000;
  for (;;) {
    try {
      const fd = openSync(lock, "wx");
      try {
        return fn();
      } finally {
        closeSync(fd);
        rmSync(lock, { force: true });
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      try {
        if (Date.now() - statSync(lock).mtimeMs > 10_000) {
          rmSync(lock, { force: true }); // a writer died mid-save
          continue;
        }
      } catch {
        /* lock vanished between attempts */
      }
      if (Date.now() > deadline) return fn(); // fail open: availability over strictness
      sleep(25);
    }
  }
}

export function saveState(tenantId: string, profileId: string, state: LocalState): void {
  const p = statePath(tenantId, profileId);
  mkdirSync(join(STATE_ROOT, tenantId), { recursive: true, mode: 0o700 });
  withLock(p, () => {
    // Forward-compatible: never drop keys another version of Continuity wrote into this file.
    // Installs and parallel worktrees share it; a blind overwrite silently destroys their state —
    // so merge our changes over whatever is on disk NOW (see the three-way merge above).
    let disk: Record<string, unknown> = {};
    try {
      disk = JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
    } catch {
      /* first write, or an unreadable file: our own state is all we can keep */
    }
    const base = JSON.parse((state as WithBase)[BASE] ?? "{}") as LocalState;
    const merged = mergeState(base, state, disk);
    // Fixed temp name: the lock above is what keeps two writers from sharing it. The
    // rename is retried when Windows refuses to replace a file another process has open.
    const tmp = `${p}.tmp`;
    writeFileSync(tmp, JSON.stringify(merged, null, 2), { mode: 0o600 });
    renameReplacing(tmp, p);
    // Bring this snapshot up to date with what is now on disk, and re-base: the next save must
    // diff against the merged file, not the one this process loaded — otherwise rows other
    // writers added would look like deletions by us.
    const self = state as unknown as Record<string, unknown>;
    for (const k of Object.keys(self)) if (!(k in merged)) delete self[k];
    Object.assign(self, merged);
    (state as WithBase)[BASE] = JSON.stringify(merged);
  });
}
