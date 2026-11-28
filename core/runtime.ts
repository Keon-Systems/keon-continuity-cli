/**
 * Kontinuity runtime: one per agent session, in ANY agent harness (pi, Claude Code,
 * Codex, Gemini CLI, Grok Build, …). No pi imports here. Holds config, the two Cortex
 * identities (this runtime's agent role + the owner role), the resolved project
 * profile, and local state.
 */

import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { CortexClient, grant, type CortexTransport, type Identity } from "../src/cortex.ts";
import { loadConfig, loadSecret, type ContinuityConfig } from "../src/config.ts";
import { assertId, slugify } from "../src/ids.ts";
import { assertRegisteredProfileId, resolveProfileId } from "../src/profile-registry.ts";
import { GatewayProfileError, loadGatewayConnection } from "./gateway-client.ts";
import { GatewayCortexTransport } from "./gateway-transport.ts";
import { loadState, saveState, type LocalState } from "./state.ts";

const execFileP = promisify(execFile);

export const TAGS = ["decision", "rejected", "open-loop", "closed", "note", "lesson", "imported", "later", "preference", "offering", "thought", "milestone"] as const;
export type Tag = (typeof TAGS)[number];

/** Who is running: becomes the Cortex role (`role_<name>`) and actor (`agent_<name>`). */
export interface AgentRuntimeName {
  /** Short lowercase token: pi | claude | codex | gemini | grok | <anything> */
  name: string;
}

/**
 * How the project profile was derived. `project-file` can travel with a repository;
 * `pin` is local to a checkout. Remote-derived IDs can change when remotes differ, and
 * folder names can collide. `explicit` = `--project`.
 */
export type ProfileSource = "explicit" | "pin" | "project-file" | "remote" | "toplevel" | "cwd" | "gateway";

export interface Runtime {
  cfg: ContinuityConfig;
  /** e.g. "pi", "claude" — used in role/actor ids and provenance URNs. */
  runtimeName: string;
  profileId: string;
  projectLabel: string;
  profileSource: ProfileSource;
  /** Optional agent generation (CONTINUITY_GENERATION): a replacement agent in the same role. Recorded as provenance, never an identity input. */
  generation?: string;
  /**
   * Which memory transport this runtime speaks (TASK-196):
   *   "cortex"  — direct Cortex HTTP (`src/cortex.ts`), the local/dev path.
   *   "gateway" — the Keon MCP Gateway (`core/gateway-transport.ts`), selected whenever an
   *               endpoint + machine credential are configured. Once selected there is NO
   *               fallback: an unmapped operation fails closed. Never both.
   */
  transport: "cortex" | "gateway";
  /** Present only on the gateway transport: what the client is bound to (never the secret). */
  gateway?: {
    endpoint: string;
    authKind: "api-key" | "bearer";
    /** The per-call context (`profile_id`) this machine enrolled for. */
    profileId?: string;
    /** Where the credential came from: the environment, or the secure store written by `gateway login`. */
    credentialSource: "env" | "stored";
  };
  /** This runtime's agent role: writes role-private shards, proposes curation. */
  agent: CortexTransport;
  /** The human owner role: approves curation → profile_shared. */
  owner: CortexTransport;
  state: LocalState;
  persist(): void;
  secretSource: string;
}

export async function gitExec(args: string[]): Promise<string | undefined> {
  try {
    const { stdout } = await execFileP("git", args, { timeout: 3000 });
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

export async function resolveProfile(cwd: string): Promise<{ profileId: string; label: string; source: ProfileSource }> {
  // Local-only pin preserves an existing profile when a repository gains or changes a remote.
  // Every resolved id passes through the read-through alias layer (src/profile-registry.ts): a
  // legacy name and its canonical name are one live profile — old ids keep resolving, nothing moves.
  // Configured named profiles are already resolved at config load (src/config.ts).
  const pinned = await gitExec(["-C", cwd, "config", "--local", "--get", "continuity.profile"]);
  if (pinned) return { profileId: resolveProfileId(assertId(pinned, "continuity.profile")), label: pinned, source: "pin" };
  const top = await gitExec(["-C", cwd, "rev-parse", "--show-toplevel"]);
  if (top) {
    const path = join(top, ".continuity.json");
    let contents: string | undefined;
    try {
      contents = readFileSync(path, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    if (contents !== undefined) {
      let file: unknown;
      try { file = JSON.parse(contents); } catch { throw new Error(`Invalid JSON in ${path}`); }
      if (!file || typeof file !== "object" || Array.isArray(file) || typeof (file as Record<string, unknown>).profile !== "string") {
        throw new Error(`${path} must contain a string "profile"`);
      }
      const raw = assertId((file as { profile: string }).profile, `${path} profile`);
      return { profileId: resolveProfileId(raw), label: raw, source: "project-file" };
    }
  }
  // Windows-style paths (C:\\repo\\app, WSL mounts) must also yield a directory name.
  let label = cwd.split(/[\\/]/).filter(Boolean).pop() ?? "unnamed";
  let source: ProfileSource = "cwd";
  const remote = await gitExec(["-C", cwd, "remote", "get-url", "origin"]);
  if (remote) {
    const tail = remote.replace(/\/+$/, "").replace(/\.git$/, "").split(/[/:]/).filter(Boolean).slice(-2).join("_");
    if (tail) {
      label = tail;
      source = "remote";
    }
  } else {
    if (top) {
      label = top.split(/[\\/]/).pop() ?? label;
      source = "toplevel";
    }
  }
  // Mint boundary: a derived project id must carry a registered kind before it can become
  // memory (docs/profile-naming.md §Enforcement) — this is where new ids are created.
  return { profileId: resolveProfileId(assertRegisteredProfileId(`proj_${slugify(label)}`, "derived project profile")), label, source };
}

export interface CreateRuntimeOptions {
  cwd: string;
  /** Defaults to env CONTINUITY_RUNTIME, else "pi". */
  runtimeName?: string;
  /** Override the project profile (e.g. `--project foo`). */
  profileId?: string;
}

/** Cortex role id for a runtime name: pi keeps the configured default; anything else is role_<name>. */
export function agentRoleFor(cfg: ContinuityConfig, runtimeName: string): string {
  return runtimeName === "pi" ? cfg.agentRole : `role_${runtimeName}`;
}

export function normalizeRuntimeName(name: string | undefined): string {
  const n = (name ?? process.env.CONTINUITY_RUNTIME ?? "pi").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return n || "agent";
}

/** The Cortex role for a runtime name (pi keeps the configured role for backwards compatibility). */
export function roleForRuntimeName(cfg: ContinuityConfig, runtimeName: string): string {
  return runtimeName === "pi" ? cfg.agentRole : `role_${runtimeName}`;
}

/** The Cortex actor for a runtime name. */
export function actorForRuntimeName(cfg: ContinuityConfig, runtimeName: string): string {
  return runtimeName === "pi" ? cfg.agentActor : `agent_${runtimeName}`;
}

/** Keep an explicitly requested project consistent with the configured Gateway context. */
export function gatewayProfileForRequest(configured?: string, requested?: string): string | undefined {
  if (requested === undefined) return configured;
  const canonicalRequest = resolveProfileId(assertId(requested, "profileId"));
  if (configured && resolveProfileId(configured) !== canonicalRequest) {
    throw new GatewayProfileError(
      `requested project ${JSON.stringify(requested)} does not match configured Gateway profile ${JSON.stringify(configured)}; configure the intended Gateway profile before retrying. Nothing was sent.`,
    );
  }
  return configured ?? canonicalRequest;
}

export async function createRuntime(opts: CreateRuntimeOptions): Promise<Runtime> {
  const cfg = loadConfig();
  const runtimeName = normalizeRuntimeName(opts.runtimeName);
  const resolved: { profileId: string; label: string; source: ProfileSource } = opts.profileId
    ? { profileId: resolveProfileId(assertId(opts.profileId, "profileId")), label: opts.profileId, source: "explicit" }
    : await resolveProfile(opts.cwd);
  const generationRaw = process.env.CONTINUITY_GENERATION?.trim();
  const generation = generationRaw ? assertId(generationRaw, "CONTINUITY_GENERATION") : undefined;

  // Per-runtime role: pi keeps the configured defaults for backwards compatibility; every
  // other harness gets role_<name>/agent_<name> so its private inferences never leak across.
  const agentRole = roleForRuntimeName(cfg, runtimeName);
  const agentActor = actorForRuntimeName(cfg, runtimeName);

  // Transport selection (TASK-196). A configured gateway endpoint means the gateway transport is
  // ON: `loadGatewayConnection` fails closed when the credential is missing or malformed, so this
  // never degrades into a silent direct-Cortex call. With no endpoint, the local path is unchanged.
  const gatewayConn = loadGatewayConnection(cfg);
  if (gatewayConn) {
    const gatewayProfile = gatewayProfileForRequest(gatewayConn.profileId, opts.profileId) ?? resolved.profileId;
    const sameProfile = resolveProfileId(gatewayProfile) === resolved.profileId;
    const actor = gatewayConn.auth.kind === "api-key" ? gatewayConn.auth.actorId : agentActor;
    const agentId: Identity = { actorId: actor, profileId: gatewayProfile, roleId: agentRole, grants: [] };
    const ownerId: Identity = { actorId: gatewayConn.auth.kind === "api-key" ? actor : cfg.ownerActor, profileId: gatewayProfile, roleId: cfg.ownerRole, grants: [] };
    const agent = new GatewayCortexTransport(gatewayConn, agentId);
    const owner = agent.as(ownerId);
    const state = loadState(cfg.tenantId, gatewayProfile);
    return {
      cfg,
      runtimeName,
      profileId: gatewayProfile,
      projectLabel: sameProfile ? resolved.label : gatewayProfile,
      profileSource: sameProfile ? resolved.source : "gateway",
      generation,
      transport: "gateway",
      gateway: {
        endpoint: gatewayConn.endpoint,
        authKind: gatewayConn.auth.kind,
        ...(gatewayConn.profileId ? { profileId: gatewayConn.profileId } : {}),
        credentialSource: process.env.KEON_MCP_API_KEY?.trim() || process.env.KEON_MCP_BEARER_TOKEN?.trim() ? "env" : "stored",
      },
      agent,
      owner,
      state,
      secretSource: "gateway",
      persist: () => saveState(cfg.tenantId, gatewayProfile, state),
    };
  }

  const { secret, source } = loadSecret(cfg);
  const { profileId, label } = resolved;

  const agentId: Identity = {
    actorId: agentActor,
    profileId,
    roleId: agentRole,
    grants: [grant.role(profileId, agentRole), grant.profileShared(profileId)],
  };
  const ownerId: Identity = {
    actorId: cfg.ownerActor,
    profileId,
    roleId: cfg.ownerRole,
    grants: [grant.role(profileId, cfg.ownerRole), grant.profileShared(profileId), grant.curationApprove],
  };
  const agent = new CortexClient({ baseUrl: cfg.cortexUrl, secret, tenantId: cfg.tenantId, timeoutMs: 8000 }, agentId);
  const owner = agent.as(ownerId);
  const state = loadState(cfg.tenantId, profileId);

  return {
    cfg,
    runtimeName,
    profileId,
    projectLabel: label,
    profileSource: resolved.source,
    generation,
    transport: "cortex",
    agent,
    owner,
    state,
    secretSource: source,
    persist: () => saveState(cfg.tenantId, profileId, state),
  };
}

/** Ensure content starts with a bracketed tag; default to [note]. */
export function tagged(text: string, fallback: Tag = "note"): string {
  const t = text.trim();
  return /^\[[a-z-]+\]\s/.test(t) ? t : `[${fallback}] ${t}`;
}

export function tagOf(content: string): string {
  const m = /^\[([a-z-]+)\]/.exec(content);
  return m ? m[1] : "note";
}

export function stripTag(content: string): string {
  return content.replace(/^\[[a-z-]+\]\s*/, "");
}

export function sessionUrn(runtime: string, sessionId: string, entry: string): string {
  // urn:<nid>:<nss> — nid ≤ 32 chars of [A-Za-z0-9-]; nss has no whitespace.
  const safe = (s: string) => s.replace(/\s+/g, "_");
  return `urn:continuity:${safe(runtime)}:${safe(sessionId)}:${safe(entry)}`;
}

/** Cache / card / runtime identity. Tenant, project, and role are all required so one slot cannot stand in for another. */
export interface ScopedRuntimeKey {
  tenantId: string;
  projectRef: string;
  role: string;
}

export function scopedRuntimeKey(key: ScopedRuntimeKey): string {
  return `${key.tenantId}\u0000${key.projectRef}\u0000${key.role}`;
}

/**
 * Runtimes for more than one project. `resolve` returns the object stored under that
 * exact key. It does not read or assign any other runtime, including a launch runtime
 * the caller still holds.
 */
export class ProjectRuntimeTable {
  private readonly byKey = new Map<string, Runtime>();

  get(key: ScopedRuntimeKey): Runtime | undefined {
    return this.byKey.get(scopedRuntimeKey(key));
  }

  put(key: ScopedRuntimeKey, runtime: Runtime): void {
    this.byKey.set(scopedRuntimeKey(key), runtime);
  }

  async resolve(key: ScopedRuntimeKey, create: () => Promise<Runtime>): Promise<Runtime> {
    const existing = this.get(key);
    if (existing) return existing;
    const created = await create();
    const raced = this.get(key);
    if (raced) return raced;
    this.put(key, created);
    return created;
  }
}
