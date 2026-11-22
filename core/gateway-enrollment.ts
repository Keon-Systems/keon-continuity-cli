/**
 * Gateway sign-in / enrollment for this machine (TASK-196).
 *
 * `continuity gateway login` is the interactive enrollment step the hosted setup path needs:
 *
 *   1. ask for the Gateway endpoint, the machine credential, and the identity/profile the
 *      enrollment carries (or take any of them from flags/environment),
 *   2. PROVE the credential against the Gateway with read-only MCP calls (`initialize` +
 *      `tools/list`, then one `memory.search` to prove the per-call profile when an API key is
 *      used) — nothing is written to memory and no Runtime decide runs,
 *   3. store the secret in the user-only credential store (src/gateway-credentials.ts) and the
 *      non-secret endpoint/profile in config.json, so ordinary Continuity commands route through
 *      the Gateway from then on (core/runtime.ts).
 *
 * Contract gap this design respects (`docs/gateway-enrollment.md`): the Gateway contract has NO
 * enrollment/sign-in primitive. Enrollment is configuration-backed on the Gateway
 * (`EnrollmentOptions`; "provisioning is a later phase") and API keys are minted by the control
 * plane behind internal, secret-authenticated routes. So this is not a device-code/OAuth flow and
 * it never invents one: it enrolls a credential that was already issued, verifies it, and stores
 * it. `logout` removes the local enrollment only; revoking the credential on the Gateway is the
 * operator's step (and revoking it there cuts this machine off on its next call).
 *
 * Prompts never echo the secret, and nothing here prints or returns it.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { renameReplacing } from "../src/atomic-file.ts";
import { CONFIG_PATH, loadConfig } from "../src/config.ts";
import {
  GatewayCredentialError,
  clearGatewayCredential,
  credentialPermissions,
  gatewayCredentialPath,
  loadGatewayCredential,
  saveGatewayCredential,
  type StoredGatewayCredential,
} from "../src/gateway-credentials.ts";
import { assertProfileId, GatewayClient, GatewayError, GatewayRefusedError, type GatewayAuth, type GatewayConnection } from "./gateway-client.ts";

/** The public Gateway MCP endpoint used when the user just presses Enter. */
export const DEFAULT_GATEWAY_ENDPOINT = "https://mcp.keon.systems/mcp";

export interface GatewayPrompter {
  /** Ask one question. `secret` input is read without echo. `fallback` is shown as the default. */
  ask(question: string, opts?: { secret?: boolean; fallback?: string }): Promise<string>;
  write(line: string): void;
}

/** A terminal prompter: line input normally, raw-mode input for secrets (never echoed). */
export function ttyPrompter(): GatewayPrompter {
  return {
    async ask(question, opts = {}) {
      const suffix = opts.fallback ? ` [${opts.fallback}]` : "";
      if (opts.secret) return readSecret(`${question}${suffix}: `);
      const { createInterface } = await import("node:readline");
      const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
      try {
        const answer = await new Promise<string>((resolve) => rl.question(`${question}${suffix}: `, resolve));
        return answer.trim();
      } finally {
        rl.close();
      }
    },
    write(line) {
      process.stderr.write(`${line}\n`);
    },
  };
}

/** Raw-mode secret entry: one character at a time, `*` echo, backspace and Ctrl-C handled. */
async function readSecret(question: string): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY || typeof stdin.setRawMode !== "function") {
    throw new GatewayCredentialError(`${question.trim()} — stdin is not a terminal, so it cannot be read without echo. Pass the credential with a flag or KEON_MCP_API_KEY / KEON_MCP_BEARER_TOKEN instead.`);
  }
  process.stderr.write(question);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");
  let value = "";
  return new Promise<string>((resolve, reject) => {
    const finish = (fn: () => void) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off("data", onData);
      process.stderr.write("\n");
      fn();
    };
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") return finish(() => resolve(value));
        if (ch === "\u0003") return finish(() => reject(new Error("login cancelled")));
        if (ch === "\u007f" || ch === "\b") {
          if (value) {
            value = value.slice(0, -1);
            process.stderr.write("\b \b");
          }
          continue;
        }
        if (ch >= " ") {
          value += ch;
          process.stderr.write("*");
        }
      }
    };
    stdin.on("data", onData);
  });
}

export interface GatewayLoginInput {
  endpoint?: string;
  authKind?: "api-key" | "bearer";
  apiKey?: string;
  token?: string;
  tenantId?: string;
  actorId?: string;
  profileId?: string;
  /** Default true: prove the credential against the Gateway before storing it. */
  verify?: boolean;
}

export interface GatewayLoginDeps {
  prompter?: GatewayPrompter;
  env?: NodeJS.ProcessEnv;
  configPath?: string;
  credentialPath?: string;
  /** Injection point for tests: build the read-only client used for verification. */
  client?: (conn: GatewayConnection) => Pick<GatewayClient, "listTools" | "search">;
  now?: () => Date;
}

export interface GatewayLoginResult {
  endpoint: string;
  authKind: "api-key" | "bearer";
  tenantId?: string;
  actorId?: string;
  profileId?: string;
  verified: boolean;
  /** A non-fatal note from verification (e.g. the profile probe was refused for an entitlement reason). */
  verificationNote?: string;
  credentialPath: string;
  configPath: string;
  /** config.json keys this login wrote (non-secret). */
  configKeys: string[];
}

function noPrompter(what: string, flag: string): never {
  throw new GatewayError(`login needs ${what}, and stdin is not a terminal to ask for it. Pass ${flag} (or the matching KEON_MCP_* environment variable).`);
}

/**
 * Enroll this machine. Interactive when a TTY is present (or a prompter is injected); otherwise
 * every value must come from flags/environment, and a missing one is an error — never a default
 * that guesses an identity.
 */
export async function loginGateway(input: GatewayLoginInput = {}, deps: GatewayLoginDeps = {}): Promise<GatewayLoginResult> {
  const env = deps.env ?? process.env;
  const configPath = deps.configPath ?? CONFIG_PATH;
  const credentialPath = deps.credentialPath ?? gatewayCredentialPath();
  const cfg = loadConfig(configPath);
  // A malformed existing store throws here: a login on top of a broken enrollment must be fixed,
  // not silently overwritten (the old secret would be lost with no record that it existed).
  const stored = loadGatewayCredential(credentialPath);
  const interactive = deps.prompter !== undefined || Boolean(process.stdin.isTTY);
  const prompter = deps.prompter ?? (interactive ? ttyPrompter() : undefined);

  const ask = async (question: string, opts: { secret?: boolean; fallback?: string } = {}): Promise<string> => {
    if (!prompter) noPrompter(question, "the matching flag");
    const answer = await prompter.ask(question, opts);
    return answer.trim() !== "" ? answer.trim() : (opts.fallback ?? "");
  };

  // 1. Endpoint (non-secret).
  const endpointRaw =
    input.endpoint?.trim() ||
    (await ask("Gateway MCP endpoint", { fallback: cfg.gatewayUrl.trim() || stored?.endpoint || DEFAULT_GATEWAY_ENDPOINT })).trim();
  const endpoint = endpointRaw.replace(/\/+$/, "");
  if (!endpoint) throw new GatewayError("a Gateway endpoint is required (e.g. https://mcp.keon.systems/mcp)");
  try {
    const url = new URL(endpoint);
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("not http(s)");
  } catch {
    throw new GatewayError(`the Gateway endpoint must be an http(s) URL; got ${JSON.stringify(endpoint)}`);
  }

  // 2. Credential kind. An explicit secret or its env var decides it; otherwise ask.
  const envToken = env.KEON_MCP_BEARER_TOKEN?.trim();
  const envKey = env.KEON_MCP_API_KEY?.trim();
  if (input.token?.trim() && (input.apiKey?.trim() || envKey)) throw new GatewayError("both a bearer token and an API key were given — pick one machine credential");
  let authKind: "api-key" | "bearer";
  if (input.authKind) authKind = input.authKind;
  else if (input.token?.trim() || (envToken && !input.apiKey?.trim())) authKind = "bearer";
  else if (input.apiKey?.trim() || envKey) authKind = "api-key";
  else {
    const answer = (await ask("Credential kind — api-key or bearer", { fallback: "api-key" })).toLowerCase();
    if (answer !== "api-key" && answer !== "bearer") throw new GatewayError('credential kind must be "api-key" or "bearer"');
    authKind = answer;
  }

  // 3. The secret itself (never echoed, never printed).
  const apiKey = authKind === "api-key" ? input.apiKey?.trim() || envKey || (await ask("API key (input hidden)", { secret: true })) : undefined;
  const token = authKind === "bearer" ? input.token?.trim() || envToken || (await ask("Bearer token (JWT, input hidden)", { secret: true })) : undefined;
  if (authKind === "api-key" && (!apiKey || apiKey.trim() === "")) throw new GatewayError("an API key is required for the api-key credential");
  if (authKind === "bearer" && (!token || token.trim() === "")) throw new GatewayError("a bearer token is required for the bearer credential");

  // 4. The enrollment's identity (API key lane). Identity is never guessed: the Gateway binds it
  //    from the credential, so a wrong value here would simply be refused at verification.
  let tenantId: string | undefined;
  let actorId: string | undefined;
  if (authKind === "api-key") {
    const storedApiKey = stored?.auth.kind === "api-key" ? stored.auth : undefined;
    tenantId =
      input.tenantId?.trim() ||
      env.KEON_MCP_TENANT_ID?.trim() ||
      (await ask("Enrolled tenant id", { fallback: storedApiKey?.tenantId ?? "" })).trim();
    actorId =
      input.actorId?.trim() ||
      env.KEON_MCP_ACTOR_ID?.trim() ||
      (await ask("Enrolled actor id", { fallback: storedApiKey?.actorId ?? "" })).trim();
    if (!tenantId || !actorId) throw new GatewayError("an API-key enrollment needs its tenant id and actor id (they come from the Gateway enrollment record)");
  }

  // 5. The per-call profile (Gateway #60). Required for an API-key credential; on the bearer
  //    lane the token's `profile_id` claim is the context, so a value is stored ONLY when it was
  //    given explicitly — asking for one there would let a default silently contradict the claim
  //    (403 MCP_PROFILE_DENIED on every later call).
  const explicitProfile = input.profileId?.trim() || env.KEON_MCP_PROFILE_ID?.trim() || cfg.gatewayProfileId.trim() || stored?.profileId;
  const profileAnswer =
    explicitProfile ||
    (authKind === "bearer" ? "" : (await ask("Profile id every Gateway call carries (profile_id)", { fallback: "proj_continuity" })).trim());
  const profileId = profileAnswer ? assertProfileId(profileAnswer, "profile id") : undefined;
  if (authKind === "api-key" && !profileId) throw new GatewayError("an API-key enrollment needs a profile id (profile_id): the Gateway refuses an API-key call without one");

  const auth: GatewayAuth = authKind === "api-key" ? { kind: "api-key", apiKey: apiKey!, tenantId: tenantId!, actorId: actorId! } : { kind: "bearer", token: token! };
  const conn: GatewayConnection = { endpoint, auth, timeoutMs: 10_000, ...(profileId ? { profileId } : {}) };

  // 6. Prove the credential (read-only; no Runtime decide, nothing written).
  let verified = false;
  let verificationNote: string | undefined;
  if (input.verify !== false) {
    const client = deps.client ? deps.client(conn) : new GatewayClient(conn);
    try {
      await client.listTools();
    } catch (e) {
      throw loginVerificationError(e);
    }
    verified = true;
    if (profileId) {
      try {
        // A profile-scoped read: proves the enrollment's AllowedProfiles entry server-side.
        await client.search("continuity gateway login check", { limit: 1, profileId });
      } catch (e) {
        if (e instanceof GatewayRefusedError && (e.code === "MCP_PROFILE_DENIED" || e.code === "MCP_KEY_REVOKED")) throw loginVerificationError(e);
        verificationNote = `the credential works, but the profile probe did not complete: ${e instanceof Error ? e.message : String(e)}`;
      }
    }
  }

  // 7. Store the secret securely, then the non-secret endpoint/profile in config.json.
  const now = (deps.now?.() ?? new Date()).toISOString();
  const credential: StoredGatewayCredential = {
    version: 1,
    endpoint,
    auth,
    ...(profileId ? { profileId } : {}),
    enrolledAt: now,
    ...(verified ? { verifiedAt: now } : {}),
    wroteConfig: { gatewayUrl: true, ...(profileId ? { gatewayProfileId: true } : {}) },
  };
  saveGatewayCredential(credential, credentialPath);
  const configKeys = writeConfigKeys(configPath, { gatewayUrl: endpoint, ...(profileId ? { gatewayProfileId: profileId } : {}) });
  return {
    endpoint,
    authKind,
    ...(tenantId ? { tenantId } : {}),
    ...(actorId ? { actorId } : {}),
    ...(profileId ? { profileId } : {}),
    verified,
    ...(verificationNote ? { verificationNote } : {}),
    credentialPath,
    configPath,
    configKeys,
  };
}

/** A verification refusal must name the machine-readable code and never leak the secret. */
function loginVerificationError(e: unknown): Error {
  if (e instanceof GatewayRefusedError) {
    return new GatewayError(`the Gateway refused this credential (${e.code}${e.httpStatus ? `, http ${e.httpStatus}` : ""}), so nothing was stored. ${e.message.replace(/^gateway refused [^:]*: /, "")}`);
  }
  if (e instanceof GatewayError) return new GatewayError(`${e.message} Nothing was stored.`);
  return new GatewayError(`could not verify the credential against the Gateway (${e instanceof Error ? e.message : String(e)}). Nothing was stored; re-run with --no-verify to enroll without a live check.`);
}

/** Merge non-secret keys into config.json atomically (`null` deletes a key); refuses a non-object config. */
function writeConfigKeys(path: string, updates: Record<string, string | null>): string[] {
  let raw: Record<string, unknown> = {};
  if (existsSync(path)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      throw new GatewayError(`config.json is not valid JSON (${path}); fix it before enrolling`);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new GatewayError(`config.json must contain a JSON object (${path})`);
    raw = parsed as Record<string, unknown>;
  }
  for (const [key, value] of Object.entries(updates)) {
    if (value === null) delete raw[key];
    else raw[key] = value;
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(raw, null, 2)}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameReplacing(tmp, path);
  return Object.keys(updates);
}

export interface GatewayLogoutDeps {
  configPath?: string;
  credentialPath?: string;
}

export interface GatewayLogoutResult {
  removed: boolean;
  credentialPath: string;
  /** config.json keys cleared because THIS enrollment wrote them (a hand-set endpoint is kept). */
  configKeysCleared: string[];
}

/**
 * Remove this machine's enrollment: delete the secret store and clear only the config keys the
 * enrollment wrote. Ordinary commands then return to the local Cortex path (no endpoint).
 * Revoking the credential on the Gateway side remains the operator's step.
 */
export function logoutGateway(deps: GatewayLogoutDeps = {}): GatewayLogoutResult {
  const configPath = deps.configPath ?? CONFIG_PATH;
  const credentialPath = deps.credentialPath ?? gatewayCredentialPath();
  let stored: StoredGatewayCredential | undefined;
  try {
    stored = loadGatewayCredential(credentialPath);
  } catch (e) {
    // A malformed store must still be removable: refuse to leave a broken secret behind.
    if (!(e instanceof GatewayCredentialError)) throw e;
    stored = undefined;
  }
  const removed = clearGatewayCredential(credentialPath);
  const configKeysCleared: string[] = [];
  const updates: Record<string, string | null> = {};
  if (stored?.wroteConfig?.gatewayUrl) {
    updates.gatewayUrl = null;
    configKeysCleared.push("gatewayUrl");
  }
  if (stored?.wroteConfig?.gatewayProfileId) {
    updates.gatewayProfileId = null;
    configKeysCleared.push("gatewayProfileId");
  }
  if (Object.keys(updates).length > 0) writeConfigKeys(configPath, updates);
  return { removed, credentialPath, configKeysCleared };
}

export interface GatewayStatusDeps {
  env?: NodeJS.ProcessEnv;
  configPath?: string;
  credentialPath?: string;
}

export interface GatewayStatusReport {
  configured: boolean;
  endpoint?: string;
  authKind?: "api-key" | "bearer";
  tenantId?: string;
  actorId?: string;
  profileId?: string;
  credentialSource: "env" | "stored" | "none";
  credentialPath: string;
  configPath: string;
  enrolledAt?: string;
  verifiedAt?: string;
  permissions: { ok: boolean | "unknown"; detail: string };
  warnings: string[];
}

/** Read-only status: what would a call use right now, and where did it come from? Never the secret. */
export function gatewayStatus(deps: GatewayStatusDeps = {}): GatewayStatusReport {
  const env = deps.env ?? process.env;
  const configPath = deps.configPath ?? CONFIG_PATH;
  const credentialPath = deps.credentialPath ?? gatewayCredentialPath();
  const cfg = loadConfig(configPath);
  let storeError: string | undefined;
  const stored = (() => {
    try {
      return loadGatewayCredential(credentialPath);
    } catch (e) {
      if (!(e instanceof GatewayCredentialError)) throw e;
      // A malformed store is shown, never hidden as "not configured".
      storeError = e.message;
      return undefined;
    }
  })();
  const envToken = env.KEON_MCP_BEARER_TOKEN?.trim();
  const envKey = env.KEON_MCP_API_KEY?.trim();
  const credentialSource: GatewayStatusReport["credentialSource"] = envToken || envKey ? "env" : stored ? "stored" : "none";
  const endpoint = (cfg.gatewayUrl.trim() || stored?.endpoint || "").replace(/\/+$/, "");
  const authKind: "api-key" | "bearer" | undefined = credentialSource === "env" ? (envToken ? "bearer" : "api-key") : stored?.auth.kind;
  const warnings: string[] = [];
  if (envToken && envKey) warnings.push("both KEON_MCP_BEARER_TOKEN and KEON_MCP_API_KEY are set; a gateway call would refuse the ambiguity (bearer wins in this report)");
  else if (credentialSource === "env" && stored) warnings.push("environment credentials are set and take precedence over the stored enrollment");
  if (cfg.gatewayUrl.trim() && stored && cfg.gatewayUrl.trim().replace(/\/+$/, "") !== stored.endpoint) {
    warnings.push(`config.json gatewayUrl (${cfg.gatewayUrl.trim()}) differs from the enrolled endpoint (${stored.endpoint}); the configured endpoint wins`);
  }
  if (credentialSource === "stored") {
    const perms = credentialPermissions(credentialPath);
    if (perms.ok === false) warnings.push(`credential file permissions are too open: ${perms.detail}`);
  }
  if (storeError) warnings.push(storeError);
  const permissions = credentialPermissions(credentialPath);
  return {
    configured: endpoint !== "",
    ...(endpoint ? { endpoint } : {}),
    ...(authKind ? { authKind } : {}),
    ...(authKind === "api-key" ? {
      tenantId: env.KEON_MCP_TENANT_ID?.trim() || (stored?.auth.kind === "api-key" ? stored.auth.tenantId : undefined),
      actorId: env.KEON_MCP_ACTOR_ID?.trim() || (stored?.auth.kind === "api-key" ? stored.auth.actorId : undefined),
    } : {}),
    profileId: env.KEON_MCP_PROFILE_ID?.trim() || cfg.gatewayProfileId.trim() || stored?.profileId,
    credentialSource,
    credentialPath,
    configPath,
    ...(stored?.enrolledAt ? { enrolledAt: stored.enrolledAt } : {}),
    ...(stored?.verifiedAt ? { verifiedAt: stored.verifiedAt } : {}),
    permissions,
    warnings,
  };
}
