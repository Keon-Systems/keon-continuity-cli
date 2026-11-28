/**
 * Managed file rendering: the confirmed-only briefing written into a fenced block
 * (<!-- continuity:begin --> … <!-- continuity:end -->) that AGENTS.md, CLAUDE.md, GEMINI.md and
 * .cursorrules readers get for free — no skill, no hook, no extension.
 *
 * `kontinuity render` creates or refreshes the block; every `share` and `supersede` keeps it
 * current — from the command's directory up to the repository root, but only in files that
 * already carry a block. Nothing is ever written into a file
 * that did not ask, and everything outside the markers belongs to the user: it is preserved
 * byte-for-byte. The output is deterministic (no timestamps), so a re-render with unchanged
 * memory is a byte-identical no-op.
 */

import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import {
  buildBriefing,
  CONFIRMED_HEADER,
  NO_CONFIRMED_LINE,
  RULES_LINE,
  TRUST_PREAMBLE,
  briefingTitle,
} from "./briefing.ts";
import { gitExec, type Runtime } from "./runtime.ts";

export const MANAGED_FILES = ["AGENTS.md", "CLAUDE.md", "GEMINI.md", ".cursorrules"] as const;
export const BEGIN_MARK = "<!-- continuity:begin -->";
export const END_MARK = "<!-- continuity:end -->";
/** Session label for deliveries made through a rendered file: the file, not an agent session, carries them. */
export const RENDER_SESSION = "render";

export type RenderAction = "created" | "updated" | "unchanged" | "skipped" | "error";
export interface RenderResult {
  file: string;
  action: RenderAction;
  error?: string;
}

/** The confirmed-only briefing for a project with nothing confirmed yet. */
export function emptyConfirmedBriefing(projectLabel: string): string {
  return [briefingTitle(projectLabel, true), TRUST_PREAMBLE, RULES_LINE, CONFIRMED_HEADER, NO_CONFIRMED_LINE].join("\n");
}

/**
 * Wrap briefing text in the managed fence. A stored record that mentions the markers cannot
 * forge or break the block: the exact marker strings are stripped from the body first
 * (recalled text is data, not structure). Stripping runs to a fixed point: removing an end
 * marker can stitch the surrounding text into a fresh begin marker
 * (`<!-- continuity:<!-- continuity:end -->begin -->`), so every intermediate string must be
 * clean, not just the first pass's output.
 */
export function renderBlock(briefingText: string): string {
  let body = briefingText;
  for (let prev = ""; body !== prev; ) {
    prev = body;
    body = body.split(BEGIN_MARK).join("").split(END_MARK).join("");
  }
  return `${BEGIN_MARK}\n${body}\n${END_MARK}`;
}

/** Exactly one complete, ordered block? */
export function hasManagedBlock(text: string): boolean {
  return text.split(BEGIN_MARK).length === 2 && text.split(END_MARK).length === 2 && text.indexOf(END_MARK) > text.indexOf(BEGIN_MARK);
}

/**
 * Splice the managed block into one file's content. Returns the new content, or undefined when
 * the file should be left alone (no block present in refresh mode, or already up to date).
 * Unbalanced or duplicated markers are an error, never a guess.
 */
export function applyManagedBlock(existing: string, block: string, opts: { create: boolean }): string | undefined {
  const begins = existing.split(BEGIN_MARK).length - 1;
  const ends = existing.split(END_MARK).length - 1;
  if (begins === 0 && ends === 0) {
    if (!opts.create) return undefined;
    // Append, never trim: the user's exact bytes (trailing spaces, blank lines, CRLF) must stay
    // a byte-identical prefix of the result.
    const nl = existing === "" || existing.endsWith("\n") ? "" : "\n";
    return `${existing}${nl}${existing ? "\n" : ""}${block}\n`;
  }
  if (begins !== 1 || ends !== 1) throw new Error(`managed block markers are unbalanced (${begins} × begin, ${ends} × end); fix the file by hand first`);
  const b = existing.indexOf(BEGIN_MARK);
  const e = existing.indexOf(END_MARK);
  if (e < b) throw new Error("managed block markers are out of order (end before begin); fix the file by hand first");
  const updated = existing.slice(0, b) + block + existing.slice(e + END_MARK.length);
  return updated === existing ? undefined : updated;
}

/**
 * Write or refresh the managed block in every target file under `dir`. Per-file problems are
 * reported in the result, never thrown: one broken file must not stop the others.
 */
export function renderToDir(dir: string, briefingText: string, opts: { create: boolean }): RenderResult[] {
  const block = renderBlock(briefingText);
  return MANAGED_FILES.map((name) => {
    const path = join(dir, name);
    try {
      const existed = existsSync(path);
      const existing = existed ? readFileSync(path, "utf8") : "";
      const updated = applyManagedBlock(existing, block, opts);
      if (updated === undefined) return { file: name, action: hasManagedBlock(existing) ? "unchanged" : "skipped" };
      writeFileSync(path, updated);
      return { file: name, action: existed ? "updated" : "created" };
    } catch (e) {
      return { file: name, action: "error", error: e instanceof Error ? e.message : String(e) };
    }
  });
}

export interface RefreshOptions {
  sessionId?: string;
  dir?: string;
}

/** Satellite profiles (north star, vocabulary) have their own scope: their memory never renders project files. */
export function isSatelliteProfile(rt: Runtime): boolean {
  return rt.profileId === rt.cfg.northStarProfile || rt.profileId === rt.cfg.vocabularyProfile;
}

function physical(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

/**
 * Every directory that may hold blocks for this invocation: the command's directory and, inside
 * a git repository (which is what the profile identity follows), its ancestors up to the
 * repository root. A `supersede` run from `src/` must still refresh the blocks at the top level;
 * anything outside the repository is never even looked at.
 */
async function refreshTargetDirs(dir: string): Promise<string[]> {
  const start = physical(dir);
  const dirs = [start];
  const top = await gitExec(["-C", start, "rev-parse", "--show-toplevel"]);
  if (top) {
    const root = physical(top);
    for (let d = dirname(start); ; d = dirname(d)) {
      if (d !== root && !d.startsWith(root + sep)) break; // never leave the repository
      dirs.push(d);
      if (d === root || d === dirname(d)) break;
    }
  }
  return dirs;
}

function hasBlockIn(dir: string): boolean {
  return MANAGED_FILES.some((name) => {
    try {
      return existsSync(join(dir, name)) && hasManagedBlock(readFileSync(join(dir, name), "utf8"));
    } catch {
      return false;
    }
  });
}

/**
 * Keep managed blocks current after shared memory changed (called from share/supersede). Looks
 * for blocks in the command's directory and up to the repository root, so memory changed from a
 * subdirectory still keeps the top-level blocks honest. Cheap no-op unless a block exists:
 * without one, nothing is written and Cortex is not even asked. Never throws — the memory
 * operation stands even if files cannot be updated.
 */
export async function refreshRender(rt: Runtime, opts: RefreshOptions = {}): Promise<RenderResult[]> {
  // Satellite profiles (north star, vocabulary) have their own scope: their memory never
  // renders into a project's files.
  if (isSatelliteProfile(rt)) return [];
  const holders = (await refreshTargetDirs(opts.dir ?? process.cwd())).filter(hasBlockIn);
  if (holders.length === 0) return [];
  const p = await buildBriefing(rt, opts.sessionId ?? RENDER_SESSION, { confirmedOnly: true });
  const text = p ? p.text : emptyConfirmedBriefing(rt.projectLabel);
  return holders.flatMap((d) => renderToDir(d, text, { create: false }));
}
