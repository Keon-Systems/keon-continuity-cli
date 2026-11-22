/**
 * Gateway-backed memory transport (TASK-196).
 *
 * `GatewayCortexTransport` implements Continuity's `CortexTransport` seam (src/cortex.ts) on top
 * of the Keon MCP Gateway client (core/gateway-client.ts), so that ORDINARY Continuity commands
 * (`recall`, `remember`, `stage`, `board`, `feedback`, `evidence`, `blame`, `delta`, …) can run
 * against the hosted Gateway instead of direct Cortex. `createRuntime` selects it whenever a
 * gateway endpoint + machine credential are configured (core/runtime.ts).
 *
 * Two rules govern this file:
 *
 *   T-1  NO SILENT FALLBACK. Every operation either maps onto a contract tool or throws a
 *        `GatewayUnsupportedError` naming what the contract is missing. Nothing in this module
 *        ever reaches direct Cortex, and no local path is swapped in for a hosted one.
 *   T-2  NO INVENTED PROTOCOL. Each mapping names the tool it uses. All of them are tools in
 *        `mcp_gateway.v1.schema.json` `$defs.ToolName`, with the argument names the Gateway
 *        handlers declare:
 *          recall              keon.cortex.memory.recall.v1
 *          remember/stage      keon.cortex.memory.write.v1
 *          search              keon.cortex.memory.search.v1
 *          list                keon.cortex.memory.list.v1   (the Gateway's GET /v1/shards)
 *          feedback events     keon.cortex.memory.feedback.v1
 *          propose             keon.cortex.curation.propose.v1
 *          dispose             keon.cortex.curation.dispose.v1
 *          getShard            keon.cortex.receipt.get.v1      (the Gateway's documented
 *                              "retrieve a governed shard record … by shard ID")
 *          lineage             keon.cortex.lineage.get.v1
 *          evidence            keon.cortex.evidence.get.v1
 *          verifyEvidence      keon.cortex.evidence.verify.v1
 *          replay              keon.cortex.replay.query.v1
 *        Unmapped, and therefore fail-closed: `reportCorrection` (the feedback contract
 *        explicitly rejects `correction`).
 *
 * Known contract gaps (documented in docs/gateway-enrollment.md, TASK-196 follow-ups — the
 * transport does not paper over them):
 *
 *   G-6  The write contract carries no provenance block and no client idempotency key. A
 *        gateway write therefore loses source_kind / source_uri / checkpoint_at / capture branch
 *        and the local idempotency key. Continuity still writes the content and its label keys.
 *   G-7  Reads do not return the shard's scope (`role_private` vs `profile_shared`) or its full
 *        provenance: `memory.search` rows and `receipt.get` carry content/status/source only.
 *        Because a briefing renders "memory the user confirmed", `continuity briefing` refuses to
 *        run on this transport rather than mislabel a private note as confirmed
 *        (core/briefing.ts BRIEFING_GATEWAY_GAP). `recall` still works: it labels rows with what
 *        the contract does provide and never claims a scope it cannot see.
 *   G-8  `dispose` has no `unique_keys`, so a disposition that asked for additive key claims is
 *        refused instead of silently dropping them.
 */

import { nowIso, type AccessOmittedReport, type AccessReport, type ApplicationReport, type ConsiderationReport, type CortexTransport, type CorrectionReport, type DispositionInput, type DispositionResult, type EvidencePack, type Identity, type ListInput, type ListResult, type MemoryEventResult, type NonApplicabilityReport, type OutcomeReport, type ProposalInput, type ProposalResult, type RecallInput, type RecallResult, type RememberInput, type RememberResult, type SearchResult, type ShardDetail, type VerifyResult } from "../src/cortex.ts";
import {
  GatewayClient,
  GatewayContractError,
  GatewayUnsupportedError,
  TOOL_NAMES,
  type GatewayConnection,
  type GatewayFeedbackResult,
} from "./gateway-client.ts";

/** The tools this transport uses that the client has no wrapper for (named once, checked by tests). */
export const GATEWAY_READ_TOOLS = {
  getShard: "keon.cortex.receipt.get.v1",
  lineage: "keon.cortex.lineage.get.v1",
  evidence: "keon.cortex.evidence.get.v1",
  verifyEvidence: "keon.cortex.evidence.verify.v1",
  replay: "keon.cortex.replay.query.v1",
} as const;

/**
 * `keon.cortex.memory_write_request.v1` narrows `memory_type` to this enum, while Continuity's
 * local classifier also emits `observation`, `decision` and `artifact_link`. A type the write
 * contract cannot carry is OMITTED (never coerced into a different meaning): the content's
 * bracketed tag still records what Continuity classified it as.
 */
const GATEWAY_MEMORY_TYPES = new Set(["claim", "belief", "lesson", "fact", "story"]);

function str(value: unknown, label: string, tool: string): string {
  if (typeof value !== "string") throw new GatewayContractError(`${tool} result carries no ${label}`, { tool, detail: value });
  return value;
}

function num(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function eventResult(f: GatewayFeedbackResult): MemoryEventResult {
  return {
    attribution: "self_reported",
    event_ids: f.event_ids,
    operation_id: f.operation_id,
    replay_equivalent_record_ids: f.replay_equivalent_record_ids,
    replayed: f.replayed,
  };
}

/**
 * One enrolled machine's transport: the Gateway client plus the LOCAL identity labels Continuity
 * uses for state paths, provenance text and rendering. On this transport the Gateway binds the
 * real identity from the machine credential + enrollment; `as()` only switches the profile a call
 * is made in (`profile_id`), which the Gateway checks against the enrollment's AllowedProfiles.
 */
/** How far the shard-listing enrichment scan goes before it gives up (20 × 500 records). */
const MAX_LIST_SCAN_PAGES = 20;
const LIST_SCAN_PAGE_SIZE = 500;
/** How long a completed scan is trusted before a miss triggers a fresh one (a record written by
 *  another session/process must not be invisible forever). */
const LIST_SCAN_TTL_MS = 60_000;

/**
 * The shard-listing scan state. Shared by every transport created with `as()` so profile
 * switches and owner/agent views reuse one scan, and reset by every write this transport makes
 * (a new record must be findable by the next getShard).
 */
interface GatewayListScanState {
  rows: Map<string, Record<string, unknown>>;
  /** A scan reached the last page; a miss is definitive until the TTL expires. */
  complete: boolean;
  completedAt?: number;
  cursor?: string;
  pages: number;
}

const newScanState = (): GatewayListScanState => ({ rows: new Map(), complete: false, pages: 0 });

export class GatewayCortexTransport implements CortexTransport {
  readonly identity: Identity;
  private readonly client: GatewayClient;
  readonly endpoint: string;
  /**
   * `memory.list` is the only gateway read that reports a shard's `subject_keys` and provenance
   * block, so getShard enriches itself from a listing scan (G-7). The scan resumes across calls
   * (no re-downloading pages already read), is capped at MAX_LIST_SCAN_PAGES, and is shared with
   * `as()` clones.
   */
  private readonly scan: GatewayListScanState;

  constructor(conn: GatewayConnection, identity: Identity, client?: GatewayClient, scan?: GatewayListScanState) {
    this.identity = identity;
    this.endpoint = conn.endpoint;
    this.client = client ?? new GatewayClient(conn);
    this.scan = scan ?? newScanState();
  }

  as(identity: Identity): GatewayCortexTransport {
    return new GatewayCortexTransport(
      { endpoint: this.client.conn.endpoint, auth: this.client.conn.auth, timeoutMs: this.client.conn.timeoutMs, ...(this.client.conn.profileId ? { profileId: this.client.conn.profileId } : {}) },
      identity,
      this.client,
      // Same brain: a scan started for one profile is not restarted for the owner view.
      this.scan,
    );
  }

  /** Any write this transport makes invalidates the listing: the next getShard must see it. */
  private invalidateListScan(): void {
    this.scan.rows.clear();
    this.scan.complete = false;
    this.scan.completedAt = undefined;
    this.scan.cursor = undefined;
    this.scan.pages = 0;
  }

  /** The per-call context this transport's local identity selects. */
  private profileOpts(): { profileId?: string } {
    return this.identity.profileId ? { profileId: this.identity.profileId } : {};
  }

  async healthy(): Promise<boolean> {
    try {
      await this.client.listTools();
      return true;
    } catch {
      return false;
    }
  }

  // ----- memory -----

  /** Find one shard in the listing (bounded, resumable). Undefined = the listing cannot show it. */
  private async listRowFor(shardId: string): Promise<Record<string, unknown> | undefined> {
    const cached = this.scan.rows.get(shardId);
    if (cached) return cached;
    if (this.scan.complete) {
      // A complete scan is trusted briefly: a record written by another session/process between
      // two calls must not stay invisible forever, but ordinary lookups must not rescan either.
      if (this.scan.completedAt !== undefined && Date.now() - this.scan.completedAt < LIST_SCAN_TTL_MS) return undefined;
      this.scan.complete = false;
      this.scan.completedAt = undefined;
      this.scan.cursor = undefined;
      this.scan.pages = 0;
    }
    while (this.scan.pages < MAX_LIST_SCAN_PAGES) {
      let result;
      try {
        result = await this.client.list({ status: "all", limit: LIST_SCAN_PAGE_SIZE, ...(this.scan.cursor ? { cursor: this.scan.cursor } : {}) }, this.profileOpts());
      } catch {
        // The listing route is optional in Cortex (CORTEX_ROUTE_UNAVAILABLE). Provenance is then
        // unavailable — getShard says so instead of inventing it.
        return undefined;
      }
      for (const row of result.shards) this.scan.rows.set(row.shard_id, row as Record<string, unknown>);
      this.scan.pages += 1;
      const hit = this.scan.rows.get(shardId);
      if (hit) return hit;
      if (!result.next_cursor) {
        this.scan.complete = true;
        this.scan.completedAt = Date.now();
        this.scan.cursor = undefined;
        return undefined;
      }
      this.scan.cursor = result.next_cursor;
    }
    return undefined;
  }

  async remember(input: RememberInput): Promise<RememberResult> {
    // G-6: the write contract has no provenance block and no idempotency key; the content and its
    // label keys are what can honestly be sent.
    const envelope = await this.client.invoke(
      TOOL_NAMES.write,
      {
        content: input.content,
        ...(input.memoryType !== undefined && GATEWAY_MEMORY_TYPES.has(input.memoryType) ? { memory_type: input.memoryType } : {}),
        source: input.source ?? "continuity/pi",
        ...(input.subjectKeys?.length ? { subject_keys: input.subjectKeys } : {}),
        ...(input.beliefScore !== undefined ? { belief_score: input.beliefScore } : {}),
        ...(input.uniqueKeys?.length ? { unique_keys: input.uniqueKeys } : {}),
      },
      this.profileOpts(),
    );
    const r = record(envelope.result);
    // A new record invalidates the listing scan: the next getShard must see it (writes flush the
    // read cache by design — a write means the world changed).
    this.invalidateListScan();
    const shardId = str(r.shard_id, "shard_id", TOOL_NAMES.write);
    const storeAck = str(r.store_ack_id, "store_ack_id", TOOL_NAMES.write);
    return {
      idempotency_key: input.idempotencyKey ?? "",
      shard_id: shardId,
      store_ack_id: storeAck,
      // The Gateway has no value hash on the write receipt; "" says "not reported", never a guess.
      value_hash: "",
    };
  }

  async recall(input: RecallInput): Promise<RecallResult> {
    const opts = input.limit !== undefined ? { limit: input.limit } : {};
    const result = input.kind === "briefing" ? await this.client.briefing(opts) : await this.client.recall(input.query, opts);
    const delivery = record(result.delivery);
    const meta = record(result.verification_meta);
    return {
      recall_event_id: result.recall_event_id,
      operation_id: result.operation_id,
      delivery: {
        key: typeof delivery.key === "string" ? delivery.key : "",
        first_delivered_at: typeof delivery.first_delivered_at === "string" ? delivery.first_delivered_at : "",
        replayed: delivery.replayed === true,
        first_excluded: num(delivery.first_excluded),
      },
      results: result.results.map((hit) => ({
        shard_id: hit.shard_id,
        content: hit.content,
        memory_type: hit.memory_type,
        rank: hit.rank,
        relevance_score: hit.relevance_score,
        gravity_score: hit.gravity_score,
        verified: hit.verified,
      })),
      verification_meta: {
        excluded: num(meta.excluded),
        method: typeof meta.method === "string" ? meta.method : "gateway",
        truncated: meta.truncated === true,
      },
      gravity_version: result.gravity_version,
      gravity_function_hash: result.gravity_function_hash,
      // The Gateway reports an ISO timestamp where Cortex reports epoch seconds; keep the number
      // shape the callers expect, and never invent a date (NaN → 0).
      gravity_as_of: Number.isNaN(Date.parse(result.gravity_as_of)) ? 0 : Math.floor(Date.parse(result.gravity_as_of) / 1000),
    };
  }

  async search(query: string, limit = 10): Promise<SearchResult> {
    const r = await this.client.search(query, { limit, ...this.profileOpts() });
    return {
      // G-7: rows carry no provenance/scope; nothing is added.
      shards: r.shards.map((shard) => ({
        shard_id: shard.shard_id,
        content: shard.content,
        memory_type: typeof shard.memory_type === "string" ? shard.memory_type : "",
        ...(typeof shard.status === "string" ? { status: shard.status } : {}),
        ...(typeof shard.created_at === "string" ? { created_at: shard.created_at } : {}),
        ...(shard.provenance && typeof shard.provenance === "object" ? { provenance: record(shard.provenance) } : {}),
        ...(Array.isArray(shard.subject_keys) ? { subject_keys: (shard.subject_keys as unknown[]).map(String) } : {}),
      })),
      total: r.total,
      truncated: r.total > r.shards.length,
    };
  }

  /**
   * `keon.cortex.memory.list.v1` — Cortex's GET /v1/shards page. `scope`/`profile_id` are shaping
   * words (G-1): the listing context comes from the credential/enrollment plus the per-call
   * profile, never from arguments. G-7 still applies to rows: a row's scope/provenance is whatever
   * the Gateway returned, and nothing is inferred when it is absent.
   */
  async list(input: ListInput = {}): Promise<ListResult> {
    // The pinned Gateway contract rejects scope as an identity-shaped argument.
    // Never silently discard a caller's authoritative filtering requirement.
    if (input.scope !== undefined || input.profile_id !== undefined && input.profile_id !== this.identity.profileId) {
      throw new GatewayUnsupportedError("Gateway memory.list cannot carry an explicit scope filter or a different profile_id; scoped layout authority is unavailable (no direct fallback).", { tool: TOOL_NAMES.list });
    }
    const r = await this.client.list(
      {
        ...(input.memory_type !== undefined ? { memoryType: input.memory_type } : {}),
        ...(input.status !== undefined ? { status: input.status } : {}),
        ...(input.time_field !== undefined ? { timeField: input.time_field } : {}),
        ...(input.since !== undefined ? { since: input.since } : {}),
        ...(input.until !== undefined ? { until: input.until } : {}),
        ...(input.subject_key_prefix !== undefined ? { subjectKeyPrefix: input.subject_key_prefix } : {}),
        ...(input.limit !== undefined ? { limit: input.limit } : {}),
        ...(input.cursor !== undefined ? { cursor: input.cursor } : {}),
      },
      this.profileOpts(),
    );
    return {
      shards: r.shards.map((shard) => ({
        shard_id: shard.shard_id,
        content: shard.content,
        memory_type: typeof shard.memory_type === "string" ? shard.memory_type : "",
        ...(typeof shard.status === "string" ? { status: shard.status } : {}),
        ...(typeof shard.created_at === "string" ? { created_at: shard.created_at } : {}),
        ...(shard.provenance && typeof shard.provenance === "object" ? { provenance: shard.provenance as Record<string, unknown> } : {}),
      })),
      next_cursor: r.next_cursor,
    };
  }

  // ----- memory events (keon.cortex.memory.feedback.v1) -----

  private async feedback(body: Record<string, unknown>): Promise<MemoryEventResult> {
    return eventResult(await this.client.feedback(body));
  }

  reportAccess(p: AccessReport): Promise<MemoryEventResult> {
    return this.feedback({ kind: "access", recall_event_id: p.recallEventId, record_ids: p.recordIds, occurred_at: p.occurredAt ?? nowIso() });
  }

  reportAccessOmitted(p: AccessOmittedReport): Promise<MemoryEventResult> {
    return this.feedback({ kind: "access_omitted", recall_event_id: p.recallEventId, record_ids: p.recordIds, reason: p.reason, occurred_at: p.occurredAt ?? nowIso() });
  }

  reportApplication(p: ApplicationReport): Promise<MemoryEventResult> {
    return this.feedback({ kind: "application", recall_event_id: p.accessRef, memory_id: p.memoryId, target_ref: p.targetRef, occurred_at: p.occurredAt ?? nowIso() });
  }

  reportNonApplicability(p: NonApplicabilityReport): Promise<MemoryEventResult> {
    return this.feedback({ kind: "non_applicability", access_ref: p.accessRef, memory_id: p.memoryId, context_ref: p.contextRef, reason: p.reason, occurred_at: p.occurredAt ?? nowIso() });
  }

  reportOutcome(p: OutcomeReport): Promise<MemoryEventResult> {
    return this.feedback({
      kind: "outcome",
      access_ref: p.accessRef,
      memory_id: p.memoryId,
      target_ref: p.targetRef,
      status: p.status,
      ...(p.evidenceRef ? { evidence_ref: p.evidenceRef } : {}),
      observed_at: p.observedAt ?? nowIso(),
    });
  }

  reportConsideration(p: ConsiderationReport): Promise<MemoryEventResult> {
    return this.feedback({ kind: "consideration", access_ref: p.accessRef, memory_id: p.memoryId, disposition: p.disposition, context_ref: p.contextRef, occurred_at: p.occurredAt ?? nowIso() });
  }

  /** The feedback contract explicitly rejects `correction` (a curation path is pending). Fail closed. */
  async reportCorrection(_p: CorrectionReport): Promise<MemoryEventResult> {
    throw new GatewayUnsupportedError(
      `unsupported on the Keon MCP Gateway transport: the ${TOOL_NAMES.feedback} contract rejects feedback kind "correction" (a curation path for corrections is pending). No audit event was written; the supersede disposition itself is the record of truth.`,
      { tool: TOOL_NAMES.feedback },
    );
  }

  reportRawEvent(_sessionId: string, body: Record<string, unknown>, _operationId?: string): Promise<MemoryEventResult> {
    // The Gateway derives the session and operation ids from the credential/enrollment; the body
    // is the contract's own event shape, checked by core/gateway-client.ts before the wire.
    return this.feedback(body);
  }

  // ----- curation -----

  async propose(input: ProposalInput): Promise<ProposalResult> {
    return this.client.propose({
      kind: input.kind,
      sourceRecordIds: input.sourceRecordIds,
      content: input.content,
      reason: input.reason,
      ...(input.toRoleId !== undefined ? { toRoleId: input.toRoleId } : {}),
      ...(input.epistemicStatus !== undefined ? { epistemicStatus: input.epistemicStatus } : {}),
    });
  }

  async dispose(input: DispositionInput): Promise<DispositionResult> {
    if (input.uniqueKeys?.length) {
      // G-8: the gateway dispose request schema has no unique_keys. Dropping them would silently
      // give up a single-issue key claim, so refuse instead.
      throw new GatewayUnsupportedError(
        `unsupported on the Keon MCP Gateway transport: ${TOOL_NAMES.curationDispose} has no unique_keys field, so additive key claims cannot be carried. Nothing was approved or superseded.`,
        { tool: TOOL_NAMES.curationDispose },
      );
    }
    // A disposition mints a derived record (and supersedes another): the listing changed.
    this.invalidateListScan();
    const r = await this.client.dispose({
      proposalId: input.proposalId,
      action: input.action,
      ...(input.supersedesRecordId !== undefined ? { supersedesRecordId: input.supersedesRecordId } : {}),
      ...(input.reason !== undefined ? { reason: input.reason } : {}),
    });
    return {
      action: r.action,
      status: r.status,
      ...(r.derived_shard_id ? { derived_shard_id: r.derived_shard_id } : {}),
      ...(r.inheritance_event_id ? { inheritance_event_id: r.inheritance_event_id } : {}),
    };
  }

  // ----- proof (Gateway read tools with exact contract mappings) -----

  async getShard(shardId: string): Promise<ShardDetail> {
    const envelope = await this.client.invoke(GATEWAY_READ_TOOLS.getShard, { shard_id: shardId }, this.profileOpts());
    const r = record(envelope.result);
    const id = str(r.shard_id, "shard_id", GATEWAY_READ_TOOLS.getShard);
    const createdAt = typeof r.created_at === "string" ? r.created_at : "";
    const source = typeof r.source === "string" ? r.source : "";
    // The receipt carries content/status/source but no provenance and no subject keys; the listing
    // row (when Cortex has the route and the row is in scope) carries both. Nothing is invented:
    // a record the listing cannot show is marked `provenance_complete: false`, and callers that
    // depend on provenance (core/memory.ts share) fail closed on that.
    const row = await this.listRowFor(shardId);
    const prov = record(row?.provenance);
    const extra = record(prov.extra);
    const subjectKeys = Array.isArray(row?.subject_keys) ? (row.subject_keys as unknown[]).map(String) : undefined;
    return {
      shard_id: id,
      content: typeof r.content === "string" ? r.content : "",
      memory_type: typeof r.memory_type === "string" ? r.memory_type : "",
      status: typeof r.status === "string" ? r.status : "unknown",
      created_at: createdAt,
      updated_at: createdAt,
      source,
      provenance: {
        source: typeof prov.source === "string" ? prov.source : source,
        timestamp: typeof prov.timestamp === "string" ? prov.timestamp : createdAt,
        ...(typeof prov.agent_id === "string" ? { agent_id: prov.agent_id } : {}),
        ...(typeof prov.source_kind === "string" ? { source_kind: prov.source_kind } : {}),
        ...(typeof prov.source_uri === "string" ? { source_uri: prov.source_uri } : {}),
        ...(typeof prov.checkpoint_at === "string" ? { checkpoint_at: prov.checkpoint_at } : {}),
        extra,
      },
      ...(subjectKeys ? { subject_keys: subjectKeys } : {}),
      provenance_complete: row !== undefined,
      ...(typeof r.memory_mode === "string" ? { memory_mode: r.memory_mode } : {}),
      ...(typeof r.belief_score === "number" ? { belief_score: r.belief_score } : {}),
      ...(typeof r.lineage_hash === "string" ? { lineage_hash: r.lineage_hash } : {}),
    };
  }

  async lineage(shardId: string): Promise<{ shard_id: string; lineage_hash: string; ancestor_ids: string[]; receipt_ref: unknown }> {
    const envelope = await this.client.invoke(GATEWAY_READ_TOOLS.lineage, { shard_id: shardId }, this.profileOpts());
    const r = record(envelope.result);
    const ancestors = Array.isArray(r.ancestor_ids) ? r.ancestor_ids.map(String) : [];
    return {
      shard_id: str(r.shard_id, "shard_id", GATEWAY_READ_TOOLS.lineage),
      lineage_hash: str(r.lineage_hash, "lineage_hash", GATEWAY_READ_TOOLS.lineage),
      ancestor_ids: ancestors,
      receipt_ref: envelope.receipts,
    };
  }

  async evidence(shardId: string): Promise<EvidencePack> {
    const envelope = await this.client.invoke(GATEWAY_READ_TOOLS.evidence, { shard_id: shardId }, this.profileOpts());
    const r = record(envelope.result);
    return {
      shard_id: str(r.shard_id, "shard_id", GATEWAY_READ_TOOLS.evidence),
      tenant_id: str(r.tenant_id, "tenant_id", GATEWAY_READ_TOOLS.evidence),
      pack: record(r.pack),
      signature: str(r.signature, "signature", GATEWAY_READ_TOOLS.evidence),
      key_id: str(r.key_id, "key_id", GATEWAY_READ_TOOLS.evidence),
      algorithm: str(r.algorithm, "algorithm", GATEWAY_READ_TOOLS.evidence),
      generated_at: str(r.generated_at, "generated_at", GATEWAY_READ_TOOLS.evidence),
    };
  }

  async verifyEvidence(input: { shardId: string } | { evidencePack: EvidencePack }): Promise<VerifyResult> {
    const args: Record<string, unknown> = "shardId" in input ? { shard_id: input.shardId } : { evidence_pack: input.evidencePack };
    const envelope = await this.client.invoke(GATEWAY_READ_TOOLS.verifyEvidence, args, this.profileOpts());
    const r = record(envelope.result);
    if (typeof r.verified !== "boolean") throw new GatewayContractError(`${GATEWAY_READ_TOOLS.verifyEvidence} result carries no verified flag`, { tool: GATEWAY_READ_TOOLS.verifyEvidence, detail: r });
    return {
      verified: r.verified,
      key_id: typeof r.key_id === "string" ? r.key_id : null,
      key_state: typeof r.key_state === "string" ? r.key_state : "",
      reason: typeof r.reason === "string" ? r.reason : "",
    };
  }

  async replay(shardIds: string[], verify = true): Promise<{ replayed: number; results: { shard_id: string; value_hash: string; match: boolean }[]; deterministic: boolean }> {
    const envelope = await this.client.invoke(GATEWAY_READ_TOOLS.replay, { shard_ids: shardIds, verify }, this.profileOpts());
    const r = record(envelope.result);
    if (!Array.isArray(r.results)) throw new GatewayContractError(`${GATEWAY_READ_TOOLS.replay} result carries no results array`, { tool: GATEWAY_READ_TOOLS.replay, detail: r });
    return {
      replayed: num(r.replayed),
      results: (r.results as unknown[]).map((row) => {
        const x = record(row);
        return { shard_id: String(x.shard_id ?? ""), value_hash: String(x.value_hash ?? ""), match: x.match === true };
      }),
      deterministic: r.deterministic === true,
    };
  }
}
