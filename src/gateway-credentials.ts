/**
 * The machine gateway credential store (TASK-196).
 *
 * `kontinuity gateway login` enrolls ONE machine credential into this store; every ordinary
 * command then reaches the Keon MCP Gateway with it. The credential is a secret and never lives
 * in `config.json` (which is a plain, non-secret file): the store is a dedicated file whose
 * permissions are restricted to the current user on every platform this runs on.
 *
 *   POSIX (Linux, macOS)  directory 0700, file 0600 — verified with `fstat` after the rename.
 *   Windows               the file inherits the profile directory ACL by default, so the DACL is
 *                         replaced with a single entry for the current user (`icacls /inheritance:r
 *                         /grant:r <user>:F`). If that cannot be done the write FAILS CLOSED: a
 *                         secret left readable by other local accounts is worse than a broken login.
 *
 * The file is written atomically (temp file in the same directory, then rename), so a crash can
 * never leave a half-written credential that the client would have to guess about.
 *
 * Contract note (TASK-196 gap, docs/gateway-enrollment.md): the Gateway contract has no
 * enrollment/sign-in primitive. `~/Repos/keon-mcp-gateway/contracts` describes the runtime
 * surface (tools, envelopes, error map) and the Gateway's enrollment store is configuration-
 * backed (`EnrollmentOptions`, no dynamic grant-write endpoint; the control plane mints API keys
 * behind internal, secret-authenticated routes). So `login` cannot MINT a credential: it takes a
 * credential the operator/control plane already issued, verifies it against the Gateway, and
 * stores it securely here. Nothing in this module invents a wire protocol.
 */

import { chmodSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { renameReplacing } from "./atomic-file.ts";
import { CONFIG_DIR } from "./config.ts";

export type GatewayAuthKind = "api-key" | "bearer";

export interface StoredGatewayCredential {
  version: 1;
  /** The Gateway MCP endpoint this credential belongs to (Streamable HTTP, e.g. https://mcp.keon.systems/mcp). */
  endpoint: string;
  auth:
    | { kind: "api-key"; apiKey: string; tenantId: string; actorId: string }
    | { kind: "bearer"; token: string };
  /** The per-call context (Gateway #60) this machine enrolled for; the Gateway still decides. */
  profileId?: string;
  enrolledAt: string;
  /** When the Gateway last confirmed the credential (absent for an unverified enrollment). */
  verifiedAt?: string;
  /** What the Gateway reported at verification time (non-secret). */
  gatewayVersion?: string;
  /**
   * Which config.json keys `login` wrote, so `logout` removes only those — a hand-configured
   * endpoint is never cleared by a logout the user did not ask for.
   */
  wroteConfig?: { gatewayUrl?: boolean; gatewayProfileId?: boolean };
}

export class GatewayCredentialError extends Error {
  readonly path?: string;
  constructor(message: string, path?: string) {
    super(message);
    this.name = "GatewayCredentialError";
    this.path = path;
  }
}

/** `~/.config/continuity/gateway-credentials.json` (same directory as config.json). */
export function gatewayCredentialPath(): string {
  return join(CONFIG_DIR, "gateway-credentials.json");
}

function credentialError(message: string, path: string): GatewayCredentialError {
  return new GatewayCredentialError(`${message} (${path}). Run \`kontinuity gateway login\` to enroll this machine again.`, path);
}

function assertEndpoint(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim() === "") throw credentialError("the stored gateway credential has no endpoint", path);
  const endpoint = value.trim().replace(/\/+$/, "");
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw credentialError("the stored gateway endpoint is not a URL", path);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw credentialError(`the stored gateway endpoint uses ${url.protocol}, not http(s)`, path);
  }
  return endpoint;
}

/**
 * Read the stored credential. A malformed store is an ERROR, never "not configured": silently
 * falling back to the direct-Cortex path after an enrollment attempt would be exactly the
 * fail-open the transport routing forbids. Absent file → `undefined` (no enrollment on this machine).
 */
export function loadGatewayCredential(path: string = gatewayCredentialPath()): StoredGatewayCredential | undefined {
  if (!existsSync(path)) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw credentialError("the stored gateway credential is not valid JSON", path);
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw credentialError("the stored gateway credential is not an object", path);
  const c = raw as Record<string, unknown>;
  if (c.version !== 1) throw credentialError(`unsupported gateway credential store version ${JSON.stringify(c.version)}`, path);
  const endpoint = assertEndpoint(c.endpoint, path);
  const authRaw = c.auth;
  if (!authRaw || typeof authRaw !== "object" || Array.isArray(authRaw)) throw credentialError("the stored gateway credential has no auth block", path);
  const a = authRaw as Record<string, unknown>;
  let auth: StoredGatewayCredential["auth"];
  if (a.kind === "api-key") {
    for (const key of ["apiKey", "tenantId", "actorId"] as const) {
      if (typeof a[key] !== "string" || (a[key] as string).trim() === "") throw credentialError(`the stored API-key credential has no ${key}`, path);
    }
    auth = { kind: "api-key", apiKey: (a.apiKey as string).trim(), tenantId: (a.tenantId as string).trim(), actorId: (a.actorId as string).trim() };
  } else if (a.kind === "bearer") {
    if (typeof a.token !== "string" || a.token.trim() === "") throw credentialError("the stored bearer credential has no token", path);
    auth = { kind: "bearer", token: a.token.trim() };
  } else {
    throw credentialError(`the stored gateway credential has an unknown auth kind ${JSON.stringify(a.kind)}`, path);
  }
  if (typeof c.enrolledAt !== "string" || Number.isNaN(Date.parse(c.enrolledAt))) throw credentialError("the stored gateway credential has no enrolledAt timestamp", path);
  const profileId = typeof c.profileId === "string" && c.profileId.trim() !== "" ? c.profileId.trim() : undefined;
  const wroteConfigRaw = c.wroteConfig && typeof c.wroteConfig === "object" ? (c.wroteConfig as Record<string, unknown>) : undefined;
  return {
    version: 1,
    endpoint,
    auth,
    ...(profileId ? { profileId } : {}),
    enrolledAt: c.enrolledAt,
    ...(typeof c.verifiedAt === "string" ? { verifiedAt: c.verifiedAt } : {}),
    ...(typeof c.gatewayVersion === "string" ? { gatewayVersion: c.gatewayVersion } : {}),
    ...(wroteConfigRaw
      ? { wroteConfig: { ...(wroteConfigRaw.gatewayUrl === true ? { gatewayUrl: true } : {}), ...(wroteConfigRaw.gatewayProfileId === true ? { gatewayProfileId: true } : {}) } }
      : {}),
  };
}

/** Replace the DACL (Windows) / mode (POSIX) so only the current user can read the secret. */
function restrictToCurrentUser(path: string): void {
  if (process.platform === "win32") {
    const user = process.env.USERNAME?.trim();
    if (!user) throw new GatewayCredentialError(`cannot restrict ${path} to the current user: USERNAME is not set, so the credential was not stored`);
    try {
      // /inheritance:r removes inherited ACEs; /grant:r replaces this user's entry with full control.
      execFileSync("icacls", [path, "/inheritance:r", "/grant:r", `${user}:F`], { stdio: "ignore" });
    } catch {
      throw new GatewayCredentialError(`cannot restrict ${path} to the current user (icacls failed), so the credential was not stored`);
    }
    return;
  }
  chmodSync(path, 0o600);
  const mode = statSync(path).mode & 0o777;
  if ((mode & 0o077) !== 0) throw new GatewayCredentialError(`could not restrict ${path} to the current user (mode ${mode.toString(8)})`);
}

/**
 * Store (or replace) the machine credential atomically with user-only permissions.
 * Returns the path written. Never logs and never returns the secret.
 */
export function saveGatewayCredential(credential: StoredGatewayCredential, path: string = gatewayCredentialPath()): string {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") chmodSync(dir, 0o700);
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(credential, null, 2)}\n`, { mode: 0o600 });
    restrictToCurrentUser(tmp);
    renameReplacing(tmp, path);
    restrictToCurrentUser(path);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
  return path;
}

/** Remove the stored credential (idempotent). Returns whether a file was removed. */
export function clearGatewayCredential(path: string = gatewayCredentialPath()): boolean {
  if (!existsSync(path)) return false;
  rmSync(path);
  return true;
}

/**
 * Permission check for `gateway status`: true when other local users cannot read the store.
 * A missing file is not a problem (nothing is stored). Windows DACLs cannot be inspected
 * portably in Node, so the check reports "unknown" there rather than pretending.
 */
export function credentialPermissions(path: string = gatewayCredentialPath()): { ok: boolean | "unknown"; detail: string } {
  if (!existsSync(path)) return { ok: "unknown", detail: "no stored credential" };
  if (process.platform === "win32") return { ok: "unknown", detail: "Windows ACLs are enforced at write time (icacls); cannot inspect portably" };
  const mode = statSync(path).mode & 0o777;
  if ((mode & 0o077) !== 0) return { ok: false, detail: `mode ${mode.toString(8)} is readable by other local users — re-run \`kontinuity gateway login\` (or chmod 600 ${path})` };
  return { ok: true, detail: `mode ${mode.toString(8)} (user-only)` };
}
