// Adapted from Keon Kontinuity for the standalone CLI.
/**
 * Task board: TASK-nn records as coordination state between runtimes.
 *
 * A task is an ordinary user-confirmed shared memory whose text starts with a task id
 * and a status segment. Transitions are supersedes (history kept), done in code — never by
 * the model — so a "lesser" agent cannot forget to claim or claim a blocked task:
 *
 *   [open-loop] TASK-07 AVAILABLE PARALLEL (small): text — next: …
 *   [open-loop] TASK-05 BLOCKED-ON: TASK-04. text — next: …
 *   [open-loop] TASK-05 BLOCKED-ON: TASK-04, USER [was AVAILABLE PARALLEL (small)]: text — next: …
 *   [open-loop] TASK-07 CLAIMED by pi 2026-11-01 [was AVAILABLE PARALLEL (small)]: text — next: …
 *   [open-loop] TASK-07 CLAIMED by pi 2026-11-01 (SPAWNED 2026-11-01) [was AVAILABLE PARALLEL (small)]: text
 *   [open-loop] TASK-07 CLAIMED by pi 2026-11-01 (FAILED 2026-11-01) [was AVAILABLE PARALLEL (small)]: text
 *   [open-loop] TASK-07 CLAIMED by pi 2026-11-01 (PAUSED 2026-11-03) (SPAWNED 2026-11-01) [was AVAILABLE PARALLEL (small)]: text
 *   [note] TASK-07 DONE by pi 2026-11-02 ref:https://…/pull/9 [was AVAILABLE PARALLEL (small)]: text
 *   [note] TASK-07 CANCELLED by pi 2026-11-03 [was claimed]: text
 *
 * A blocker is either a TASK-nn (cleared by its DONE) or a pseudo-ref: USER (a decision only
 * the user can make — a scope call, a direction pick) or EXT (something outside the board —
 * an upstream fix, a verification run). A task waiting on USER/EXT is never claimable until the
 * gate is cleared, and only `task unblock` clears one — it needs --user-confirmed, so a worker
 * cannot ungate itself. `task block` adds blockers to a live available/blocked task (prose like
 * "build after TASK-99" becomes a real gate) and keeps the pre-block form in `[was …]`, which
 * `unblock` restores exactly. Block/unblock are supersede transitions like claim/release.
 * Block is deliberately confirmation-free (it can only ever DENY claims, never grant them — a
 * griefing worker can gate tasks but cannot ungate, corrupt, or claim one, and the user's
 * `task unblock --user-confirmed` undoes it in one command). If untrusted runtimes ever share
 * a board, put block behind the same owner authority as unblock: anything that changes who
 * may act should need the same authority in both directions.
 *
 * The briefing is a snapshot taken at session start, so every transition re-reads the board
 * from Cortex first. Two runtimes racing on one task: the second supersede targets a record that
 * is already superseded and Cortex refuses it — the loser sees an error, not a silent double claim.
 *
 * Marking a task DONE runs one post-transition hook (TASK-221): every BLOCKED task whose last
 * TASK-nn blocker just cleared and which holds no USER/EXT gate is promoted to its pre-block
 * AVAILABLE form (`promotableDependents`). Best effort after the DONE has landed, so a lost
 * promotion race never makes a recorded DONE look failed.
 */

import { isDeepStrictEqual } from "node:util";
import { grant, type SearchShard, type SearchResult } from "../src/cortex.ts";
import { IngestRefusal } from "../shared/ingest.ts";
import { isUniqueKeyConflict, share, supersede, writePrivate } from "./memory.ts";
import { boardReadKey, invalidateBoardReads, readCachedBoard } from "./board-read-cache.ts";
import { derivedId } from "../src/ids.ts";
import type { Runtime } from "./runtime.ts";
import { currentProject } from "./projects.ts";
import { assertTaskNumberWidth, importClaimable, mapContractReader, type ContractReader } from "./task-contract.ts";
import {
  sharedAllocator,
  sourceKindForProvenance,
  TaskAllocatorError,
  type AllocateItemInput,
  type AllocateScope,
  type AllocatedTask,
  type BoardTaskContract,
} from "./task-allocator.ts";

import { readBoardDisplayMetadata } from "./board-display.ts";
import { splitBoardDisplay, type BoardDisplayMetadata } from "../shared/board-edit.ts";

export type TaskStatus = "available" | "blocked" | "claimed" | "done" | "backlog" | "archive";

/** Non-task gates: "user" = a decision only the user can make; "external" = outside the board. */
export type WaitingOn = "user" | "external";

/** A blocker as written: a TASK-nn number, or a USER/EXT gate. */
export type BlockerRef = number | WaitingOn;

export interface Task {
  n: number;
  id: string; // current shared record id
  status: TaskStatus;
  /** Status segment as written when the task was available/blocked, e.g. "AVAILABLE PARALLEL (small)". */
  origStatus: string;
  blockedOn: number[];
  /** USER/EXT gates on a blocked task (or on the [was …] status of a claimed one). */
  waitingOn: WaitingOn[];
  /** Pre-block available form kept on BLOCKED-ON records as `[was …]`; what `unblock` restores. */
  wasStatus?: string;
  by?: string;
  at?: string; // YYYY-MM-DD
  /** For a claim: the date the claim was paused (TASK-125) — the claim is kept, the worker is paused. */
  pausedAt?: string; // YYYY-MM-DD
  /** For a claim: a worker was spawned for it (TASK-124) — 🚀 on the card. */
  spawnedAt?: string; // YYYY-MM-DD
  /** For a claim: the spawned run failed (TASK-124) — ❌ on the card. Never set alongside spawnedAt. */
  runFailedAt?: string; // YYYY-MM-DD
  ref?: string;
  /** Normalized preview only; transition-looking tails may be hidden, never source authority. */
  text: string;
  /** Bytes after the status delimiter, including leading/trailing whitespace. */
  rawBody?: string;
  content: string;
  /** Resolved from curation-linked record metadata, never parsed from task text. */
  displayMetadata?: BoardDisplayMetadata;
  ageDays?: number; // for claimed: days since claim
}

export const TASK_RE = /^\[(?:open-loop|note)\]\s+TASK-(\d{1,3})\s+(.*)$/s;
// The separator is explicit: `refs. text` / `refs: text` (legacy release output) / `refs text`
// / `refs [was …]: text` — the `[was …]` form is recognised only in its machine shape (no dot
// before it), so a text that begins with "[was foo]: …" on the plain form is never eaten.
const BLOCKED_RE = /^BLOCKED-ON:\s*((?:TASK-\d{1,3}|USER|EXT)(?:[\s,]+(?:TASK-\d{1,3}|USER|EXT))*)(?: \[was ([^\]]*)\]:|\.|:|(?=\s)|$)(.*)$/s;
// Claim markers — `(PAUSED <date>)` (TASK-125), `(SPAWNED <date>)` / `(FAILED <date>)` (TASK-124) — are
// read as an unordered run so hand-edited or older orderings still parse; `claimedContent` writes one
// canonical order. The run is permissive on purpose: a malformed marker is IGNORED (the claim still
// parses, just without that state) — a hand edit must never take a claim off the board.
const CLAIMED_RE = /^CLAIMED by (\S+) (\d{4}-\d{2}-\d{2})((?: \([^)]*\))*) \[was ([^\]]*)\]:(.*)$/s;
const DONE_RE = /^(DONE|ARCHIVE) by (\S+) (\d{4}-\d{2}-\d{2}) ref:(\S+) \[was ([^\]]*)\]:(.*)$/s;
/** Off-board tombstones (TASK-125: cancel writes CANCELLED, drop writes DROPPED) — both end a task's board life and keep its history. */
const TOMBSTONE_RE = /^(?:DROPPED|CANCELLED) by \S+ \d{4}-\d{2}-\d{2} \[was [^\]]*\]:/s;
const AVAILABLE_RE = /^(AVAILABLE(?:\s+PARALLEL)?(?:\s*\([^)]*\))?):(.*)$/s;

export const taskId = (n: number) => `TASK-${String(n).padStart(2, "0")}`;

/** Preview-only normalization; never use this result as the source body. */
function taskPreview(body: string): string {
  return body.replace(/(?: \[transition:transition_[a-f0-9]{40}\])+$/, "").trim();
}

/** Metadata must come from the scoped curation-link reader, never from task text. */
export function parseTask(content: string, id = "", today = new Date().toISOString().slice(0, 10), metadata?: BoardDisplayMetadata): Task | undefined {
  const m = TASK_RE.exec(content.trimStart());
  if (!m) return undefined;
  const n = Number(m[1]);
  // Syntax alone cannot distinguish an old genuine nonce from a literal source token.
  // Only a validated bounded-display envelope authenticates its single outer trailer.
  // Legacy/unreadable/ambiguous tails stay in rawBody, even when genuinely generated.
  const displayMetadata = splitBoardDisplay(content, metadata).fields ? metadata : undefined;
  const rest = displayMetadata ? m[2].trimStart().replace(/ \[transition:transition_[a-f0-9]{40}\]$/, "") : m[2].trimStart();
  const base = { n, id, content, ...(displayMetadata ? { displayMetadata } : {}) }; // retain full record bytes
  let x: RegExpExecArray | null;
  if ((x = CLAIMED_RE.exec(rest))) {
    const ageDays = Math.max(0, Math.round((Date.parse(today) - Date.parse(x[2])) / 86_400_000));
    const marks: { pausedAt?: string; spawnedAt?: string; runFailedAt?: string } = {};
    // Per-marker strict match inside the permissive run: only a well-formed known marker sets a
    // field; anything else (a typo, a hand edit) is skipped — never fatal to the claim.
    for (const m of x[3]!.matchAll(/\(([^)]*)\)/g)) {
      const mm = /^(PAUSED|SPAWNED|FAILED) (\d{4}-\d{2}-\d{2})$/.exec(m[1]!);
      if (!mm) continue;
      if (mm[1] === "PAUSED") marks.pausedAt = mm[2];
      else if (mm[1] === "SPAWNED") marks.spawnedAt = mm[2];
      else marks.runFailedAt = mm[2];
    }
    return { ...base, status: "claimed", by: x[1], at: x[2], ...marks, origStatus: x[4], blockedOn: blockedIds(x[4]), waitingOn: waitingIds(x[4]), text: taskPreview(x[5]), rawBody: x[5], ageDays };
  }
  if ((x = DONE_RE.exec(rest))) return { ...base, status: x[1] === "DONE" ? "done" : "archive", by: x[2], at: x[3], ref: x[4], origStatus: x[5], blockedOn: blockedIds(x[5]), waitingOn: waitingIds(x[5]), text: taskPreview(x[6]), rawBody: x[6] };
  if ((x = /^BACKLOG(?: \[was (.*?)\])?(?: \[available (.*?)\])?:(.*)$/s.exec(rest))) {
    const origStatus = x[1] || "AVAILABLE PARALLEL";
    return { ...base, status: "backlog", origStatus, blockedOn: blockedIds(origStatus), waitingOn: waitingIds(origStatus), wasStatus: x[2] || (origStatus.startsWith("AVAILABLE") ? origStatus : undefined), text: taskPreview(x[3]), rawBody: x[3] };
  }
  if ((x = BLOCKED_RE.exec(rest))) {
    const refs = x[1]!;
    const ids = blockedIds(refs);
    const waiting = waitingIds(refs);
    return {
      ...base,
      status: "blocked",
      origStatus: `BLOCKED-ON: ${[...ids.map(taskId), ...waiting.map(waitToken)].join(", ")}`,
      blockedOn: ids,
      waitingOn: waiting,
      wasStatus: x[2] || undefined,
      text: taskPreview(x[3]!),
      rawBody: x[3]!,
    };
  }
  if ((x = AVAILABLE_RE.exec(rest))) return { ...base, status: "available", origStatus: x[1], blockedOn: [], waitingOn: [], text: taskPreview(x[2]), rawBody: x[2] };
  return undefined;
}

function blockedIds(s: string): number[] {
  return [...s.matchAll(/TASK-(\d{1,3})/g)].map((m) => Number(m[1]));
}

function waitingIds(s: string): WaitingOn[] {
  return [...s.matchAll(/\b(USER|EXT)\b/g)].map((m) => (m[1] === "USER" ? "user" : "external"));
}

/** Canonical record token for a gate: USER / EXT. */
export const waitToken = (w: WaitingOn): string => (w === "user" ? "USER" : "EXT");

/** Parse CLI/tool blocker tokens: TASK-nn / user / ext(ernal), case-insensitive. */
export function parseBlockerRefs(tokens: string[]): BlockerRef[] {
  const out: BlockerRef[] = [];
  for (const tok of tokens) {
    const m = /^(?:TASK-)?(\d{1,3})$/i.exec(tok);
    if (m) {
      out.push(Number(m[1]));
      continue;
    }
    if (/^USER$/i.test(tok)) {
      out.push("user");
      continue;
    }
    if (/^(?:EXT|EXTERNAL)$/i.test(tok)) {
      out.push("external");
      continue;
    }
    throw new BoardError(`"${tok}" is not a blocker — use TASK-nn, USER (a decision only the user can make) or EXT (outside the board)`);
  }
  if (!out.length) throw new BoardError("name at least one blocker: TASK-nn, USER or EXT");
  return out;
}

/** Validate a `waitingOn` array from the CLI/tool surface (task add). Deduped; undefined passes through. */
export function normalizeWaitingOn(values: unknown): WaitingOn[] | undefined {
  if (values === undefined) return undefined;
  if (!Array.isArray(values)) throw new BoardError('waitingOn must be an array of "user" / "external"');
  const out = values.map((v) =>
    typeof v === "string" && /^user$/i.test(v) ? "user" : typeof v === "string" && /^(?:ext|external)$/i.test(v) ? "external" : null,
  );
  if (out.some((x) => x === null)) throw new BoardError('waitingOn entries must be "user" or "external"');
  return [...new Set(out as WaitingOn[])];
}

/** Transitions serialize the raw body, not the normalized preview. */
function taskBody(t: Task): string {
  return t.rawBody !== undefined && taskPreview(t.rawBody) === t.text ? t.rawBody : ` ${t.text}`;
}

/**
 * Claim record. A paused claim (TASK-125) keeps the ORIGINAL claimer and claim date — the
 * claim is kept, only `(PAUSED <date>)` marks that its worker was paused — so `resume`
 * restores the exact claim by dropping the marker.
 */
export function claimedContent(t: Task, by: string, date: string, pausedAt?: string): string {
  const paused = pausedAt ? ` (PAUSED ${pausedAt})` : "";
  // Run state (TASK-124) rides the claim record as its own marker. Exactly one is written:
  // a failed run never reads 🚀 (failed wins if a caller ever hands in both).
  const run = t.runFailedAt ? ` (FAILED ${t.runFailedAt})` : t.spawnedAt ? ` (SPAWNED ${t.spawnedAt})` : "";
  return `[open-loop] ${taskId(t.n)} CLAIMED by ${by} ${date}${paused}${run} [was ${t.origStatus}]:${taskBody(t)}`;
}

export function releasedContent(t: Task): string {
  // AVAILABLE segments take `: text`; BLOCKED-ON has its own grammar (`refs. text`) — older
  // releases wrote `refs: text`, which BLOCKED_RE still reads (text clean, not ": text").
  const sep = t.origStatus.startsWith("BLOCKED-ON") ? "." : ":";
  return `[open-loop] ${taskId(t.n)} ${t.origStatus}${sep}${taskBody(t)}`;
}

export function doneContent(t: Task, by: string, date: string, ref: string): string {
  return `[note] ${taskId(t.n)} DONE by ${by} ${date} ref:${ref} [was ${t.origStatus}]:${taskBody(t)}`;
}

/**
 * Content for a blocked task: BLOCKED-ON over task ids and/or USER/EXT gates. The pre-block
 * available form rides along as `[was …]` when it is not the default "AVAILABLE PARALLEL", so
 * `unblock` can restore it exactly. (A claim snapshots `[was BLOCKED-ON: …]` and drops the
 * inner form — a released task then unblocks to the default form; cosmetic only.)
 */
export function blockedContent(t: Task, refs: BlockerRef[]): string {
  const tasks = [...new Set(refs.filter((r): r is number => typeof r === "number"))];
  const waiting = [...new Set(refs.filter((r): r is WaitingOn => typeof r !== "number"))];
  const seg = [...tasks.map(taskId), ...waiting.map(waitToken)].join(", ");
  const was = (t.status === "available" ? t.origStatus : t.wasStatus) ?? "";
  // Grammar: `BLOCKED-ON: refs. text` plain, `BLOCKED-ON: refs [was …]: text` with the
  // pre-block form — same dot/colon discipline as the other status segments.
  return was !== "" && was !== "AVAILABLE PARALLEL"
    ? `[open-loop] ${taskId(t.n)} BLOCKED-ON: ${seg} [was ${was}]:${taskBody(t)}`
    : `[open-loop] ${taskId(t.n)} BLOCKED-ON: ${seg}.${taskBody(t)}`;
}

/** Content for a task whose last gate was cleared: back to its pre-block available form. */
export function unblockedContent(t: Task): string {
  return `[open-loop] ${taskId(t.n)} ${t.wasStatus ?? "AVAILABLE PARALLEL"}:${taskBody(t)}`;
}

/** One proposed new task (Concierge vibe-coding → board add, deck-design.md §7). */
export interface NewTask {
  /** Task description; must not itself start with a tag or TASK-nn id (the composer owns those). */
  text: string;
  /** Size hint shown in parens, e.g. "small" — free-form, one token. */
  size?: string;
  /** Existing task numbers this one waits on (→ BLOCKED-ON). Batch-internal deps go in the text. */
  blockedOn?: number[];
  /** Non-task gates this one waits on (→ BLOCKED-ON: …, USER / …, EXT). */
  waitingOn?: WaitingOn[];
  /** "— next: …" tail: the first step for whoever claims it. */
  next?: string;
}

/**
 * Content for a freshly added task. Ids and status segments are composed HERE, never
 * accepted from a caller's text: `[open-loop] TASK-07 AVAILABLE PARALLEL (small): text — next: …`
 * or, when it waits on others, `[open-loop] TASK-07 BLOCKED-ON: TASK-04. text`. Round-trips
 * through `parseTask` so board state stays machine-readable.
 */
export function addedContent(n: number, t: NewTask, parallel = true): string {
  const text = t.text.trim() + (t.next?.trim() ? ` — next: ${t.next.trim()}` : "");
  const size = t.size?.trim() ? ` (${t.size.trim()})` : "";
  const avail = `AVAILABLE${parallel ? " PARALLEL" : ""}${size}`;
  const taskRefs = [...new Set(t.blockedOn ?? [])];
  const waitRefs = [...new Set(t.waitingOn ?? [])];
  if (taskRefs.length > 0 || waitRefs.length > 0) {
    const seg = [...taskRefs.map(taskId), ...waitRefs.map(waitToken)].join(", ");
    // Keep the non-default available form so `task unblock` can restore it exactly.
    return avail !== "AVAILABLE PARALLEL"
      ? `[open-loop] ${taskId(n)} BLOCKED-ON: ${seg} [was ${avail}]: ${text}`
      : `[open-loop] ${taskId(n)} BLOCKED-ON: ${seg}. ${text}`;
  }
  return `[open-loop] ${taskId(n)} ${avail}: ${text}`;
}

/** The next free task number on a loaded board (1 when empty). */
export function nextTaskNumber(board: Board): number {
  return Math.max(0, ...board.tasks.keys()) + 1;
}

/**
 * Effective status once blockers are considered: a BLOCKED task whose blockers are all DONE is
 * claimable — but never one still holding a USER/EXT gate: those are cleared only by the user.
 */
export function isClaimable(t: Task, board: Map<number, Task>): boolean {
  if (t.status === "available") return true;
  if (t.status !== "blocked") return false;
  return t.waitingOn.length === 0 && t.blockedOn.every((n) => isCompleted(board.get(n)));
}

export function isCompleted(t: Task | undefined): boolean {
  return t?.status === "done" || t?.status === "archive";
}

export function unmetBlockers(t: Task, board: Map<number, Task>): number[] {
  return t.blockedOn.filter((n) => !isCompleted(board.get(n)));
}

/**
 * The tasks a DONE just cleared (TASK-221): every BLOCKED task that names the finished task as
 * a blocker, has no other unmet TASK-nn blocker, and holds no USER/EXT gate. Called on the
 * pre-transition board, so `completed` is treated as DONE explicitly. Sorted ascending.
 *
 * Contracts keep their harder gates: a held task (its USER gate is the hold's projection), one
 * with unresolved contract blockers, declared source gates, or contract-level TASK dependencies
 * that are still open is NOT promoted — writing it AVAILABLE would show a line that every
 * claim path still refuses. BACKLOG is a deliberate deprioritization, not a blocker, so it is
 * left alone too.
 */
export function promotableDependents(board: Board, completed: number): Task[] {
  const cleared = (n: number) => n === completed || isCompleted(board.tasks.get(n));
  return [...board.tasks.values()]
    .filter((t) => t.status === "blocked" && t.blockedOn.includes(completed))
    .filter((t) => t.waitingOn.length === 0 && t.blockedOn.every(cleared))
    .filter((t) => {
      const c = contractAt(board, t.n);
      if (!c) return true;
      if (c.executionState === "held") return false;
      if ((c.unresolvedBlockers?.length ?? 0) > 0) return false;
      if ((c.sourceGates?.length ?? 0) > 0) return false;
      // The contract's own dependency refs are claim gates that may not be on the line.
      return [...c.blockedOn, ...c.qualifiedBlockedOn.map((q) => q.taskNumber)].every(cleared);
    })
    .sort((a, b) => a.n - b.n);
}

export interface Board {
  tasks: Map<number, Task>;
  /** True if Cortex capped a search and the per-task fallback still could not prove completeness. */
  truncated: boolean;
  /**
   * Project identity for contract lookups — the composite `project#TASK-nn` key
   * (`currentProject()` when a project context is set, else the profile, the same
   * fallback `launchProjectContext` uses).
   */
  projectId?: string;
  /**
   * Claim-path seam (TASK-130): TaskContract/1 by project + task number; null for
   * legacy lines. Claim decisions go through `contractAt` — never the projected line
   * alone. Omitted when every row is legacy (then `contractAt` answers null).
   */
  contracts?: ContractReader;
}

/** The task's TaskContract/1 through the reader seam; null for legacy lines. */
export function contractAt(board: Board, n: number): BoardTaskContract | null {
  return board.contracts?.taskContract(board.projectId, n) ?? null;
}

/**
 * `limit` does not make this cheaper. Cortex `POST /v1/shards/search` loads the full
 * payload of every candidate (token index, or a tenant scan in 1,000-row pages, up to
 * its scan cap), scores in process, and only then clips to `limit`. A broad term such
 * as `[open-loop] TASK` or `[project/1]` therefore transfers about the whole tenant on
 * every call. Cost is the number of calls and how wide the query is, not the limit.
 *
 * `GET /v1/shards` can filter `since`, but each row is still a full shard body — not a
 * change signal. A dedicated board read (`GET /v1/tasks`, ING-08) or a lightweight-rank
 * search (the Cortex owner is proposing the latter) is the real fix. This client does
 * not change that HTTP contract.
 */
const SEARCH_MAX = 100;
/** Ids per batched search: one block of sequential task ids is one Cortex round trip (TASK-120). */
const SCAN_BLOCK = 24;
/** Each wave plans at least this many blocks, so the scan advances in strides even when no record cross-references another. */
const WAVE_MIN_BLOCKS = 6;
/** Keep covering this many ids past the highest seen one — the gap tolerance the per-id fallback had. */
const PROBE_GAP = 5;
/** Split a capped block into pieces sized under this many records (cap is 100; leave headroom for uneven density). */
const SPLIT_TARGET = 80;
/** Searches in flight at once: enough to keep Cortex busy, few enough that a big scan never queues past the client timeout. */
const MAX_PARALLEL = 8;
/** TASK-RE parses 1..3 digits; the id scan never goes past this. */
const MAX_TASK_N = 999;

/**
 * Current shared TASK records for this project. The board is coordination state, not an agent-turn
 * delivery, so it uses the internal `search` read (no delivery semantics) with the shared grant only:
 * private source copies are never board state. Reads Cortex every time; the briefing is a snapshot.
 *
 * Task ids are sequential from 1 and every id leaves at least one record behind, and a multi-id
 * query is the exact union of its per-id matches (term overlap scores on any shared token), so the
 * capped fallback enumerates the id space in BATCHED id blocks instead of one search per id. That
 * shape is the whole fix for TASK-120: the old one-search-per-id fallback issued 126 serial
 * searches (~31s of Cortex latency on a 120-task board, measured) where blocks need ~10. A block
 * whose results hit the 100-shard cap is split until every record fits — the cap keeps only part
 * of a capped block and current states can be among the dropped — and waves of blocks ride in
 * parallel where they are independent. Completeness rules are unchanged: the two tag searches
 * still prove a small board complete on their own, and the id scan still covers up to the highest
 * seen id plus PROBE_GAP.
 */
export async function loadBoard(rt: Runtime, _sessionId: string): Promise<Board> {
  const shared = rt.agent.as({ ...rt.agent.identity, grants: [grant.profileShared(rt.profileId)] });
  const found = new Map<string, SearchShard>();
  let truncated = false;
  let maxSeen = 0;
  // A tiny semaphore around the searches themselves: waves and split pieces share one budget, so
  // a dense board degrades into more rounds instead of a request pile-up.
  let inFlight = 0;
  const waiting: (() => void)[] = [];
  const acquire = () => new Promise<void>((r) => (inFlight < MAX_PARALLEL ? (inFlight++, r()) : waiting.push(r)));
  const release = () => {
    const r = waiting.shift();
    if (r) r();
    else inFlight--;
  };
  // One build never issues the same query twice. Identical blocks (a split that
  // replans a range, or the tag search colliding with a block) share one request.
  const searches = new Map<string, Promise<SearchResult>>();
  const searchOnce = (q: string): Promise<SearchResult> => {
    const hit = searches.get(q);
    if (hit) return hit;
    const pending = (async () => {
      await acquire();
      try {
        return await shared.search(q, SEARCH_MAX);
      } finally {
        release();
      }
    })();
    searches.set(q, pending);
    return pending;
  };
  const take = async (q: string) => {
    const r = await searchOnce(q);
    for (const s of r.shards) found.set(s.shard_id, s);
    return r.truncated || r.total > r.shards.length;
  };
  /** One batched search over a block of ids; capped blocks are re-scanned in smaller pieces until every record fits. */
  const scan = async (ns: number[]): Promise<void> => {
    if (ns.length === 0) return;
    const r = await searchOnce(ns.map(taskId).join(" "));
    for (const s of r.shards) {
      found.set(s.shard_id, s);
      for (const m of s.content.matchAll(/TASK-(\d{1,3})/g)) maxSeen = Math.max(maxSeen, Number(m[1]));
    }
    if (r.truncated) {
      // The server's own scan cap: every search misses the same tail, so splitting cannot recover it.
      truncated = true;
      return;
    }
    if (r.total > r.shards.length) {
      if (ns.length === 1) {
        truncated = true;
        return;
      }
      // The 100-shard cap dropped part of the block (it keeps the best-scored records — current
      // states can be among the dropped), so re-scan in pieces sized from the observed record
      // count until every record fits.
      const size = Math.max(1, Math.ceil(ns.length / Math.ceil(r.total / SPLIT_TARGET)));
      const pieces: number[][] = [];
      for (let i = 0; i < ns.length; i += size) pieces.push(ns.slice(i, i + size));
      await Promise.all(pieces.map(scan));
    }
  };
  // Wave 1 rides with the bulk searches: the tags are the lexical hit surface for open and done
  // tasks (uncapped → the two searches already hold the whole board), while the id blocks start
  // enumerating in the same round in case history has capped the bulk result. A failed read must
  // reject loadBoard (reads never silently shrink) — but `bulk` settles after the wave and must
  // never reject unobserved when the wave itself rejects first.
  let bulkError: unknown;
  const bulk: Promise<boolean> = (async () => (await take("[open-loop] TASK")) || (await take("[note] TASK DONE")))().catch((e) => {
    bulkError = e;
    return true;
  });
  let lo = 1;
  // The first wave keeps a wide stride so a board is discovered before maxSeen is known.
  // Later waves cover only up to the highest id actually seen: a full extra stride of
  // WAVE_MIN_BLOCKS was six more searches when one block would do, and each of those
  // searches pulls full shard payloads.
  const plan = (minBlocks: number): number[][] => {
    const wave: number[][] = [];
    while (lo <= MAX_TASK_N && (wave.length < minBlocks || lo <= maxSeen + PROBE_GAP)) {
      const hi = Math.min(lo + SCAN_BLOCK - 1, MAX_TASK_N);
      wave.push(Array.from({ length: hi - lo + 1 }, (_, i) => lo + i));
      lo = hi + 1;
    }
    return wave;
  };
  await Promise.all(plan(WAVE_MIN_BLOCKS).map(scan));
  if (bulkError !== undefined) throw bulkError;
  if (await bulk) {
    // History grew past the cap; continue only through the highest seen id + PROBE_GAP.
    while (lo <= maxSeen + PROBE_GAP && lo <= MAX_TASK_N) await Promise.all(plan(1).map(scan));
  }
  const tasks = new Map<number, Task>();
  const seenAt = new Map<number, string>();
  for (const s of found.values()) {
    if (s.status === "superseded" || s.status === "archived") continue;
    if (s.provenance?.extra?.scope_class === "role_private") continue;
    const t = parseTask(s.content, s.shard_id);
    if (!t) continue;
    // Two current records for one task id should not happen; prefer the newer by event time.
    const prov = s.provenance as { checkpoint_at?: string } | undefined;
    const at = prov?.checkpoint_at ?? (typeof s.created_at === "string" ? s.created_at : "");
    if (tasks.has(t.n) && at < (seenAt.get(t.n) ?? "")) continue;
    tasks.set(t.n, t);
    seenAt.set(t.n, at);
  }
  await Promise.all([...tasks.values()].filter((t) => t.content.includes("\n[board-display/1] ")).map(async (t) => {
    const record = await rt.agent.getShard(t.id).catch(() => undefined);
    if (record?.content === t.content) {
      const metadata = await readBoardDisplayMetadata(rt, record);
      if (metadata) Object.assign(t, parseTask(t.content, t.id, undefined, metadata));
    }
  }));
  const contracts = sharedAllocator().contracts({ tenantId: rt.cfg.tenantId, profileId: rt.profileId });
  const projectId = currentProject()?.projectId ?? rt.profileId;
  return contracts.size > 0 ? { tasks, truncated, projectId, contracts: mapContractReader(contracts) } : { tasks, truncated, projectId };
}

/**
 * A repeated board read in a long-running process. `fresh` never returns a snapshot; it
 * joins an in-flight fresh load at the current generation, and otherwise starts its own
 * (a write bumps the generation, so it never joins a pre-write load). `maxAgeMs` lets a display read reuse
 * a snapshot; omit it to keep one until the next write or fresh read. Writes call
 * `invalidateBoardReads` — this cache is never the authority for a claim.
 */
export function loadCachedBoard(rt: Runtime, sessionId: string, fresh = false, maxAgeMs?: number): Promise<Board> {
  return readCachedBoard(boardReadKey(rt), fresh, () => loadBoard(rt, sessionId), maxAgeMs);
}

/**
 * Generic memory writes (share, supersede in core/memory.ts) do not go through the board
 * commands. When any of the given contents parses as a task, drop this identity's cached board.
 */
export function invalidateBoardForTaskContent(rt: Runtime, ...contents: Array<string | undefined>): void {
  if (contents.some((c) => typeof c === "string" && parseTask(c) !== undefined)) invalidateBoardReads(boardReadKey(rt));
}

/** A board supersede drops the cached snapshot for this identity. The write itself re-read first. */
async function supersedeBoard(...args: Parameters<typeof supersede>): Promise<string> {
  const id = await supersede(...args);
  invalidateBoardReads(boardReadKey(args[0]));
  return id;
}

/** Also recognize off-board tombstones (DROPPED/CANCELLED), so private source copies cannot resurrect one. */
function boardRecordNumber(content: string): number | undefined {
  const task = parseTask(content);
  if (task) return task.n;
  const match = TASK_RE.exec(content.trim());
  return match && TOMBSTONE_RE.test(match[2].trim()) ? Number(match[1]) : undefined;
}

/** Task ids carried by board records, including dropped tombstones. */
export function taskIdsIn(rows: Iterable<{ content: string }>): number[] {
  const ids: number[] = [];
  for (const r of rows) {
    const n = boardRecordNumber(r.content);
    if (n !== undefined) ids.push(n);
  }
  return ids;
}

/**
 * True when any board-state record for TASK-nn exists (any status). Board state is shared-only —
 * `loadBoard` never reads role_private — so a non-private record, even a superseded one, means the
 * shared chain owns the task id.
 *
 * The query is `taskId(n)` ("TASK-08") and relies on Cortex tokenising it as one whitespace-
 * delimited token — guaranteed by the board's own content format (the id is always followed by a
 * status word). If the record format ever changes, this probe must change with it.
 */
export async function sharedTaskExists(rt: Runtime, n: number): Promise<boolean> {
  const shared = rt.agent.as({ ...rt.agent.identity, grants: [grant.profileShared(rt.profileId)] });
  const r = await shared.search(taskId(n), SEARCH_MAX);
  return r.shards.some((s) => s.provenance?.extra?.scope_class !== "role_private" && boardRecordNumber(s.content) === n);
}

/**
 * Drop stale private task mirrors from a delivery (pass only private rows). A private TASK-nn
 * record is a source copy of board state; a board transition supersedes the shared record and
 * never the private copy, so the copy freezes at whatever state it was written in and reads as a
 * phantom open task. Once a shared record exists for the same task id — current or history — the
 * private copy is stale and is dropped. A task id with no shared record at all is a not-yet-
 * confirmed draft and is kept. Task ids the caller could not resolve are probed with one bounded
 * search each; a probe failure keeps the row — a search error must never make memory disappear.
 */
export async function dropStaleTaskMirrors<T extends { content: string }>(rt: Runtime, rows: T[], knownSharedTaskIds: Iterable<number>): Promise<T[]> {
  const shared = new Set(knownSharedTaskIds);
  const probed = new Map<number, boolean>();
  const out: T[] = [];
  for (const row of rows) {
    const t = parseTask(row.content);
    if (!t) {
      out.push(row);
      continue;
    }
    if (shared.has(t.n)) continue;
    let stale = probed.get(t.n);
    if (stale === undefined) {
      stale = await sharedTaskExists(rt, t.n).catch(() => false);
      probed.set(t.n, stale);
    }
    if (!stale) out.push(row);
  }
  return out;
}

export class BoardError extends Error {
  readonly reason?: string;

  constructor(message: string, reason?: string) {
    super(message);
    this.name = "BoardError";
    this.reason = reason;
  }
}

function allocatorScope(rt: Runtime, projectId?: string): AllocateScope {
  return {
    tenantId: rt.cfg.tenantId,
    profileId: rt.profileId,
    projectId: projectId && projectId.length > 0 ? projectId : rt.profileId,
    actorId: rt.agent.identity.actorId,
    roleId: rt.agent.identity.roleId,
  };
}

function contractRefusal(board: Board, t: Task): { reason: string; message: string } | undefined {
  const contract = contractAt(board, t.n);
  if (!contract) return undefined;
  if (contract.executionState === "held") {
    return { reason: "EXECUTION_HELD", message: `${taskId(t.n)} is execution-held and cannot be claimed until it is activated` };
  }
  if ((contract.rigorTier as string) === "T2") {
    return { reason: "T2_UNAVAILABLE", message: `${taskId(t.n)} requires T2 Runtime mediation, which is unavailable. Nothing was claimed.` };
  }
  if (!importClaimable(contract, t, board.tasks)) {
    return { reason: "DEPENDENCY_UNRESOLVED", message: `${taskId(t.n)} has an unresolved dependency and cannot be claimed` };
  }
  return undefined;
}

function rememberTransition(rt: Runtime, contract: BoardTaskContract, content: string, shardId: string): void {
  const parsed = parseTask(content, shardId);
  sharedAllocator().remember(allocatorScope(rt, contract.projectId), {
    ...contract,
    recordProvenance: contract.recordProvenance,
    executionState: contract.executionState,
    content,
    shardId,
    status: parsed?.status ?? contract.status,
  });
}

/** Restrictive launch precondition, not claim authority. Snapshot before model/workspace preflight. */
export interface ClaimPreflight {
  task: Pick<Task, "id" | "content">;
  contract: BoardTaskContract | null;
}
export function snapshotClaimPreflight(board: Board, n: number): ClaimPreflight {
  const task = board.tasks.get(n);
  if (!task) throw new BoardError(`${taskId(n)} is not on the board`);
  return { task: { id: task.id, content: task.content }, contract: structuredClone(contractAt(board, n)) };
}

export async function claimTask(rt: Runtime, sessionId: string, n: number, by = rt.runtimeName, preflight?: ClaimPreflight): Promise<{ task: Task; newId: string; content: string }> {
  const board = await loadBoard(rt, sessionId);
  const t = board.tasks.get(n);
  if (!t) throw new BoardError(`${taskId(n)} is not on the board`);
  // The second live read must still describe exactly what the launcher validated. Refuse
  // BEFORE supersede, not by releasing/reclaiming or launching a stale lower-quality route.
  // The existing supersede CAS then binds the claim write to this very record revision.
  if (preflight && (t.id !== preflight.task.id || t.content !== preflight.task.content || !isDeepStrictEqual(contractAt(board, n), preflight.contract))) {
    throw new BoardError(`${taskId(n)} changed after launch preflight; nothing claimed or launched. Refresh and validate the current task before a new launch.`, "PREFLIGHT_CHANGED");
  }
  if (t.status === "claimed") throw new BoardError(`${taskId(n)} is already CLAIMED by ${t.by} (${t.at}); use release first if that worker is gone`);
  if (t.status !== "available" && t.status !== "blocked") throw new BoardError(`${taskId(n)} is ${t.status.toUpperCase()} and cannot be claimed`);
  const held = contractRefusal(board, t);
  if (held) throw new BoardError(held.message, held.reason);
  const unmet = unmetBlockers(t, board.tasks);
  if (unmet.length) throw new BoardError(`${taskId(n)} is BLOCKED-ON ${unmet.map(taskId).join(", ")} (not DONE yet)`, "DEPENDENCY_UNRESOLVED");
  if (t.waitingOn.length) {
    throw new BoardError(
      `${taskId(n)} is waiting on: ${t.waitingOn.map(waitToken).join(", ")} — not claimable until the user clears it (\`continuity task unblock ${n} --user-confirmed\`)`,
      t.waitingOn.includes("user") ? "EXECUTION_HELD" : "DEPENDENCY_UNRESOLVED",
    );
  }
  const content = `${claimedContent(t, by, today())} [transition:${derivedId("transition", t.id)}]`;
  const newId = await supersedeBoard(rt, t.id, sessionId, content, `claimed by ${by} via board`, { boardDisplay: t.displayMetadata });
  const contract = contractAt(board, n);
  if (contract) rememberTransition(rt, contract, content, newId);
  return { task: t, newId, content };
}

/**
 * Add blockers to an available/blocked task (prose deps like "build after TASK-99" become real
 * gates). Strictly makes claiming harder, so it needs no user confirmation — the reverse does.
 */
export async function blockTask(rt: Runtime, sessionId: string, n: number, refs: BlockerRef[], by = rt.runtimeName): Promise<{ task: Task; newId: string; content: string }> {
  if (!refs.length) throw new BoardError("name at least one blocker: TASK-nn, USER or EXT");
  const board = await loadBoard(rt, sessionId);
  const t = board.tasks.get(n);
  if (!t) throw new BoardError(`${taskId(n)} is not on the board`);
  if (t.status === "claimed") throw new BoardError(`${taskId(n)} is CLAIMED by ${t.by} (${t.at}); release it before blocking`);
  if (t.status === "done") throw new BoardError(`${taskId(n)} is DONE (${t.by} ${t.at} ${t.ref})`);
  if (t.status !== "available" && t.status !== "blocked" && t.status !== "backlog") throw new BoardError(`${taskId(n)} is ${t.status.toUpperCase()} — only available, blocked or backlog tasks can be blocked`);
  const merged: BlockerRef[] = [...t.blockedOn, ...t.waitingOn, ...refs];
  const content = `${blockedContent(t, merged)} [transition:${derivedId("transition", t.id)}]`;
  const newId = await supersedeBoard(rt, t.id, sessionId, content, `blocked by ${by} via board`, { boardDisplay: t.displayMetadata });
  return { task: t, newId, content };
}

/**
 * Clear blockers (all of them, or just the named refs). This CHANGES what can be claimed, so it
 * is owner authority: refuse without userConfirmed — a worker must never ungate itself.
 * An execution-held contract's projected USER gate is never cleared here (TASK-130): that
 * gate IS the hold and only the activation card clears it — a clear-all that would touch it
 * is refused too. Named TASK/EXT refs and source gates on any other task behave as always.
 */
export async function unblockTask(
  rt: Runtime,
  sessionId: string,
  n: number,
  refs: BlockerRef[] | undefined,
  userConfirmed: boolean,
  by = rt.runtimeName,
): Promise<{ task: Task; newId: string; content: string }> {
  if (!userConfirmed) throw new BoardError("unblocking changes what can be claimed — only do this after the user explicitly confirmed it, then re-run with --user-confirmed");
  if (refs !== undefined && !refs.length) throw new BoardError("name at least one blocker to clear (or omit the refs to clear them all)");
  const board = await loadBoard(rt, sessionId);
  const t = board.tasks.get(n);
  if (!t) throw new BoardError(`${taskId(n)} is not on the board`);
  if (t.status !== "blocked") throw new BoardError(`${taskId(n)} is ${t.status.toUpperCase()} — only a blocked task has blockers`);
  // The hold projects its own USER gate (renderContract) and that gate is not a source
  // gate — it IS the hold. Only the activation card clears the hold, so unblock refuses
  // the projected gate even with --user-confirmed (a raw "USER" string is caught here too).
  const heldContract = contractAt(board, n);
  const touchesHoldGate = refs === undefined || refs.some((r) => typeof r === "string" && r.toLowerCase() === "user");
  if (heldContract?.executionState === "held" && touchesHoldGate) {
    throw new BoardError(
      `${taskId(n)} is execution-held — its USER gate is the execution hold's projection, and the activation card is the only way to clear the hold (\`continuity task activate ${n} worker|human\` / POST /api/board/activate). Nothing was cleared; after activation, any remaining source gate clears with unblock as always.`,
      "EXECUTION_HELD",
    );
  }
  const have: BlockerRef[] = [...t.blockedOn, ...t.waitingOn];
  if (refs !== undefined) {
    // Every named ref must be there — clearing USER must not silently swallow a ghost TASK-99.
    const token = (r: BlockerRef) => (typeof r === "number" ? taskId(r) : waitToken(r));
    const missing = refs.filter((r) => !have.includes(r));
    if (missing.length) throw new BoardError(`${taskId(n)} is not blocked on ${missing.map(token).join(", ")}`);
  }
  const drop = new Set<BlockerRef>(refs ?? []);
  const remaining: BlockerRef[] = refs === undefined ? [] : have.filter((r) => !drop.has(r));
  const content = `${remaining.length ? blockedContent(t, remaining) : unblockedContent(t)} [transition:${derivedId("transition", t.id)}]`;
  const newId = await supersedeBoard(rt, t.id, sessionId, content, `unblocked by ${by} via board`, { boardDisplay: t.displayMetadata });
  return { task: t, newId, content };
}

/** Explicit owner actions on the board. All state changes supersede the current record. */
export async function moveBoardTask(rt: Runtime, sessionId: string, n: number, action: "available" | "backlog" | "archive" | "delete", userConfirmed: boolean): Promise<{ task: Task; newId: string; content: string }> {
  if (!userConfirmed) throw new BoardError("board actions require explicit user confirmation");
  const board = await loadBoard(rt, sessionId);
  const t = board.tasks.get(n);
  if (!t) throw new BoardError(`${taskId(n)} is not on the board`);
  const allowed = action === "archive" ? t.status === "done"
    : action === "available" ? t.status === "blocked" || t.status === "backlog"
    : action === "backlog" ? t.status === "blocked" || t.status === "available"
    : t.status === "blocked" || t.status === "available" || t.status === "backlog";
  if (!allowed) throw new BoardError(`${taskId(n)} cannot ${action} from ${t.status}`);
  const contract = contractAt(board, n);
  if (action === "available" && contract?.executionState === "held")
    throw new BoardError(`${taskId(n)} is execution-held; activate it before making it available`, "EXECUTION_HELD");
  if (action === "available" && contract?.unresolvedBlockers.length)
    throw new BoardError(`${taskId(n)} has unresolved contract dependencies; resolve them before making it available`, "DEPENDENCY_UNRESOLVED");
  const content = `${action === "available" ? unblockedContent(t) : action === "backlog" ? `[open-loop] ${taskId(n)} BACKLOG [was ${t.origStatus}]${t.wasStatus ? ` [available ${t.wasStatus}]` : ""}:${taskBody(t)}` : action === "archive" ? `[note] ${taskId(n)} ARCHIVE by ${t.by} ${t.at} ref:${t.ref} [was ${t.origStatus}]:${taskBody(t)}` : `[note] ${taskId(n)} DROPPED by ${rt.runtimeName} ${today()} [was ${t.status}]:${taskBody(t)}`} [transition:${derivedId("transition", t.id)}]`;
  const newId = await supersedeBoard(rt, t.id, sessionId, content, `${action} by ${rt.runtimeName} via board`, { boardDisplay: t.displayMetadata });
  if (contract) rememberTransition(rt, action === "available" ? { ...contract, sourceGates: [], blockedOn: [], qualifiedBlockedOn: [] } : contract, content, newId);
  return { task: t, newId, content };
}

/**
 * Pause a claim (TASK-125): the claim is KEPT (same claimer, same claim date) and marked
 * `(PAUSED <date>)`, so the card can show ⏸ and `resumeTask` restores the exact claim.
 * Pausing the spawned worker itself is the caller's step (core/spawn.ts) — this is the
 * board-level truth it reports against.
 */
export async function pauseTask(rt: Runtime, sessionId: string, n: number): Promise<{ task: Task; newId: string; content: string }> {
  const board = await loadBoard(rt, sessionId);
  const t = board.tasks.get(n);
  if (!t) throw new BoardError(`${taskId(n)} is not on the board`);
  if (t.status !== "claimed") throw new BoardError(`${taskId(n)} is not claimed (${t.status})`);
  if (t.pausedAt) throw new BoardError(`${taskId(n)} is already paused (${t.pausedAt})`);
  const content = `${claimedContent(t, t.by ?? rt.runtimeName, t.at ?? today(), today())} [transition:${derivedId("transition", t.id)}]`;
  const newId = await supersedeBoard(rt, t.id, sessionId, content, `claim paused by ${rt.runtimeName} via board`, { boardDisplay: t.displayMetadata });
  return { task: t, newId, content };
}

/** Undo `pauseTask` exactly: the paused marker is dropped, the claim itself is untouched. */
export async function resumeTask(rt: Runtime, sessionId: string, n: number): Promise<{ task: Task; newId: string; content: string }> {
  const board = await loadBoard(rt, sessionId);
  const t = board.tasks.get(n);
  if (!t) throw new BoardError(`${taskId(n)} is not on the board`);
  if (t.status !== "claimed") throw new BoardError(`${taskId(n)} is not claimed (${t.status})`);
  if (!t.pausedAt) throw new BoardError(`${taskId(n)} is not paused`);
  const content = `${claimedContent(t, t.by ?? rt.runtimeName, t.at ?? today())} [transition:${derivedId("transition", t.id)}]`;
  const newId = await supersedeBoard(rt, t.id, sessionId, content, `claim resumed by ${rt.runtimeName} via board`, { boardDisplay: t.displayMetadata });
  return { task: t, newId, content };
}

/** The claim's run state (TASK-124): a worker was spawned for it, or the spawned run failed. */
export type ClaimRunState = "spawned" | "failed";

/**
 * Record the claim's run state at spawn time (TASK-124): `(SPAWNED <date>)` once a worker
 * is up for the claim (🚀 on the Task Board card), `(FAILED <date>)` when the run died
 * before one came up (❌). The spawn flows call this — CLI `task spawn`, deck
 * `POST /api/board/spawn`, extension `/sa` — so no viewer has to infer run state from
 * staleness. Marking again REPLACES the run marker: a respawn supersedes a failed run;
 * the claim itself (claimer, claim date, pause) is untouched. Honest limit: a run that
 * dies AFTER a successful launch is beyond spawn-time evidence — that claim simply goes
 * stale, and the card already says so. The returned task is the claim AFTER the mark (with the new
 * record id) — callers showing state want the marked one, not the pre-mark snapshot.
 */
export async function markRunState(rt: Runtime, sessionId: string, n: number, state: ClaimRunState): Promise<{ task: Task; newId: string; content: string }> {
  const board = await loadBoard(rt, sessionId);
  const t = board.tasks.get(n);
  if (!t) throw new BoardError(`${taskId(n)} is not on the board`);
  if (t.status !== "claimed") throw new BoardError(`${taskId(n)} is not claimed (${t.status}) — run state is a claim marker`);
  const at = today();
  const marked: Task = { ...t, spawnedAt: state === "spawned" ? at : undefined, runFailedAt: state === "failed" ? at : undefined };
  const content = `${claimedContent(marked, t.by ?? rt.runtimeName, t.at ?? today(), t.pausedAt)} [transition:${derivedId("transition", t.id)}]`;
  const newId = await supersedeBoard(rt, t.id, sessionId, content, `claim run ${state} recorded by ${rt.runtimeName} via board`, { boardDisplay: t.displayMetadata });
  return { task: parseTask(content, newId) ?? marked, newId, content };
}

/**
 * Cancel a task (TASK-125): abort it — an off-board CANCELLED tombstone like `dropTask`, but
 * the intent is recorded honestly (aborted, not quietly removed) and the caller stops the
 * spawned worker (core/spawn.ts) on the way out. DONE work is never cancelled.
 */
export async function cancelTask(rt: Runtime, sessionId: string, n: number): Promise<{ task: Task; newId: string; content: string }> {
  const board = await loadBoard(rt, sessionId);
  const t = board.tasks.get(n);
  if (!t) throw new BoardError(`${taskId(n)} is not on the board`);
  if (isCompleted(t)) throw new BoardError(`${taskId(n)} is ${t.status.toUpperCase()} (${t.by} ${t.at} ${t.ref})`);
  const content = `[note] ${taskId(n)} CANCELLED by ${rt.runtimeName} ${today()} [was ${t.status}]:${taskBody(t)} [transition:${derivedId("transition", t.id)}]`;
  const newId = await supersedeBoard(rt, t.id, sessionId, content, `cancelled by ${rt.runtimeName} via board`, { boardDisplay: t.displayMetadata });
  return { task: t, newId, content };
}

export async function releaseTask(rt: Runtime, sessionId: string, n: number): Promise<{ task: Task; newId: string; content: string }> {
  const board = await loadBoard(rt, sessionId);
  const t = board.tasks.get(n);
  if (!t) throw new BoardError(`${taskId(n)} is not on the board`);
  if (t.status !== "claimed") throw new BoardError(`${taskId(n)} is not claimed (${t.status})`);
  // Ending a paused claim here would orphan its SIGSTOP'd worker (frozen forever in the
  // worktree). Every path that ends a paused claim goes through resume or cancel first.
  if (t.pausedAt) throw new BoardError(`${taskId(n)} is paused (${t.pausedAt}) — resume or cancel it first`);
  const content = `${releasedContent(t)} [transition:${derivedId("transition", t.id)}]`;
  const newId = await supersedeBoard(rt, t.id, sessionId, content, `claim released by ${rt.runtimeName} via board`, { boardDisplay: t.displayMetadata });
  return { task: t, newId, content };
}

/** Remove a task from the active board without claiming it was completed. History is retained. */
export async function dropTask(rt: Runtime, sessionId: string, n: number): Promise<{ task: Task; newId: string; content: string }> {
  const board = await loadBoard(rt, sessionId);
  const t = board.tasks.get(n);
  if (!t) throw new BoardError(`${taskId(n)} is not on the board`);
  if (t.pausedAt) throw new BoardError(`${taskId(n)} is paused (${t.pausedAt}) — resume or cancel it first (dropping it would orphan its paused worker)`);
  const content = `[note] ${taskId(n)} DROPPED by ${rt.runtimeName} ${today()} [was ${t.status}]:${taskBody(t)} [transition:${derivedId("transition", t.id)}]`;
  const newId = await supersedeBoard(rt, t.id, sessionId, content, `dropped by ${rt.runtimeName} via board`, { boardDisplay: t.displayMetadata });
  return { task: t, newId, content };
}

/** A dependent the DONE hook moved from BLOCKED/WAITING to its pre-block AVAILABLE form. */
export interface Promotion {
  task: Task;
  newId: string;
  content: string;
}

/** A dependent the hook could not promote — reported, never allowed to fail the DONE itself. */
export interface PromotionFailure {
  task: Task;
  error: string;
}

/**
 * Post-DONE hook (TASK-221): promote every dependent `promotableDependents` cleared. Runs AFTER
 * the DONE record has landed, and is best effort on purpose — a lost race on a dependent's
 * record must never make a recorded DONE look failed. Failures ride back to the caller so the
 * CLI can say them out loud; the dependent stays blocked and the next DONE (or `task unblock`)
 * picks it up.
 */
async function promoteClearedDependents(
  rt: Runtime,
  sessionId: string,
  board: Board,
  completed: number,
  by: string,
): Promise<{ promoted: Promotion[]; failures: PromotionFailure[] }> {
  const promoted: Promotion[] = [];
  const failures: PromotionFailure[] = [];
  for (const t of promotableDependents(board, completed)) {
    const content = `${unblockedContent(t)} [transition:${derivedId("transition", t.id)}]`;
    try {
      const newId = await supersedeBoard(rt, t.id, sessionId, content, `${taskId(completed)} done — blockers cleared by ${by} via board`, { boardDisplay: t.displayMetadata });
      promoted.push({ task: t, newId, content });
    } catch (e) {
      failures.push({ task: t, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return { promoted, failures };
}

export async function finishTask(
  rt: Runtime,
  sessionId: string,
  n: number,
  ref: string,
  by = rt.runtimeName,
): Promise<{ task: Task; newId: string; content: string; promoted: Promotion[]; promotionFailures: PromotionFailure[] }> {
  if (!/^\S+$/.test(ref)) throw new BoardError("ref must be a single token: a PR URL or commit sha");
  const board = await loadBoard(rt, sessionId);
  const t = board.tasks.get(n);
  if (!t) throw new BoardError(`${taskId(n)} is not on the board`);
  if (isCompleted(t)) throw new BoardError(`${taskId(n)} is already ${t.status.toUpperCase()} (${t.ref})`);
  if (t.pausedAt) throw new BoardError(`${taskId(n)} is paused (${t.pausedAt}) — resume or cancel it first`);
  const content = doneContent(t, by, today(), ref);
  const newId = await supersedeBoard(rt, t.id, sessionId, content, `done by ${by} via board (${ref})`, { boardDisplay: t.displayMetadata });
  const { promoted, failures } = await promoteClearedDependents(rt, sessionId, board, n, by);
  return { task: t, newId, content, promoted, promotionFailures: failures };
}

/** Contract hold, T2, source gates, and unfinished dependencies, then the legacy line rule. */
export function taskIsClaimable(board: Board, t: Task): boolean {
  return importClaimable(contractAt(board, t.n), t, board.tasks);
}

/** Tasks a worker may start: available or blocked-with-all-blockers-done, ascending. */
export function claimable(board: Board): Task[] {
  return [...board.tasks.values()].filter((t) => taskIsClaimable(board, t)).sort((a, b) => a.n - b.n);
}

/**
 * The unique key a minted TASK-nn claims on its write (ccm-atomic-batch-v1 keyspace:
 * (tenant, profile, key)). One number, one claim, across processes and runtimes — the max+1
 * planner can race, the key cannot. Numbers outside the v1 width 1..999 are refused
 * (assertTaskNumberWidth) so a 1..3-digit parser can never drop or misread the id.
 */
export function taskUniqueKey(profileId: string, n: number): string {
  assertTaskNumberWidth(n);
  const key = `task:${profileId}:${n}`;
  // ccm-atomic-batch-v1 §2.1 — fail here, naming the cause, instead of at a distant wire check.
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(key)) {
    throw new IngestRefusal("invalid_shape", `the unique key ${JSON.stringify(key)} is outside the ccm-atomic-batch-v1 charset (1..128 of A-Za-z0-9._:-) — profile ${JSON.stringify(profileId)} cannot be named in a claimable key`, { profileId, taskNumber: n });
  }
  return key;
}

/** How often a lost number race is retried with the next number before the add fails. */
const MINT_RETRIES = 5;

/**
 * The mint write lost the race for one task number: another writer already claimed
 * `task:<profileId>:<n>` (a 409 naming the key — the write was atomic, nothing landed).
 * `written` lists the task numbers this attempt already published before losing (empty for
 * single adds — the only shape this retry loop re-mints).
 */
class MintKeyConflict extends Error {
  readonly n: number;
  readonly key: string;
  readonly written: number[];

  constructor(n: number, key: string, written: number[]) {
    super(`unique key ${key} is already claimed by another writer`);
    this.name = "MintKeyConflict";
    this.n = n;
    this.key = key;
    this.written = written;
  }
}

/**
 * Direct board creation through the canonical allocator. Numbers are unique per
 * `(tenant, profile)` inside this process, and TASK-1000 is refused.
 * Imported and inferred provenance stays off `user_said`. Imported tasks are held.
 *
 * TASK-135: every minted number is single-issue beyond this process too — the write for a new
 * TASK-nn declares the unique key `task:<profileId>:<n>`, and a 409 for that key means another
 * process won the max+1 race. Then reload the board and retry with the next number, at most
 * MINT_RETRIES times, then fail with a clear error. Both transports pass the declaration on
 * single writes: the Cortex write model carries `uniqueKeys` (TASK-133), the Gateway's
 * keon.cortex.memory.write.v1 carries `unique_keys` (TASK-134 — added there on single writes
 * and batch items, never on the single dispose path, which is why the claim rides the write).
 */
export async function addBoardTasks(
  rt: Runtime,
  sessionId: string,
  input: {
    operationId: string;
    projectId?: string;
    items: AllocateItemInput[];
    entryRef: string;
    reason: string;
  },
): Promise<{ tasks: AllocatedTask[]; replayed: boolean }> {
  const scope = allocatorScope(rt, input.projectId);
  // A lost number becomes the floor of the next attempt: it is taken (the winner's write
  // committed) even when the winner's shared record is not visible on the reload yet.
  let floor = 0;
  for (let retries = 0; ; retries++) {
    try {
      return await sharedAllocator().allocate(scope, {
        schemaVersion: "CortexTaskAllocateRequest/1",
        operationId: input.operationId,
        targetProjectId: scope.projectId,
        items: input.items,
      }, {
        boardMax: async () => {
          const board = await loadBoard(rt, sessionId);
          return Math.max(floor, Math.max(0, ...board.tasks.keys()));
        },
        knownTasks: async () => {
          const board = await loadBoard(rt, sessionId);
          return board.tasks.keys();
        },
        publish: async (planned) => {
          const written: AllocatedTask[] = [];
          try {
            for (const task of planned) {
              const key = taskUniqueKey(rt.profileId, task.taskNumber);
              let sourceId: string;
              try {
                sourceId = await writePrivate(rt, {
                  content: task.content,
                  sourceKind: sourceKindForProvenance(task.recordProvenance),
                  sessionId,
                  entryRef: input.entryRef,
                  occurredAt: new Date().toISOString(),
                  uniqueKeys: [key],
                });
              } catch (e) {
                if (isUniqueKeyConflict(e, key)) throw new MintKeyConflict(task.taskNumber, key, written.map((t) => t.taskNumber));
                throw e;
              }
              const derivedId = await share(rt, sourceId, task.content, input.reason, sessionId);
              written.push({ ...task, shardId: derivedId });
            }
            return written;
          } finally {
            if (written.length > 0) invalidateBoardReads(boardReadKey(rt));
          }
        },
      });
    } catch (e) {
      if (!(e instanceof MintKeyConflict)) throw e;
      // A lost number is retried only when the failed attempt wrote nothing: re-minting a
      // partly published add would duplicate its written tasks under new numbers.
      if (e.written.length > 0) {
        throw new TaskAllocatorError(
          409,
          "TASK_NUMBER_CONFLICT",
          `${taskId(e.n)} lost the task-number race (${e.key} is claimed by another writer) after ${e.written.map(taskId).join(", ")} were already written. Nothing was rolled back; re-add only the missing task(s).`,
        );
      }
      if (retries >= MINT_RETRIES) {
        throw new TaskAllocatorError(
          409,
          "TASK_NUMBER_CONFLICT",
          `task-number race: ${e.key} was claimed by another writer on ${MINT_RETRIES + 1} attempts (a concurrent add keeps taking the next number). Nothing was written; run the add again.`,
        );
      }
      floor = e.n;
    }
  }
}

/**
 * Clear only the execution hold. Source USER/EXT gates stay. Provenance is not
 * rewritten. Worker activation still has to pass the workspace gate at the caller.
 */
export async function activateTask(
  rt: Runtime,
  sessionId: string,
  n: number,
  opts: { kind: "worker" | "human" },
): Promise<{ task: Task; newId: string; content: string; contract: BoardTaskContract }> {
  if (opts.kind !== "worker" && opts.kind !== "human") {
    throw new BoardError('activation kind must be "worker" or "human"', "INVALID_SHAPE");
  }
  const board = await loadBoard(rt, sessionId);
  const t = board.tasks.get(n);
  if (!t) throw new BoardError(`${taskId(n)} is not on the board`);
  const contract = contractAt(board, n);
  if (!contract) {
    throw new BoardError(
      `${taskId(n)} has no TaskContract/1 execution hold. A USER/EXT gate is cleared with \`task unblock --user-confirmed\`.`,
      "EXECUTION_HELD",
    );
  }
  if (contract.recordProvenance !== "user_said" && contract.recordProvenance !== "imported" && contract.recordProvenance !== "inferred") {
    throw new BoardError(`${taskId(n)} has an unknown provenance and was not activated`, "FORBIDDEN_PROVENANCE");
  }
  if ((contract.rigorTier as string) === "T2") {
    throw new BoardError(`${taskId(n)} requires T2 Runtime mediation, which is unavailable. The hold was not cleared.`, "T2_UNAVAILABLE");
  }
  if (contract.executionState !== "held") {
    throw new BoardError(`${taskId(n)} is already ${contract.executionState}. Activation was not repeated.`, "INVALID_EXECUTION_STATE");
  }
  const next: BoardTaskContract = { ...contract, executionState: "open", recordProvenance: contract.recordProvenance };
  const size = /\(([^)]*)\)/.exec(t.wasStatus ?? t.origStatus)?.[1];
  // Rebuild only the status projection; addedContent's new-task trim must not
  // normalize the existing source body (including whitespace-only bodies).
  const projected = addedContent(n, {
    text: "",
    ...(size ? { size } : {}),
    ...(next.blockedOn.length > 0 ? { blockedOn: [...next.blockedOn] } : {}),
    ...(next.sourceGates.length > 0 ? { waitingOn: [...next.sourceGates] } : {}),
  });
  const content = `${projected.slice(0, -1)}${taskBody(t)} [transition:${derivedId("transition", t.id)}]`;
  const newId = await supersedeBoard(rt, t.id, sessionId, content, `execution hold cleared (${opts.kind}) via board`, { boardDisplay: t.displayMetadata });
  const parsed = parseTask(content, newId);
  const stored: AllocatedTask = {
    ...next,
    content,
    shardId: newId,
    status: parsed?.status ?? "available",
  };
  sharedAllocator().remember(allocatorScope(rt, contract.projectId), stored);
  return { task: t, newId, content, contract: stored };
}

export const STALE_CLAIM_DAYS = 1;

/** Tasks that are not DONE — the board's actionable state. */
export function openTasks(board: Board): Task[] {
  return [...board.tasks.values()].filter((t) => !isCompleted(t));
}

/**
 * True when the board has tasks and every one is DONE: the all-done milestone. A truncated board
 * is never "all done" — Cortex capped the search, so an unseen open task may exist.
 */
export function allTasksDone(board: Board): boolean {
  return board.tasks.size > 0 && !board.truncated && openTasks(board).length === 0;
}

export function formatBoard(board: Board, opts: { ids?: boolean; done?: boolean; project?: string } = {}): string {
  const all = [...board.tasks.values()].sort((a, b) => a.n - b.n);
  // An empty board is usually the wrong board: one profile per project, resolved from the
  // launch directory. Name the profile so "no tasks" can never read like the board failed.
  if (all.length === 0) {
    return opts.project
      ? `no TASK-nn records on the ${opts.project} board — a board is scoped to one project profile (resolved from the launch directory; \`--project <profile>\` overrides)`
      : "no TASK-nn records on this project's board";
  }
  const idOf = (t: Task) => (opts.ids ? `  id=${t.id.slice(0, 10)}` : "");
  const short = (s: string, n = 110) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
  const groups: Record<TaskStatus | "waiting", string[]> = { available: [], blocked: [], waiting: [], claimed: [], done: [], backlog: [], archive: [] };
  for (const t of all) {
    // A task holding a USER/EXT gate, or an execution hold, is its own column however
    // many TASK blockers it also has: "available" must mean claimable right now.
    const contract = contractAt(board, t.n);
    const held = contract?.executionState === "held";
    const waiting = (held && (t.status === "available" || t.status === "blocked")) || (t.status === "blocked" && t.waitingOn.length > 0);
    const eff: TaskStatus | "waiting" = waiting ? "waiting" : t.status === "blocked" && taskIsClaimable(board, t) ? "available" : t.status;
    const note = t.status === "blocked" && eff === "available" ? " (blockers done)" : "";
    const extra = /\(([^)]*)\)/.exec(t.origStatus)?.[1];
    const prov = contract ? ` [${contract.recordProvenance}${held ? " held" : ""}]` : "";
    const line =
      eff === "available"
        ? `- ${taskId(t.n)}${extra ? ` (${extra})` : ""}${note}: ${short(t.text)}${prov}${idOf(t)}`
        : eff === "waiting"
          ? `- ${taskId(t.n)} ← waits on ${held ? "HELD" : ""}${held && (unmetBlockers(t, board.tasks).length || t.waitingOn.length) ? ", " : ""}${[...unmetBlockers(t, board.tasks).map(taskId), ...t.waitingOn.map(waitToken)].join(", ")}: ${short(t.text, 80)}${prov}${idOf(t)}`
          : eff === "blocked"
            ? `- ${taskId(t.n)} ← waits on ${[...unmetBlockers(t, board.tasks).map(taskId), ...t.waitingOn.map(waitToken)].join(", ")}: ${short(t.text, 80)}${idOf(t)}`
          : eff === "claimed"
            ? `- ${taskId(t.n)} by ${t.by} ${t.at}${t.pausedAt ? ` ⏸ PAUSED ${t.pausedAt}` : ""}${t.runFailedAt ? ` ❌ FAILED ${t.runFailedAt}` : t.spawnedAt ? ` 🚀 SPAWNED ${t.spawnedAt}` : ""}${!t.pausedAt && (t.ageDays ?? 0) > STALE_CLAIM_DAYS ? ` (STALE: ${t.ageDays}d, no DONE — release or cancel if the worker is gone)` : ""}: ${short(t.text, 80)}${idOf(t)}`
            : `- ${taskId(t.n)} by ${t.by} ${t.at} ${t.ref}: ${short(t.text, 60)}`;
    groups[eff].push(line);
  }
  const out: string[] = [];
  const open = groups.available.length + groups.claimed.length + groups.waiting.length + groups.blocked.length + groups.backlog.length;
  // An all-done board is a statement, not a bare DONE summary that reads like the board failed.
  if (open === 0) out.push(`no open tasks — all ${groups.done.length + groups.archive.length} DONE${opts.done ? "" : " (hidden — \`/cb done\` (or \`continuity task board --done\`) to list)"}`);
  const sec = (title: string, lines: string[]) => lines.length && out.push(`${title} (${lines.length})`, ...lines);
  sec("AVAILABLE", groups.available);
  sec("CLAIMED", groups.claimed);
  sec("WAITING", groups.waiting);
  sec("BLOCKED", groups.blocked);
  sec("BACKLOG", groups.backlog);
  if (opts.done) sec("ARCHIVE", groups.archive);
  else if (groups.archive.length) out.push(`ARCHIVE (${groups.archive.length}) hidden — \`continuity task board --done\` to list`);
  // DONE history grows forever and drowns the actionable columns: summarize by default, list on request.
  if (opts.done) sec("DONE", groups.done);
  else if (open > 0 && groups.done.length) out.push(`DONE (${groups.done.length}) hidden — \`/cb done\` (or \`continuity task board --done\`) to list`);
  if (board.truncated) out.push("(board may be incomplete: Cortex capped the search; verify a task with `continuity recall TASK-nn` before relying on this)");
  return out.join("\n");
}

const today = () => new Date().toISOString().slice(0, 10);
