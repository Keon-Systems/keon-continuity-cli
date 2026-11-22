// Adapted from Keon Kontinuity for the standalone CLI.
/**
 * Authorized Project/1 instance registry (ING-02).
 *
 * Naming aliases (`actor_me` → `proj_me`, `proj_north_star`) stay in src/profile-registry.ts.
 * This module is the instance authority: immutable id, canonical slug, lifecycle, workspace
 * binding, explicit satellite grants, and compare-and-swap revision. It does not delete
 * records, does not inherit Life / North Star access, and does not adopt a legacy derived
 * profile unless the owner passes an explicit reviewed provenance.
 *
 * Since TASK-136 each Project/1 is one shared `project/1` record in the reserved registry
 * profile `proj_projects` (core/projects-cortex.ts): the registry travels across machines,
 * the revision is the supersede chain (Cortex's "already superseded" refusal is the
 * compare-and-swap), and uniqueness is the TASK-133 unique-key pair. The JSON file under the
 * tenant state dir is a read-through cache, never the authority — the stores below are the
 * seam: `createCortexProjectStore` (production; core/projects-cortex.ts) and
 * `createFileProjectStore` / `memoryProjectStore` (the offline/test seam this module keeps).
 *
 * The Cortex board is the only task store: task numbers are per project, never per role,
 * and this registry keeps no task rows. Rows written by the retired role-scoped local
 * store are never dropped silently — `readSnapshot` moves them into the read-only
 * `legacyTasks` snapshot and reports the count once — but they are history, not live
 * state. The registry file is local state under the tenant state dir, authorized on
 * every call.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { execFile } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { basename, resolve } from "node:path";
import { promisify } from "node:util";
import { randomBytes } from "node:crypto";
import type { Rigor, WorkspaceBinding } from "../shared/ingest.ts";
import {
  canonicalizeProjectSlug,
  checkProjectInstanceSlug,
  isReservedProjectSlug,
  type ProjectSlugCollisionCode,
} from "../src/profile-registry.ts";
import { renameReplacing } from "../src/atomic-file.ts";
import { stateDir, statePath } from "./state.ts";
import { createRuntime, ProjectRuntimeTable, type CreateRuntimeOptions, type Runtime } from "./runtime.ts";

const execFileP = promisify(execFile);

export const PROJECT_ID_RE = /^prj_[a-z0-9]{16,64}$/;
const ACTOR_RE = /^[A-Za-z][A-Za-z0-9_-]{0,64}$/;
const ROLE_RE = /^[a-z][a-z0-9_]{0,32}$/;
const GRANT_RE = /^(proj|actor)_[a-z0-9_]+$/;
const RIGORS = new Set<Rigor>(["T0", "T1", "T2"]);

/**
 * The reserved registry profile (TASK-136): one shared `project/1` record per Project/1
 * lives here, so projects travel across machines. Reserved beside `proj_me` /
 * `proj_north_star` / `proj_vocabulary` (src/profile-registry.ts) — never a Project/1
 * instance, and never a satellite grant.
 */
export const PROJECT_REGISTRY_PROFILE = "proj_projects";

export type ProjectErrorCode =
  | "invalid_shape"
  | "invalid_slug"
  | "reserved_slug"
  | "instance_collision"
  | "legacy_profile"
  | "revision_conflict"
  | "enumeration_truncated"
  | "not_found"
  | "not_authorized"
  | "confirmation_required"
  | "spawn_refused"
  | "invalid_workspace"
  | "archived"
  | "grant_refused"
  | "busy";

export type ProjectExitCode = 1 | 2 | 3 | 7;

export class ProjectError extends Error {
  readonly code: ProjectErrorCode;
  readonly httpStatus: number;
  readonly exitCode: ProjectExitCode;
  /** `busy` (503): the registry lock could not be taken in time. Nothing was changed — retry later. */
  readonly retryable: boolean;

  constructor(code: ProjectErrorCode, message: string, httpStatus: number, exitCode: ProjectExitCode = 1) {
    super(message);
    this.name = "ProjectError";
    this.code = code;
    this.httpStatus = httpStatus;
    this.exitCode = exitCode;
    this.retryable = code === "busy";
  }
}

export interface ProjectAdoption {
  legacyProfileId: string;
  provenance: string;
  reviewedAt: string;
}

export interface ProjectRecord {
  version: "Project/1";
  projectId: string;
  slug: string;
  title: string;
  ownerRef: string;
  tenantId: string;
  lifecycle: "pending" | "active" | "archived";
  defaultRigor: Rigor;
  workspace: WorkspaceBinding;
  /** Server-validated git root. Never taken from a document or a client `ref`. */
  workspaceRoot?: string;
  workspacePendingReason?: string;
  /** Explicit satellite profile ids. New instances start empty. */
  satelliteGrants: string[];
  /** Additional actors. The owner is authorized via `ownerRef` and is not implied by grants. */
  acl: string[];
  revision: number;
  /** Cortex profile the board lives under. The slug, unless this is a reviewed legacy adoption. */
  boardNamespace: string;
  adoption?: ProjectAdoption;
  createdAt: string;
  updatedAt: string;
  /**
   * Registry bookkeeping (TASK-136): the shard id of this project's current `project/1`
   * record in the registry profile — the head of the supersede chain. Cache/snapshot only;
   * never part of the Project/1 record content. Absent = the row is local-only (published
   * by nobody yet — pre-migration rows stay visible until `project migrate` publishes them).
   */
  recordId?: string;
}

/**
 * A row left behind by the retired role-scoped local task store (pi review 2026-11-06,
 * finding #2). Read-only history: the row is kept verbatim, nothing writes it again, and
 * the Cortex board is the only task store.
 */
export interface LegacyProjectTask {
  tenantId: string;
  projectId: string;
  role: string;
  taskNumber: number;
  title: string;
  revision: number;
  updatedAt: string;
}

export interface RegistrySnapshot {
  projects: ProjectRecord[];
  /** Retired role-scoped task rows, preserved verbatim. Never served, never edited. */
  legacyTasks: LegacyProjectTask[];
}

export interface ProjectCaller {
  tenantId: string;
  actorId: string;
}

export interface ProjectStore {
  read<T>(tenantId: string, fn: (snapshot: RegistrySnapshot) => T | Promise<T>): Promise<T>;
  update<T>(tenantId: string, fn: (snapshot: RegistrySnapshot) => { snapshot: RegistrySnapshot; result: T } | Promise<{ snapshot: RegistrySnapshot; result: T }>): Promise<T>;
}

/** True when a derived profile already has records and there is no Project/1 row for it yet. */
export interface LegacyProfileProbe {
  hasRecords(tenantId: string, profileId: string): Promise<boolean>;
  /**
   * Cheap re-validation run UNDER the registry lock after `hasRecords` answered OUTSIDE
   * it (TASK-131). Never reaches the network. It can only ESCALATE the pre-lock answer
   * to "has records" (fail closed when the picture changed while the lock was queued);
   * a `true` from `hasRecords` is authoritative and sticky.
   *
   * Caveats: a probe WITHOUT `revalidate` gets no under-lock check at all (`false`), and
   * a local-mirror re-check is exactly as fresh as the mirror — records that reached
   * Cortex after the pre-lock probe and before the mirror catches up still slip through.
   * "Re-validated under the lock" never means "as fresh as Cortex".
   */
  revalidate?(tenantId: string, profileId: string): boolean | Promise<boolean>;
  /**
   * Profile ids of legacy derived profiles that have records — the adoptable candidates.
   * Enumeration is local (Cortex cannot enumerate); `hasRecords` stays the admission
   * authority. Optional so minimal probes (tests) only answer `hasRecords`.
   */
  list?(tenantId: string): Promise<string[]>;
}

const emptySnapshot = (): RegistrySnapshot => ({ projects: [], legacyTasks: [] });

export function projectRegistryPath(tenantId: string): string {
  return resolve(stateDir(tenantId), "projects", "registry.json");
}

/**
 * Read the registry file, moving any rows of the retired role-scoped task store into the
 * read-only `legacyTasks` snapshot. Called only from holdAndRead/holdAndUpdate, which
 * hold the registry file lock (and the per-tenant queue) for the whole call — the same
 * lock updates hold across their read-modify-write — so the migration write cannot race
 * or clobber a live write. The move is persisted first and the count is reported once
 * per registry file; if the persist fails the read still serves (rows are never dropped)
 * and the move is retried on a later read.
 *
 * Exported for the TASK-136 read-through cache (core/projects-cortex.ts): the same file
 * is now the cache, and its `legacyTasks` discipline is unchanged.
 */
export function readSnapshot(path: string): RegistrySnapshot {
  if (!existsSync(path)) return emptySnapshot();
  const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<RegistrySnapshot> & { tasks?: LegacyProjectTask[] };
  const projects = Array.isArray(raw.projects) ? raw.projects : [];
  const kept = Array.isArray(raw.legacyTasks) ? raw.legacyTasks : [];
  const retired = Array.isArray(raw.tasks) ? raw.tasks : [];
  if (retired.length === 0) return { projects, legacyTasks: kept };
  const snapshot: RegistrySnapshot = { projects, legacyTasks: [...kept, ...retired] };
  try {
    writeSnapshot(path, snapshot);
  } catch {
    // A read must not fail because the migration could not persist: the rows are still
    // returned in legacyTasks, and a later read retries the move (and the report).
    return snapshot;
  }
  process.stderr.write(
    `project registry: moved ${retired.length} legacy task row(s) of the retired role-scoped task store to legacyTasks (read-only history; the Cortex board is the only task store)\n`,
  );
  return snapshot;
}

export function writeSnapshot(path: string, snapshot: RegistrySnapshot): void {
  mkdirSync(resolve(path, ".."), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(snapshot, null, 2), { mode: 0o600 });
  // Windows may answer EPERM/EACCES/EBUSY while another process has the registry file open.
  renameReplacing(tmp, path);
}

export interface RegistryLockOptions {
  /** How long acquisition waits before failing closed with `busy` (default 5000ms). */
  timeoutMs?: number;
  /**
   * Freshness budget (default 30s). The holder heartbeats the lock file while it works,
   * so "TTL passed" means the owner STOPPED renewing (crashed, wedged, suspended) —
   * staleness is "provably no owner", never just "old while healthy".
   */
  ttlMs?: number;
  /** Acquisition poll interval (default 25ms). */
  pollMs?: number;
}

/**
 * The registry lock contract (TASK-131). `timeoutMs` is the 5s deadline from pi review
 * 2026-11-06 finding #5: after it, acquisition FAILS CLOSED (`busy`, 503, retryable) and
 * the update NEVER proceeds — the old no-op release was a lost compare-and-swap on the
 * Project/1 revision. Cross-platform by construction: no flock, no POSIX-only calls.
 * Owner identity is hostname + pid: the registry dir assumes ONE host — never share it
 * across containers/VMs that can report equal hostnames with overlapping pids.
 */
export const REGISTRY_LOCK_DEFAULTS: Required<RegistryLockOptions> = {
  timeoutMs: 5000,
  ttlMs: 30_000,
  pollMs: 25,
};

export interface FileProjectStoreOptions {
  /** Lock timings. Tests shrink them; production uses REGISTRY_LOCK_DEFAULTS. */
  lock?: RegistryLockOptions;
}

/** What the lock file records about its owner (TASK-131): enough to release safely and to decide stealability. */
interface LockOwner {
  pid: number;
  hostname: string;
  nonce: string;
  createdAt: string;
}

interface LockState {
  raw: string;
  /** Null for a lock we cannot identify (crash between create and write, or a pre-TASK-131 empty lock). */
  owner: LockOwner | null;
  /**
   * Age since the lock file was last renewed (mtime — the holder heartbeats it). NOT
   * `createdAt`: a healthy long-running update must never look stale (big brother
   * review 2026-11-07: a TTL is not mutual exclusion unless the holder renews it).
   */
  ageMs: number;
}

/** Blocking sleep for the synchronous rename/unlink retry path (no async there). */
function syncSleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Windows transiently refuses rename/unlink of files another process has open
 * (EPERM/EBUSY). Retry briefly. The registry is cross-platform machinery (universal
 * travel with continuity): nothing here may lean on flock or POSIX-only semantics.
 */
function retryTransient(fn: () => void): void {
  for (let attempt = 0; ; attempt++) {
    try {
      fn();
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if ((code !== "EPERM" && code !== "EBUSY") || attempt >= 10) throw e;
      syncSleep(25); // 250ms total budget: brief, and never a wedge
    }
  }
}

function parseLockOwner(raw: string): LockOwner | null {
  try {
    const o = JSON.parse(raw) as Partial<LockOwner>;
    if (
      Number.isInteger(o.pid) && (o.pid as number) > 0 &&
      typeof o.hostname === "string" && o.hostname.length > 0 &&
      typeof o.nonce === "string" && o.nonce.length > 0 &&
      typeof o.createdAt === "string" && Number.isFinite(Date.parse(o.createdAt))
    ) {
      return { pid: o.pid as number, hostname: o.hostname, nonce: o.nonce, createdAt: o.createdAt };
    }
  } catch {
    /* an unidentifiable lock is handled by the TTL, never stolen blind */
  }
  return null;
}

function readLockState(lock: string): LockState | undefined {
  let raw: string;
  try {
    raw = readFileSync(lock, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
  const owner = parseLockOwner(raw);
  let ageMs: number;
  try {
    ageMs = Date.now() - statSync(lock).mtimeMs;
  } catch {
    return undefined; // vanished between the read and the stat
  }
  return { raw, owner, ageMs };
}

/** True only when the owner pid is provably dead on THIS host (`process.kill(pid, 0)` → ESRCH). */
function ownerProvenDead(owner: LockOwner): boolean {
  if (owner.hostname.toLowerCase() !== hostname().toLowerCase()) return false; // a pid check cannot reach another host
  if (!Number.isInteger(owner.pid) || owner.pid <= 0) return false;
  try {
    process.kill(owner.pid, 0);
    return false; // alive (EPERM means it exists but is not ours: not dead)
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ESRCH";
  }
}

/**
 * Steal rules (TASK-131): steal ONLY when the owner is provably dead on this host or
 * the renewal TTL passed (the owner stopped heartbeating — crashed, wedged, suspended).
 * Everything else waits or fails closed — a healthy holder's lock is never deleted
 * because a waiter got impatient, because a healthy holder keeps renewing.
 */
function lockIsStealable(state: LockState, ttlMs: number): boolean {
  if (state.ageMs > ttlMs) return true;
  return state.owner !== null && ownerProvenDead(state.owner);
}

/**
 * Steal a lock we proved stealable — but re-check the nonce first (TASK-131): the lock
 * on disk must still be the exact one we examined. If another thief replaced it in the
 * decision window we abandon the steal and re-decide against the new owner instead of
 * deleting someone's live lock.
 */
function stealLock(lock: string, seen: LockState): boolean {
  const again = readLockState(lock);
  if (again === undefined) return true; // vanished: the caller retries create
  const sameLock = seen.owner && again.owner ? seen.owner.nonce === again.owner.nonce : seen.raw === again.raw;
  if (!sameLock) return false;
  retryTransient(() => rmSync(lock, { force: true }));
  return true;
}

/** Release removes the lock ONLY when the nonce is still ours — a foreign lock is left untouched (TASK-131). */
function releaseLock(lock: string, nonce: string): void {
  const current = readLockState(lock);
  if (current === undefined) return;
  if (current.owner?.nonce !== nonce) return;
  retryTransient(() => rmSync(lock, { force: true }));
}

/**
 * File store. An in-process queue plus a fail-closed lock file serialize writers. The
 * lock is held across an async `fn` so a second process waits rather than writing a
 * stale snapshot; when it cannot take the lock before the deadline it throws `busy`
 * and `fn` NEVER runs (TASK-131).
 */
export function createFileProjectStore(opts: FileProjectStoreOptions = {}): ProjectStore {
  const lockOpts = opts.lock ?? {};
  const chains = new Map<string, Promise<unknown>>();
  const queue = <T>(tenantId: string, fn: () => Promise<T>): Promise<T> => {
    const prev = chains.get(tenantId) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    chains.set(tenantId, run.then(() => undefined, () => undefined));
    return run;
  };
  return {
    read(tenantId, fn) {
      return queue(tenantId, () => holdAndRead(tenantId, fn, lockOpts));
    },
    update(tenantId, fn) {
      return queue(tenantId, () => holdAndUpdate(tenantId, fn, lockOpts));
    },
  };
}

async function holdAndRead<T>(tenantId: string, fn: (snapshot: RegistrySnapshot) => T | Promise<T>, lockOpts: RegistryLockOptions): Promise<T> {
  const path = projectRegistryPath(tenantId);
  const release = await acquireLock(path, lockOpts);
  try {
    return await fn(readSnapshot(path));
  } finally {
    release();
  }
}

async function holdAndUpdate<T>(tenantId: string, fn: (snapshot: RegistrySnapshot) => { snapshot: RegistrySnapshot; result: T } | Promise<{ snapshot: RegistrySnapshot; result: T }>, lockOpts: RegistryLockOptions): Promise<T> {
  const path = projectRegistryPath(tenantId);
  // The lock covers exactly the read-modify-write. Slow work that may reach the network
  // (the legacy Cortex probe) runs BEFORE acquireLock in ProjectRegistry.create, and the
  // decision it produced is re-validated under the lock — a slow Cortex must never hold
  // the lock (TASK-131: that is how a lost compare-and-swap on the Project/1 revision happened).
  const release = await acquireLock(path, lockOpts);
  try {
    const snapshot = readSnapshot(path);
    const out = await fn(snapshot);
    writeSnapshot(path, out.snapshot);
    return out.result;
  } finally {
    release();
  }
}

/**
 * Take the registry lock, failing closed (TASK-131). The lock file records
 * {pid, hostname, nonce, createdAt}. When the deadline passes without the lock,
 * this throws a retryable `busy` ProjectError (503) and the caller NEVER proceeds.
 * Exported for the TASK-136 cortex-backed store (core/projects-cortex.ts), whose
 * cache file is guarded by the same lock.
 */
export async function acquireLock(path: string, opts: RegistryLockOptions = {}): Promise<() => void> {
  // Explicit `undefined` must not erase a default (it would make the deadline NaN and
  // the loop would spin forever instead of failing closed).
  const timeoutMs = opts.timeoutMs ?? REGISTRY_LOCK_DEFAULTS.timeoutMs;
  const ttlMs = opts.ttlMs ?? REGISTRY_LOCK_DEFAULTS.ttlMs;
  const pollMs = opts.pollMs ?? REGISTRY_LOCK_DEFAULTS.pollMs;
  const lock = `${path}.lock`;
  const deadline = Date.now() + timeoutMs;
  mkdirSync(resolve(path, ".."), { recursive: true, mode: 0o700 });
  const self: LockOwner = {
    pid: process.pid,
    hostname: hostname(),
    nonce: randomBytes(16).toString("hex"),
    createdAt: new Date().toISOString(),
  };
  for (;;) {
    let fd: number;
    try {
      fd = openSync(lock, "wx", 0o600);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      const seen = readLockState(lock);
      if (seen === undefined) continue; // vanished between EEXIST and the read: try to create again
      if (lockIsStealable(seen, ttlMs) && stealLock(lock, seen)) continue;
      if (Date.now() > deadline) {
        throw new ProjectError(
          "busy",
          `project registry is busy: another writer holds ${basename(lock)} and its owner is neither dead nor stopped renewing for ${ttlMs}ms; nothing was changed — retry later`,
          503,
        );
      }
      await new Promise((r) => setTimeout(r, pollMs));
      continue;
    }
    try {
      writeFileSync(fd, JSON.stringify(self));
    } catch (e) {
      closeSync(fd);
      retryTransient(() => rmSync(lock, { force: true }));
      throw e;
    }
    closeSync(fd);
    // Lease renewal (big brother review 2026-11-07): the TTL must never expire under a
    // healthy holder, so while we work we heartbeat the lock file's freshness. "TTL
    // passed" then provably means the owner stopped renewing (crashed, wedged,
    // suspended) — staleness is 'provably no owner', never just 'old'. The heartbeat
    // touches the file only while the nonce is still ours; if the lock was taken over
    // it stops, and release will not touch the takeover either.
    const heartbeat = setInterval(() => {
      try {
        const current = readLockState(lock);
        if (current === undefined || current.owner?.nonce !== self.nonce) {
          clearInterval(heartbeat);
          return;
        }
        const now = new Date();
        utimesSync(lock, now, now);
      } catch {
        /* transient: the release nonce check and the TTL keep this safe either way */
      }
    }, Math.max(250, Math.floor(ttlMs / 3)));
    heartbeat.unref();
    return () => {
      clearInterval(heartbeat);
      releaseLock(lock, self.nonce);
    };
  }
}

export function memoryProjectStore(): ProjectStore {
  const data = new Map<string, RegistrySnapshot>();
  const chains = new Map<string, Promise<unknown>>();
  const queue = <T>(tenantId: string, fn: () => Promise<T>): Promise<T> => {
    const prev = chains.get(tenantId) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    chains.set(tenantId, run.then(() => undefined, () => undefined));
    return run;
  };
  const load = (tenantId: string): RegistrySnapshot => data.get(tenantId) ?? emptySnapshot();
  return {
    read(tenantId, fn) {
      return queue(tenantId, async () => fn(load(tenantId)));
    },
    update(tenantId, fn) {
      return queue(tenantId, async () => {
        const out = await fn(load(tenantId));
        data.set(tenantId, out.snapshot);
        return out.result;
      });
    },
  };
}

export function mintProjectId(): string {
  return `prj_${randomBytes(16).toString("hex")}`;
}

export function toProjectV1(record: ProjectRecord) {
  return {
    version: "Project/1" as const,
    projectId: record.projectId,
    slug: record.slug,
    title: record.title,
    ownerRef: record.ownerRef,
    lifecycle: record.lifecycle,
    defaultRigor: record.defaultRigor,
    workspace: record.workspace,
    satelliteGrants: [...record.satelliteGrants],
    revision: record.revision,
  };
}

export interface ProjectContext {
  readonly explicit: boolean;
  readonly tenantId: string;
  readonly projectId: string;
  readonly profileId: string;
  readonly role: string;
  readonly title: string;
  readonly revision: number;
  readonly lifecycle: ProjectRecord["lifecycle"];
  readonly workspace: WorkspaceBinding;
  /** Git cwd when the workspace is bound. Absent for repo-less and workspace-pending projects. */
  readonly cwd: string | undefined;
  readonly grants: readonly string[];
  readonly defaultRigor: Rigor | null;
  readonly runtime: Runtime;
  readonly spawnAllowed: boolean;
}

const projectStorage = new AsyncLocalStorage<ProjectContext>();

export function currentProject(): ProjectContext | undefined {
  return projectStorage.getStore();
}

export function runWithProject<T>(project: ProjectContext, fn: () => T): T {
  return projectStorage.run(project, fn);
}

export function spawnAllowed(record: Pick<ProjectRecord, "workspace" | "workspaceRoot" | "lifecycle">): boolean {
  return record.lifecycle !== "archived" && record.workspace.state === "bound" && typeof record.workspaceRoot === "string" && record.workspaceRoot.length > 0;
}

/**
 * Git / worktree / worker cwd for this request. An explicit repo-less or pending project
 * never falls back to the server launch directory.
 */
export function workerCwd(project: ProjectContext, launchCwd: string): string {
  if (!project.explicit) return launchCwd;
  if (project.spawnAllowed && project.cwd) return project.cwd;
  throw new ProjectError(
    "spawn_refused",
    "repo-less or workspace-pending project cannot reach a git spawn path and will not inherit the server launch directory",
    409,
    7,
  );
}

export function launchProjectContext(rt: Runtime, cwd: string, role?: string): ProjectContext {
  const workspace: WorkspaceBinding = { state: "bound", ref: "launch" };
  const context: ProjectContext = {
    explicit: false,
    tenantId: rt.cfg.tenantId,
    projectId: rt.profileId,
    profileId: rt.profileId,
    role: role && role.length > 0 ? role : rt.agent.identity.roleId,
    title: rt.projectLabel,
    revision: 0,
    lifecycle: "active",
    workspace,
    cwd,
    grants: Object.freeze([] as string[]),
    defaultRigor: null,
    runtime: rt,
    spawnAllowed: true,
  };
  return Object.freeze(context);
}

function cloneSnapshot(snapshot: RegistrySnapshot): RegistrySnapshot {
  return {
    projects: snapshot.projects.map((p) => ({ ...p, satelliteGrants: [...p.satelliteGrants], acl: [...p.acl], workspace: { ...p.workspace } })),
    legacyTasks: snapshot.legacyTasks.map((t) => ({ ...t })),
  };
}

/** Exported for the TASK-136 migration listing (core/projects-cortex.ts). */
export function requireActor(caller: ProjectCaller): void {
  if (!caller.tenantId || !ACTOR_RE.test(caller.actorId)) {
    throw new ProjectError("not_authorized", "project caller is not an authorized actor", 403, 7);
  }
}

/** Exported for the TASK-136 migration listing (core/projects-cortex.ts): the same visibility rule as `list`. */
export function visible(record: ProjectRecord, caller: ProjectCaller): boolean {
  return record.tenantId === caller.tenantId && (record.ownerRef === caller.actorId || record.acl.includes(caller.actorId));
}

function requireConfirmed(confirmed: boolean): void {
  if (confirmed !== true) {
    throw new ProjectError(
      "confirmation_required",
      "needs confirmation: project administration refuses this change without explicit confirmation. Nothing was changed.",
      403,
      3,
    );
  }
}

function oneLine(value: string, label: string, max: number): string {
  const text = value.trim();
  if (text.length === 0 || text.length > max || /[\r\n\u0000]/.test(text)) {
    throw new ProjectError("invalid_shape", `${label} must be a single line of 1..${max} characters`, 400, 2);
  }
  return text;
}

function collisionError(code: ProjectSlugCollisionCode, message: string): ProjectError {
  const status = code === "invalid_slug" ? 400 : 409;
  const exit: ProjectExitCode = code === "invalid_slug" ? 2 : 1;
  return new ProjectError(code, message, status, exit);
}

export interface WorkspaceInspection {
  ok: true;
  root: string;
  ref: string;
}

export async function inspectWorkspacePath(input: string): Promise<WorkspaceInspection | { ok: false; reason: string }> {
  if (typeof input !== "string" || input.trim() === "" || input.includes("\0")) {
    return { ok: false, reason: "workspace path is empty" };
  }
  const abs = resolve(input);
  try {
    const st = statSync(abs);
    if (!st.isDirectory()) return { ok: false, reason: "workspace path is not a directory" };
  } catch {
    return { ok: false, reason: "workspace path does not exist" };
  }
  try {
    const { stdout } = await execFileP("git", ["-C", abs, "rev-parse", "--show-toplevel"], { timeout: 3000 });
    const root = stdout.trim();
    if (!root) return { ok: false, reason: "git did not report a work tree" };
    const ref = basename(root).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "repo";
    return { ok: true, root, ref };
  } catch {
    return { ok: false, reason: "workspace path is not a git repository" };
  }
}

export interface CreateProjectInput {
  caller: ProjectCaller;
  title: string;
  slug: string;
  defaultRigor?: Rigor;
  workspace: { state: "none" } | { state: "pending" } | { state: "bound"; path: string };
  confirmed: boolean;
  /** Owner-reviewed adoption of a legacy derived profile. Refused when omitted. */
  adopt?: { provenance: string };
  now?: string;
}

export interface ProjectMutation {
  caller: ProjectCaller;
  projectRef: string;
  expectedRevision: number;
  confirmed: boolean;
  now?: string;
}

export interface ProjectView {
  project: ReturnType<typeof toProjectV1>;
  spawnAllowed: boolean;
  workspaceRoot: string | null;
  workspacePendingReason?: string;
  adopted: boolean;
  adoptionProvenance?: string;
  boardNamespace: string;
}

export function projectView(record: ProjectRecord): ProjectView {
  return {
    project: toProjectV1(record),
    spawnAllowed: spawnAllowed(record),
    workspaceRoot: record.workspaceRoot ?? null,
    ...(record.workspacePendingReason ? { workspacePendingReason: record.workspacePendingReason } : {}),
    adopted: record.adoption !== undefined,
    ...(record.adoption ? { adoptionProvenance: record.adoption.provenance } : {}),
    boardNamespace: record.boardNamespace,
  };
}

const NO_LEGACY: LegacyProfileProbe = { async hasRecords() { return false; } };

export interface ProjectRegistryOptions {
  /**
   * The registry store. Production passes `createCortexProjectStore(...)`
   * (core/projects-cortex.ts — the local file is a read-through cache there); the
   * default file store is the offline/test seam, not the production registry.
   */
  store?: ProjectStore;
  legacy?: LegacyProfileProbe;
  now?: () => string;
}

export class ProjectRegistry {
  readonly store: ProjectStore;
  readonly legacy: LegacyProfileProbe;
  readonly now: () => string;

  constructor(opts: ProjectRegistryOptions = {}) {
    this.store = opts.store ?? createFileProjectStore();
    this.legacy = opts.legacy ?? NO_LEGACY;
    this.now = opts.now ?? (() => new Date().toISOString());
  }

  async list(caller: ProjectCaller): Promise<ProjectRecord[]> {
    requireActor(caller);
    const rows = await this.store.read(caller.tenantId, (snapshot) => snapshot.projects.filter((p) => visible(p, caller)));
    return rows.sort((a, b) => a.slug.localeCompare(b.slug) || a.projectId.localeCompare(b.projectId));
  }

  /**
   * Legacy derived profiles with records that no Project/1 row has adopted yet (TASK-147):
   * exactly the slugs `create` would refuse without an explicit `adopt.provenance`.
   * Reserved aliases are never adoptable and never listed.
   */
  async listAdoptable(caller: ProjectCaller): Promise<string[]> {
    requireActor(caller);
    const candidates = (await this.legacy.list?.(caller.tenantId)) ?? [];
    return this.store.read(caller.tenantId, (snapshot) => {
      const instances = new Set(
        snapshot.projects.filter((p) => p.tenantId === caller.tenantId).map((p) => canonicalizeProjectSlug(p.slug)),
      );
      return [...new Set(candidates.map((id) => canonicalizeProjectSlug(id)))]
        .filter((id) => id !== "" && !isReservedProjectSlug(id) && !instances.has(id))
        .sort();
    });
  }

  async open(caller: ProjectCaller, ref: string): Promise<ProjectRecord> {
    requireActor(caller);
    return this.store.read(caller.tenantId, (snapshot) => this.findAuthorized(snapshot, caller, ref));
  }

  async create(input: CreateProjectInput): Promise<{ record: ProjectRecord; bindingOk: boolean; bindingReason?: string }> {
    requireActor(input.caller);
    requireConfirmed(input.confirmed);
    const title = oneLine(input.title, "title", 200);
    const rigor = input.defaultRigor ?? "T0";
    if (!RIGORS.has(rigor)) throw new ProjectError("invalid_shape", 'defaultRigor must be "T0", "T1", or "T2"', 400, 2);
    const stamp = input.now ?? this.now();
    const instancesOf = (snapshot: RegistrySnapshot) =>
      snapshot.projects.filter((p) => p.tenantId === input.caller.tenantId).map((p) => ({ projectId: p.projectId, slug: p.slug }));
    // TASK-131: the legacy probe may call Cortex and must NEVER run under the registry
    // lock — a slow Cortex holding the lock past the deadline used to become a lost
    // compare-and-swap on the Project/1 revision. Admission is checked before probing
    // (a colliding slug never reaches Cortex) and re-checked under the lock below.
    const preAdmission = await this.store.read(input.caller.tenantId, (snapshot) =>
      checkProjectInstanceSlug(input.slug, { instances: instancesOf(snapshot) }),
    );
    if (!preAdmission.ok) throw collisionError(preAdmission.code, preAdmission.message);
    const probedLegacy = await this.legacy.hasRecords(input.caller.tenantId, preAdmission.slug);
    return this.store.update(input.caller.tenantId, async (snapshot) => {
      const next = cloneSnapshot(snapshot);
      const admission = checkProjectInstanceSlug(input.slug, {
        instances: instancesOf(next),
      });
      if (!admission.ok) throw collisionError(admission.code, admission.message);
      // Re-validate the probe's answer under the lock: the cheap re-check never reaches
      // the network and can only ESCALATE to "has records" (fail closed when the picture
      // changed while we queued); a pre-lock `true` is authoritative and sticky.
      const revalidated = (await this.legacy.revalidate?.(input.caller.tenantId, admission.slug)) ?? false;
      const legacy = probedLegacy || revalidated;
      if (legacy && !input.adopt) {
        throw collisionError(
          "legacy_profile",
          `project slug ${admission.slug} already has legacy records and is not an empty project; refusing implicit adoption`,
        );
      }
      let adoption: ProjectAdoption | undefined;
      if (input.adopt) {
        if (!legacy) {
          throw new ProjectError("invalid_shape", `project slug ${admission.slug} has no legacy profile to adopt`, 400, 2);
        }
        const provenance = oneLine(input.adopt.provenance, "provenance", 500);
        adoption = { legacyProfileId: admission.slug, provenance, reviewedAt: stamp };
      }
      let workspace: WorkspaceBinding = input.workspace.state === "none" ? { state: "none" } : { state: "pending" };
      let workspaceRoot: string | undefined;
      let workspacePendingReason: string | undefined;
      let bindingOk = input.workspace.state !== "bound";
      let bindingReason: string | undefined;
      if (input.workspace.state === "bound") {
        const inspected = await inspectWorkspacePath(input.workspace.path);
        if (inspected.ok) {
          workspace = { state: "bound", ref: inspected.ref };
          workspaceRoot = inspected.root;
          bindingOk = true;
        } else {
          workspace = { state: "pending" };
          workspacePendingReason = inspected.reason;
          bindingOk = false;
          bindingReason = inspected.reason;
        }
      }
      const record: ProjectRecord = {
        version: "Project/1",
        projectId: mintProjectId(),
        slug: admission.slug,
        title,
        ownerRef: input.caller.actorId,
        tenantId: input.caller.tenantId,
        lifecycle: "active",
        defaultRigor: rigor,
        workspace,
        ...(workspaceRoot ? { workspaceRoot } : {}),
        ...(workspacePendingReason ? { workspacePendingReason } : {}),
        satelliteGrants: [],
        acl: [],
        revision: 1,
        boardNamespace: admission.slug,
        ...(adoption ? { adoption } : {}),
        createdAt: stamp,
        updatedAt: stamp,
      };
      next.projects.push(record);
      return { snapshot: next, result: { record, bindingOk, ...(bindingReason ? { bindingReason } : {}) } };
    });
  }

  async bindWorkspace(input: ProjectMutation & { path: string }): Promise<{ record: ProjectRecord; bindingOk: boolean; bindingReason?: string }> {
    return this.revise(input, async (record) => {
      const inspected = await inspectWorkspacePath(input.path);
      if (!inspected.ok) {
        record.workspace = { state: "pending" };
        delete record.workspaceRoot;
        record.workspacePendingReason = inspected.reason;
        return { bindingOk: false, bindingReason: inspected.reason };
      }
      record.workspace = { state: "bound", ref: inspected.ref };
      record.workspaceRoot = inspected.root;
      delete record.workspacePendingReason;
      return { bindingOk: true };
    });
  }

  async setGrants(input: ProjectMutation & { satelliteGrants: string[] }): Promise<ProjectRecord> {
    const { record } = await this.revise(input, (record) => {
      if (!Array.isArray(input.satelliteGrants)) throw new ProjectError("grant_refused", "satelliteGrants must be an array", 400, 2);
      const grants: string[] = [];
      for (const grant of input.satelliteGrants) {
        if (typeof grant !== "string" || !GRANT_RE.test(grant)) {
          throw new ProjectError("grant_refused", "satelliteGrants must be explicit proj_ or actor_ ids", 400, 2);
        }
        if (grant.toLowerCase() === PROJECT_REGISTRY_PROFILE) {
          throw new ProjectError("grant_refused", `${PROJECT_REGISTRY_PROFILE} is the reserved registry profile and is never a satellite grant`, 400, 2);
        }
        if (!grants.includes(grant)) grants.push(grant);
      }
      record.satelliteGrants = grants;
      return {};
    });
    return record;
  }

  async setRigor(input: ProjectMutation & { defaultRigor: Rigor }): Promise<ProjectRecord> {
    if (!RIGORS.has(input.defaultRigor)) throw new ProjectError("invalid_shape", 'defaultRigor must be "T0", "T1", or "T2"', 400, 2);
    const { record } = await this.revise(input, (record) => {
      record.defaultRigor = input.defaultRigor;
      return {};
    });
    return record;
  }

  async archive(input: ProjectMutation): Promise<ProjectRecord> {
    const { record } = await this.revise(input, (record) => {
      record.lifecycle = "archived";
      return {};
    });
    return record;
  }

  private async revise<T extends { bindingOk?: boolean; bindingReason?: string }>(
    input: ProjectMutation,
    mutate: (record: ProjectRecord) => T | Promise<T>,
  ): Promise<{ record: ProjectRecord } & T> {
    requireActor(input.caller);
    requireConfirmed(input.confirmed);
    if (!Number.isInteger(input.expectedRevision) || input.expectedRevision < 0) {
      throw new ProjectError("invalid_shape", "expectedRevision must be a non-negative integer", 400, 2);
    }
    const stamp = input.now ?? this.now();
    return this.store.update(input.caller.tenantId, async (snapshot) => {
      const next = cloneSnapshot(snapshot);
      const record = this.findAuthorized(next, input.caller, input.projectRef);
      assertRevision(record, input.expectedRevision);
      if (record.lifecycle === "archived") {
        throw new ProjectError("archived", "archived projects do not accept writes", 409, 1);
      }
      const extra = await mutate(record);
      record.revision += 1;
      record.updatedAt = stamp;
      return { snapshot: next, result: { record, ...extra } };
    });
  }

  private findAuthorized(snapshot: RegistrySnapshot, caller: ProjectCaller, ref: string): ProjectRecord {
    const record = findRecord(snapshot, caller.tenantId, ref);
    if (!record) throw new ProjectError("not_found", "project not found", 404, 2);
    if (!visible(record, caller)) throw new ProjectError("not_authorized", "not authorized for this project", 403, 7);
    return record;
  }
}

function assertRevision(record: ProjectRecord, expected: number): void {
  if (record.revision !== expected) {
    throw new ProjectError(
      "revision_conflict",
      `expectedRevision ${expected} does not match project revision ${record.revision}`,
      409,
      1,
    );
  }
}

function findRecord(snapshot: RegistrySnapshot, tenantId: string, ref: string): ProjectRecord | undefined {
  const inTenant = snapshot.projects.filter((p) => p.tenantId === tenantId);
  if (PROJECT_ID_RE.test(ref)) return inTenant.find((p) => p.projectId === ref);
  const slug = canonicalizeProjectSlug(ref);
  return inTenant.find((p) => p.slug === slug || p.projectId === ref);
}

export function normalizeRole(role: string): string {
  const text = role.trim();
  if (!ROLE_RE.test(text)) throw new ProjectError("invalid_shape", "role must be a short lowercase token", 400, 2);
  return text;
}

export function openProjectRegistry(opts: ProjectRegistryOptions = {}): ProjectRegistry {
  return new ProjectRegistry(opts);
}

/** Local mirror of a derived profile: pending or shared rows mean the slug is not empty. */
function localProfileHasRecords(tenantId: string, profileId: string): boolean {
  const file = statePath(tenantId, profileId);
  if (!existsSync(file)) return false;
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as { pending?: unknown[]; shared?: unknown[] };
    return (Array.isArray(raw.pending) ? raw.pending.length : 0) + (Array.isArray(raw.shared) ? raw.shared.length : 0) > 0;
  } catch {
    return true;
  }
}

/**
 * Local derived-profile state files that carry records (TASK-147). One `<profileId>.json`
 * per profile in the tenant state dir; reserved aliases and record-less files are not
 * adoption candidates and are left out here. The registry applies the remaining filters
 * (reserved slugs, already-adopted instances) in `listAdoptable`.
 *
 * Fails loudly: an unreadable state dir is an error the picker must surface, never a
 * silent empty listing (that would recreate the blind spot this listing exists to close).
 * Non-canonical file names are skipped — the listing must never name a slug the
 * admission authority would not recognize.
 */
export function localLegacyProfiles(tenantId: string): string[] {
  let entries: string[];
  try {
    const dir = stateDir(tenantId);
    if (!existsSync(dir)) return [];
    entries = readdirSync(dir);
  } catch {
    throw new ProjectError(
      "legacy_profile",
      "could not enumerate legacy profile state; the adoptable listing is unavailable",
      500,
      1,
    );
  }
  const out: string[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const profileId = entry.slice(0, -".json".length);
    if (!profileId.startsWith("proj_") || canonicalizeProjectSlug(profileId) !== profileId) continue;
    if (localProfileHasRecords(tenantId, profileId)) out.push(profileId);
  }
  return out.sort();
}

export function localLegacyProbe(): LegacyProfileProbe {
  return {
    async hasRecords(tenantId, profileId) {
      return localProfileHasRecords(tenantId, profileId);
    },
    async list(tenantId) {
      return localLegacyProfiles(tenantId);
    },
  };
}

export interface BuildProjectContextOptions {
  registry: ProjectRegistry;
  runtimes: ProjectRuntimeTable;
  launch: Runtime;
  launchCwd: string;
  projectRef?: string;
  role?: string;
  createRuntime?: (opts: CreateRuntimeOptions) => Promise<Runtime>;
}

function runtimeNameFor(launch: Runtime, role: string): string {
  if (role === launch.agent.identity.roleId) return launch.runtimeName;
  return role.startsWith("role_") ? role.slice("role_".length) : role;
}

/**
 * Resolve one immutable project context. `launch` is never assigned and never returned
 * for an explicit project, so a second call for another project cannot retarget it.
 */
export async function buildProjectContext(opts: BuildProjectContextOptions): Promise<ProjectContext> {
  const role = opts.role ? normalizeRole(opts.role) : opts.launch.agent.identity.roleId;
  if (!opts.projectRef) return launchProjectContext(opts.launch, opts.launchCwd, role);
  const caller = { tenantId: opts.launch.cfg.tenantId, actorId: opts.launch.cfg.ownerActor };
  const record = await opts.registry.open(caller, opts.projectRef);
  const create = opts.createRuntime ?? createRuntime;
  const cwdForRuntime = record.workspaceRoot ?? opts.launchCwd;
  const runtime = await opts.runtimes.resolve(
    { tenantId: record.tenantId, projectRef: record.projectId, role },
    () => create({
      cwd: cwdForRuntime,
      runtimeName: runtimeNameFor(opts.launch, role),
      profileId: record.boardNamespace,
    }),
  );
  const allowed = spawnAllowed(record);
  return Object.freeze({
    explicit: true,
    tenantId: record.tenantId,
    projectId: record.projectId,
    profileId: record.boardNamespace,
    role,
    title: record.title,
    revision: record.revision,
    lifecycle: record.lifecycle,
    workspace: record.workspace,
    cwd: allowed ? record.workspaceRoot : undefined,
    grants: Object.freeze([...record.satelliteGrants]),
    defaultRigor: record.defaultRigor,
    runtime,
    spawnAllowed: allowed,
  });
}

/** The browser may name a project. It may not name an actor or a tenant. */
export function projectSelectorFrom(header: string | undefined, query: string | null, routeRef: string | undefined): string | undefined {
  const named = [header, query ?? undefined, routeRef].filter((v): v is string => typeof v === "string" && v.trim() !== "");
  if (named.length === 0) return undefined;
  const first = named[0]!;
  for (const other of named.slice(1)) {
    if (other === first) continue;
    if (canonicalizeProjectSlug(other) === canonicalizeProjectSlug(first) && canonicalizeProjectSlug(first).startsWith("proj_")) continue;
    throw new ProjectError("invalid_shape", "project header, query, and route disagree", 400, 2);
  }
  return first;
}
