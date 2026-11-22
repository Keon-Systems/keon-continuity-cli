/**
 * Operator controls that must survive across sessions and projects.
 *
 * Capture pause/resume: while paused, nothing is captured automatically (stage, import,
 * pi autosave). Explicit user-directed commands (remember, later, schema, supersede) still work —
 * pausing capture is not a way to disable the user's own decisions, and it never widens or
 * narrows what Cortex enforces. Stored per tenant, so one `pause` covers every project and runtime
 * on this machine for that tenant. Plain JSON, rebuildable by hand.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { renameReplacing } from "../src/atomic-file.ts";
import { stateDir } from "./state.ts";

export interface ControlState {
  version: 1;
  capturePaused: boolean;
  pausedAt?: string;
  pausedBy?: string;
  reason?: string;
}

const controlPath = (tenantId: string) => join(stateDir(tenantId), "control.json");

export function loadControl(tenantId: string): ControlState {
  const p = controlPath(tenantId);
  if (!existsSync(p)) return { version: 1, capturePaused: false };
  try {
    const raw = JSON.parse(readFileSync(p, "utf8")) as Partial<ControlState>;
    return { version: 1, capturePaused: raw.capturePaused === true, pausedAt: raw.pausedAt, pausedBy: raw.pausedBy, reason: raw.reason };
  } catch {
    // Unreadable control file: fail toward NOT capturing. A broken pause switch must not silently capture.
    return { version: 1, capturePaused: true, reason: "control file unreadable; capture held until `continuity resume`" };
  }
}

export function setCapturePaused(tenantId: string, paused: boolean, by: string, reason?: string): ControlState {
  const next: ControlState = paused
    ? { version: 1, capturePaused: true, pausedAt: new Date().toISOString(), pausedBy: by, reason: reason?.slice(0, 240) }
    : { version: 1, capturePaused: false };
  mkdirSync(stateDir(tenantId), { recursive: true, mode: 0o700 });
  const p = controlPath(tenantId);
  const tmp = `${p}.tmp`;
  writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
  renameReplacing(tmp, p);
  return next;
}

export class CapturePausedError extends Error {
  constructor(state: ControlState) {
    super(`capture is paused${state.pausedAt ? ` since ${state.pausedAt}` : ""}${state.reason ? ` (${state.reason})` : ""}. Nothing was captured. Resume with \`continuity resume\`; explicit \`remember --user-confirmed\` still works.`);
    this.name = "CapturePausedError";
  }
}

export function assertCaptureAllowed(tenantId: string): void {
  const c = loadControl(tenantId);
  if (c.capturePaused) throw new CapturePausedError(c);
}
