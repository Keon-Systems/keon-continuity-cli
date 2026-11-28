/**
 * Git evidence for applied memory. Two halves of one loop:
 *
 *   1. `feedback applied` records what was applied this session (locally, in state.applied).
 *      A prepare-commit-msg hook (installed by `kontinuity git install-hooks`) appends
 *      `Continuity-Applied: <id>` trailers for exactly those records, so the commit itself
 *      carries the evidence of what memory shaped it.
 *   2. `feedback outcome … success|failure` without --evidence finds that commit and uses its
 *      SHA as the evidence ref automatically.
 *
 * Rules enforced here:
 *   - Trailers carry RECORD IDS ONLY — never content, never target refs. A commit message is
 *     published. Every id is validated as a safe token and secret-scanned before it is written;
 *     anything else is SKIPPED and counted (the value is never echoed). A commit is never
 *     blocked by this feature.
 *   - The hook work is local: it reads local state and a message file. No Cortex call, no
 *     identity, no secret. `prepare-commit-msg` exits 0 even when continuity is unconfigured.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { loadConfig } from "../src/config.ts";
import { findSecret } from "./guard.ts";
import { resolveProfile, type Runtime } from "./runtime.ts";
import { loadState, MAX_APPLIED, type LocalState } from "./state.ts";

const execFileP = promisify(execFile);

export const APPLIED_TRAILER = "Continuity-Applied";
export const HOOK_MARKER = "# continuity-git-hook v1";
const PRE_CONTINUITY = "prepare-commit-msg.pre-continuity";

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileP("git", ["-C", cwd, ...args], { timeout: 10_000, maxBuffer: 4 * 1024 * 1024 });
  return stdout.trim();
}

/** A trailer value must be a plain token: no whitespace, no control characters, no secret shapes. */
export function safeTrailerId(id: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(id) && findSecret(id) === undefined;
}

/**
 * Record an application locally so the commit can carry it as a `Continuity-Applied` trailer.
 * Attribution is stamped here; the ledger is bounded and deduped per (record, session).
 */
export function recordApplied(rt: Runtime, memoryId: string, targetRef: string, sessionId: string, worktree?: string): void {
  const list = (rt.state.applied ??= []);
  if (list.some((e) => e.memoryId === memoryId && e.sessionId === sessionId)) return;
  list.push({ memoryId, sessionId, runtime: rt.runtimeName, targetRef, at: new Date().toISOString(), ...(worktree ? { worktree } : {}) });
  while (list.length > MAX_APPLIED) list.shift();
  rt.persist();
}

/**
 * Which record ids the hook should attach. With an explicit session (CONTINUITY_SESSION or
 * --session) that session is authoritative. Without one, the fallback is "reported applied today
 * in this worktree" — the CLI's default session id is date-scoped, and worktrees are what keeps
 * parallel task workers from attaching each other's records. Ids are unique, oldest first.
 */
export function appliedIdsForCommit(state: LocalState, opts: { sessionId?: string; worktree?: string; now?: Date }): string[] {
  const today = (opts.now ?? new Date()).toISOString().slice(0, 10);
  const ids: string[] = [];
  for (const e of state.applied ?? []) {
    const match = opts.sessionId ? e.sessionId === opts.sessionId : Boolean(opts.worktree) && e.worktree === opts.worktree && e.at.slice(0, 10) === today;
    if (match && !ids.includes(e.memoryId)) ids.push(e.memoryId);
  }
  return ids;
}

/**
 * Append `Continuity-Applied: <id>` trailers to a commit message. Ids already in the message are
 * not repeated; ids that are not safe tokens are skipped and counted, never written and never
 * echoed. The trailers land after the last content line (before any editor comment lines),
 * joining an existing `Continuity-Applied` paragraph or starting a fresh trailer block after a
 * blank line — so prose that merely looks like `Token: value` is never treated as trailers.
 */
export function appendAppliedTrailers(message: string, ids: string[]): { text: string; added: string[]; skipped: number } {
  const present = new Set(
    message
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.startsWith(`${APPLIED_TRAILER}:`))
      .map((l) => l.slice(APPLIED_TRAILER.length + 1).trim()),
  );
  const added: string[] = [];
  let skipped = 0;
  for (const id of ids) {
    if (present.has(id)) continue;
    if (!safeTrailerId(id)) {
      skipped += 1;
      continue;
    }
    added.push(id);
    present.add(id);
  }
  if (added.length === 0) return { text: message, added, skipped };

  const lines = message.split("\n");
  let insertAt = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    const t = lines[i].trim();
    if (t === "" || t.startsWith("#")) continue;
    insertAt = i + 1;
    break;
  }
  if (insertAt < 0) return { text: message, added: [], skipped }; // no message content to annotate

  let p = insertAt - 1;
  while (p - 1 >= 0 && lines[p - 1].trim() !== "" && !lines[p - 1].trim().startsWith("#")) p--;
  const paragraph = lines.slice(p, insertAt);
  const joinsOwnBlock = paragraph.length > 0 && paragraph.every((l) => l.trim().startsWith(`${APPLIED_TRAILER}:`));
  const block = added.map((id) => `${APPLIED_TRAILER}: ${id}`);
  lines.splice(insertAt, 0, ...(joinsOwnBlock ? block : ["", ...block]));
  return { text: lines.join("\n"), added, skipped };
}

/** The newest commit whose message carries `Continuity-Applied: <id>` — the evidence for that application. */
export async function commitForApplied(cwd: string, memoryId: string): Promise<string | undefined> {
  if (!safeTrailerId(memoryId)) return undefined;
  let out: string;
  try {
    out = await git(cwd, ["log", "--fixed-strings", `--grep=${APPLIED_TRAILER}: ${memoryId}`, "--format=%H", "-n", "20"]);
  } catch {
    return undefined;
  }
  for (const sha of out.split("\n").map((s) => s.trim()).filter(Boolean)) {
    const body = await git(cwd, ["log", "-1", "--format=%B", sha]);
    if (body.split("\n").some((l) => l.trim() === `${APPLIED_TRAILER}: ${memoryId}`)) return sha;
  }
  return undefined;
}

export interface PrepareCommitMsgResult {
  added: string[];
  skipped: number;
}

/**
 * The hook's work: append trailers for records reported applied this session to the commit
 * message file. Local only — reads local state, never calls Cortex, never needs an identity.
 * `source` is git's commit source (message | template | commit | merge | squash | …); merges and
 * squashes are left alone because no single application shaped them.
 */
export async function prepareCommitMsg(opts: { cwd: string; msgFile: string; source?: string; sessionId?: string }): Promise<PrepareCommitMsgResult> {
  if (!opts.msgFile) throw new Error("usage: kontinuity git prepare-commit-msg <msgfile> [source]");
  if (opts.source === "merge" || opts.source === "squash") return { added: [], skipped: 0 };
  const message = readFileSync(opts.msgFile, "utf8");
  const cfg = loadConfig();
  const { profileId } = await resolveProfile(opts.cwd);
  const state = loadState(cfg.tenantId, profileId);
  let worktree: string | undefined;
  try {
    worktree = await git(opts.cwd, ["rev-parse", "--show-toplevel"]);
  } catch {
    return { added: [], skipped: 0 }; // not a git checkout: nothing to attach
  }
  const r = appendAppliedTrailers(message, appliedIdsForCommit(state, { sessionId: opts.sessionId, worktree }));
  if (r.text !== message) writeFileSync(opts.msgFile, r.text);
  return { added: r.added, skipped: r.skipped };
}

export interface HookInstallResult {
  path: string;
  action: string;
  chained?: string;
  cliPath: string;
}

// git reports symlink-resolved paths (macOS: /var -> /private/var), so compare in that form
const real = (p: string): string => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};

const isFile = (p: string): boolean => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};

/**
 * A hook must outlive the checkout that installed it. `cliPath` normally points into a checkout of
 * this project; when that checkout is a linked worktree (a task worktree), its absolute path dies
 * with the worktree and the hook would be left calling a missing file. Re-root the path onto the
 * base checkout — the one owning `git rev-parse --git-common-dir` — keeping the location relative
 * to the worktree root, so hooks installed from a task worktree survive its removal. Paths outside
 * any git checkout (a globally installed CLI) are already stable and are returned unchanged, as is
 * anything we cannot re-root confidently.
 */
export async function stableCliPath(cliPath: string): Promise<string> {
  const dir = dirname(cliPath);
  let worktreeRoot: string;
  let commonDir: string;
  try {
    worktreeRoot = resolve(dir, await git(dir, ["rev-parse", "--show-toplevel"]));
    commonDir = resolve(dir, await git(dir, ["rev-parse", "--git-common-dir"]));
  } catch {
    return cliPath; // not inside a git checkout: already a stable install location
  }
  const realCli = real(cliPath);
  worktreeRoot = real(worktreeRoot);
  commonDir = real(commonDir);
  const rel = relative(worktreeRoot, realCli);
  if (!rel || rel.startsWith(`..${sep}`) || rel === ".." || resolve(worktreeRoot, rel) !== realCli) return cliPath;
  if (basename(commonDir) !== ".git") return cliPath; // unusual layout (e.g. separate git dir): keep as-is
  const candidate = resolve(dirname(commonDir), rel);
  return candidate !== realCli && isFile(candidate) ? candidate : cliPath;
}

/** The hook script: chains any pre-continuity hook, then best-effort appends the trailers. */
export function hookScript(nodeBin: string, cliPath: string): string {
  const q = (s: string) => `"${s.replace(/(["\\$`])/g, "\\$1")}"`;
  const lines = [
    "#!/bin/sh",
    HOOK_MARKER,
    "# Appends 'Continuity-Applied: <id>' trailers for records reported applied this session.",
    "# Installed by 'kontinuity git install-hooks'. Local only, best effort: never fails a commit.",
    `CHAIN="$(dirname "$0")/${PRE_CONTINUITY}"`,
    'if [ -x "$CHAIN" ]; then "$CHAIN" "$@"; fi',
  ];
  lines.push(`${q(nodeBin)} ${q(cliPath)} git prepare-commit-msg "$@" || true`, "exit 0", "");
  return lines.join("\n");
}

/**
 * Install the prepare-commit-msg hook in this checkout. An existing non-continuity hook is kept
 * and chained (it runs first); a second install over the hook we wrote replaces it.
 */
export async function installGitHooks(cwd: string, cliPath: string): Promise<HookInstallResult> {
  let hooksDir: string;
  try {
    hooksDir = resolve(cwd, await git(cwd, ["rev-parse", "--git-path", "hooks"]));
  } catch {
    throw new Error(`not a git repository: ${cwd} (run from inside a checkout)`);
  }
  mkdirSync(hooksDir, { recursive: true });
  const path = join(hooksDir, "prepare-commit-msg");
  const backup = join(hooksDir, PRE_CONTINUITY);
  let action: string;
  let chained: string | undefined;
  if (existsSync(path)) {
    if (readFileSync(path, "utf8").includes(HOOK_MARKER)) {
      action = "replaced";
    } else {
      if (existsSync(backup)) throw new Error(`${backup} already exists: an earlier install kept the pre-continuity hook. Remove it (or ${path}) and re-run.`);
      renameSync(path, backup);
      chained = backup;
      action = "installed (chained after your existing hook)";
    }
  } else {
    action = "installed";
  }
  const hookCli = await stableCliPath(cliPath); // never bake a task worktree's absolute path into the hook
  writeFileSync(path, hookScript(process.execPath, hookCli), { mode: 0o755 });
  return { path, action, chained, cliPath: hookCli };
}
