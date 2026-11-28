/**
 * A tiny in-process stand-in for the Cortex HTTP routes Kontinuity uses. It records every request so
 * tests can assert exactly what was sent, and it can be told to misbehave (drop, refuse, 5xx) to
 * exercise the outbox. It is NOT a Cortex: idempotency here is "same X-Idempotency-Key → same shard".
 */
import { testTmpDir } from "./tmp.ts";
import { createHash, createHmac } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { validateMemoryEvent } from "./cortex-schemas.ts";

export type Mode = "ok" | "drop-before-commit" | "drop-after-commit" | "status";

export interface Req {
  method: string;
  path: string;
  headers: IncomingMessage["headers"];
  body: any;
}

export class FakeCortex {
  server!: Server;
  port = 0;
  mode: Mode = "ok";
  status = 500;
  /** When set, POST /v1/shards/search answers this HTTP status (with Retry-After seconds, if given) — board-read fault injection. */
  searchFault?: { status: number; retryAfterSeconds?: number };
  /** If set, POST /v1/shards whose content matches answers `status` — targeted write faults (e.g. only the bookkeeping write fails) without taking the whole fake down. */
  failOnContent?: (content: string) => boolean;
  /** If set, the next POST /v1/shards answers 409 once (duplicate), after which it behaves per `mode`. */
  conflictOnce = false;
  /** Optional test barrier immediately before disposition CAS/unique-key arbitration. */
  beforeDisposition?: (body: any) => Promise<void>;
  /** Cortex derived identities include content and are insert-only even in history. */
  rejectDuplicateDerivedContent = false;
  /** In "status" mode, commit the shard first and then answer with the error (a replay surfaced as 5xx). */
  commitThenStatus = false;
  requests: Req[] = [];
  shards = new Map<string, { id: string; content: string; role: string; profile: string; tenant?: string; memoryType?: string; key?: string; scope?: string; status?: string; capturedBy?: string; extra?: Record<string, unknown>; checkpointAt?: string; agentId?: string; sourceUri?: string; sourceKind?: string; source?: string; at?: string; subjectKeys?: string[]; lineageRefs?: string[] }>();
  private byKey = new Map<string, string>();
  proposals = new Map<string, { kind: string; toRoleId?: string; content: string; role: string; actor: string; sourceRecordIds?: string[] }>();
  /** lineage: derived shard id → ancestor ids (supersede chains, derivations). */
  ancestors = new Map<string, string[]>();
  eventOps = new Set<string>();
  /** Mimic Cortex refusing a reused operation id whose request changed (occurred_at differs per attempt). */
  conflictOnReusedOp = false;
  /** ccm-atomic-batch-v1 claimable keys: `profile\0key` → shard id. A taken key is 409 naming it, nothing written. */
  uniqueKeys = new Map<string, string>();
  /** 409s served for taken unique keys — the race tests assert the race really happened. */
  uniqueKeyConflicts = 0;
  /** Test barrier: hold writes that declare unique keys until this many have arrived (one-shot) — forces the max+1 race between processes. */
  uniqueKeyHold = 0;
  private parked: (() => void)[] = [];
  omitRecallEventId = false;
  /** When non-zero, POST /v1/memory-events answers this status (to test that event failures are surfaced, not swallowed). */
  eventStatus = 0;
  /** Restrict `eventStatus` to these event kinds (empty = every kind). */
  eventFailKinds: string[] = [];
  /** Extra fields (status, created_at, provenance) are echoed on `/v1/recall` items when a test sets them. */
  recallResults: { shard_id: string; content: string; [k: string]: unknown }[] = [];
  /** Opt-in: multi-term search queries match by term prefix (an approximation of Cortex lexical recall). Off by default so pre-write checks in other tests see only exact/prefix hits. */
  lexicalSearch = false;
  /** Opt-in: POST /v1/shards/search is profile-scoped like real Cortex's grant-scoped search — only shards written under the requesting X-Keon-Profile-Id match (multi-profile tests would otherwise see each other's boards). */
  profileScopedSearch = false;
  /** Opt-in realistic role/profile grants for media owner-fallback integration tests. */
  grantScopedReads = false;
  private readable(s: { role: string; profile: string; scope?: string; tenant?: string }, req: IncomingMessage): boolean {
    if (!this.grantScopedReads) return true;
    if ((s.tenant ?? "tnt_test") !== String(req.headers["x-tenant-id"] ?? "")) return false;
    const grants = String(req.headers["x-keon-grant-scopes"] ?? "").split(",");
    return grants.includes(s.scope === "profile_shared" ? `profile:${s.profile}:shared` : `role:${s.profile}:${s.role}`);
  }
  /** Extra hits for POST /v1/shards/search — records this test did not write through the fake (e.g. another runtime's shares). */
  searchResults: { shard_id: string; content: string; status?: string; created_at?: string; provenance?: Record<string, unknown> }[] = [];
  /** When true, POST /v1/shards/search reports a truncated result set (for bounded-union tests). */
  searchTruncated = false;
  /** Per-profile caps (TASK-44): searches under these X-Keon-Profile-Id values report truncated; `searchTruncated` still caps every search. */
  searchTruncatedProfiles: string[] = [];
  /** `GET /v1/shards` availability: 0 serves pages; 404/405/501 simulate a Cortex without the route. */
  listStatus = 0;
  /** Force a maximum page size to exercise cursor paging (0 = honour the request, capped at 500). */
  listMaxPageSize = 0;
  /** Protocol fault injection only: repeat the previous opaque cursor. */
  listRepeatCursor = false;
  private n = 0;

  async start(): Promise<this> {
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", r));
    this.port = (this.server.address() as AddressInfo).port;
    return this;
  }

  get url() {
    return `http://127.0.0.1:${this.port}`;
  }

  stop() {
    this.server.closeAllConnections();
    return new Promise<void>((r) => this.server.close(() => r()));
  }

  shardPosts() {
    return this.requests.filter((r) => r.method === "POST" && r.path === "/v1/shards");
  }

  /** Fixed-width, prefix-unambiguous ids — like real Cortex hex ids, a short prefix must never match two records (`shd_fake3` vs `shd_fake30`). */
  private nextId(prefix: string) {
    return `${prefix}${String(++this.n).padStart(4, "0")}`;
  }

  private async handle(req: IncomingMessage, res: import("node:http").ServerResponse) {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString("utf8");
    const body = raw ? JSON.parse(raw) : undefined;
    const path = req.url ?? "";
    this.requests.push({ method: req.method ?? "", path, headers: req.headers, body });
    const send = (code: number, data: unknown) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(code >= 400 ? { detail: data } : { success: true, data }));
    };
    if (path === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ ok: true, storage: "fake", schema_version: "0", protocol: "shards/1.1" }));
    }
    if (path === "/v1/shards" && req.method === "POST") {
      if (this.mode === "drop-before-commit") return req.socket.destroy();
      if (this.mode === "status" && !this.commitThenStatus) return send(this.status, "forced");
      if (this.failOnContent?.(String((body as { content?: unknown } | undefined)?.content ?? ""))) return send(this.status, "forced: failOnContent");
      const uniqueKeys: string[] = Array.isArray(body?.uniqueKeys) ? body.uniqueKeys.map(String) : [];
      const profileKey = (k: string) => `${String(req.headers["x-keon-profile-id"] ?? "")}\0${k}`;
      const key = String(req.headers["x-idempotency-key"] ?? "");
      let id = key ? this.byKey.get(key) : undefined;
      if (!id && uniqueKeys.length > 0 && this.uniqueKeyHold > 0) {
        // Race barrier: every arriving mint write waits until the quota arrived, then all resume.
        this.uniqueKeyHold--;
        const go = new Promise<void>((r) => this.parked.push(r));
        if (this.uniqueKeyHold === 0) for (const r of this.parked.splice(0)) r();
        await go;
      }
      // ccm idempotency: a reused X-Idempotency-Key short-circuits BEFORE the claim check and
      // returns the stored receipt (keon-cortex: "an identical retry can complete") — a replay
      // of a key-bearing write must never 409 on its OWN key.
      if (!id && uniqueKeys.length > 0) {
        const taken = uniqueKeys.find((k) => this.uniqueKeys.has(profileKey(k)));
        if (taken) {
          // Real Cortex (ccm-atomic-batch-v1 §2.2): a taken key is a 409 naming the key;
          // the record and its key rows roll back — nothing is written.
          this.uniqueKeyConflicts++;
          return send(409, `unique key is already claimed: ${taken}`);
        }
      }
      if (!id) {
        // The claim check above and this claim store are back-to-back with NO await between
        // them: that adjacency models ccm's claim-in-the-write's-transaction atomicity in this
        // single-threaded fake. Never insert a yield between the check and this set.
        id = this.nextId("shd_fake");
        // Mirror the real Cortex: write provenance keeps source / agent_id / source_uri /
        // source_kind / checkpoint_at, but `extra` is server-built — submitted extras
        // (captured_by, branch stamps) are NOT handed back. Test-seeded `extra`/`capturedBy`
        // still round-trip, for deployments that do preserve them.
        this.shards.set(id, {
          id,
          content: body.content,
          memoryType: body.memoryType,
          role: String(req.headers["x-keon-role-id"]),
          profile: String(req.headers["x-keon-profile-id"]),
          tenant: String(req.headers["x-tenant-id"]),
          key,
          checkpointAt: body.provenance?.checkpointAt ?? body.provenance?.checkpoint_at,
          agentId: body.provenance?.agentId,
          sourceUri: body.provenance?.sourceUri,
          sourceKind: body.provenance?.sourceKind,
          source: body.provenance?.source,
          // Real Cortex stores subject keys on write (ingress alias "subjectKeys") and hands
          // them back as "subject_keys" — the schema:item linkage depends on this round-trip.
          subjectKeys: Array.isArray(body.subjectKeys) ? body.subjectKeys.map(String) : undefined,
        });
        for (const k of uniqueKeys) this.uniqueKeys.set(profileKey(k), id);
        if (key) this.byKey.set(key, id);
      }
      if (this.mode === "drop-after-commit") return req.socket.destroy();
      if (this.mode === "status") return send(this.status, "forced");
      if (this.conflictOnce) {
        this.conflictOnce = false;
        return send(409, "duplicate");
      }
      return send(200, { shard_id: id });
    }
    // Board reads only: the project-registry lookups ("[project/n]") that daemon startup makes are not faulted.
    if (path === "/v1/shards/search" && this.searchFault && !String((body as { query?: unknown } | undefined)?.query ?? "").startsWith("[project/")) {
      res.writeHead(this.searchFault.status, { "content-type": "application/json", ...(this.searchFault.retryAfterSeconds !== undefined ? { "retry-after": String(this.searchFault.retryAfterSeconds) } : {}) });
      return res.end(JSON.stringify({ detail: "forced: searchFault" }));
    }
    if (path === "/v1/shards/search") {
      // Like real Cortex, search rows hand the write provenance back (source_uri / agent_id /
      // checkpoint_at / profile_id — resync's writer attribution and event times depend on it).
      // Real Cortex matches by term overlap (any shared whitespace token; keon-cortex
      // shard_plane.term_overlap_score) and clips the ranked result to `limit` while reporting the
      // full match count in `total` — the board's batched id-block searches depend on both.
      const searchProfile = String(req.headers["x-keon-profile-id"] ?? "");
      const fromShards = [...this.shards.values()].filter((s) => this.readable(s, req) && (!this.profileScopedSearch || !searchProfile || s.profile === searchProfile)).filter((s) => s.content === body.query || s.content.startsWith(body.query) || (this.lexicalSearch && termOverlap(body.query, s.content))).map((s) => ({ shard_id: s.id, content: s.content, memory_type: s.memoryType ?? "note", status: s.status ?? "active", created_at: s.at ?? "2026-01-01T00:00:00Z", subject_keys: s.subjectKeys ?? [], provenance: { ...(s.sourceUri ? { source_uri: s.sourceUri } : {}), ...(s.agentId ? { agent_id: s.agentId } : {}), checkpoint_at: s.checkpointAt ?? s.at, extra: { scope_class: s.scope ?? "role_private", role_id: s.role, profile_id: s.profile, ...(s.capturedBy ? { captured_by: s.capturedBy } : {}), ...(s.extra ?? {}) } } }));
      const matched = [...this.searchResults, ...fromShards];
      const truncated = this.searchTruncated || this.searchTruncatedProfiles.includes(String(req.headers["x-keon-profile-id"] ?? ""));
      const limit = Math.min(Math.max(Number(body?.limit) || 10, 1), 100);
      return send(200, { shards: matched.slice(0, limit), total: matched.length + (truncated ? 5 : 0), truncated });
    }
    if (path.split("?")[0] === "/v1/shards" && req.method === "GET") {
      if (this.listStatus) return send(this.listStatus, "listing unavailable");
      const query = new URL(`http://fake${path}`).searchParams;
      const profileFilter = query.get("profile_id");
      const scopeFilter = query.get("scope");
      const typeFilter = query.get("memory_type");
      const statusFilter = query.get("status") ?? "active";
      const timeField = query.get("time_field") ?? "checkpoint_at";
      const since = query.get("since");
      const until = query.get("until");
      const prefix = query.get("subject_key_prefix");
      const requested = Math.min(Math.max(Number(query.get("limit") ?? 100) || 100, 1), 500);
      const limit = this.listMaxPageSize > 0 ? Math.min(requested, this.listMaxPageSize) : requested;
      // Match pinned Cortex keyset semantics: checkpoint/id ordering, opaque cursor
      // bound to filters and caller carriage, limit excluded from that binding.
      const filters = { profile_id: profileFilter, scope: scopeFilter, memory_type: typeFilter, status: statusFilter, time_field: timeField, since, until, subject_key_prefix: prefix };
      const binding = createHash("sha256").update(JSON.stringify([req.headers["x-tenant-id"], req.headers["x-actor-id"], req.headers["x-keon-role-id"], req.headers["x-keon-profile-id"], String(req.headers["x-keon-grant-scopes"] ?? "").split(",").sort(), filters])).digest("hex");
      const encode = (key: string[]) => {
        const payload = JSON.stringify([key, binding]);
        return Buffer.from(JSON.stringify([payload, createHmac("sha256", "fake-list-only").update(payload).digest("hex")])).toString("base64url");
      };
      let after: string[] | undefined;
      if (query.has("cursor")) {
        try {
          const [payload, signature] = JSON.parse(Buffer.from(query.get("cursor")!, "base64url").toString());
          const [key, bound] = JSON.parse(payload);
          if (bound !== binding || signature !== createHmac("sha256", "fake-list-only").update(payload).digest("hex") || !Array.isArray(key) || key.length !== 2) throw new Error("cursor");
          after = key;
        } catch { return send(422, "cursor is invalid or does not match the current filters/carriage"); }
      }
      const fromShards = [...this.shards.values()].map((s) => ({
        shard_id: s.id,
        content: s.content,
        memory_type: s.memoryType ?? "note",
        status: s.status ?? "active",
        created_at: s.at ?? "2026-01-01T00:00:00Z",
        subject_keys: s.subjectKeys ?? [],
        _profile: s.profile,
        _scope: s.scope ?? "role_private",
        _checkpoint: s.checkpointAt ?? s.at ?? "2026-01-01T00:00:00Z",
        _readable: this.readable(s, req) && (s.tenant ?? "tnt_test") === String(req.headers["x-tenant-id"] ?? ""),
        provenance: { ...(s.sourceUri ? { source_uri: s.sourceUri } : {}), ...(s.agentId ? { agent_id: s.agentId } : {}), checkpoint_at: s.checkpointAt ?? s.at, extra: { scope_class: s.scope ?? "role_private", role_id: s.role, profile_id: s.profile, ...(s.capturedBy ? { captured_by: s.capturedBy } : {}), ...(s.extra ?? {}) } },
      }));
      const fromSearch = this.searchResults.map((s) => ({
        ...s,
        memory_type: (s as { memory_type?: string }).memory_type ?? "note",
        subject_keys: (s as { subject_keys?: string[] }).subject_keys ?? [],
        _profile: String((s.provenance as { extra?: { profile_id?: unknown } } | undefined)?.extra?.profile_id ?? ""),
        _scope: String((s.provenance as { extra?: { scope_class?: unknown } } | undefined)?.extra?.scope_class ?? "role_private"),
        _checkpoint: String((s.provenance as { checkpoint_at?: unknown } | undefined)?.checkpoint_at ?? s.created_at ?? ""),
        _readable: true,
      }));
      const rows = [...fromSearch, ...fromShards]
        .filter((r) => r._readable)
        .filter((r) => !profileFilter || r._profile === profileFilter)
        .filter((r) => !scopeFilter || r._scope === scopeFilter)
        .filter((r) => !typeFilter || r.memory_type === typeFilter)
        .filter((r) => statusFilter === "all" || r.status === "active")
        .filter((r) => !prefix || r.subject_keys.some((key: string) => key.startsWith(prefix)))
        .filter((r) => {
          const at = String(timeField === "created_at" ? r.created_at ?? "" : r._checkpoint ?? "");
          return (!since || at >= since) && (!until || at <= until);
        })
        .sort((a, b) => String(a._checkpoint).localeCompare(String(b._checkpoint)) || String(a.shard_id).localeCompare(String(b.shard_id)));
      const compare = (a: string[], b: string[]) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0;
      rows.sort((a, b) => compare([String(a._checkpoint), a.shard_id], [String(b._checkpoint), b.shard_id]));
      const remaining = after ? rows.filter(r => compare([String(r._checkpoint), r.shard_id], after!) > 0) : rows;
      const page = remaining.slice(0, limit);
      const last = page.at(-1);
      const next = this.listRepeatCursor && query.get("cursor") ? query.get("cursor") : remaining.length > limit && last ? encode([String(last._checkpoint), last.shard_id]) : null;
      return send(200, {
        shards: page.map(({ _profile, _scope, _checkpoint, _readable, ...row }) => row),
        next_cursor: next,
      });
    }
    if (path.endsWith("/lineage") && req.method === "GET") {
      const id = decodeURIComponent(path.slice("/v1/shards/".length, -"/lineage".length));
      return send(200, { shard_id: id, lineage_hash: "fake", ancestor_ids: this.ancestors.get(id) ?? [], receipt_ref: null });
    }
    if (path.startsWith("/v1/shards/") && req.method === "GET") {
      const s = this.shards.get(decodeURIComponent(path.slice("/v1/shards/".length)));
      if (!s || !this.readable(s, req)) return send(404, "not found");
      const extra: Record<string, unknown> = { scope_class: s.scope ?? "role_private", role_id: s.role, profile_id: s.profile, ...(s.extra ?? {}) };
      if (s.capturedBy) extra.captured_by = s.capturedBy;
      return send(200, {
        shard_id: s.id,
        content: s.content,
        memory_type: s.memoryType ?? "note",
        status: s.status ?? "active",
        created_at: s.at ?? "2026-01-01T00:00:00Z",
        updated_at: s.at ?? "2026-01-01T00:00:00Z",
        source: s.source ?? "t",
        subject_keys: s.subjectKeys ?? [],
        lineage_refs: s.lineageRefs ?? [],
        provenance: {
          source: s.source ?? "t",
          ...(s.agentId ? { agent_id: s.agentId } : {}),
          timestamp: s.at ?? "2026-01-01T00:00:00Z",
          ...(s.sourceKind ? { source_kind: s.sourceKind } : {}),
          ...(s.sourceUri ? { source_uri: s.sourceUri } : {}),
          ...(s.checkpointAt ?? s.at ? { checkpoint_at: s.checkpointAt ?? s.at } : {}),
          extra,
        },
      });
    }
    if (path === "/v1/recall") {
      // Recalls are profile-scoped: only records written under the requesting profile match.
      const profile = String(req.headers["x-keon-profile-id"] ?? "");
      const seen = new Set<string>();
      const merged: { shard_id: string; content: string }[] = [];
      const all = [...this.recallResults, ...[...this.shards.values()].map((s) => ({ shard_id: s.id, content: s.content }))];
      for (const r of all) {
        if (seen.has(r.shard_id)) continue;
        const s = this.shards.get(r.shard_id);
        if (s && profile && s.profile !== profile) continue;
        seen.add(r.shard_id);
        merged.push(r);
      }
      // Like real Cortex, recall honours `limit` (continuity always asks for 8) and ranks the records that
      // match the query ahead of the rest. Handing back every record on the board made the fake answer a
      // recall with 100+ results, so the access event listing them was a 422 ("must be 1-100 distinct
      // identifiers") and `kontinuity recall` failed once a board held about 100 records.
      const q = typeof body?.query === "string" ? body.query : "";
      const terms = q.trim().split(/\s+/).filter(Boolean);
      const matches = (r: { content: string }) => terms.length > 0 && (r.content === q || r.content.startsWith(q) || (() => { const toks = r.content.split(/\s+/); return terms.every((t: string) => toks.some((k: string) => k.startsWith(t))); })());
      const limit = Number.isInteger(body?.limit) && body.limit > 0 ? Math.min(body.limit, 100) : 10;
      merged.sort((a, b) => Number(matches(b)) - Number(matches(a)));
      merged.splice(limit);
      return send(200, {
        ...(this.omitRecallEventId ? {} : { recall_event_id: "rev_fake1" }),
        operation_id: String(req.headers["x-keon-operation-id"]),
        delivery: { key: "k", first_delivered_at: "2026-01-01T00:00:00Z", replayed: false, first_excluded: 0 },
        results: merged.map((r, i) => ({ ...r, memory_type: "note", rank: i, relevance_score: 1, gravity_score: 0, verified: true })),
        verification_meta: { excluded: 0, method: "fake", truncated: false },
        gravity_version: "0",
        gravity_function_hash: "0",
        gravity_as_of: 0,
      });
    }
    if (path === "/v1/memory-events") {
      const op = String(req.headers["x-keon-operation-id"]);
      if (this.eventStatus && (this.eventFailKinds.length === 0 || this.eventFailKinds.includes(String(body?.kind)))) return send(this.eventStatus, "memory-event store unavailable");
      // Like real Cortex: a body that violates the event schema is a 422 (nothing recorded). This is
      // what makes a malformed event fail tests instead of being accepted.
      const schemaErrors = validateMemoryEvent(body);
      if (schemaErrors.length > 0) return send(422, schemaErrors);
      if (this.conflictOnReusedOp && this.eventOps.has(op)) return send(409, "operation_id reused with a different request");
      this.eventOps.add(op);
      return send(200, { attribution: "self_reported", event_ids: ["ev1"] });
    }
    if (path === "/v1/curation/proposals" && req.method === "POST") {
      const id = this.nextId("prp_fake");
      this.proposals.set(id, {
        kind: String(body.kind),
        toRoleId: typeof body.to_role_id === "string" ? body.to_role_id : undefined,
        content: String(body.content),
        role: String(req.headers["x-keon-role-id"] ?? ""),
        actor: String(req.headers["x-actor-id"] ?? ""),
        sourceRecordIds: Array.isArray(body.source_record_ids) ? body.source_record_ids.map(String) : undefined,
      });
      return send(200, { operation_id: String(req.headers["x-keon-operation-id"]), proposal_id: id, replayed: false, status: "pending" });
    }
    if (path === "/v1/curation/dispositions" && req.method === "POST") {
      await this.beforeDisposition?.(body);
      const p = this.proposals.get(String(body.proposal_id));
      if (!p) return send(404, "proposal not found");
      if (body.action === "reject") return send(200, { action: "reject", status: "rejected" });
      const oldId = body.action === "supersede" && body.supersedes_record_id ? String(body.supersedes_record_id) : undefined;
      if (oldId) {
        const old = this.shards.get(oldId);
        // Mirror keon-cortex curation.py: the supersede target must not be superseded yet —
        // this refusal IS the compare-and-swap two concurrent revives race on.
        if (old && old.status === "superseded") {
          return send(409, "supersede target is already superseded — the replacement relation must not fork (P4a-T10)");
        }
      }
      // ccm-atomic-batch-v1: declared unique keys bind to the minted record (for supersede,
      // the replacement — the old record's keys move to it). A taken key refuses everything.
      const declared: string[] = Array.isArray(body.unique_keys) ? body.unique_keys.map(String) : [];
      const profile = String(req.headers["x-keon-profile-id"]);
      const oldKeys = oldId ? [...this.uniqueKeys.entries()].filter(([, owner]) => owner === oldId).map(([k]) => k) : [];
      for (const key of declared) {
        const owner = this.uniqueKeys.get(`${profile}\u0000${key}`);
        if (owner !== undefined && !(oldId && owner === oldId)) {
          return send(409, `unique key is already claimed: ${key}`);
        }
      }
      if (this.rejectDuplicateDerivedContent && [...this.shards.values()].some(s => s.profile === profile && s.scope === "profile_shared" && s.content === p.content)) {
        return send(409, "the derived artifact already exists in the target scope");
      }
      // Mirror shards/1.1: handoff-kind approvals materialize a record scoped to handoff_to_role_id.
      // A derived record is a curation row: server-built provenance (agent_id yes), no inherited extras.
      const id = this.nextId("shd_fake");
      const extra: Record<string, unknown> =
        p.kind === "handoff"
          ? { scope_class: "handoff", curation_kind: "handoff", handoff_to_role_id: p.toRoleId, role_id: p.role, agent_id: p.actor, support_level: "provisional", epistemic_status: "unverified" }
          : { scope_class: "profile_shared", support_level: "provisional", epistemic_status: "unverified" };
      this.shards.set(id, { id, content: p.content, role: p.role, profile, tenant: String(req.headers["x-tenant-id"]), extra, lineageRefs: p.sourceRecordIds, ...(p.kind === "handoff" ? {} : { scope: "profile_shared" }), agentId: p.actor || undefined });
      if (oldId) {
        const old = this.shards.get(oldId);
        if (old) old.status = "superseded";
        // The superseded record's keys move to the replacement (ccm-atomic-batch-v1 §2.3).
        for (const key of oldKeys) this.uniqueKeys.set(`${profile}\u0000${key}`, id);
      }
      for (const key of declared) this.uniqueKeys.set(`${profile}\u0000${key}`, id);
      return send(200, { action: String(body.action), status: body.action === "approve" ? "approved" : String(body.action), derived_shard_id: id, inheritance_event_id: "inh_fake1" });
    }
    return send(404, `no route ${path}`);
  }
}

/** Isolated HOME + state dir + config + secret for one test file. Must run BEFORE importing core modules. */
export function isolateEnv(cortexUrl: string, extraConfig: Record<string, unknown> = {}) {
  const root = testTmpDir("continuity-test-");
  const cfgDir = join(root, "home", ".config", "continuity");
  mkdirSync(cfgDir, { recursive: true });
  process.env.HOME = join(root, "home");
  process.env.USERPROFILE = join(root, "home");
  process.env.XDG_STATE_HOME = join(root, "state");
  // A throwaway value built at runtime; never a real credential.
  process.env.CORTEX_GATEWAY_SERVICE_SECRET = ["test", "only", "value"].join("-");
  // Tests must never auto-sweep the real checkout's task worktrees (core/spawn.ts honours this).
  process.env.CONTINUITY_NO_SWEEP = "1";
  delete process.env.CONTINUITY_GENERATION;
  setConfig(cortexUrl, extraConfig);
  return { root, setConfig };

  function setConfig(url: string, extra: Record<string, unknown> = {}) {
    writeFileSync(join(cfgDir, "config.json"), JSON.stringify({ cortexUrl: url, tenantId: "tnt_test", ...extra }));
  }
}

/** A URL on 127.0.0.1 where nothing is listening (a port that was just freed). */
export async function deadUrl(): Promise<string> {
  const srv = createServer();
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const port = (srv.address() as AddressInfo).port;
  await new Promise<void>((r) => srv.close(() => r()));
  return `http://127.0.0.1:${port}`;
}

/**
 * Real Cortex term-overlap scoring: `|terms ∩ content_terms| / |terms|` over lowercase whitespace
 * splits (keon-cortex shard_plane.term_overlap_score) — a record matches when ANY query term is
 * one of its whitespace tokens, so a multi-id query is the exact union of its per-id matches.
 * The exact/prefix clause in the search handler stays as an additional matcher for callers that
 * look records up by content.
 */
function termOverlap(query: unknown, content: string): boolean {
  if (typeof query !== "string") return false;
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return false;
  const tokens = new Set(content.toLowerCase().split(/\s+/));
  return terms.some((t) => tokens.has(t));
}
