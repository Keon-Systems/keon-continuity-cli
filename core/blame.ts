/**
 * Git ↔ memory: where a record was MADE and what it SHAPED.
 *
 * Two views over the same evidence:
 *   - `continuity blame <path>` — which decisions shaped a file: the commits touching it that
 *     carry `Continuity-Applied: <id>` trailers (TASK-13's prepare-commit-msg hook), each record
 *     shown with the runtime that made it and its decision date.
 *   - branch-aware briefing warnings — a [decision] made on a branch that was deleted without
 *     landing, or abandoned (never landed in the default branch, not checked out anywhere), is
 *     flagged in the briefing so an agent verifies before relying on it. Warn-only: memory
 *     grants no authority, and this never blocks anything.
 *
 * Where a record was made: every capture stamps `provenance.extra.branch` (core/memory.ts
 * freezes it into the write so outbox replay stays byte-identical) AND records the branch in
 * the local madeOn ledger (core/state.ts). The ledger is the link that survives branch
 * deletion — commits on a deleted branch are unreachable, and Cortex does not have to hand
 * write provenance back — which is what makes the "deleted branch" case detectable at all.
 * For records without either, the trailer commits' containing branches are the fallback, and
 * the trailers also give the "did it land?" check (a branch that was merged and deleted still
 * has its commits in the default branch's history).
 *
 * Everything here is best-effort LOCAL git. Any failure degrades to "nothing to report",
 * never to an error: the briefing must render even when the checkout is not a git repo.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { statSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import type { ShardDetail } from "../src/cortex.ts";
import { findSecret } from "./guard.ts";
import { APPLIED_TRAILER, safeTrailerId, commitForApplied } from "./githooks.ts";
import { tagOf, type Runtime } from "./runtime.ts";
import { MAX_MADE_ON, type LocalState } from "./state.ts";

const execFileP = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string | undefined> {
  try {
    const { stdout } = await execFileP("git", ["-C", cwd, ...args], { timeout: 10_000, maxBuffer: 4 * 1024 * 1024 });
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

async function gitOk(cwd: string, args: string[]): Promise<boolean> {
  try {
    await execFileP("git", ["-C", cwd, ...args], { timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

// ---------- trailers ----------

/**
 * Record ids from `Continuity-Applied: <id>` trailer lines in a commit message. Ids are
 * token-validated (the trailer contract from core/githooks.ts): anything else is skipped,
 * never echoed. Order preserved, deduped.
 */
export function parseTrailerIds(message: string): string[] {
  const ids: string[] = [];
  for (const raw of message.split("\n")) {
    const line = raw.trim();
    if (!line.startsWith(`${APPLIED_TRAILER}:`)) continue;
    const id = line.slice(APPLIED_TRAILER.length + 1).trim();
    if (id && safeTrailerId(id) && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

export interface TrailerCommit {
  sha: string;
  /** Author date (ISO). */
  date: string;
  subject: string;
  ids: string[];
}

const LOG_FORMAT = ["--format=%H%x1f%cI%x1f%s%x1f%B%x1e"];

function parseLog(raw: string | undefined): TrailerCommit[] {
  const commits: TrailerCommit[] = [];
  for (const record of (raw ?? "").split("\x1e")) {
    const text = record.replace(/^\n+/, "").trim();
    if (!text) continue;
    const [sha = "", date = "", subject = "", body = ""] = text.split("\x1f");
    const ids = parseTrailerIds(body);
    if (sha && ids.length > 0) commits.push({ sha, date, subject, ids });
  }
  return commits;
}

/** Commits touching `path` (this checkout's history) whose message carries `Continuity-Applied` trailers. */
export async function fileTrailerCommits(cwd: string, path: string, follow: boolean): Promise<TrailerCommit[]> {
  const args = ["log", "HEAD", "--fixed-strings", `--grep=${APPLIED_TRAILER}:`, ...(follow ? ["--follow"] : []), ...LOG_FORMAT, "--", path];
  return parseLog(await git(cwd, args));
}

/**
 * Every reachable commit with trailers (all refs). Bounded: the trailer grep filters the walk.
 * Used for the "did it land?" check and for records whose capture stamp is missing.
 */
export async function allTrailerCommits(cwd: string): Promise<TrailerCommit[]> {
  return parseLog(await git(cwd, ["log", "--all", "-n", "2000", "--fixed-strings", `--grep=${APPLIED_TRAILER}:`, ...LOG_FORMAT]));
}

// ---------- branches ----------

const MAX_BRANCH_LEN = 100;

/** A branch name is safe to keep in provenance only as a plain token: no secret shapes, no absurd length. */
export function safeBranchName(name: string): boolean {
  return name.length > 0 && name.length <= MAX_BRANCH_LEN && findSecret(name) === undefined;
}

/** The git branch this capture happens on. Undefined when detached, outside a repo, or unsafe to keep. */
export async function captureBranch(cwd: string = process.cwd()): Promise<string | undefined> {
  const name = await git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (!name || name === "HEAD") return undefined;
  return safeBranchName(name) ? name : undefined;
}

/**
 * Freeze the capture origin into the write ONCE. The outbox replays a frozen write and Cortex
 * ingest retries must be byte-identical (a different provenance on the same content is a 409,
 * not a dedupe), so the stamp is part of the frozen input — never recomputed at replay time.
 */
export async function withCaptureBranch<T extends { branch?: string }>(w: T, cwd?: string): Promise<T> {
  if (w.branch !== undefined) return w;
  const branch = await captureBranch(cwd);
  return branch ? { ...w, branch } : w;
}

/**
 * Record where a record was MADE (the git branch of its capture) in local state. Cortex does not
 * have to hand write provenance back (its shard rows carry their own extras), and commits on a
 * deleted branch are unreachable — so this ledger is the link that survives branch deletion.
 * First capture wins: where something was made never changes. Returns true when state changed.
 */
export function noteMadeOn(state: LocalState, memoryId: string, branch?: string): boolean {
  if (!branch || !memoryId) return false;
  const list = (state.madeOn ??= []);
  if (list.some((m) => m.memoryId === memoryId)) return false;
  list.push({ memoryId, branch, at: new Date().toISOString() });
  while (list.length > MAX_MADE_ON) list.shift();
  return true;
}

/** Local and remote branch names normalized: "refs/remotes/origin/task-9" and "origin/task-9" → "task-9". */
export function normalizeBranch(name: string): string {
  return name.replace(/^refs\/(heads|remotes\/[^/]+)\//, "").replace(/^origin\//, "");
}

export interface GitContext {
  /** Rev for the landed check: "origin/main", "main", … */
  defaultRev: string;
  /** Normalized name of the default branch. */
  defaultBranch: string;
  /** Every local and remote branch (normalized names). */
  branches: Set<string>;
  /** Branches checked out in some worktree (the current one included): work in flight. */
  activeBranches: Set<string>;
  /** Normalized branch name → newest tip date (ISO). */
  tipDates: Map<string, string>;
}

/** Local git facts for the branch checks. Undefined outside a git checkout. */
export async function loadGitContext(cwd: string = process.cwd()): Promise<GitContext | undefined> {
  const originHead = await git(cwd, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
  let defaultRev = originHead;
  if (!defaultRev) {
    for (const b of ["main", "master"]) {
      if (await gitOk(cwd, ["show-ref", "--verify", "--quiet", `refs/heads/${b}`])) {
        defaultRev = `refs/heads/${b}`;
        break;
      }
    }
  }
  if (!defaultRev) {
    const current = await git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
    if (!current) return undefined;
    defaultRev = current; // no default known: judge against the current branch — nothing is "unlanded" against itself
  }
  const defaultBranch = normalizeBranch(defaultRev);
  const branches = new Set<string>();
  const tipDates = new Map<string, string>();
  const refs = await git(cwd, ["for-each-ref", "--format=%(refname:short)%09%(committerdate:iso-strict)", "refs/heads", "refs/remotes"]);
  for (const line of (refs ?? "").split("\n")) {
    const [name, date] = line.split("\t");
    if (!name) continue;
    const norm = normalizeBranch(name);
    branches.add(norm);
    const tip = date ? date.trim() : undefined;
    if (tip && (!tipDates.get(norm) || Date.parse(tip) > Date.parse(tipDates.get(norm)!))) tipDates.set(norm, tip);
  }
  const activeBranches = new Set<string>();
  const wt = await git(cwd, ["worktree", "list", "--porcelain"]);
  for (const m of (wt ?? "").matchAll(/^branch refs\/heads\/(.+)$/gm)) activeBranches.add(normalizeBranch(m[1]!));
  return { defaultRev, defaultBranch, branches, activeBranches, tipDates };
}

async function isAncestor(cwd: string, sha: string, rev: string): Promise<boolean> {
  return gitOk(cwd, ["merge-base", "--is-ancestor", sha, rev]);
}

/** Branches (normalized, default branch excluded) whose history contains `sha`. */
async function containingBranches(cwd: string, sha: string, ctx: GitContext): Promise<string[]> {
  const out = await git(cwd, ["for-each-ref", `--contains=${sha}`, "--format=%(refname:short)", "refs/heads", "refs/remotes"]);
  const names = new Set<string>();
  for (const raw of (out ?? "").split("\n")) {
    const name = normalizeBranch(raw.trim());
    if (name && name !== ctx.defaultBranch) names.add(name);
  }
  return [...names];
}

// ---------- attribution ----------

export type BranchStatus = "landed" | "active" | "abandoned" | "deleted";

export interface Attribution {
  status: BranchStatus;
  /** Surviving branches tied to the record/commit (normalized names, default branch excluded). */
  branches: string[];
  /** The stamped "made on" branch, when it no longer exists. */
  goneBranch?: string;
  /** Newest tip date across the surviving branches (abandoned). */
  lastCommitAt?: string;
}

/**
 * The classification, pure: landed → quiet; work in flight (checked out somewhere) → quiet;
 * surviving but unlanded and unworked branches → abandoned; no trace left on any branch → deleted.
 */
export function classifyAttribution(input: {
  landed: boolean;
  active: string[];
  surviving: string[];
  goneBranch?: string;
  offAllRefs: boolean;
  tipDates?: Map<string, string>;
}): Attribution | undefined {
  if (input.landed) return { status: "landed", branches: [] };
  if (input.active.length > 0) return { status: "active", branches: [...input.active] };
  if (input.surviving.length > 0) {
    let lastCommitAt: string | undefined;
    for (const b of input.surviving) {
      const tip = input.tipDates?.get(b);
      if (tip && (!lastCommitAt || Date.parse(tip) > Date.parse(lastCommitAt))) lastCommitAt = tip;
    }
    return { status: "abandoned", branches: [...input.surviving].sort(), lastCommitAt };
  }
  if (input.goneBranch !== undefined || input.offAllRefs) return { status: "deleted", branches: [], goneBranch: input.goneBranch };
  return undefined; // no evidence either way: say nothing
}

interface Attributable {
  /** Capture stamp: the branch the record was made on. */
  branch?: string;
  /** Trailer commits carrying the record id (reachable history only). */
  commits: TrailerCommit[];
}

async function attribute(cwd: string, ctx: GitContext, rec: Attributable): Promise<Attribution | undefined> {
  const stamped = rec.branch ? normalizeBranch(rec.branch) : undefined;
  const landed =
    (stamped !== undefined && stamped === ctx.defaultBranch) ||
    (await Promise.all(rec.commits.map((c) => isAncestor(cwd, c.sha, ctx.defaultRev)))).some(Boolean);
  const surviving = new Set<string>();
  let offAllRefs = false;
  for (const c of rec.commits) {
    const names = await containingBranches(cwd, c.sha, ctx);
    if (names.length === 0) offAllRefs = true;
    for (const n of names) surviving.add(n);
  }
  let goneBranch: string | undefined;
  if (rec.branch) {
    const name = normalizeBranch(rec.branch);
    if (name !== ctx.defaultBranch && (ctx.branches.has(name) || ctx.branches.has(`origin/${name}`))) surviving.add(name);
    else goneBranch = rec.branch;
  }
  const active = [...surviving].filter((b) => ctx.activeBranches.has(b));
  return classifyAttribution({ landed, active, surviving: [...surviving], goneBranch, offAllRefs, tipDates: ctx.tipDates });
}

// ---------- records ----------

export interface MemoryShard {
  id: string;
  content: string;
  tag: string;
  occurredAt?: string;
  /** provenance.extra.branch: the branch the record was made on (capture stamp). */
  branch?: string;
  /** provenance.extra.captured_by: the runtime that made it. */
  capturedBy?: string;
}

export interface ResolvedRecord {
  id: string;
  content?: string;
  tag?: string;
  runtime?: string;
  decidedAt?: string;
  branch?: string;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v ? v : undefined;
}

/**
 * Which runtime made a record. `captured_by` when the server hands write provenance back;
 * otherwise the session URN Continuity writes (`urn:continuity:<runtime>:<session>:<entry>`,
 * preserved by Cortex on the source shard); as a last resort the actor id (`agent_<runtime>`).
 */
export function runtimeOfProvenance(p: { agent_id?: unknown; source_uri?: unknown; extra?: Record<string, unknown> } | undefined): string | undefined {
  const captured = str(p?.extra?.captured_by);
  if (captured) return captured;
  const urn = str(p?.source_uri);
  const fromUrn = urn ? /^urn:continuity:([^:/\s]+):/.exec(urn) : undefined;
  if (fromUrn) return fromUrn[1];
  const actor = str(p?.agent_id);
  return actor?.startsWith("agent_") ? actor.slice("agent_".length) || undefined : undefined;
}

/**
 * Resolve a record id to its text and provenance. Provenance gaps fall back to the private
 * source shard (local state maps derivedId → sourceId; a derived record is a curation row, and
 * the source is where Continuity wrote the runtime, event time and branch) and to the local
 * madeOn ledger (the branch survives branch deletion there).
 */
export async function resolveRecord(rt: Runtime, id: string): Promise<ResolvedRecord> {
  const out: ResolvedRecord = { id };
  const fillFrom = (d: ShardDetail | undefined) => {
    if (!d) return;
    out.content ??= d.content;
    out.tag ??= tagOf(d.content);
    out.runtime ??= runtimeOfProvenance(d.provenance);
    out.branch ??= str(d.provenance?.extra?.branch);
    out.decidedAt ??= str(d.provenance?.checkpoint_at) ?? undefined;
  };
  const fillFromLedger = (mid: string | undefined) => {
    const entry = mid ? [...(rt.state.madeOn ?? [])].reverse().find((m) => m.memoryId === mid) : undefined;
    out.branch ??= entry?.branch;
  };
  const detail: ShardDetail | undefined = await rt.agent.getShard(id).catch(() => undefined);
  const sourceId = rt.state.shared.find((s) => s.derivedId === id)?.sourceId;
  if (detail) {
    fillFrom(detail);
    fillFromLedger(id);
    if (out.runtime && out.branch && out.decidedAt) return out;
    const src: ShardDetail | undefined = sourceId ? await rt.agent.getShard(sourceId).catch(() => undefined) : undefined;
    fillFrom(src);
    fillFromLedger(sourceId);
    out.decidedAt ??= detail.created_at || undefined;
    return out;
  }
  // Cortex did not answer: local state still knows some records.
  const s = rt.state.shared.find((x) => x.derivedId === id || x.sourceId === id);
  if (s) {
    out.content = s.content;
    out.tag = tagOf(s.content);
    out.decidedAt = s.approvedAt;
    fillFromLedger(id);
    fillFromLedger(s.sourceId);
    return out;
  }
  const p = rt.state.pending.find((x) => x.shardId === id);
  if (p) {
    out.content = p.content;
    out.tag = tagOf(p.content);
    out.decidedAt = p.createdAt;
    fillFromLedger(id);
    return out;
  }
  fillFromLedger(id);
  return out;
}

// ---------- branch-aware warnings (briefing) ----------

export interface BranchWarning {
  id: string;
  content: string;
  tag: string;
  /** Decision date (YYYY-MM-DD) when known. */
  decidedAt?: string;
  runtime?: string;
  status: "deleted" | "abandoned";
  /** Stamp branch that no longer exists (deleted), when known. */
  goneBranch?: string;
  /** Surviving unmerged branches (abandoned). */
  branches: string[];
  lastCommitAt?: string;
}

/** One line for the briefing: why this decision needs verification before it is relied on. */
export function branchWarningSuffix(w: BranchWarning, defaultBranch = "the default branch"): string {
  const where = w.goneBranch ? `branch "${w.goneBranch}"` : w.branches.length > 0 ? `branch ${w.branches.map((b) => `"${b}"`).join(", ")}` : "a branch";
  if (w.status === "deleted") return `⚠ made on ${where} — deleted without landing in ${defaultBranch}`;
  return `⚠ made on ${where} — abandoned: never landed in ${defaultBranch}, not checked out anywhere${w.lastCommitAt ? ` (last commit ${w.lastCommitAt.slice(0, 10)})` : ""}`;
}

export interface BranchCheck {
  /** Concrete name for the wording ("main", "master", …); "the default branch" outside git. */
  defaultBranch: string;
  warnings: BranchWarning[];
}

/**
 * Branch-aware check for [decision] records: warn when a decision was made on a deleted or
 * abandoned branch — its work may never have landed. Warn-only and best-effort: no git, no
 * evidence, or landed work → no warning.
 */
export async function branchWarnings(rt: Runtime, shards: MemoryShard[], opts: { cwd?: string } = {}): Promise<BranchCheck> {
  const decisions = shards.filter((s) => s.tag === "decision");
  if (decisions.length === 0) return { defaultBranch: "the default branch", warnings: [] };
  const cwd = opts.cwd ?? process.cwd();
  const ctx = await loadGitContext(cwd);
  if (!ctx) return { defaultBranch: "the default branch", warnings: [] };
  const trailerMap = new Map<string, TrailerCommit[]>();
  for (const c of await allTrailerCommits(cwd)) for (const id of c.ids) trailerMap.set(id, [...(trailerMap.get(id) ?? []), c]);

  const warnings: BranchWarning[] = [];
  for (const d of decisions) {
    // Fill provenance gaps from the record's private source shard.
    let branch = d.branch;
    let runtime = d.capturedBy;
    if (!branch || !runtime) {
      const resolved = await resolveRecord(rt, d.id);
      branch ??= resolved.branch;
      runtime ??= resolved.runtime;
    }
    const a = await attribute(cwd, ctx, { branch, commits: trailerMap.get(d.id) ?? [] });
    if (a?.status !== "deleted" && a?.status !== "abandoned") continue;
    warnings.push({
      id: d.id,
      content: d.content,
      tag: d.tag,
      decidedAt: d.occurredAt?.slice(0, 10),
      runtime,
      status: a.status,
      goneBranch: a.goneBranch,
      branches: a.branches,
      lastCommitAt: a.lastCommitAt,
    });
  }
  return { defaultBranch: ctx.defaultBranch, warnings };
}

// ---------- blame ----------

export interface BlameRecord {
  id: string;
  content?: string;
  tag?: string;
  /** The runtime that made the record (provenance captured_by). */
  runtime?: string;
  /** When the record was decided (its event time), as far as the records show. */
  decidedAt?: string;
  /** The branch it was made on (capture stamp), when known. */
  madeOnBranch?: string;
  /** Set when the record's own "made on" branch is deleted or abandoned. */
  warning?: string;
}

export interface BlameCommit {
  sha: string;
  date: string;
  subject: string;
  /** Landed in the default branch · on an active branch · abandoned/deleted. */
  status: BranchStatus | "unknown";
  branches: string[];
  records: BlameRecord[];
}

export interface BlameReport {
  path: string;
  defaultBranch: string;
  commits: BlameCommit[];
}

/**
 * `continuity blame <path>`: the decisions that shaped a file, from which runtime and date.
 * The link decision → file is the commit that carried the record's `Continuity-Applied` trailer
 * and touched the file. Commits are this checkout's history (the file as you have it).
 */
export async function blameFile(rt: Runtime, path: string, opts: { cwd?: string } = {}): Promise<BlameReport> {
  const cwd = opts.cwd ?? process.cwd();
  const abs = resolvePath(cwd, path.replace(/^~\//, `${process.env.HOME}/`));
  const follow = (() => {
    try {
      return statSync(abs).isFile();
    } catch {
      return false;
    }
  })();
  const ctx = await loadGitContext(cwd);
  const commits = await fileTrailerCommits(cwd, path, follow);
  const resolved = new Map<string, ResolvedRecord>();
  for (const c of commits) {
    for (const id of c.ids) {
      if (!resolved.has(id)) resolved.set(id, await resolveRecord(rt, id));
    }
  }
  const out: BlameCommit[] = [];
  for (const c of commits) {
    const status = ctx ? ((await isAncestor(cwd, c.sha, ctx.defaultRev)) ? "landed" : (await attribute(cwd, ctx, { commits: [c] }))?.status ?? "unknown") : "unknown";
    const branches = ctx && status !== "landed" ? await containingBranches(cwd, c.sha, ctx) : [];
    const records: BlameRecord[] = [];
    for (const id of c.ids) {
      const r = resolved.get(id)!;
      let warning: string | undefined;
      if (ctx && r.branch) {
        // The record's own "made on" branch: warn when it is gone or abandoned. The landed check
        // sees every commit carrying the record's trailer (TASK-13's lookup), not only this file's,
        // so a decision that landed elsewhere does not cry wolf.
        const recCommits: TrailerCommit[] = [c];
        const evidence = await commitForApplied(cwd, id);
        if (evidence && evidence !== c.sha) recCommits.push({ sha: evidence, date: "", subject: "", ids: [id] });
        const a = await attribute(cwd, ctx, { branch: r.branch, commits: recCommits });
        if (a?.status === "deleted" || a?.status === "abandoned") warning = branchWarningSuffix({ id, content: r.content ?? "", tag: r.tag ?? "?", status: a.status, goneBranch: a.goneBranch, branches: a.branches, lastCommitAt: a.lastCommitAt }, ctx.defaultBranch);
      }
      records.push({
        id,
        content: r.content,
        tag: r.tag,
        runtime: r.runtime,
        decidedAt: r.decidedAt,
        madeOnBranch: r.branch,
        warning,
      });
    }
    out.push({ sha: c.sha, date: c.date, subject: c.subject, status, branches, records });
  }
  return { path, defaultBranch: ctx?.defaultBranch ?? "the default branch", commits: out };
}
