/**
 * Thin, dependency-free client for the Keon Cortex HTTP API (protocol shards/1.1).
 *
 * Mirrors keon-cortex/docs/integration.md §3–§6. Nothing here is clever: it
 * builds the carriage headers for one identity, mints operation/receipt ids,
 * and surfaces Cortex's fail-closed errors as typed exceptions.
 *
 * Two identities matter for Kontinuity (see SKETCH-wave0.md §2):
 *   - the agent role (writes role-private shards, proposes curation)
 *   - the owner role (approves curation → profile_shared)
 * Use `client.as(identity)` to switch; config/secret are shared.
 */

import { assertId, derivedId, mintId } from "./ids.ts";

// ---------- identity & carriage ----------

export interface Identity {
  actorId: string;
  profileId: string;
  roleId: string;
  /** Grant scope tokens; sorted + comma-joined on the wire. */
  grants: string[];
}

export interface CortexConnection {
  baseUrl: string;
  secret: string;
  tenantId: string;
  /** Default fetch timeout in ms for non-recall requests. */
  timeoutMs?: number;
  /** Recall ranks all matching candidates before applying limit; default 30s. */
  recallTimeoutMs?: number;
}

/** Grant-token builders so callers don't hand-type the grammar. */
export const grant = {
  role: (profileId: string, roleId: string) => `role:${profileId}:${roleId}`,
  profileShared: (profileId: string) => `profile:${profileId}:shared`,
  handoff: (profileId: string, roleId: string) => `handoff:${profileId}:${roleId}`,
  curationApprove: "cap:curation.approve",
} as const;

// ---------- wire types (subset we use) ----------

export type MemoryType = "claim" | "belief" | "lesson" | "fact" | "story" | "observation" | "decision" | "artifact_link";

/** Kontinuity's provenance kinds — who turned this into a durable record. Bounded tokens (T-35 alphabet). */
export type ProvenanceKind = "agent_inferred" | "user_said" | "user_confirmed" | "imported";

/**
 * Cortex `CandidateProvenance` (ingress/models.py). `source` and `tenantId` are
 * required by the schema; the client fills `tenantId` from the connection.
 *   - sourceKind    → Kontinuity's ProvenanceKind (bounded identifier token)
 *   - sourceUri     → `https://…` or `urn:…` only; we use `urn:continuity:<runtime>:<session>:<entry>`
 *   - checkpointAt  → EVENT time (when it was said/decided) — Cortex's own row time is system time.
 *   - extra         → free-form; Kontinuity puts captured_by / continuity_version here.
 */
export interface Provenance {
  source: string;
  agentId?: string;
  sourceKind?: ProvenanceKind | string;
  sourceUri?: string;
  checkpointAt?: string;
  extra?: Record<string, unknown>;
}

export interface RememberInput {
  content: string;
  memoryType?: MemoryType;
  source?: string;
  subjectKeys?: string[];
  beliefScore?: number;
  extractorVersion?: string;
  provenance?: Provenance;
  /** Decision receipt anchor. Minted if absent (Wave 0 is not under Runtime). */
  receiptId?: string;
  idempotencyKey?: string;
  /**
   * ccm-atomic-batch-v1 claimable keys bound to the written record (the (tenant, profile, key)
   * keyspace; the wire alias is `uniqueKeys`). At most 8 keys, each 1–128 characters of
   * A-Za-z0-9._:-. Claimed in the write's own transaction: a taken key is a 409 naming the key
   * and nothing is written. Absent or empty is no declaration.
   */
  uniqueKeys?: string[];
}

export interface RememberResult {
  idempotency_key: string;
  shard_id: string;
  store_ack_id: string;
  value_hash: string;
}

export interface RecallInput {
  query: string;
  sessionId: string;
  limit?: number;
  kind?: "recall" | "briefing";
  operationId?: string;
}

/**
 * `baton` on a `/v1/recall` item (OpenAPI `RecallBaton`, keon-cortex PR #164).
 * Each key is JSON null when `provenance.extra` has no string for it.
 * `agent_id` and `role_id` are extra stamps, not the caller and not `provenance.agent_id`.
 */
export interface RecallBaton {
  curation_kind: string | null;
  agent_id: string | null;
  role_id: string | null;
  handoff_to_role_id: string | null;
}

/**
 * One `/v1/recall` result. Current Cortex stops at the score fields. PR #164
 * adds the ribbon as top-level keys (always present; JSON null when the shard
 * has no string) plus `baton`. It does not add a nested `provenance` object.
 */
export interface RecallResultItem {
  shard_id: string;
  content: string;
  memory_type: string;
  rank: number;
  relevance_score: number;
  gravity_score: number;
  verified: boolean;
  /** Shard status. Always a string once PR #164 is serving; absent on older Cortex. */
  status?: string;
  /** Shard `created_at`. Always a string once PR #164 is serving. */
  created_at?: string | null;
  /** `provenance.extra.scope_class`. Null when the shard has no string. */
  scope_class?: string | null;
  /** `provenance.source_kind`. Null when the shard has no string. */
  source_kind?: string | null;
  /** `provenance.checkpoint_at`. Null when the shard has no string. */
  checkpoint_at?: string | null;
  /** `provenance.extra.branch`. Null when the shard has no string. */
  branch?: string | null;
  /** `provenance.extra.captured_by`. Null when the shard has no string. */
  captured_by?: string | null;
  /** Baton stamps from `provenance.extra`. Absent on older Cortex. */
  baton?: RecallBaton | null;
  [k: string]: unknown;
}

export interface RecallResult {
  recall_event_id: string;
  operation_id: string;
  delivery: { key: string; first_delivered_at: string; replayed: boolean; first_excluded: number };
  results: RecallResultItem[];
  verification_meta: { excluded: number; method: string; truncated: boolean };
  gravity_version: string;
  gravity_function_hash: string;
  gravity_as_of: number;
}

export interface SearchShard {
  shard_id: string;
  content: string;
  memory_type: string;
  status?: string;
  created_at?: string;
  provenance?: { extra?: { scope_class?: string; support_level?: string; [k: string]: unknown }; [k: string]: unknown };
  [k: string]: unknown;
}

export interface SearchResult {
  shards: SearchShard[];
  total: number;
  truncated: boolean;
}

/** Candidate browsing, not model recall. Opaque cursors bind filters and carriage. */
export interface ListInput {
  profile_id?: string;
  scope?: "role_private" | "profile_shared";
  memory_type?: MemoryType;
  status?: "active" | "all";
  time_field?: "checkpoint_at" | "created_at";
  since?: string;
  until?: string;
  subject_key_prefix?: string;
  limit?: number;
  cursor?: string;
}
export interface ListResult { shards: SearchShard[]; next_cursor: string | null }

export interface MemoryEventResult {
  attribution: "self_reported";
  event_ids: string[];
  operation_id: string;
  replay_equivalent_record_ids: string[];
  replayed: boolean;
}

export type CurationKind = "lesson" | "preference" | "handoff";

export interface ProposalInput {
  kind: CurationKind;
  sourceRecordIds: string[];
  content: string;
  reason: string;
  /** Required for kind "handoff". */
  toRoleId?: string;
  /** Bounded identifier token, e.g. "user_confirmed". */
  epistemicStatus?: string;
  operationId?: string;
}

export interface ProposalResult {
  operation_id: string;
  proposal_id: string;
  replayed: boolean;
  status: string;
}

export interface DispositionInput {
  proposalId: string;
  action: "approve" | "reject" | "supersede";
  /** Required for approve/supersede; must be absent for reject. Minted if omitted. */
  approvalReceiptRef?: string;
  /** Required for supersede: the previously approved derived record being replaced. */
  supersedesRecordId?: string;
  /**
   * ccm-atomic-batch-v1 unique keys bound to the record this disposition mints (the derived
   * record; for supersede the replacement — the old record's keys move to it in the same
   * transaction). At most 8 keys, 1–128 chars of [A-Za-z0-9._:-]. A taken key is a 409
   * naming the key and nothing is written. Must be absent for reject.
   */
  uniqueKeys?: string[];
  reason?: string;
  operationId?: string;
}

export interface DispositionResult {
  action: string;
  status: string;
  derived_shard_id?: string;
  inheritance_event_id?: string;
  [k: string]: unknown;
}

/** GET /v1/shards/{id} — the fields Kontinuity renders as the provenance ribbon. */
export interface ShardDetail {
  shard_id: string;
  content: string;
  memory_type: string;
  status: string;
  created_at: string;
  updated_at: string;
  source: string;
  provenance: {
    source: string;
    agent_id?: string | null;
    timestamp: string;
    source_kind?: string | null;
    source_uri?: string | null;
    checkpoint_at?: string | null;
    extra?: { role_id?: string; profile_id?: string; scope_class?: string; support_level?: string; [k: string]: unknown };
    [k: string]: unknown;
  };
  /**
   * Gateway transport only (TASK-196): `false` means the read surface could not report the
   * record's provenance / subject_keys, so checks that depend on them (schema citations in
   * `share`) cannot run and must fail closed. Absent on the direct Cortex path.
   */
  provenance_complete?: boolean;
  /** Raw `subject_keys` when the transport reports them (the gateway list rows carry them). */
  subject_keys?: string[];
  [k: string]: unknown;
}

export interface EvidencePack {
  shard_id: string;
  tenant_id: string;
  pack: Record<string, unknown>;
  signature: string;
  key_id: string;
  algorithm: string;
  generated_at: string;
}

export interface VerifyResult {
  verified: boolean;
  key_id: string | null;
  key_state: string;
  reason: string;
}

// ---------- errors ----------

/**
 * How a status-0 failure happened. `refused` = the request provably never reached Cortex
 * (connection refused / DNS); `timeout` and `reset` mean the request MAY have been processed,
 * so the result is indeterminate, never success and never a safe "not sent".
 */
export type TransportKind = "refused" | "timeout" | "reset" | "other";

export interface CortexErrorBudget {
  /** Parsed `Retry-After`, in milliseconds. Absent when the response had no usable header. */
  retryAfterMs?: number;
  /** Machine code from the error body, when Cortex sent one (`search_budget_exceeded`). */
  code?: string;
}

export class CortexError extends Error {
  readonly status: number;
  readonly path: string;
  readonly detail: unknown;
  /** Only set when status === 0 (no HTTP response). */
  readonly transport?: TransportKind;
  readonly retryAfterMs?: number;
  readonly code?: string;
  constructor(status: number, path: string, detail: unknown, transport?: TransportKind, budget?: CortexErrorBudget) {
    super(`Cortex ${status} on ${path}: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`);
    this.name = "CortexError";
    this.status = status;
    this.path = path;
    this.detail = detail;
    this.transport = transport;
    this.retryAfterMs = budget?.retryAfterMs;
    this.code = budget?.code ?? cortexDetailCode(detail);
  }
}

/** Delay-seconds or HTTP-date, per Retry-After. Unusable values are omitted. */
export function parseRetryAfterMs(header: string | null | undefined, now = Date.now()): number | undefined {
  if (header == null) return undefined;
  const text = header.trim();
  if (!text) return undefined;
  if (/^\d+(\.\d+)?$/.test(text)) {
    const seconds = Number(text);
    if (!Number.isFinite(seconds) || seconds < 0) return undefined;
    return Math.round(seconds * 1000);
  }
  const at = Date.parse(text);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, at - now);
}

export function cortexDetailCode(detail: unknown): string | undefined {
  if (typeof detail === "string") return detail.includes("search_budget_exceeded") ? "search_budget_exceeded" : undefined;
  if (!detail || typeof detail !== "object") return undefined;
  const rec = detail as Record<string, unknown>;
  if (typeof rec.code === "string" && rec.code.length > 0) return rec.code;
  if (rec.detail && typeof rec.detail === "object") return cortexDetailCode(rec.detail);
  return undefined;
}

/**
 * How long a 429 pauses further search/recall on this connection when the
 * response did not carry a positive Retry-After. Matches the idle poll floor
 * so a bare 429 cannot become a tight loop.
 */
export const SEARCH_BUDGET_DEFAULT_BACKOFF_MS = 300_000;
/** A hostile or absurd Retry-After cannot pin the process longer than a day. */
export const SEARCH_BUDGET_MAX_BACKOFF_MS = 24 * 60 * 60 * 1000;

interface BudgetPause {
  until: number;
  detail: unknown;
  code?: string;
}

const budgetPauses = new WeakMap<CortexConnection, BudgetPause>();

function budgetWaitMs(error: CortexError): number {
  const parsed = error.retryAfterMs;
  const wait = parsed !== undefined && parsed > 0 ? parsed : SEARCH_BUDGET_DEFAULT_BACKOFF_MS;
  return Math.min(wait, SEARCH_BUDGET_MAX_BACKOFF_MS);
}

function rememberSearchBudget(conn: CortexConnection, error: unknown): void {
  if (!(error instanceof CortexError) || error.status !== 429) return;
  const until = Date.now() + budgetWaitMs(error);
  const prev = budgetPauses.get(conn);
  if (!prev || until > prev.until) budgetPauses.set(conn, { until, detail: error.detail, code: error.code });
}

/** Positive Retry-After on a CortexError, capped at a day. Missing or zero is omitted. */
export function retryAfterMsOf(error: unknown): number | undefined {
  if (!(error instanceof CortexError)) return undefined;
  const ms = error.retryAfterMs;
  if (ms === undefined || !Number.isFinite(ms) || ms <= 0) return undefined;
  return Math.min(ms, SEARCH_BUDGET_MAX_BACKOFF_MS);
}

function throwIfSearchBudget(conn: CortexConnection, path: string): void {
  const pause = budgetPauses.get(conn);
  if (!pause) return;
  const remaining = pause.until - Date.now();
  if (remaining <= 0) {
    budgetPauses.delete(conn);
    return;
  }
  throw new CortexError(429, path, pause.detail, undefined, { retryAfterMs: remaining, ...(pause.code ? { code: pause.code } : {}) });
}

function transportKind(e: unknown): TransportKind {
  const err = e as { name?: string; code?: string; cause?: { code?: string } };
  const code = err?.cause?.code ?? err?.code;
  if (err?.name === "AbortError" || code === "UND_ERR_CONNECT_TIMEOUT" || code === "UND_ERR_HEADERS_TIMEOUT" || code === "ETIMEDOUT") return "timeout";
  if (code === "ECONNREFUSED" || code === "ENOTFOUND" || code === "EAI_AGAIN") return "refused";
  if (code === "ECONNRESET" || code === "UND_ERR_SOCKET") return "reset";
  return "other";
}

/**
 * Undici reports every transport failure as the bare message "fetch failed"; the real reason (ECONNREFUSED,
 * ECONNRESET, UND_ERR_SOCKET, a timeout) lives on `cause`. Keep it, so an operator (and a CI log) can tell a
 * refused connection from a reset keep-alive socket from a timeout instead of seeing "fetch failed" for all three.
 */
function transportDetail(e: unknown): string {
  if (!(e instanceof Error)) return String(e);
  const c = (e as { cause?: { code?: string; message?: string } }).cause;
  const why = c?.code ?? c?.message;
  return why && !e.message.includes(why) ? `${e.message} (${why})` : e.message;
}

// ---------- client ----------

/** Cortex's ConsiderationEventIn dispositions. Neither means "cited/weighed but not applied". */
export type ConsiderationDisposition = "not_applicable" | "considered_rejected";

// ---------- transport seam (TASK-196) ----------

/** One `access` report: a record was delivered into context. */
export interface AccessReport {
  sessionId: string;
  recallEventId: string;
  recordIds: string[];
  occurredAt?: string;
  operationId?: string;
}

/** One `access_omitted` report: recalled, but not delivered. */
export interface AccessOmittedReport {
  sessionId: string;
  recallEventId: string;
  recordIds: string[];
  reason: string;
  occurredAt?: string;
  operationId?: string;
}

export interface ApplicationReport {
  sessionId: string;
  accessRef: string;
  memoryId: string;
  targetRef: string;
  occurredAt?: string;
  operationId?: string;
}

export interface NonApplicabilityReport {
  sessionId: string;
  accessRef: string;
  memoryId: string;
  contextRef: string;
  reason: string;
  occurredAt?: string;
  operationId?: string;
}

export interface OutcomeReport {
  sessionId: string;
  accessRef: string;
  memoryId: string;
  targetRef: string;
  status: "success" | "failure" | "unknown" | "not_executed";
  evidenceRef?: string;
  observedAt?: string;
  operationId?: string;
}

export interface ConsiderationReport {
  sessionId: string;
  accessRef: string;
  memoryId: string;
  contextRef: string;
  disposition: ConsiderationDisposition;
  occurredAt?: string;
  operationId?: string;
}

export interface CorrectionReport {
  sessionId: string;
  correctsRef: string;
  newContentRef: string;
  reason: string;
  approvedBy?: string;
  occurredAt?: string;
  operationId?: string;
}

/**
 * What Kontinuity's core needs from a memory backend (TASK-196).
 *
 * Two implementations exist:
 *   - `CortexClient` (this file) — direct Cortex HTTP, the local/dev path.
 *   - `GatewayCortexTransport` (core/gateway-transport.ts) — the same operations mapped onto
 *     Keon MCP Gateway tools. It implements what the Gateway contract actually serves and fails
 *     CLOSED (never falls back to direct Cortex) for everything else.
 *
 * `as(identity)` relabels the LOCAL identity (state paths, provenance labels, rendering). On the
 * gateway transport identity and grants come from the machine credential + enrollment; `as()`
 * only changes the profile a call is made in (`profile_id`), which the Gateway checks itself.
 */
export interface CortexTransport {
  readonly identity: Identity;
  as(identity: Identity): CortexTransport;
  healthy(): Promise<boolean>;
  remember(input: RememberInput): Promise<RememberResult>;
  recall(input: RecallInput): Promise<RecallResult>;
  search(query: string, limit?: number): Promise<SearchResult>;
  list(input?: ListInput): Promise<ListResult>;
  reportAccess(p: AccessReport): Promise<MemoryEventResult>;
  reportAccessOmitted(p: AccessOmittedReport): Promise<MemoryEventResult>;
  reportApplication(p: ApplicationReport): Promise<MemoryEventResult>;
  reportNonApplicability(p: NonApplicabilityReport): Promise<MemoryEventResult>;
  reportOutcome(p: OutcomeReport): Promise<MemoryEventResult>;
  reportConsideration(p: ConsiderationReport): Promise<MemoryEventResult>;
  reportCorrection(p: CorrectionReport): Promise<MemoryEventResult>;
  reportRawEvent(sessionId: string, body: Record<string, unknown>, operationId?: string): Promise<MemoryEventResult>;
  propose(input: ProposalInput): Promise<ProposalResult>;
  dispose(input: DispositionInput): Promise<DispositionResult>;
  getShard(shardId: string): Promise<ShardDetail>;
  lineage(shardId: string): Promise<{ shard_id: string; lineage_hash: string; ancestor_ids: string[]; receipt_ref: unknown }>;
  evidence(shardId: string): Promise<EvidencePack>;
  verifyEvidence(input: { shardId: string } | { evidencePack: EvidencePack }): Promise<VerifyResult>;
  replay(shardIds: string[], verify?: boolean): Promise<{ replayed: number; results: { shard_id: string; value_hash: string; match: boolean }[]; deterministic: boolean }>;
}

export interface CortexHealth {
  ok: boolean;
  storage: string;
  schema_version: string;
  protocol: string;
  edition?: string;
  license?: string;
  features?: string[];
  absent_features?: string[];
}

export class CortexClient implements CortexTransport {
  readonly conn: CortexConnection;
  readonly identity: Identity;

  constructor(conn: CortexConnection, identity: Identity) {
    assertId(conn.tenantId, "tenantId");
    assertId(identity.actorId, "actorId");
    assertId(identity.profileId, "profileId");
    assertId(identity.roleId, "roleId");
    this.conn = conn;
    this.identity = identity;
  }

  /** Same connection, different identity. */
  as(identity: Identity): CortexClient {
    return new CortexClient(this.conn, identity);
  }

  // ----- plumbing -----

  private baseHeaders(): Record<string, string> {
    const grants = [...this.identity.grants].sort().join(",");
    return {
      "Content-Type": "application/json",
      "X-Keon-Cortex-Secret": this.conn.secret,
      "X-Tenant-Id": this.conn.tenantId,
      "X-Actor-Id": this.identity.actorId,
      "X-Keon-Profile-Id": this.identity.profileId,
      "X-Keon-Role-Id": this.identity.roleId,
      "X-Keon-Grant-Scopes": grants,
    };
  }

  private async request<T>(
    method: "GET" | "POST",
    path: string,
    opts: { body?: unknown; headers?: Record<string, string>; raw?: boolean; timeoutMs?: number } = {},
  ): Promise<T> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? this.conn.timeoutMs ?? 10_000);
    try {
      let res: Response;
      let text: string;
      try {
        res = await fetch(`${this.conn.baseUrl}${path}`, {
          method,
          headers: { ...this.baseHeaders(), ...(opts.headers ?? {}) },
          body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
          signal: ctrl.signal,
        });
        text = await res.text();
      } catch (e) {
        // No HTTP response: surface as status 0 so callers can fail closed and classify it.
        throw new CortexError(0, path, transportDetail(e), transportKind(e));
      }
      let json: unknown = undefined;
      try {
        json = text.length ? JSON.parse(text) : undefined;
      } catch {
        json = text;
      }
      if (!res.ok) {
        const detail = (json as { detail?: unknown } | undefined)?.detail ?? json ?? text;
        const retryAfterMs = parseRetryAfterMs(res.headers.get("retry-after"));
        const code = cortexDetailCode(detail);
        throw new CortexError(res.status, path, detail, undefined, {
          ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
          ...(code ? { code } : {}),
        });
      }
      if (opts.raw) return json as T;
      // Most routes wrap as {success, data}; /health and /v1/evidence/verify (unconfigured) don't.
      const wrapped = json as { success?: boolean; data?: unknown } | undefined;
      if (wrapped && typeof wrapped === "object" && "data" in wrapped) return wrapped.data as T;
      return json as T;
    } finally {
      clearTimeout(timer);
    }
  }

  // ----- health -----

  async health(): Promise<CortexHealth> {
    return this.request("GET", "/health", { raw: true });
  }

  async healthy(): Promise<boolean> {
    try {
      return (await this.health()).ok === true;
    } catch {
      return false;
    }
  }

  // ----- §4.1 remember -----

  async remember(input: RememberInput): Promise<RememberResult> {
    const headers: Record<string, string> = {
      "X-Decision-Receipt-Id": assertId(input.receiptId ?? mintId("rcpt"), "receiptId"),
    };
    if (input.idempotencyKey) headers["X-Idempotency-Key"] = assertId(input.idempotencyKey, "idempotencyKey");
    const body: Record<string, unknown> = {
      schemaId: "cortex.memory_shard_candidate.v1",
      tenantId: this.conn.tenantId,
      content: input.content,
    };
    if (input.memoryType) body.memoryType = input.memoryType;
    if (input.source) body.source = input.source;
    if (input.subjectKeys) body.subjectKeys = input.subjectKeys;
    if (input.uniqueKeys?.length) body.uniqueKeys = input.uniqueKeys;
    if (input.beliefScore !== undefined) body.beliefScore = input.beliefScore;
    if (input.extractorVersion) body.extractorVersion = input.extractorVersion;
    if (input.provenance) {
      const p = input.provenance;
      const prov: Record<string, unknown> = { source: p.source, tenantId: this.conn.tenantId };
      if (p.agentId) prov.agentId = p.agentId;
      if (p.sourceKind) prov.sourceKind = p.sourceKind;
      if (p.sourceUri) prov.sourceUri = p.sourceUri;
      if (p.checkpointAt) prov.checkpointAt = p.checkpointAt;
      if (p.extra) prov.extra = p.extra;
      body.provenance = prov;
    }
    return this.request("POST", "/v1/shards", { body, headers });
  }

  // ----- §4.2 recall -----

  async recall(input: RecallInput): Promise<RecallResult> {
    const path = "/v1/recall";
    throwIfSearchBudget(this.conn, path);
    let res: RecallResult;
    try {
      res = await this.request<RecallResult>("POST", path, {
        // Measured broad-tag recalls against the migrated Neon corpus take ~18s.
        // Keep the normal request deadline short; do not retry an accounted delivery.
        timeoutMs: this.conn.recallTimeoutMs ?? Math.max(30_000, this.conn.timeoutMs ?? 0),
        headers: {
          "X-Keon-Session-Id": assertId(input.sessionId, "sessionId"),
          "X-Keon-Operation-Id": assertId(input.operationId ?? mintId("op"), "operationId"),
        },
        body: { query: input.query, limit: input.limit ?? 10, kind: input.kind ?? "recall" },
      });
    } catch (error) {
      rememberSearchBudget(this.conn, error);
      throw error;
    }
    // A delivery without a recall event id cannot be accounted for: fail closed rather than hand it to an agent.
    if (!res || typeof res.recall_event_id !== "string" || res.recall_event_id.length === 0) {
      throw new CortexError(502, "/v1/recall", "response carried no recall_event_id; refusing to use an unaccounted delivery");
    }
    return res;
  }

  /**
   * Internal candidate read — no delivery semantics. Use for visibility checks, not agent turns.
   * HTTP 429 (the coming `search_budget_exceeded` budget) is not retried here. The connection
   * pauses until Retry-After, or for {@link SEARCH_BUDGET_DEFAULT_BACKOFF_MS} when the header
   * is missing, and further search/recall calls fail without another request.
   */
  async search(query: string, limit = 10): Promise<SearchResult> {
    const path = "/v1/shards/search";
    throwIfSearchBudget(this.conn, path);
    try {
      return await this.request("POST", path, { body: { query, limit: Math.min(100, Math.max(1, limit)) } });
    } catch (error) {
      rememberSearchBudget(this.conn, error);
      throw error;
    }
  }

  /** GET /v1/shards (TASK-166). Never substitutes lexical search silently. */
  async list(input: ListInput = {}): Promise<ListResult> {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(input)) if (value !== undefined) query.set(key, String(value));
    const result = await this.request<ListResult>("GET", `/v1/shards${query.size ? `?${query}` : ""}`);
    if (!result || !Array.isArray(result.shards) || !(result.next_cursor === null || typeof result.next_cursor === "string" && result.next_cursor.length > 0)) {
      throw new CortexError(502, "/v1/shards", "invalid listing response");
    }
    return result;
  }

  // ----- §4.3 / §4.5 memory events -----

  private memoryEvent(sessionId: string, body: Record<string, unknown>, operationId?: string): Promise<MemoryEventResult> {
    return this.request("POST", "/v1/memory-events", {
      headers: {
        "X-Keon-Session-Id": assertId(sessionId, "sessionId"),
        "X-Keon-Operation-Id": assertId(operationId ?? mintId("op"), "operationId"),
      },
      body,
    });
  }

  /**
   * Read receipt: a record was delivered into context. READS USE FRESH OPERATION IDS (TASK-82 fix,
   * observed Cortex 409 operation_id-reused 2026-11-03): an access report is one delivery report,
   * and a reused operation id with a fresh `occurred_at` is exactly the request-fingerprint change
   * Cortex refuses (OPMEM N-21). The old derived id did not "report once" — on a re-read it
   * collided and the 409 dropped the accounting (or warned on every re-read). Influence reports
   * (application / non_applicability / outcome / consideration / correction) still derive their
   * operation ids: a retry there must not multiply influence.
   */
  reportAccess(p: AccessReport) {
    return this.memoryEvent(
      p.sessionId,
      { kind: "access", recall_event_id: p.recallEventId, record_ids: p.recordIds, occurred_at: p.occurredAt ?? nowIso() },
      p.operationId ?? mintId("op"),
    );
  }

  /** Read receipt for what was recalled but not delivered. Fresh operation id, like `reportAccess`. */
  reportAccessOmitted(p: AccessOmittedReport) {
    return this.memoryEvent(
      p.sessionId,
      { kind: "access_omitted", recall_event_id: p.recallEventId, record_ids: p.recordIds, reason: p.reason, occurred_at: p.occurredAt ?? nowIso() },
      p.operationId ?? mintId("op"),
    );
  }

  reportApplication(p: ApplicationReport) {
    return this.memoryEvent(
      p.sessionId,
      { kind: "application", access_ref: p.accessRef, memory_id: p.memoryId, target_ref: p.targetRef, occurred_at: p.occurredAt ?? nowIso() },
      p.operationId ?? derivedId("op", "application", p.sessionId, p.accessRef, p.memoryId, p.targetRef),
    );
  }

  reportNonApplicability(p: NonApplicabilityReport) {
    return this.memoryEvent(
      p.sessionId,
      { kind: "non_applicability", access_ref: p.accessRef, memory_id: p.memoryId, context_ref: p.contextRef, reason: p.reason, occurred_at: p.occurredAt ?? nowIso() },
      p.operationId ?? derivedId("op", "non_applicability", p.sessionId, p.accessRef, p.memoryId, p.contextRef),
    );
  }

  reportOutcome(p: OutcomeReport) {
    const body: Record<string, unknown> = {
      kind: "outcome",
      access_ref: p.accessRef,
      memory_id: p.memoryId,
      target_ref: p.targetRef,
      status: p.status,
      observed_at: p.observedAt ?? nowIso(),
    };
    if (p.evidenceRef) body.evidence_ref = p.evidenceRef;
    return this.memoryEvent(p.sessionId, body, p.operationId ?? derivedId("op", "outcome", p.sessionId, p.accessRef, p.memoryId, p.targetRef, p.status));
  }

  /**
   * Consideration. Cortex's schema (ConsiderationEventIn, services/memory_events.py) REQUIRES a
   * `disposition` and offers only "not_applicable" | "considered_rejected" — neither means "cited or
   * weighed but not applied". The caller must pick one explicitly; this client never invents one
   * (a body without it is a 422). Never carries a target_ref.
   */
  reportConsideration(p: ConsiderationReport) {
    return this.memoryEvent(
      p.sessionId,
      { kind: "consideration", access_ref: p.accessRef, memory_id: p.memoryId, disposition: p.disposition, context_ref: p.contextRef, occurred_at: p.occurredAt ?? nowIso() },
      p.operationId ?? derivedId("op", "consideration", p.sessionId, p.accessRef, p.memoryId, p.disposition, p.contextRef),
    );
  }

  /**
   * Correction: append-only lineage from a corrected record to its replacement (CorrectionEventIn).
   * `corrects_ref` and `new_content_ref` are shard ids; `reason` is 1-1024 chars.
   */
  reportCorrection(p: CorrectionReport) {
    const body: Record<string, unknown> = {
      kind: "correction",
      corrects_ref: assertId(p.correctsRef, "correctsRef"),
      new_content_ref: assertId(p.newContentRef, "newContentRef"),
      reason: p.reason.trim().slice(0, 1024) || "superseded",
      occurred_at: p.occurredAt ?? nowIso(),
    };
    if (p.approvedBy) body.approved_by = p.approvedBy;
    return this.memoryEvent(p.sessionId, body, p.operationId ?? derivedId("op", "correction", p.sessionId, p.correctsRef, p.newContentRef));
  }

  /** Escape hatch for event kinds without a typed helper (feedback). Bodies must match Cortex's schema exactly: it forbids unknown fields. */
  reportRawEvent(sessionId: string, body: Record<string, unknown>, operationId?: string) {
    return this.memoryEvent(sessionId, body, operationId);
  }

  // ----- §5 curation -----

  async propose(input: ProposalInput): Promise<ProposalResult> {
    const body: Record<string, unknown> = {
      kind: input.kind,
      source_record_ids: input.sourceRecordIds,
      content: input.content,
      reason: input.reason,
    };
    if (input.toRoleId) body.to_role_id = input.toRoleId;
    if (input.epistemicStatus) body.epistemic_status = input.epistemicStatus;
    return this.request("POST", "/v1/curation/proposals", {
      headers: { "X-Keon-Operation-Id": assertId(input.operationId ?? mintId("op"), "operationId") },
      body,
    });
  }

  async dispose(input: DispositionInput): Promise<DispositionResult> {
    const body: Record<string, unknown> = { proposal_id: input.proposalId, action: input.action };
    if (input.action === "approve" || input.action === "supersede") {
      body.approval_receipt_ref = assertId(input.approvalReceiptRef ?? mintId("rcpt"), "approvalReceiptRef");
    }
    if (input.action === "supersede") {
      if (!input.supersedesRecordId) throw new Error("supersede requires supersedesRecordId");
      body.supersedes_record_id = input.supersedesRecordId;
    }
    if (input.uniqueKeys !== undefined) {
      if (input.action === "reject") throw new Error("reject must not carry uniqueKeys");
      body.unique_keys = input.uniqueKeys;
    }
    if (input.reason) body.reason = input.reason.slice(0, 1024);
    return this.request("POST", "/v1/curation/dispositions", {
      headers: { "X-Keon-Operation-Id": assertId(input.operationId ?? mintId("op"), "operationId") },
      body,
    });
  }

  // ----- §6 proof -----

  getShard(shardId: string): Promise<ShardDetail> {
    return this.request("GET", `/v1/shards/${encodeURIComponent(shardId)}`);
  }

  lineage(shardId: string): Promise<{ shard_id: string; lineage_hash: string; ancestor_ids: string[]; receipt_ref: unknown }> {
    return this.request("GET", `/v1/shards/${encodeURIComponent(shardId)}/lineage`);
  }

  evidence(shardId: string): Promise<EvidencePack> {
    return this.request("GET", `/v1/shards/${encodeURIComponent(shardId)}/evidence`);
  }

  /** Verify by id, or hand back a previously exported pack. Fails closed when no trusted keys are configured. */
  async verifyEvidence(input: { shardId: string } | { evidencePack: EvidencePack }): Promise<VerifyResult> {
    const body = "shardId" in input ? { shard_id: input.shardId } : { evidence_pack: input.evidencePack };
    // Unconfigured registry returns an unwrapped object; configured returns {success,data}. Normalize.
    const r = await this.request<VerifyResult | { data: VerifyResult }>("POST", "/v1/evidence/verify", { body, raw: true });
    return "data" in r ? r.data : r;
  }

  replay(shardIds: string[], verify = true): Promise<{ replayed: number; results: { shard_id: string; value_hash: string; match: boolean }[]; deterministic: boolean }> {
    return this.request("POST", "/v1/replay", { body: { shard_ids: shardIds, verify } });
  }
}

export function nowIso(): string {
  return new Date().toISOString();
}
