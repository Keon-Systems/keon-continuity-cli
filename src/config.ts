// Adapted from Keon Kontinuity. Contains the standalone CLI configuration.
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { resolveProfileId } from "./profile-registry.ts";

export interface ContinuityConfig {
  cortexUrl: string;
  /**
   * Keon MCP Gateway endpoint (TASK-82), e.g. "http://localhost:5000/mcp". Empty (default) = the
   * gateway transport is off and the local direct-Cortex dev path runs unchanged. When set, the
   * `continuity gateway …` commands speak MCP to the gateway; the machine credential comes from
   * KEON_MCP_BEARER_TOKEN or KEON_MCP_API_KEY + KEON_MCP_TENANT_ID + KEON_MCP_ACTOR_ID (gateway
   * enrollment) — identity is never taken from tool arguments (core/gateway-client.ts G-1).
   */
  gatewayUrl: string;
  /**
   * The profile every Gateway call is made in (`profile_id`, the per-call context proof; Keon
   * Gateway #60). It is a client-side CHOICE of context, not authority: the Gateway checks it
   * against this machine enrollment's `AllowedProfiles` (deny by default) and answers 403
   * MCP_PROFILE_DENIED otherwise. Grammar `[A-Za-z0-9_.-]{1,128}`. `KEON_MCP_PROFILE_ID` in the
   * environment overrides it. Required for an API-key credential (the client fails closed
   * locally without it); optional for a bearer token, whose `profile_id` claim is the context.
   * Never taken from tool arguments.
   */
  gatewayProfileId: string;
  /** Path to a file whose trimmed contents are the gateway secret. Never logged. */
  secretFile: string;
  tenantId: string;
  agentRole: string;
  agentActor: string;
  ownerRole: string;
  ownerActor: string;
  briefingTokenCap: number;
  resurfaceMinAgeDays: number;
  /** Pre-write contradiction check: overlap coefficient (0–1) at which a write "may conflict" with a live shared record. */
  contradictionOverlap: number;
  autosaveOnShutdown: boolean;
  /** Profile that holds cross-project "[later]" items (the deferred vision). */
  northStarProfile: string;
  /** Profile that holds the user's cross-project life/preference profile ("[preference]" items). */
  meProfile: string;
  /** Profile that holds governed schemas ("shapes"). */
  vocabularyProfile: string;
  /** Profile that holds the Deck's own state: "[layout]" / "[lens]" records (deck-architecture.md §4, §7). */
  deckProfile: string;
  maxSchemas: number;
}

export const CONFIG_DIR = join(homedir(), ".config", "continuity");
export const CONFIG_PATH = join(CONFIG_DIR, "config.json");

const DEFAULTS: ContinuityConfig = {
  cortexUrl: "http://127.0.0.1:8000",
  gatewayUrl: "",
  gatewayProfileId: "",
  secretFile: join(CONFIG_DIR, "cortex-secret"),
  tenantId: "tnt_local",
  agentRole: "role_pi",
  agentActor: "agent_pi",
  ownerRole: "role_owner",
  ownerActor: "owner",
  briefingTokenCap: 3000,
  resurfaceMinAgeDays: 21,
  contradictionOverlap: 0.55,
  autosaveOnShutdown: true,
  northStarProfile: "proj_north_star",
  meProfile: "proj_me",
  vocabularyProfile: "proj_vocabulary",
  deckProfile: "proj_deck",
  maxSchemas: 32,
};

/** Load explicit settings while preserving the shared profile naming rules. */
export function loadConfig(path: string = CONFIG_PATH): ContinuityConfig {
  const cfg = { ...DEFAULTS };
  if (existsSync(path)) {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<Record<keyof ContinuityConfig, unknown>>
      & { passportTokenCap?: unknown };
    for (const key of Object.keys(DEFAULTS) as (keyof ContinuityConfig)[]) {
      const value = raw[key];
      const expected = typeof DEFAULTS[key];
      if (typeof value === expected) Object.assign(cfg, { [key]: value });
    }
    if (raw.briefingTokenCap === undefined && typeof raw.passportTokenCap === "number"
        && Number.isFinite(raw.passportTokenCap) && raw.passportTokenCap > 0) {
      cfg.briefingTokenCap = raw.passportTokenCap;
    }
  }
  if (cfg.secretFile.startsWith("~/")) cfg.secretFile = join(homedir(), cfg.secretFile.slice(2));
  cfg.northStarProfile = resolveProfileId(cfg.northStarProfile);
  cfg.meProfile = resolveProfileId(cfg.meProfile);
  cfg.vocabularyProfile = resolveProfileId(cfg.vocabularyProfile);
  cfg.deckProfile = resolveProfileId(cfg.deckProfile);
  return cfg;
}

/**
 * Resolve the gateway secret. Order: CORTEX_GATEWAY_SERVICE_SECRET env (dev
 * convenience), then the secret file. Returns the secret and *where* it came
 * from so callers can report the source without ever printing the value.
 */
export function loadSecret(cfg: ContinuityConfig): { secret: string; source: string } {
  const fromEnv = process.env.CORTEX_GATEWAY_SERVICE_SECRET;
  if (fromEnv && fromEnv.trim().length > 0) return { secret: fromEnv.trim(), source: "env" };
  if (!existsSync(cfg.secretFile)) {
    throw new Error(
      `No Cortex secret: set CORTEX_GATEWAY_SERVICE_SECRET or create ${cfg.secretFile} ` +
        `(one line, the value of CORTEX_GATEWAY_SERVICE_SECRET the Cortex service was started with).`,
    );
  }
  const secret = readFileSync(cfg.secretFile, "utf8").trim();
  if (secret.length === 0) throw new Error(`${cfg.secretFile} is empty`);
  return { secret, source: `file:${cfg.secretFile}` };
}
