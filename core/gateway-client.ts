/**
 * Keon MCP Gateway client (TASK-82): the hosted transport for Continuity.
 *
 * Where the legacy `src/cortex.ts` `CortexClient` speaks direct Cortex HTTP (the local dev
 * path only), this client speaks MCP to the Keon MCP Gateway — the single ingress and egress
 * for Keon Systems (docs/gateway-continuity-discovery.md, docs/keon-unified-gateway-proposal.md).
 * Transport: JSON-RPC 2.0 over Streamable HTTP (`POST <endpoint>`, MCP `initialize` /
 * `tools/list` / `tools/call`), tool names and payload shapes per `~/Repos/keon-mcp-gateway/contracts`
 * (vendored in `smoke/fixtures/contracts/`, refreshed against the live Gateway `19f9c82`).
 *
 * Per-call context proof (Gateway #60, deployed): every invoke made with an API key carries a
 * `profile_id`, sent as `params.profile_id` of the JSON-RPC `tools/call` (never inside
 * `arguments`; the legacy `POST /mcp/tools/invoke` carries it as a top-level body field outside
 * `arguments`, which this client does not use). The Gateway checks it against the enrollment's
 * `AllowedProfiles`, deny by default (403 MCP_PROFILE_DENIED). The profile is the client's CHOICE of
 * context, configured on the connection (`gatewayProfileId` / `KEON_MCP_PROFILE_ID`), never taken
 * from tool arguments, and never authority: grants and capabilities are always re-derived from the
 * enrollment. With no profile configured an API-key client fails closed locally, before the wire.
 *
 * The operation mapping — Continuity verb → keon.cortex.* MCP tool:
 *
 *   briefing   → keon.cortex.memory.recall.v1   (kind: briefing)
 *   recall     → keon.cortex.memory.recall.v1   (kind: recall)
 *   remember   → keon.cortex.memory.write.v1    (user-confirmed record; label only, see below)
 *   stage      → keon.cortex.memory.write.v1    (staged record; label only, see below)
 *   feedback   → keon.cortex.memory.feedback.v1 (access | application | outcome | non_applicability | feedback)
 *   share      → keon.cortex.curation.propose.v1 (kind: lesson) then keon.cortex.curation.dispose.v1
 *                (approve). Approve needs the enrollment capability `curation.approve`; without it
 *                the Gateway refuses (403 CORTEX_CAPABILITY_REQUIRED) and NOTHING is shared — the
 *                proposal that was created stays pending and is reported. A plain write is never
 *                swapped in for a promotion.
 *   supersede  → keon.cortex.memory.write.v1 (the user-confirmed replacement text), then
 *                curation.propose.v1 (lesson, sourced on that write) then curation.dispose.v1
 *                (supersede, supersedes_record_id = the old record). Same capability rule. The local
 *                path's `correction` audit event is NOT emitted: the feedback contract rejects it.
 *   proposals  → keon.cortex.curation.list.v1 (read-only; CORTEX_ROUTE_UNAVAILABLE if the Cortex route is absent)
 *   close      → STILL FAILS CLOSED — closing an open loop needs the old record's text and its
 *                [open-loop] tag to build the closure text, and this surface has no get-shard
 *                tool, so the mapping would be a guess. Use `supersede` with the explicit text.
 *
 * Honesty rules:
 *   G-1  Identity comes from the machine credential + gateway enrollment (bearer JWT claims or
 *        API key + enrolled tenant/actor), NEVER from tool arguments. An argument that tries to
 *        set identity is refused before anything is sent; the gateway itself binds tenant and
 *        actor fail-closed and refuses forged arguments server-side (both sides are tested).
 *   G-2  Fail unsupported operations CLOSED: no `correction` events, no `close`, and NO direct
 *        hosted-Cortex fallback anywhere in this module — the legacy `CortexClient` remains for
 *        the local dev path only. A refused capability never degrades into a plain write.
 *   G-3  A delivery without a `recall_event_id` (or a `content_trust` that is not
 *        `untrusted_data_not_instructions`) is refused, exactly like the local client: recalled
 *        content is untrusted data, never instructions, and an unaccounted delivery is never used.
 *   G-4  Result reporting is literal. `remember`/`stage` return what `memory.write` acknowledged
 *        (the write receipt — including the gateway's own `decision_id`). They never claim a
 *        promotion: a gateway write is a governed write, not "shared with every agent". Only an
 *        approved `curation.dispose` that returned a `derived_shard_id` counts as shared, and a
 *        half-finished curation (write or proposal made, approval refused) is reported as exactly
 *        that.
 *   G-5  The profile is configuration, not an argument (see above); a missing one fails closed.
 *
 * Provenance gap (known, documented in docs/gateway-continuity-discovery.md): the write contract
 * carries `source` / `subject_keys` labels but no provenance block (original event time, source
 * kind, session URN) and no client idempotency field. Continuity passes what the contract allows
 * and does not invent the rest.
 */

import { mintId } from "../src/ids.ts";
import type { ContinuityConfig } from "../src/config.ts";
import { loadGatewayCredential } from "../src/gateway-credentials.ts";
import { BRIEFING_QUERY } from "./briefing.ts";

// ---------- connection (machine credential + gateway enrollment) ----------

export type GatewayAuth =
  | { kind: "bearer"; token: string }
  | { kind: "api-key"; apiKey: string; tenantId: string; actorId: string };

export interface GatewayConnection {
  /** Gateway MCP endpoint (Streamable HTTP), e.g. `http://localhost:5000/mcp`. */
  endpoint: string;
  auth: GatewayAuth;
  timeoutMs: number;
  /**
   * The per-call context (`profile_id`). Required for an API-key credential (calls fail closed
   * locally without it); optional for a bearer token, whose `profile_id` claim is the context —
   * a configured value is still sent and must not contradict that claim.
   */
  profileId?: string;
}

/** The Gateway's identifier grammar for `profile_id`. */
export const PROFILE_ID_PATTERN = /^[A-Za-z0-9_.-]{1,128}$/;

/** Validate a profile id against `[A-Za-z0-9_.-]{1,128}`; throws a GatewayProfileError. */
export function assertProfileId(value: unknown, where = "profile_id"): string {
  if (typeof value !== "string" || !PROFILE_ID_PATTERN.test(value)) {
    throw new GatewayProfileError(`${where} must be 1 to 128 characters of [A-Za-z0-9_.-] (the Gateway grammar); got ${typeof value === "string" ? JSON.stringify(value.length > 40 ? `${value.slice(0, 40)}…` : value) : typeof value}`);
  }
  return value;
}

/**
 * Resolve the gateway connection from config + the machine's enrolled credential.
 *
 * Sources, in order:
 *   1. The endpoint: `gatewayUrl` in config.json, else the endpoint stored by `continuity gateway login`.
 *   2. The credential: KEON_MCP_BEARER_TOKEN / KEON_MCP_API_KEY (+ KEON_MCP_TENANT_ID +
 *      KEON_MCP_ACTOR_ID) from the environment, else the securely stored enrollment.
 *   3. The per-call profile: KEON_MCP_PROFILE_ID, else `gatewayProfileId`, else the stored profile.
 *
 * No endpoint anywhere → `undefined` (gateway transport off; the local CortexClient path runs).
 * Once an endpoint IS configured, partial configuration fails closed: an endpoint with no
 * credential, or an API key without its enrolled tenant/actor, is an error — never a guess and
 * never a silent fallback to direct Cortex.
 */
export function loadGatewayConnection(cfg: ContinuityConfig, env: NodeJS.ProcessEnv = process.env, opts: { credentialPath?: string } = {}): GatewayConnection | undefined {
  // A malformed store throws (GatewayCredentialError) rather than reading as "not configured".
  const stored = loadGatewayCredential(opts.credentialPath);
  const endpoint = (cfg.gatewayUrl.trim() || stored?.endpoint || "").replace(/\/+$/, "");
  const bearer = env.KEON_MCP_BEARER_TOKEN?.trim();
  const apiKey = env.KEON_MCP_API_KEY?.trim();
  if (!endpoint) {
    // An explicit credential in the environment is a statement of intent. With no endpoint there
    // is nothing to send it to — fail closed instead of silently ignoring it and using direct
    // Cortex (the exact fail-open TASK-196 exists to remove).
    if (bearer || apiKey) {
      throw new GatewayError(
        "a gateway machine credential is set in the environment (KEON_MCP_BEARER_TOKEN / KEON_MCP_API_KEY) but no gateway endpoint is configured: " +
          'set "gatewayUrl" in ~/.config/continuity/config.json or run `continuity gateway login`. Refusing to fall back to direct Cortex.',
      );
    }
    return undefined;
  }
  const tenantId = env.KEON_MCP_TENANT_ID?.trim();
  const actorId = env.KEON_MCP_ACTOR_ID?.trim();
  // The per-call profile: env beats config beats the stored enrollment. Validated here, once, so
  // a typo is a local error and not a 422 from the Gateway.
  const profileRaw = env.KEON_MCP_PROFILE_ID?.trim() || cfg.gatewayProfileId?.trim() || stored?.profileId || "";
  const profileId = profileRaw ? assertProfileId(profileRaw, "KEON_MCP_PROFILE_ID / gatewayProfileId") : undefined;
  if (bearer && apiKey) throw new GatewayError("both KEON_MCP_BEARER_TOKEN and KEON_MCP_API_KEY are set — pick one machine credential");
  if (bearer) return { endpoint, auth: { kind: "bearer", token: bearer }, timeoutMs: 10_000, ...(profileId ? { profileId } : {}) };
  if (apiKey) {
    if (!tenantId || !actorId) throw new GatewayError("KEON_MCP_API_KEY needs the enrolled identity too: set KEON_MCP_TENANT_ID and KEON_MCP_ACTOR_ID (they come from gateway enrollment, never from tool arguments)");
    if (!profileId) throw new GatewayProfileError(NO_PROFILE_MESSAGE);
    return { endpoint, auth: { kind: "api-key", apiKey, tenantId, actorId }, timeoutMs: 10_000, profileId };
  }
  if (stored) {
    // The enrolled credential already carries its tenant/actor (or the bearer token); the profile
    // may come from config/env, and an API-key enrollment still fails closed without one.
    if (stored.auth.kind === "api-key" && !profileId) throw new GatewayProfileError(NO_PROFILE_MESSAGE);
    return {
      endpoint,
      auth: stored.auth,
      timeoutMs: 10_000,
      ...(profileId ? { profileId } : {}),
    };
  }
  throw new GatewayError(`gateway endpoint ${endpoint} is configured but no machine credential is enrolled: run \`continuity gateway login\`, or set KEON_MCP_BEARER_TOKEN / KEON_MCP_API_KEY (with KEON_MCP_TENANT_ID and KEON_MCP_ACTOR_ID from your gateway enrollment)`);
}

const NO_PROFILE_MESSAGE =
  "no profile is configured: every Gateway call made with an API key must carry a profile_id the enrollment allows. " +
  'Set "gatewayProfileId" in ~/.config/continuity/config.json (or KEON_MCP_PROFILE_ID in the environment) to a profile in your enrollment\'s AllowedProfiles, ' +
  "e.g. proj_continuity. It is never read from tool arguments. Nothing was sent.";

// ---------- errors ----------

/** Base: anything the gateway path refuses. Never swallowed, never a fallback. */
export class GatewayError extends Error {
  readonly tool?: string;
  readonly detail?: unknown;
  constructor(message: string, opts: { tool?: string; detail?: unknown } = {}) {
    super(message);
    this.name = "GatewayError";
    this.tool = opts.tool;
    this.detail = opts.detail;
  }
}

/** G-2: the operation has no tool on the gateway surface. Fail closed, say so. */
export class GatewayUnsupportedError extends GatewayError {
  constructor(message: string, opts: { tool?: string } = {}) {
    super(message, opts);
    this.name = "GatewayUnsupportedError";
  }
}

/** A request or response that violates the contracts/ shapes. Fail closed. */
export class GatewayContractError extends GatewayError {
  constructor(message: string, opts: { tool?: string; detail?: unknown } = {}) {
    super(message, opts);
    this.name = "GatewayContractError";
  }
}

/** G-5: the per-call profile is missing or malformed. Refused before anything is sent. */
export class GatewayProfileError extends GatewayError {
  constructor(message: string) {
    super(message);
    this.name = "GatewayProfileError";
  }
}

/**
 * A governed refusal from the Gateway (an error envelope or a JSON-RPC error carrying one), with
 * the machine-readable `code`. The message says what the code means for a Continuity user; the
 * Gateway's own wording rides along. Nothing was done unless a `GatewayCurationIncompleteError` says so.
 */
export class GatewayRefusedError extends GatewayError {
  readonly code: string;
  readonly httpStatus?: number;
  readonly retryable?: boolean;
  constructor(message: string, opts: { code: string; tool?: string; detail?: unknown; httpStatus?: number; retryable?: boolean }) {
    super(message, { tool: opts.tool, detail: opts.detail });
    this.name = "GatewayRefusedError";
    this.code = opts.code;
    this.httpStatus = opts.httpStatus;
    this.retryable = opts.retryable;
  }
}

/**
 * A multi-step curation that stopped part-way (G-4): say exactly what exists. `shared` is always
 * false here — a half-finished curation never counts as shared.
 */
export class GatewayCurationIncompleteError extends GatewayError {
  readonly shared = false as const;
  readonly progress: { writtenShardId?: string; proposalId?: string };
  readonly cause: unknown;
  constructor(message: string, progress: { writtenShardId?: string; proposalId?: string }, cause: unknown) {
    super(message, { detail: progress });
    this.name = "GatewayCurationIncompleteError";
    this.progress = progress;
    this.cause = cause;
  }
}

/** What each refusal code means for the person at the CLI (the Gateway's wording is appended). */
const REFUSAL_HINTS: Record<string, string> = {
  MCP_PROFILE_DENIED:
    "the profile was refused. It is missing, not in this enrollment's AllowedProfiles, contradicts the token's profile claim, or the enrollment is not active. " +
    'Check "gatewayProfileId" / KEON_MCP_PROFILE_ID and ask the Gateway operator to allow that profile for this machine. Nothing was read or written',
  MCP_KEY_REVOKED:
    "the machine credential is revoked, expired or not active (an inactive enrollment can also show as MCP_PROFILE_DENIED). Ask the Gateway operator for a fresh enrollment; do not reuse another machine's key. Nothing was read or written",
  MCP_TOOL_SCHEMA_INVALID:
    "the Gateway rejected the request as malformed (422). If this names profile_id, it must be a string of 1 to 128 characters of [A-Za-z0-9_.-]. Nothing was written",
  CORTEX_ROUTE_UNAVAILABLE:
    "Cortex does not serve this route yet (curation list, GET /v1/curation/proposals, is not deployed behind this Gateway). Nothing is wrong with your credential; try again once Cortex is updated",
  CORTEX_CAPABILITY_REQUIRED:
    "this machine's enrollment does not hold the curation.approve capability, so it may propose but not approve or supersede. Nothing was approved or superseded; the operator must grant the capability on the enrollment",
};

/** Pull a governed refusal out of an error envelope (tools/call) or a JSON-RPC error's `data`. */
function refusalFrom(source: { code?: unknown; message?: unknown; http_status?: unknown; retryable?: unknown } | undefined, tool: string | undefined, detail: unknown): GatewayRefusedError | undefined {
  if (!source || typeof source.code !== "string" || source.code.length === 0) return undefined;
  const code = source.code;
  const hint = REFUSAL_HINTS[code];
  const httpStatus = typeof source.http_status === "number" ? source.http_status : undefined;
  const gw = typeof source.message === "string" && source.message ? ` Gateway said: ${source.message}` : "";
  const what = tool ? `gateway refused ${tool}` : "gateway refused the request";
  return new GatewayRefusedError(
    hint
      ? `${what}: ${hint}. (${code}${httpStatus ? `, http ${httpStatus}` : ""}.${gw})`
      : `${what}: ${typeof source.message === "string" && source.message ? source.message : "tool error"} (${code}${httpStatus ? `, http ${httpStatus}` : ""})`,
    { code, tool, detail, httpStatus, retryable: typeof source.retryable === "boolean" ? source.retryable : undefined },
  );
}

/** G-1: an argument tried to set identity. Refused before anything is sent. */
export class GatewayIdentityError extends GatewayError {
  constructor(message: string) {
    super(message);
    this.name = "GatewayIdentityError";
  }
}

// ---------- wire shapes (contracts/mcp_gateway.v1.schema.json + per-tool schemas) ----------

export const TOOL_NAMES = {
  recall: "keon.cortex.memory.recall.v1",
  write: "keon.cortex.memory.write.v1",
  search: "keon.cortex.memory.search.v1",
  list: "keon.cortex.memory.list.v1",
  feedback: "keon.cortex.memory.feedback.v1",
  curationPropose: "keon.cortex.curation.propose.v1",
  curationDispose: "keon.cortex.curation.dispose.v1",
  curationList: "keon.cortex.curation.list.v1",
  curationBatch: "keon.cortex.curation.batch.v1",
} as const;

/** `ToolName` in the contract — what the gateway can ever be asked for. */
const CONTRACT_TOOL_NAMES = new Set<string>([
  "keon.browseahead.scan.v1",
  "keon.governed.execute.v1",
  "keon.governance.noop.v1",
  "keon.launch.hardening.v1",
  "keon.cortex.memory.write.v1",
  "keon.cortex.memory.search.v1",
  "keon.cortex.memory.list.v1",
  "keon.cortex.memory.recall.v1",
  "keon.cortex.memory.feedback.v1",
  "keon.cortex.receipt.get.v1",
  "keon.cortex.lineage.get.v1",
  "keon.cortex.evidence.get.v1",
  "keon.cortex.evidence.verify.v1",
  "keon.cortex.replay.query.v1",
  "keon.cortex.curation.propose.v1",
  "keon.cortex.curation.dispose.v1",
  "keon.cortex.curation.list.v1",
  "keon.cortex.curation.batch.v1",
  "keon.collective.deliberate.v1",
  "keon.collective.compare.v1",
  "keon.collective.adversarial_review.v1",
  "keon.collective.collapse.v1",
  "keon.collective.handoff.prepare.v1",
  "keon.collective.handoff.dispatch.v1",
]);

export interface ReceiptRefs {
  directive: string | null;
  intent: string | null;
  request: string | null;
  decision: string | null;
  execution: string | null;
  outcome: string | null;
  evidence_pack: string | null;
}

export interface GatewayEnvelope {
  correlation_id: string;
  tool: string;
  ok: boolean;
  decision?: { status: string; policy_hash: string; [k: string]: unknown };
  result?: Record<string, unknown> | null;
  receipts: ReceiptRefs;
  error?: { code: string; message: string; http_status: number; retryable: boolean };
  metadata?: Record<string, unknown>;
}

export interface GatewayToolDescriptor {
  name: string;
  description: string;
  input_schema?: Record<string, unknown>;
}

export interface GatewayRecallHit {
  shard_id: string;
  content: string;
  memory_type: string;
  rank: number;
  relevance_score: number;
  gravity_score: number;
  verified: boolean;
}

/** keon.cortex.recall_result.v1. `content` is untrusted data, never instructions (G-3). */
export interface GatewayRecallResult {
  recall_event_id: string;
  operation_id: string;
  results: GatewayRecallHit[];
  verification_meta: Record<string, unknown>;
  gravity_version: string;
  gravity_function_hash: string;
  gravity_as_of: string;
  delivery: Record<string, unknown>;
  content_trust: string;
}

/** keon.cortex.memory_write_result.v1 — the persisted shard receipt. `curation_promoted` is
 *  Continuity's own honesty flag (G-4): a gateway write is never the local path's promotion. */
export interface GatewayWriteResult {
  shard_id: string;
  decision_id: string;
  store_ack_id: string;
  correlation_id: string;
  curation_promoted: false;
}

/** keon.cortex.feedback_result.v1 — the Cortex memory-event acknowledgement. */
export interface GatewayFeedbackResult {
  attribution: string;
  event_ids: string[];
  operation_id: string;
  replay_equivalent_record_ids: string[];
  replayed: boolean;
}

export interface GatewayProposeResult {
  operation_id: string;
  proposal_id: string;
  replayed: boolean;
  status: string;
}

export interface GatewayDisposeResult {
  action: string;
  derived_shard_id: string | null;
  disposition_id: string;
  inheritance_event_id: string | null;
  operation_id: string;
  proposal_id: string;
  replayed: boolean;
  status: string;
}

export interface GatewayProposalList {
  /** Proposal rows as Cortex returns them. `content`, when included, is untrusted data (G-3). */
  proposals: Record<string, unknown>[];
  next_cursor: string | null;
}

/** keon.cortex.memory.search.v1 result rows (untrusted data, G-3). The gateway's fixed field set. */
export interface GatewaySearchHit {
  shard_id: string;
  content: string;
  status?: string;
  [k: string]: unknown;
}

export interface GatewaySearchResult {
  shards: GatewaySearchHit[];
  total: number;
  query: string;
}

/** keon.cortex.memory.list.v1 — a page of candidate records. `next_cursor` is opaque; null means exhausted. */
export interface GatewayListResult {
  shards: GatewaySearchHit[];
  next_cursor: string | null;
}

/** keon.cortex.curation_batch_request.v1 `items[]` (ccm-atomic-batch-v1). */
export interface GatewayCurationBatchItem {
  write?: {
    content: string;
    source?: string;
    memoryType?: "claim" | "belief" | "lesson" | "fact" | "story";
    memoryMode?: "propositional" | "episodic" | "narrative";
    subjectKeys?: string[];
    beliefScore?: number;
    uniqueKeys?: string[];
  };
  proposal: {
    kind: "lesson" | "preference" | "handoff";
    content: string;
    sourceRecordIds?: string[];
    toRoleId?: string;
    epistemicStatus?: string;
    reason?: string;
  };
  disposition: {
    action: "approve" | "supersede";
    supersedesRecordId?: string;
    reason?: string;
    /** Bound to the minted record (the derived record; for supersede the replacement). */
    uniqueKeys?: string[];
  };
}

/** keon.cortex.curation_batch_result.v1 — the stable Cortex batch snapshot. */
export interface GatewayCurationBatchResult {
  batch_id: string;
  idempotency_key: string;
  receipt_id: string;
  items: {
    index: number;
    action: "approve" | "supersede";
    status: string;
    source_shard_id: string | null;
    derived_shard_id: string;
    proposal_id: string;
    disposition_id: string;
    inheritance_event_id: string;
  }[];
}

export interface GatewayShareResult {
  shared: true;
  derived_shard_id: string;
  source_record_id: string;
  proposal: GatewayProposeResult;
  disposition: GatewayDisposeResult;
}

export interface GatewaySupersedeResult {
  superseded: true;
  old_record_id: string;
  derived_shard_id: string;
  written: GatewayWriteResult;
  proposal: GatewayProposeResult;
  disposition: GatewayDisposeResult;
  correction_event: string;
}

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** The write input shared by remember/stage (keon.cortex.memory_write_request.v1). */
export interface GatewayWriteInput {
  content: string;
  source?: string;
  memoryType?: "claim" | "belief" | "lesson" | "fact" | "story";
  memoryMode?: "propositional" | "episodic" | "narrative";
  subjectKeys?: string[];
  beliefScore?: number;
  /**
   * ccm-atomic-batch-v1 claimable keys (wire: `unique_keys`) — at most 8 keys, each 1–128
   * characters of A-Za-z0-9._:-. A taken key is a 409 naming the key and nothing is written.
   */
  uniqueKeys?: string[];
}

// ---------- G-1: identity is never an argument ----------

/**
 * Arguments that would set identity. The gateway binds identity from the machine credential and
 * enrollment (and refuses forged arguments server-side); a call that tries to set it here is
 * refused before anything is sent. Same rule as the `continuity mcp` server (M-1 in core/mcp.ts),
 * with the gateway envelope spellings added.
 */
export const IDENTITY_ARGUMENTS = [
  "as", "runtime", "role", "actor", "profile", "project", "session", "sessionId", "session_id",
  "tenant", "tenantId", "tenant_id", "actor_id", "role_id", "profile_id", "generation",
  // Scope-shaping words are identity too (TASK-86 review): a tool that accepts them as data could
  // smuggle visibility/ownership semantics past the binding. They are refused as identity
  // arguments before the wire; unmapped contract tools rely on this list alone client-side.
  "grants", "grant_scopes", "visibility", "ownership", "scope",
] as const;

function assertNoIdentityArguments(tool: string, args: Record<string, unknown>): void {
  for (const key of Object.keys(args)) {
    if ((IDENTITY_ARGUMENTS as readonly string[]).includes(key)) {
      throw new GatewayIdentityError(
        `refused: identity comes from the machine credential and gateway enrollment, never from tool arguments. ` +
          `"${key}" was not sent; nothing was written or read (tool ${tool}).`,
      );
    }
  }
}

// ---------- client-side shape checks (fail closed before the wire) ----------

const MEMORY_TYPES = new Set(["claim", "belief", "lesson", "fact", "story"]);
const MEMORY_MODES = new Set(["propositional", "episodic", "narrative"]);
const FEEDBACK_KINDS = new Set(["access", "access_omitted", "application", "outcome", "non_applicability", "feedback", "consideration"]);
const CONSIDERATION_DISPOSITIONS = new Set(["not_applicable", "considered_rejected"]);
const OUTCOME_STATUSES = new Set(["success", "failure", "unknown", "not_executed"]);

function assertString(value: unknown, label: string, min = 1, max = Infinity): string {
  if (typeof value !== "string" || value.length < min || value.length > max) {
    throw new GatewayContractError(`${label} must be a string of ${min}..${max} characters`);
  }
  return value;
}

/** ISO-8601 with an explicit timezone, ≤64 chars. Lowercase z is refused (contract: feedback_request). */
function assertTime(value: unknown, label: string): string {
  const s = assertString(value, label, 1, 64);
  if (Number.isNaN(Date.parse(s)) || !/(Z|[+-]\d{2}:?\d{2})$/.test(s)) {
    throw new GatewayContractError(`${label} must be an ISO-8601 time with an explicit timezone (uppercase Z or an offset; lowercase z is not accepted)`);
  }
  return s;
}

function assertIdentifier(value: unknown, label: string, max = 128): string {
  return assertString(value, label, 1, max);
}

function assertKnownKeys(tool: string, args: Record<string, unknown>, allowed: readonly string[]): void {
  for (const key of Object.keys(args)) {
    if (!allowed.includes(key)) throw new GatewayContractError(`tool argument '${key}' is not accepted by ${tool}`, { tool });
  }
}

/** The Gateway default `Cortex:MaxContentBytes`; the handler counts UTF-8 BYTES (the schema's maxLength is only a character ceiling). */
const MAX_CONTENT_BYTES = 32768;

function assertUtf8Bytes(value: string, label: string, max: number, tool: string): void {
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes > max) throw new GatewayContractError(`${label} is ${bytes} UTF-8 bytes, over the Gateway default limit of ${max}`, { tool });
}

/**
 * unique_keys (keon.cortex.memory_write_request.v1): at most 8 keys, each 1–128 characters of
 * A-Za-z0-9._:- (full-string match, no trimming), no duplicates. Fail closed before the wire.
 */
function assertUniqueKeys(value: unknown, tool: string): void {
  if (!Array.isArray(value) || value.length > 8 || value.some((k) => typeof k !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(k))) {
    throw new GatewayContractError("unique_keys must be an array of at most 8 keys, each 1 to 128 characters of A-Za-z0-9._:-", { tool });
  }
  if (new Set(value).size !== value.length) {
    throw new GatewayContractError("unique_keys must not contain duplicates", { tool });
  }
}

function checkRecallArguments(args: Record<string, unknown>): Record<string, unknown> {
  assertKnownKeys(TOOL_NAMES.recall, args, ["query", "limit", "kind"]);
  assertString(args.query, "query", 1, 4096);
  if (args.limit !== undefined && (typeof args.limit !== "number" || !Number.isInteger(args.limit) || args.limit < 1 || args.limit > 50)) {
    throw new GatewayContractError("limit must be an integer from 1 to 50", { tool: TOOL_NAMES.recall });
  }
  if (args.kind !== undefined && args.kind !== "recall" && args.kind !== "briefing") {
    throw new GatewayContractError("kind must be briefing or recall", { tool: TOOL_NAMES.recall });
  }
  return args;
}

function checkWriteArguments(args: Record<string, unknown>): Record<string, unknown> {
  assertKnownKeys(TOOL_NAMES.write, args, ["content", "source", "memory_type", "memory_mode", "subject_keys", "belief_score", "unique_keys"]);
  assertString(args.content, "content");
  assertUtf8Bytes(args.content as string, "content", MAX_CONTENT_BYTES, TOOL_NAMES.write);
  if (args.source !== undefined) assertString(args.source, "source", 1, 2048);
  if (args.memory_type !== undefined && !MEMORY_TYPES.has(String(args.memory_type))) {
    throw new GatewayContractError(`memory_type must be one of ${[...MEMORY_TYPES].join(" | ")}`, { tool: TOOL_NAMES.write });
  }
  if (args.memory_mode !== undefined && !MEMORY_MODES.has(String(args.memory_mode))) {
    throw new GatewayContractError(`memory_mode must be one of ${[...MEMORY_MODES].join(" | ")}`, { tool: TOOL_NAMES.write });
  }
  if (args.subject_keys !== undefined) {
    if (!Array.isArray(args.subject_keys) || args.subject_keys.some((k) => typeof k !== "string" || k.length > 256) || args.subject_keys.length > 64) {
      throw new GatewayContractError("subject_keys must be an array of at most 64 strings of at most 256 characters", { tool: TOOL_NAMES.write });
    }
  }
  if (args.belief_score !== undefined && (typeof args.belief_score !== "number" || args.belief_score < 0 || args.belief_score > 1)) {
    throw new GatewayContractError("belief_score must be a number from 0.0 to 1.0", { tool: TOOL_NAMES.write });
  }
  if (args.unique_keys !== undefined) assertUniqueKeys(args.unique_keys, TOOL_NAMES.write);
  return args;
}

/**
 * keon.cortex.feedback_request.v1 rules (the schema's per-kind contract): self-reported events
 * only. `correction` is not accepted — the contract explicitly rejects it ("a curation path is
 * pending"); `access_omitted` and `consideration` are accepted since Gateway 19f9c82. Fail closed (G-2).
 */
function checkFeedbackArguments(args: Record<string, unknown>): Record<string, unknown> {
  assertKnownKeys(TOOL_NAMES.feedback, args, [
    "kind", "occurred_at", "observed_at", "recall_event_id", "access_ref", "record_ids",
    "memory_id", "target_ref", "evidence_ref", "status", "context_ref", "reason", "detail", "disposition",
  ]);
  const kind = String(args.kind);
  if (kind === "correction") {
    throw new GatewayUnsupportedError(
      `feedback kind "${kind}" has no gateway tool: the ${TOOL_NAMES.feedback} contract rejects correction ` +
        `(a curation path for corrections is pending; write a new memory, or use supersede).`,
      { tool: TOOL_NAMES.feedback },
    );
  }
  if (!FEEDBACK_KINDS.has(kind)) {
    throw new GatewayContractError(`kind must be one of ${[...FEEDBACK_KINDS].join(" | ")}`, { tool: TOOL_NAMES.feedback });
  }
  if (args.occurred_at !== undefined) assertTime(args.occurred_at, "occurred_at");
  if (args.observed_at !== undefined) assertTime(args.observed_at, "observed_at");
  const needIdentifier = (key: string) => assertIdentifier(args[key], key);
  const needRef = (key: string) => assertString(args[key], key, 1, 256);
  switch (kind) {
    case "access": {
      needIdentifier("recall_event_id");
      const ids = args.record_ids;
      if (!Array.isArray(ids) || ids.length < 1 || ids.length > 100 || new Set(ids).size !== ids.length) {
        throw new GatewayContractError("record_ids must be 1 to 100 unique identifiers", { tool: TOOL_NAMES.feedback });
      }
      for (const id of ids) assertIdentifier(id, "record_ids[]");
      break;
    }
    case "access_omitted": {
      // An access plus a required reason; never counted as access.
      needIdentifier("recall_event_id");
      const ids = args.record_ids;
      if (!Array.isArray(ids) || ids.length < 1 || ids.length > 100 || new Set(ids).size !== ids.length) {
        throw new GatewayContractError("record_ids must be 1 to 100 unique identifiers", { tool: TOOL_NAMES.feedback });
      }
      for (const id of ids) assertIdentifier(id, "record_ids[]");
      assertString(args.reason, "reason", 1, 1024);
      break;
    }
    case "consideration": {
      // Not the feedback fields: access_ref is the recall event id; detail is not accepted.
      needIdentifier("access_ref");
      needIdentifier("memory_id");
      if (!CONSIDERATION_DISPOSITIONS.has(String(args.disposition))) {
        throw new GatewayContractError(`disposition must be one of ${[...CONSIDERATION_DISPOSITIONS].join(" | ")}`, { tool: TOOL_NAMES.feedback });
      }
      needRef("context_ref");
      if (args.detail !== undefined || args.reason !== undefined) {
        throw new GatewayContractError("consideration does not use detail or reason", { tool: TOOL_NAMES.feedback });
      }
      break;
    }
    case "application": {
      // The contract takes recall_event_id here; the gateway sends it to Cortex as access_ref.
      needIdentifier("recall_event_id");
      needIdentifier("memory_id");
      needRef("target_ref");
      if (args.evidence_ref !== undefined) needRef("evidence_ref");
      break;
    }
    case "outcome": {
      needIdentifier("memory_id");
      needRef("target_ref");
      const status = String(args.status);
      if (!OUTCOME_STATUSES.has(status)) throw new GatewayContractError(`status must be one of ${[...OUTCOME_STATUSES].join(" | ")}`, { tool: TOOL_NAMES.feedback });
      if (args.access_ref !== undefined) needIdentifier("access_ref");
      if (status === "success" || status === "failure") needRef("evidence_ref");
      else if (args.evidence_ref !== undefined) {
        throw new GatewayContractError(`outcome ${status} must not carry evidence: nothing was observed`, { tool: TOOL_NAMES.feedback });
      }
      break;
    }
    case "non_applicability": {
      needIdentifier("access_ref");
      needIdentifier("memory_id");
      needRef("context_ref");
      assertString(args.reason, "reason", 1, 1024);
      break;
    }
    case "feedback": {
      needIdentifier("memory_id");
      if (args.access_ref !== undefined) needIdentifier("access_ref");
      if (args.detail !== undefined) assertString(args.detail, "detail", 1, 1024);
      break;
    }
  }
  return args;
}

// ---------- curation argument checks (handler rules at 19f9c82, CortexCurationRules) ----------

const CURATION_KINDS = new Set(["lesson", "preference", "handoff"]);
const DISPOSE_ACTIONS = new Set(["approve", "reject", "supersede"]);
const LIST_STATUSES = new Set(["pending", "approved", "rejected"]);

function assertGrammarId(value: unknown, label: string): string {
  const v = assertString(value, label, 1, 128);
  return v;
}

function checkReason(args: Record<string, unknown>, tool: string): void {
  if (args.reason === undefined) return;
  const r = assertString(args.reason, "reason", 0, 1024);
  if (r.includes("\0")) throw new GatewayContractError("reason must not contain NUL", { tool });
}

function checkProposeArguments(args: Record<string, unknown>): Record<string, unknown> {
  const tool = TOOL_NAMES.curationPropose;
  assertKnownKeys(tool, args, ["kind", "source_record_ids", "content", "to_role_id", "epistemic_status", "reason"]);
  if (!CURATION_KINDS.has(String(args.kind))) throw new GatewayContractError("kind must be lesson, preference, or handoff", { tool });
  const ids = args.source_record_ids;
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > 64 || new Set(ids).size !== ids.length) {
    throw new GatewayContractError("source_record_ids must be 1 to 64 unique identifiers", { tool });
  }
  for (const id of ids) assertGrammarId(id, "source_record_ids[]");
  const content = assertString(args.content, "content", 1);
  if (content.trim().length === 0 || content.includes("\0")) throw new GatewayContractError("content is required, must not be whitespace, and must not contain NUL", { tool });
  assertUtf8Bytes(content, "content", MAX_CONTENT_BYTES, tool);
  if (args.kind === "handoff") {
    if (args.to_role_id === undefined) throw new GatewayContractError("to_role_id is required when kind is handoff", { tool });
    assertGrammarId(args.to_role_id, "to_role_id");
  } else if (args.to_role_id !== undefined) {
    throw new GatewayContractError("to_role_id is only accepted when kind is handoff", { tool });
  }
  if (args.epistemic_status !== undefined) assertGrammarId(args.epistemic_status, "epistemic_status");
  checkReason(args, tool);
  return args;
}

function checkDisposeArguments(args: Record<string, unknown>): Record<string, unknown> {
  const tool = TOOL_NAMES.curationDispose;
  assertKnownKeys(tool, args, ["proposal_id", "action", "supersedes_record_id", "reason"]);
  assertGrammarId(args.proposal_id, "proposal_id");
  if (!DISPOSE_ACTIONS.has(String(args.action))) throw new GatewayContractError("action must be approve, reject, or supersede", { tool });
  if (args.action === "supersede") {
    if (args.supersedes_record_id === undefined) throw new GatewayContractError("supersedes_record_id is required when action is supersede", { tool });
    assertGrammarId(args.supersedes_record_id, "supersedes_record_id");
  } else if (args.supersedes_record_id !== undefined) {
    throw new GatewayContractError("supersedes_record_id is only accepted when action is supersede", { tool });
  }
  checkReason(args, tool);
  return args;
}

/** keon.cortex.memory.search.v1 arguments (the handler's accepted set). */
function checkSearchArguments(tool: string, args: Record<string, unknown>): Record<string, unknown> {
  assertKnownKeys(tool, args, ["query", "limit"]);
  const query = assertString(args.query, "query", 1);
  if (query.trim().length === 0) throw new GatewayContractError("query must not be whitespace", { tool });
  if (args.limit !== undefined && (!Number.isInteger(args.limit) || (args.limit as number) < 1 || (args.limit as number) > 100)) {
    throw new GatewayContractError("limit must be an integer from 1 to 100", { tool });
  }
  return args;
}

/** keon.cortex.memory.list.v1 filters (the handler's accepted set, minus identity-shaped words). */
const LIST_MEMORY_TYPES = new Set(["claim", "belief", "lesson", "fact", "story", "observation", "decision", "artifact_link"]);
const LIST_TIME_FIELDS = new Set(["checkpoint_at", "created_at"]);

function checkMemoryListArguments(tool: string, args: Record<string, unknown>): Record<string, unknown> {
  // profile_id and scope are identity/shaping words (G-1): the listing context and its grants
  // come from the credential, never an argument. A per-call profile is opts.profileId.
  assertKnownKeys(tool, args, ["memory_type", "status", "time_field", "since", "until", "subject_key_prefix", "limit", "cursor"]);
  if (args.memory_type !== undefined && !LIST_MEMORY_TYPES.has(String(args.memory_type))) {
    throw new GatewayContractError(`memory_type must be one of ${[...LIST_MEMORY_TYPES].join(" | ")}`, { tool });
  }
  if (args.status !== undefined && args.status !== "active" && args.status !== "all") {
    throw new GatewayContractError("status must be active or all", { tool });
  }
  if (args.time_field !== undefined && !LIST_TIME_FIELDS.has(String(args.time_field))) {
    throw new GatewayContractError("time_field must be checkpoint_at or created_at", { tool });
  }
  if (args.since !== undefined) assertString(args.since, "since", 1, 64);
  if (args.until !== undefined) assertString(args.until, "until", 1, 64);
  if (args.subject_key_prefix !== undefined) assertString(args.subject_key_prefix, "subject_key_prefix", 1, 512);
  if (args.limit !== undefined && (!Number.isInteger(args.limit) || (args.limit as number) < 1 || (args.limit as number) > 500)) {
    throw new GatewayContractError("limit must be an integer from 1 to 500", { tool });
  }
  if (args.cursor !== undefined) assertString(args.cursor, "cursor", 1, 4096);
  return args;
}

/** ccm-atomic-batch-v1 §2.1: 1..8 keys, 1–128 chars of [A-Za-z0-9._:-], no duplicates. */
const UNIQUE_KEY_RE = /^[A-Za-z0-9._:-]{1,128}$/;

function checkUniqueKeys(value: unknown, label: string, tool: string): void {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.length < 1 || value.length > 8 || new Set(value).size !== value.length) {
    throw new GatewayContractError(`${label} must be 1 to 8 unique keys`, { tool });
  }
  for (const key of value) {
    if (typeof key !== "string" || !UNIQUE_KEY_RE.test(key)) {
      throw new GatewayContractError(`${label} entries must be 1 to 128 characters of A-Za-z0-9._:-`, { tool });
    }
  }
}

/** keon.cortex.curation_batch_request.v1 (ccm-atomic-batch-v1): 1..16 items, all or nothing. */
function checkBatchArguments(args: Record<string, unknown>): Record<string, unknown> {
  const tool = TOOL_NAMES.curationBatch;
  assertKnownKeys(tool, args, ["items"]);
  const items = args.items;
  if (!Array.isArray(items) || items.length < 1 || items.length > 16) {
    throw new GatewayContractError("items must be 1 to 16 batch items", { tool });
  }
  for (const raw of items) {
    const item = raw as Record<string, unknown>;
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      throw new GatewayContractError("each item must be an object", { tool });
    }
    assertKnownKeys(tool, item, ["write", "proposal", "disposition"]);
    // The item's own write, when present (the same shape as memory.write arguments).
    if (item.write !== undefined) {
      const write = item.write as Record<string, unknown>;
      if (write === null || typeof write !== "object" || Array.isArray(write)) throw new GatewayContractError("write must be an object", { tool });
      assertKnownKeys(`${tool} write`, write, ["content", "source", "memory_type", "memory_mode", "subject_keys", "belief_score", "unique_keys"]);
      const content = assertString(write.content, "write.content", 1);
      assertUtf8Bytes(content, "write.content", MAX_CONTENT_BYTES, tool);
      if (write.source !== undefined) assertString(write.source, "write.source", 1, 2048);
      if (write.memory_type !== undefined && !MEMORY_TYPES.has(String(write.memory_type))) {
        throw new GatewayContractError(`write.memory_type must be one of ${[...MEMORY_TYPES].join(" | ")}`, { tool });
      }
      if (write.memory_mode !== undefined && !MEMORY_MODES.has(String(write.memory_mode))) {
        throw new GatewayContractError(`write.memory_mode must be one of ${[...MEMORY_MODES].join(" | ")}`, { tool });
      }
      if (write.subject_keys !== undefined) {
        if (!Array.isArray(write.subject_keys) || write.subject_keys.length > 64 || write.subject_keys.some((k) => typeof k !== "string" || k.length > 256)) {
          throw new GatewayContractError("write.subject_keys must be an array of at most 64 strings of at most 256 characters", { tool });
        }
      }
      if (write.belief_score !== undefined && (typeof write.belief_score !== "number" || write.belief_score < 0 || write.belief_score > 1)) {
        throw new GatewayContractError("write.belief_score must be a number from 0.0 to 1.0", { tool });
      }
      checkUniqueKeys(write.unique_keys, "write.unique_keys", tool);
    }
    // The curated artifact.
    const proposal = item.proposal as Record<string, unknown>;
    if (proposal === undefined || proposal === null || typeof proposal !== "object" || Array.isArray(proposal)) {
      throw new GatewayContractError("each item needs a proposal", { tool });
    }
    assertKnownKeys(`${tool} proposal`, proposal, ["kind", "content", "source_record_ids", "to_role_id", "epistemic_status", "reason"]);
    if (!CURATION_KINDS.has(String(proposal.kind))) throw new GatewayContractError("proposal.kind must be lesson, preference, or handoff", { tool });
    const pContent = assertString(proposal.content, "proposal.content", 1);
    if (pContent.includes("\0")) throw new GatewayContractError("proposal.content must not contain NUL", { tool });
    assertUtf8Bytes(pContent, "proposal.content", MAX_CONTENT_BYTES, tool);
    const sources = proposal.source_record_ids;
    if (sources !== undefined) {
      if (!Array.isArray(sources) || sources.length > 64 || new Set(sources).size !== sources.length) {
        throw new GatewayContractError("proposal.source_record_ids must be 0 to 64 unique identifiers", { tool });
      }
      for (const id of sources) assertGrammarId(id, "proposal.source_record_ids[]");
    }
    if (proposal.kind === "handoff") {
      if (proposal.to_role_id === undefined) throw new GatewayContractError("to_role_id is required when kind is handoff", { tool });
      assertGrammarId(proposal.to_role_id, "proposal.to_role_id");
    } else if (proposal.to_role_id !== undefined) {
      throw new GatewayContractError("to_role_id is only accepted when kind is handoff", { tool });
    }
    if (proposal.epistemic_status !== undefined) assertGrammarId(proposal.epistemic_status, "proposal.epistemic_status");
    if (proposal.reason !== undefined) assertString(proposal.reason, "proposal.reason", 0, 1024);
    // The disposition: approve or supersede only — a batch publishes; reject is not a batch action.
    const disposition = item.disposition as Record<string, unknown>;
    if (disposition === undefined || disposition === null || typeof disposition !== "object" || Array.isArray(disposition)) {
      throw new GatewayContractError("each item needs a disposition", { tool });
    }
    assertKnownKeys(`${tool} disposition`, disposition, ["action", "supersedes_record_id", "reason", "unique_keys"]);
    const action = String(disposition.action);
    if (action !== "approve" && action !== "supersede") {
      throw new GatewayContractError("disposition.action must be approve or supersede (reject is not a batch action)", { tool });
    }
    if (action === "supersede") {
      if (disposition.supersedes_record_id === undefined) throw new GatewayContractError("supersedes_record_id is required when action is supersede", { tool });
      assertGrammarId(disposition.supersedes_record_id, "disposition.supersedes_record_id");
    } else if (disposition.supersedes_record_id !== undefined) {
      throw new GatewayContractError("supersedes_record_id is only accepted when action is supersede", { tool });
    }
    if (disposition.reason !== undefined) assertString(disposition.reason, "disposition.reason", 0, 1024);
    checkUniqueKeys(disposition.unique_keys, "disposition.unique_keys", tool);
    // An item needs a write or at least one source_record_id, except a bare supersede item.
    const namedSources = Array.isArray(sources) ? sources.length : 0;
    if (item.write === undefined && namedSources === 0 && !(action === "supersede" && disposition.supersedes_record_id !== undefined)) {
      throw new GatewayContractError("each item needs a write or at least one source_record_id (a bare supersede item sources itself from supersedes_record_id)", { tool });
    }
  }
  return args;
}

function checkListArguments(args: Record<string, unknown>): Record<string, unknown> {
  const tool = TOOL_NAMES.curationList;
  assertKnownKeys(tool, args, ["status", "source_record_id", "created_after", "cursor", "limit", "include_content"]);
  if (args.status !== undefined && !LIST_STATUSES.has(String(args.status))) {
    throw new GatewayContractError(args.status === "superseded" ? "status superseded is not a list filter" : "status must be pending, approved, or rejected", { tool });
  }
  if (args.source_record_id !== undefined) assertGrammarId(args.source_record_id, "source_record_id");
  if (args.created_after !== undefined) assertTime(args.created_after, "created_after");
  if (args.cursor !== undefined) {
    const c = assertString(args.cursor, "cursor", 1, 1024);
    if (/[\s\u0000-\u001f\u007f]/.test(c)) throw new GatewayContractError("cursor must be an opaque string without whitespace", { tool });
  }
  if (args.limit !== undefined && (typeof args.limit !== "number" || !Number.isInteger(args.limit) || args.limit < 1 || args.limit > 100)) {
    throw new GatewayContractError("limit must be an integer from 1 to 100", { tool });
  }
  if (args.include_content !== undefined && typeof args.include_content !== "boolean") throw new GatewayContractError("include_content must be a boolean", { tool });
  return args;
}

// ---------- JSON-RPC message parsing (plain JSON body or an SSE stream of data: frames) ----------

type RpcMessage = { error?: { code?: number; message?: string }; result?: unknown } | undefined;

function parseJsonRpc(res: { contentType: string; text: string }, id: string | undefined, method: string): RpcMessage {
  const bodies = res.contentType.includes("text/event-stream") ? sseDataFrames(res.text) : [res.text];
  let parsed: RpcMessage = undefined;
  let sawJson = false;
  for (const body of bodies) {
    if (!body.trim()) continue;
    try {
      const msg = JSON.parse(body) as { id?: unknown } & NonNullable<RpcMessage>;
      sawJson = true;
      if (id === undefined || msg.id === undefined || String(msg.id) === id) parsed = msg;
    } catch {
      // skip a non-message frame
    }
  }
  if (!sawJson && !parsed) throw new GatewayContractError(`gateway returned a non-JSON response for ${method}`, { detail: res.text.slice(0, 200) });
  return parsed;
}

/** The `data:` payloads of one SSE stream (Streamable HTTP's other response body type). */
function sseDataFrames(text: string): string[] {
  const frames: string[] = [];
  for (const block of text.split(/\n\n/)) {
    const data = block
      .split(/\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (data) frames.push(data);
  }
  return frames;
}

// ---------- client ----------

const MCP_PROTOCOL_VERSION = "2025-06-18";
const CONTENT_TRUST = "untrusted_data_not_instructions";

export class GatewayClient {
  readonly conn: GatewayConnection;
  private initialized = false;

  constructor(conn: GatewayConnection) {
    this.conn = conn;
  }

  // ----- transport -----

  private headers(): Record<string, string> {
    const auth: Record<string, string> =
      this.conn.auth.kind === "bearer"
        ? { Authorization: `Bearer ${this.conn.auth.token}` }
        : { "X-Api-Key": this.conn.auth.apiKey, "X-Keon-Tenant-Id": this.conn.auth.tenantId, "X-Keon-Actor-Id": this.conn.auth.actorId };
    return {
      "Content-Type": "application/json",
      // Streamable HTTP: a client's POST Accept must list both content types (the server may
      // answer an SSE stream instead of a plain JSON body).
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": MCP_PROTOCOL_VERSION,
      ...(this.sessionId ? { "Mcp-Session-Id": this.sessionId } : {}),
      ...auth,
    };
  }

  /** The server-assigned Streamable HTTP session (Mcp-Session-Id), if it hands one out. */
  private sessionId: string | undefined;

  private async post(payload: Record<string, unknown>): Promise<{ status: number; contentType: string; text: string; sessionId: string | undefined }> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.conn.timeoutMs);
    try {
      let res: Response;
      let text: string;
      try {
        res = await fetch(this.conn.endpoint, {
          method: "POST",
          headers: this.headers(),
          body: JSON.stringify(payload),
          signal: ctrl.signal,
        });
        text = await res.text();
      } catch (e) {
        const why = e instanceof Error ? e.message : String(e);
        throw new GatewayError(`gateway unreachable at ${this.conn.endpoint} (${why})`);
      }
      return {
        status: res.status,
        contentType: res.headers.get("content-type") ?? "",
        text,
        sessionId: res.headers.get("mcp-session-id") ?? undefined,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * One JSON-RPC exchange. Streamable HTTP may answer either an `application/json` JSON-RPC
   * message or a `text/event-stream` SSE stream of `data:` frames; both are parsed here. A
   * notification (no `id`) is fire-and-forget: its response body is often empty.
   */
  private async rpc(method: string, params: Record<string, unknown>, notify = false): Promise<unknown> {
    const id = notify ? undefined : mintId("mcp");
    const payload: Record<string, unknown> = { jsonrpc: "2.0", method, params, ...(id ? { id } : {}) };
    const res = await this.post(payload);
    if (res.sessionId && !this.sessionId) this.sessionId = res.sessionId;
    if (notify) {
      if (res.status >= 400) throw new GatewayError(`gateway ${res.status} on ${method}`, { detail: res.text.slice(0, 200) });
      return undefined;
    }
    const msg = parseJsonRpc(res, id, method);
    if (!msg) throw new GatewayContractError(`gateway response did not carry the reply for ${method} (id ${id})`, { detail: res.text.slice(0, 200) });
    if (res.status >= 400 && !msg.error) throw new GatewayError(`gateway ${res.status} on ${method}`, { detail: res.text.slice(0, 200) });
    if (msg.error) {
      // A JSON-RPC error may carry the governed error envelope in `data` (tools/list refusals do).
      const data = (msg.error as { data?: { error?: { code?: unknown; message?: unknown; http_status?: unknown; retryable?: unknown } } }).data;
      const refused = refusalFrom(data?.error, undefined, msg.error);
      if (refused) throw refused;
      throw new GatewayError(`gateway refused ${method}: ${msg.error.message ?? "unknown error"} (code ${msg.error.code ?? "?"})`, { detail: msg.error });
    }
    return msg.result;
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return;
    const result = (await this.rpc("initialize", {
      protocolVersion: MCP_PROTOCOL_VERSION,
      clientInfo: { name: "continuity", version: "0.1.0" },
      capabilities: {},
    })) as { protocolVersion?: unknown } | undefined;
    if (!result || typeof result.protocolVersion !== "string") {
      throw new GatewayContractError("gateway initialize returned no protocolVersion");
    }
    // Streamable HTTP handshake: the initialized notification completes it (best-effort — a
    // server that answers 202/empty is fine; a hard failure still surfaces).
    await this.rpc("notifications/initialized", {}, true);
    this.initialized = true;
  }

  // ----- discovery -----

  /** MCP `tools/list` — what this gateway actually exposes (fail closed on anything absent). */
  async listTools(): Promise<GatewayToolDescriptor[]> {
    await this.ensureInitialized();
    const result = (await this.rpc("tools/list", {})) as { tools?: unknown } | undefined;
    const tools = result?.tools;
    if (!Array.isArray(tools)) throw new GatewayContractError("tools/list returned no tools array");
    return tools.map((t) => {
      const tool = t as { name?: unknown; description?: unknown; inputSchema?: unknown };
      return {
        name: assertIdentifier(tool.name, "tool name"),
        description: typeof tool.description === "string" ? tool.description : "",
        input_schema: (tool.inputSchema as Record<string, unknown> | undefined) ?? undefined,
      };
    });
  }

  // ----- the tool funnel (G-1, G-2) -----

  /**
   * One `tools/call`. The only place bytes go to the gateway. Refuses identity arguments before
   * anything is sent, checks the request against the per-tool contract, and fails closed on any
   * response the contract cannot explain (wrong tool, missing receipts, an error envelope).
   */
  async invoke(tool: string, args: Record<string, unknown>, opts: { profileId?: string } = {}): Promise<GatewayEnvelope> {
    if (!CONTRACT_TOOL_NAMES.has(tool)) throw new GatewayUnsupportedError(`"${tool}" is not a tool on the gateway surface (contracts/mcp_gateway.v1.schema.json ToolName)`, { tool });
    assertNoIdentityArguments(tool, args);
    const checked =
      tool === TOOL_NAMES.recall ? checkRecallArguments(args)
      : tool === TOOL_NAMES.write ? checkWriteArguments(args)
      : tool === TOOL_NAMES.search ? checkSearchArguments(tool, args)
      : tool === TOOL_NAMES.list ? checkMemoryListArguments(tool, args)
      : tool === TOOL_NAMES.feedback ? checkFeedbackArguments(args)
      : tool === TOOL_NAMES.curationPropose ? checkProposeArguments(args)
      : tool === TOOL_NAMES.curationDispose ? checkDisposeArguments(args)
      : tool === TOOL_NAMES.curationList ? checkListArguments(args)
      : tool === TOOL_NAMES.curationBatch ? checkBatchArguments(args)
      : args; // other contract tools: shape checking is their handler's job; identity refusal above still applies
    // G-5: the per-call profile. A per-call option (client code, never a tool argument) beats the
    // connection's; an API-key client with neither fails closed here, before anything is sent.
    const profileId = opts.profileId !== undefined ? assertProfileId(opts.profileId, "profileId") : this.conn.profileId !== undefined ? assertProfileId(this.conn.profileId, "connection profileId") : undefined;
    if (profileId === undefined && this.conn.auth.kind === "api-key") throw new GatewayProfileError(NO_PROFILE_MESSAGE);
    await this.ensureInitialized();
    // `profile_id` rides on `params`, NEXT TO `arguments`, never inside it (Gateway #60).
    const result = (await this.rpc("tools/call", { name: tool, arguments: checked, ...(profileId !== undefined ? { profile_id: profileId } : {}) })) as
      | { content?: unknown; structuredContent?: unknown; isError?: unknown }
      | undefined;
    const envelope = result?.structuredContent as GatewayEnvelope | undefined;
    if (!envelope || typeof envelope !== "object") {
      throw new GatewayContractError(`gateway tools/call returned no structuredContent envelope for ${tool}`, { tool });
    }
    if (envelope.tool !== tool) throw new GatewayContractError(`envelope is for ${envelope.tool}, not ${tool}`, { tool });
    if (typeof envelope.correlation_id !== "string" || envelope.correlation_id.length === 0) {
      throw new GatewayContractError("envelope carries no correlation_id", { tool });
    }
    if (result?.isError === true || envelope.ok === false) {
      const err = envelope.error;
      const refused = refusalFrom(err, tool, envelope);
      if (refused) throw refused;
      throw new GatewayError(
        `gateway refused ${tool}: ${err?.message ?? "tool error"} (${err?.code ?? "unknown"}${err?.http_status ? `, http ${err.http_status}` : ""})`,
        { tool, detail: envelope },
      );
    }
    if (envelope.ok !== true || !envelope.decision || !envelope.receipts) {
      throw new GatewayContractError("envelope is not a ToolsInvokeResponseSuccess (ok/decision/receipts)", { tool, detail: envelope });
    }
    // mcp_gateway.v1 lets a decision denial ride with ok=true ("other tool decision-denial
    // contracts retain ok=true"): never read that as success.
    if (envelope.decision.status === "denied") {
      throw new GatewayError(`gateway denied ${tool} (policy ${envelope.decision.policy_hash ?? "?"}: ${String(envelope.decision.reason_code ?? "denied")})`, { tool, detail: envelope });
    }
    return envelope;
  }

  // ----- the mapped operations -----

  /**
   * briefing → memory.recall (kind: briefing). Recalled content is untrusted data (G-3).
   * This raw gateway recall stays one union query (`BRIEFING_QUERY`): the gateway contract is
   * one request. `buildBriefing` does not call it — that path recalls one tag at a time.
   */
  async briefing(opts: { limit?: number } = {}): Promise<GatewayRecallResult> {
    const args: Record<string, unknown> = { query: BRIEFING_QUERY, kind: "briefing" };
    if (opts.limit !== undefined) args.limit = opts.limit;
    return this.recallResult(await this.invoke(TOOL_NAMES.recall, args));
  }

  /** recall → memory.recall (kind: recall). */
  async recall(query: string, opts: { limit?: number } = {}): Promise<GatewayRecallResult> {
    const args: Record<string, unknown> = { query, kind: "recall" };
    if (opts.limit !== undefined) args.limit = opts.limit;
    return this.recallResult(await this.invoke(TOOL_NAMES.recall, args));
  }

  /**
   * remember → memory.write (G-4). The user-confirmed record is written through the governed
   * write; the receipt it returns is the whole truth. The local path's curation promotion is not
   * part of this surface (`share` fails closed), so this never claims "shared with every agent".
   * Like the local remember, it refuses without `userConfirmed` — writing what "you said" needs
   * the user to have said it.
   */
  async remember(input: GatewayWriteInput & { userConfirmed: boolean }): Promise<GatewayWriteResult> {
    if (input.userConfirmed !== true) {
      throw new GatewayError("remember writes what the user said — only after the user confirmed it in conversation (userConfirmed: true)");
    }
    return this.writeResult(await this.invoke(TOOL_NAMES.write, {
      content: input.content,
      ...(input.source !== undefined ? { source: input.source } : { source: "continuity/remember" }),
      ...(input.memoryType !== undefined ? { memory_type: input.memoryType } : {}),
      ...(input.memoryMode !== undefined ? { memory_mode: input.memoryMode } : {}),
      // subject_keys are recall surface (topic tags), not status flags; `source` carries the
      // remember/stage distinction. "continuity" keeps these records findable as ours.
      subject_keys: [...(input.subjectKeys ?? []), "continuity"],
      ...(input.beliefScore !== undefined ? { belief_score: input.beliefScore } : {}),
      // TASK-135: ccm-atomic-batch-v1 claimable keys — pass through on single writes (TASK-134
      // added them here and on batch items; the single dispose path does not carry them).
      ...(input.uniqueKeys?.length ? { unique_keys: [...input.uniqueKeys] } : {}),
    }));
  }

  /** stage → memory.write (G-4): an agent-inferred record, kept as the write receipt says. */
  async stage(input: GatewayWriteInput): Promise<GatewayWriteResult> {
    return this.writeResult(await this.invoke(TOOL_NAMES.write, {
      content: input.content,
      ...(input.source !== undefined ? { source: input.source } : { source: "continuity/stage" }),
      ...(input.memoryType !== undefined ? { memory_type: input.memoryType } : {}),
      ...(input.memoryMode !== undefined ? { memory_mode: input.memoryMode } : {}),
      subject_keys: [...(input.subjectKeys ?? []), "continuity"],
      ...(input.beliefScore !== undefined ? { belief_score: input.beliefScore } : {}),
      ...(input.uniqueKeys?.length ? { unique_keys: [...input.uniqueKeys] } : {}),
    }));
  }

  /**
   * feedback → memory.feedback. Self-reported events only: access | application | outcome |
   * non_applicability | feedback. `correction` and `consideration` fail closed (G-2).
   */
  async feedback(event: Record<string, unknown>): Promise<GatewayFeedbackResult> {
    const envelope = await this.invoke(TOOL_NAMES.feedback, event);
    const r = envelope.result ?? {};
    const result: GatewayFeedbackResult = {
      attribution: String(r.attribution ?? ""),
      event_ids: Array.isArray(r.event_ids) ? r.event_ids.map(String) : [],
      operation_id: String(r.operation_id ?? ""),
      replay_equivalent_record_ids: Array.isArray(r.replay_equivalent_record_ids) ? r.replay_equivalent_record_ids.map(String) : [],
      replayed: r.replayed === true,
    };
    if (!result.attribution || !result.operation_id) {
      throw new GatewayContractError("feedback acknowledgement carries no attribution/operation_id", { tool: TOOL_NAMES.feedback, detail: r });
    }
    return result;
  }

  // ----- curation (Gateway #59: propose · dispose · list) -----

  /** keon.cortex.curation.propose.v1 — propose promoting source records (no capability needed). */
  async propose(input: { kind: "lesson" | "preference" | "handoff"; sourceRecordIds: string[]; content: string; reason?: string; toRoleId?: string; epistemicStatus?: string }): Promise<GatewayProposeResult> {
    const envelope = await this.invoke(TOOL_NAMES.curationPropose, {
      kind: input.kind,
      source_record_ids: input.sourceRecordIds,
      content: input.content,
      ...(input.toRoleId !== undefined ? { to_role_id: input.toRoleId } : {}),
      ...(input.epistemicStatus !== undefined ? { epistemic_status: input.epistemicStatus } : {}),
      ...(input.reason !== undefined ? { reason: input.reason } : {}),
    });
    const r = (envelope.result ?? {}) as Record<string, unknown>;
    if (typeof r.proposal_id !== "string" || r.proposal_id.length === 0) {
      throw new GatewayContractError("propose acknowledgement carries no proposal_id", { tool: TOOL_NAMES.curationPropose, detail: r });
    }
    return { operation_id: String(r.operation_id ?? ""), proposal_id: r.proposal_id, replayed: r.replayed === true, status: String(r.status ?? "") };
  }

  /**
   * keon.cortex.curation.dispose.v1. `approve` and `supersede` need the enrollment capability
   * `curation.approve` (the Gateway refuses with CORTEX_CAPABILITY_REQUIRED before anything runs);
   * `reject` does not. The approval receipt is the Gateway's own Runtime decision — never an argument.
   */
  async dispose(input: { proposalId: string; action: "approve" | "reject" | "supersede"; supersedesRecordId?: string; reason?: string }): Promise<GatewayDisposeResult> {
    const envelope = await this.invoke(TOOL_NAMES.curationDispose, {
      proposal_id: input.proposalId,
      action: input.action,
      ...(input.supersedesRecordId !== undefined ? { supersedes_record_id: input.supersedesRecordId } : {}),
      ...(input.reason !== undefined ? { reason: input.reason } : {}),
    });
    const r = (envelope.result ?? {}) as Record<string, unknown>;
    const result: GatewayDisposeResult = {
      action: String(r.action ?? ""),
      derived_shard_id: typeof r.derived_shard_id === "string" && r.derived_shard_id ? r.derived_shard_id : null,
      disposition_id: String(r.disposition_id ?? ""),
      inheritance_event_id: typeof r.inheritance_event_id === "string" ? r.inheritance_event_id : null,
      operation_id: String(r.operation_id ?? ""),
      proposal_id: String(r.proposal_id ?? ""),
      replayed: r.replayed === true,
      status: String(r.status ?? ""),
    };
    if (!result.disposition_id || !result.proposal_id) {
      throw new GatewayContractError("dispose acknowledgement carries no disposition_id/proposal_id", { tool: TOOL_NAMES.curationDispose, detail: r });
    }
    if (result.action !== input.action) {
      throw new GatewayContractError(`dispose acknowledged action "${result.action}", not "${input.action}"`, { tool: TOOL_NAMES.curationDispose, detail: r });
    }
    return result;
  }

  /** keon.cortex.curation.list.v1 — read-only; CORTEX_ROUTE_UNAVAILABLE when Cortex lacks the route. Proposal content is untrusted data (G-3). */
  async listProposals(q: { status?: "pending" | "approved" | "rejected"; sourceRecordId?: string; createdAfter?: string; cursor?: string; limit?: number; includeContent?: boolean } = {}): Promise<GatewayProposalList> {
    const envelope = await this.invoke(TOOL_NAMES.curationList, {
      ...(q.status !== undefined ? { status: q.status } : {}),
      ...(q.sourceRecordId !== undefined ? { source_record_id: q.sourceRecordId } : {}),
      ...(q.createdAfter !== undefined ? { created_after: q.createdAfter } : {}),
      ...(q.cursor !== undefined ? { cursor: q.cursor } : {}),
      ...(q.limit !== undefined ? { limit: q.limit } : {}),
      ...(q.includeContent !== undefined ? { include_content: q.includeContent } : {}),
    });
    const r = (envelope.result ?? {}) as Record<string, unknown>;
    if (!Array.isArray(r.proposals)) throw new GatewayContractError("curation list carries no proposals array", { tool: TOOL_NAMES.curationList, detail: r });
    return { proposals: r.proposals as Record<string, unknown>[], next_cursor: typeof r.next_cursor === "string" ? r.next_cursor : null };
  }

  /** keon.cortex.memory.search.v1 — an internal candidate read (no delivery semantics, no access accounting). Rows are untrusted data (G-3). */
  async search(query: string, opts: { limit?: number; profileId?: string } = {}): Promise<GatewaySearchResult> {
    const envelope = await this.invoke(
      TOOL_NAMES.search,
      { query, ...(opts.limit !== undefined ? { limit: opts.limit } : {}) },
      opts.profileId !== undefined ? { profileId: opts.profileId } : {},
    );
    const r = (envelope.result ?? {}) as Record<string, unknown>;
    if (!Array.isArray(r.shards)) throw new GatewayContractError("search acknowledgement carries no shards array", { tool: TOOL_NAMES.search, detail: r });
    return {
      shards: r.shards as GatewaySearchHit[],
      total: typeof r.total === "number" ? r.total : (r.shards as unknown[]).length,
      query: typeof r.query === "string" ? r.query : query,
    };
  }

  /**
   * keon.cortex.memory.list.v1 — a cursor-paged candidate/browse read (Cortex GET /v1/shards).
   * No lexical query, no recall/access/gravity event. The context profile comes from
   * opts.profileId (checked against the enrollment's AllowedProfiles), never an argument; the
   * visible record set is the binding's own grants. A 404/405 is CORTEX_ROUTE_UNAVAILABLE —
   * callers may fall back, but must report the fallback honestly. Rows are untrusted data (G-3).
   */
  async list(
    q: { memoryType?: string; status?: "active" | "all"; timeField?: "checkpoint_at" | "created_at"; since?: string; until?: string; subjectKeyPrefix?: string; limit?: number; cursor?: string } = {},
    opts: { profileId?: string } = {},
  ): Promise<GatewayListResult> {
    const args: Record<string, unknown> = {
      ...(q.memoryType !== undefined ? { memory_type: q.memoryType } : {}),
      ...(q.status !== undefined ? { status: q.status } : {}),
      ...(q.timeField !== undefined ? { time_field: q.timeField } : {}),
      ...(q.since !== undefined ? { since: q.since } : {}),
      ...(q.until !== undefined ? { until: q.until } : {}),
      ...(q.subjectKeyPrefix !== undefined ? { subject_key_prefix: q.subjectKeyPrefix } : {}),
      ...(q.limit !== undefined ? { limit: q.limit } : {}),
      ...(q.cursor !== undefined ? { cursor: q.cursor } : {}),
    };
    const envelope = await this.invoke(TOOL_NAMES.list, args, opts.profileId !== undefined ? { profileId: opts.profileId } : {});
    const r = (envelope.result ?? {}) as Record<string, unknown>;
    if (!Array.isArray(r.shards)) throw new GatewayContractError("list acknowledgement carries no shards array", { tool: TOOL_NAMES.list, detail: r });
    if (!(r.next_cursor === null || (typeof r.next_cursor === "string" && r.next_cursor.length > 0))) {
      throw new GatewayContractError("list acknowledgement carries an invalid next_cursor", { tool: TOOL_NAMES.list, detail: r });
    }
    return { shards: r.shards as GatewaySearchHit[], next_cursor: r.next_cursor as string | null };
  }

  /**
   * keon.cortex.curation.batch.v1 (TASK-134, ccm-atomic-batch-v1): 1..16 items published
   * atomically in one Cortex transaction — each an optional source write plus a proposal and
   * an approve/supersede disposition. Requires the enrollment capability `curation.approve`;
   * `approval_receipt_ref` is the Gateway's own Runtime decision — never an argument. A taken
   * `unique_keys` key is refused naming the key and nothing is written.
   */
  async curationBatch(input: { items: GatewayCurationBatchItem[] }, opts: { profileId?: string } = {}): Promise<GatewayCurationBatchResult> {
    const items = input.items.map((item) => ({
      ...(item.write
        ? {
            write: {
              content: item.write.content,
              ...(item.write.source !== undefined ? { source: item.write.source } : {}),
              ...(item.write.memoryType !== undefined ? { memory_type: item.write.memoryType } : {}),
              ...(item.write.memoryMode !== undefined ? { memory_mode: item.write.memoryMode } : {}),
              ...(item.write.subjectKeys !== undefined ? { subject_keys: item.write.subjectKeys } : {}),
              ...(item.write.beliefScore !== undefined ? { belief_score: item.write.beliefScore } : {}),
              ...(item.write.uniqueKeys !== undefined ? { unique_keys: item.write.uniqueKeys } : {}),
            },
          }
        : {}),
      proposal: {
        kind: item.proposal.kind,
        content: item.proposal.content,
        ...(item.proposal.sourceRecordIds !== undefined ? { source_record_ids: item.proposal.sourceRecordIds } : {}),
        ...(item.proposal.toRoleId !== undefined ? { to_role_id: item.proposal.toRoleId } : {}),
        ...(item.proposal.epistemicStatus !== undefined ? { epistemic_status: item.proposal.epistemicStatus } : {}),
        ...(item.proposal.reason !== undefined ? { reason: item.proposal.reason } : {}),
      },
      disposition: {
        action: item.disposition.action,
        ...(item.disposition.supersedesRecordId !== undefined ? { supersedes_record_id: item.disposition.supersedesRecordId } : {}),
        ...(item.disposition.reason !== undefined ? { reason: item.disposition.reason } : {}),
        ...(item.disposition.uniqueKeys !== undefined ? { unique_keys: item.disposition.uniqueKeys } : {}),
      },
    }));
    const envelope = await this.invoke(TOOL_NAMES.curationBatch, { items }, opts.profileId !== undefined ? { profileId: opts.profileId } : {});
    const r = (envelope.result ?? {}) as Record<string, unknown>;
    if (typeof r.batch_id !== "string" || typeof r.receipt_id !== "string" || !Array.isArray(r.items)) {
      throw new GatewayContractError("batch acknowledgement carries no batch_id/receipt_id/items", { tool: TOOL_NAMES.curationBatch, detail: r });
    }
    const result = r as unknown as GatewayCurationBatchResult;
    if (result.items.length !== input.items.length) {
      throw new GatewayContractError(`batch acknowledged ${result.items.length} item(s) for ${input.items.length} — refusing an unaccounted publication`, { tool: TOOL_NAMES.curationBatch, detail: r });
    }
    for (const row of result.items) {
      if (typeof row.derived_shard_id !== "string" || row.derived_shard_id.length === 0) {
        throw new GatewayContractError("batch item carries no derived_shard_id — it is not counted as published", { tool: TOOL_NAMES.curationBatch, detail: r });
      }
    }
    return result;
  }

  /**
   * share → propose (lesson) then dispose (approve). Like the local share it needs the user's
   * confirmation (`userConfirmed`), the source record id and the text to promote (normally the
   * staged record's text). Approval needs the enrollment capability `curation.approve`: when the
   * Gateway refuses, the proposal that was created stays PENDING, nothing is shared, and the error
   * says so (G-4). The local path's baton/schema pre-checks need a get-shard call this surface does
   * not have, so they do not run here.
   */
  async share(sourceId: string | undefined, content: string | undefined, opts: { userConfirmed?: boolean; reason?: string } = {}): Promise<GatewayShareResult> {
    if (opts.userConfirmed !== true) throw new GatewayError("share promotes a record to shared memory — only after the user confirmed it in conversation (userConfirmed: true)");
    if (!sourceId || !content?.trim()) throw new GatewayError("usage: share <source-record-id> <the text to share> — both are required; nothing was sent");
    const reason = opts.reason ?? "user confirmed via the continuity gateway transport";
    const proposal = await this.propose({ kind: "lesson", sourceRecordIds: [sourceId], content, reason });
    let disposition: GatewayDisposeResult;
    try {
      disposition = await this.dispose({ proposalId: proposal.proposal_id, action: "approve", reason });
    } catch (e) {
      throw new GatewayCurationIncompleteError(
        `NOT shared: proposal ${proposal.proposal_id} was created and stays pending, but approving it failed — ${errMessage(e)}`,
        { proposalId: proposal.proposal_id },
        e,
      );
    }
    if (!disposition.derived_shard_id) {
      throw new GatewayCurationIncompleteError(
        `NOT shared: approval of proposal ${proposal.proposal_id} returned no derived_shard_id (status ${disposition.status}) — it is not counted as shared`,
        { proposalId: proposal.proposal_id },
        undefined,
      );
    }
    return { shared: true, derived_shard_id: disposition.derived_shard_id, source_record_id: sourceId, proposal, disposition };
  }

  /**
   * supersede → write the replacement text (user-confirmed), propose it as a lesson sourced on
   * that write, then dispose (supersede) with `supersedes_record_id` = the old shared record. Same
   * capability rule as share. Honest gap: the local path also reports a `correction` audit event;
   * the Gateway's feedback contract rejects `correction`, so none is emitted — the disposition is
   * the record of truth. If a later step fails, the error lists what already exists (the private
   * write, the pending proposal) and that nothing was superseded.
   */
  async supersede(oldRecordId: string | undefined, newContent: string | undefined, opts: { userConfirmed?: boolean; reason?: string } = {}): Promise<GatewaySupersedeResult> {
    if (opts.userConfirmed !== true) throw new GatewayError("supersede replaces a shared record — only after the user confirmed it in conversation (userConfirmed: true)");
    if (!oldRecordId || !newContent?.trim()) throw new GatewayError("usage: supersede <shared-record-id> <the new text> — both are required; nothing was sent");
    const reason = opts.reason ?? "user superseded via the continuity gateway transport";
    const written = await this.writeResult(await this.invoke(TOOL_NAMES.write, {
      content: newContent,
      source: "continuity/supersede",
      subject_keys: ["continuity"],
    }));
    const progress: { writtenShardId?: string; proposalId?: string } = { writtenShardId: written.shard_id };
    let proposal: GatewayProposeResult;
    try {
      proposal = await this.propose({ kind: "lesson", sourceRecordIds: [written.shard_id], content: newContent, reason });
    } catch (e) {
      throw new GatewayCurationIncompleteError(
        `NOT superseded: the replacement text was written privately as ${written.shard_id}, but proposing it failed — ${errMessage(e)}`,
        progress,
        e,
      );
    }
    progress.proposalId = proposal.proposal_id;
    let disposition: GatewayDisposeResult;
    try {
      disposition = await this.dispose({ proposalId: proposal.proposal_id, action: "supersede", supersedesRecordId: oldRecordId, reason });
    } catch (e) {
      throw new GatewayCurationIncompleteError(
        `NOT superseded: ${oldRecordId} is unchanged. The replacement was written privately as ${written.shard_id} and proposal ${proposal.proposal_id} stays pending — ${errMessage(e)}`,
        progress,
        e,
      );
    }
    if (!disposition.derived_shard_id) {
      throw new GatewayCurationIncompleteError(
        `NOT superseded: the supersede disposition for proposal ${proposal.proposal_id} returned no derived_shard_id (status ${disposition.status}) — ${oldRecordId} is not counted as replaced`,
        progress,
        undefined,
      );
    }
    return { superseded: true, old_record_id: oldRecordId, derived_shard_id: disposition.derived_shard_id, written, proposal, disposition, correction_event: "not emitted: the gateway feedback contract rejects correction" };
  }

  /**
   * close → STILL FAILS CLOSED (G-2). Closing an open loop is a supersede whose text is built from
   * the old record's own content and its [open-loop] tag; this surface has no get-shard tool, so
   * the closure text would be a guess. State the closure text yourself with `supersede`.
   */
  async close(_id?: string, _evidence?: string): Promise<never> {
    throw new GatewayUnsupportedError(
      "unsupported on the Keon MCP Gateway transport: close builds its closure text from the old record's content and [open-loop] tag, and this surface has no get-shard tool, so it would be a guess. " +
        "Nothing was written. Use `continuity gateway supersede <shared-record-id> <the closed text> --user-confirmed` with the closure text spelled out.",
    );
  }

  // ----- result checks (G-3) -----

  private recallResult(envelope: GatewayEnvelope): GatewayRecallResult {
    const r = (envelope.result ?? {}) as Record<string, unknown>;
    // A delivery without a recall event id cannot be accounted for: refuse rather than hand it to an agent.
    const recallEventId = r.recall_event_id;
    if (typeof recallEventId !== "string" || recallEventId.length === 0) {
      throw new GatewayContractError("response carried no recall_event_id; refusing to use an unaccounted delivery", { tool: TOOL_NAMES.recall, detail: r });
    }
    if (r.content_trust !== CONTENT_TRUST) {
      throw new GatewayContractError(`response content_trust is ${JSON.stringify(r.content_trust)}, not ${CONTENT_TRUST}; refusing a delivery that does not mark its content as untrusted data`, { tool: TOOL_NAMES.recall, detail: r });
    }
    if (!Array.isArray(r.results)) throw new GatewayContractError("recall response carries no results array", { tool: TOOL_NAMES.recall, detail: r });
    return {
      recall_event_id: recallEventId,
      operation_id: String(r.operation_id ?? ""),
      results: r.results.map((hit) => {
        const h = hit as Record<string, unknown>;
        return {
          shard_id: String(h.shard_id ?? ""),
          content: String(h.content ?? ""),
          memory_type: String(h.memory_type ?? ""),
          rank: Number(h.rank ?? 0),
          relevance_score: Number(h.relevance_score ?? 0),
          gravity_score: Number(h.gravity_score ?? 0),
          verified: h.verified === true,
        };
      }),
      verification_meta: (r.verification_meta as Record<string, unknown>) ?? {},
      gravity_version: String(r.gravity_version ?? ""),
      gravity_function_hash: String(r.gravity_function_hash ?? ""),
      gravity_as_of: String(r.gravity_as_of ?? ""),
      delivery: (r.delivery as Record<string, unknown>) ?? {},
      content_trust: String(r.content_trust),
    };
  }

  private writeResult(envelope: GatewayEnvelope): GatewayWriteResult {
    const r = (envelope.result ?? {}) as Record<string, unknown>;
    const result: GatewayWriteResult = {
      shard_id: String(r.shard_id ?? ""),
      decision_id: String(r.decision_id ?? ""),
      store_ack_id: String(r.store_ack_id ?? ""),
      correlation_id: String(r.correlation_id ?? envelope.correlation_id ?? ""),
      curation_promoted: false,
    };
    if (!result.shard_id || !result.store_ack_id) {
      throw new GatewayContractError("write result carries no shard_id/store_ack_id", { tool: TOOL_NAMES.write, detail: r });
    }
    return result;
  }
}
