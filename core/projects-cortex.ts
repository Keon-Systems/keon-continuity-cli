/**
 * The Project/1 registry in Cortex (TASK-136): one shared `project/1` record per
 * Project/1 in the reserved registry profile `proj_projects`, so projects travel across
 * machines (Linux, Windows, macOS — universal travel with continuity).
 *
 * Design (docs/doc-ingest-architecture.md §Project/1 registry records):
 *   - shape `project/1` — `[project/1] project-id:<prj_…> project-slug:<slug> {json}`;
 *     the prefix tokens are exactly the unique-key pair, and the JSON is the record.
 *   - the revision IS the supersede chain: a revise supersedes the head record and
 *     Cortex's "supersede target is already superseded" refusal IS the compare-and-swap
 *     — two concurrent revives of one head converge on exactly one winner.
 *   - uniqueness is TASK-133 (`ccm-atomic-batch-v1`): publishing claims
 *     `project-id:<prj_…>` and `project-slug:<slug>` in the (tenant, profile, key)
 *     keyspace, bound to the minted record in the same transaction. A taken key is a
 *     refusal naming the key (→ `instance_collision`). On supersede the keys MOVE to the
 *     replacement — they are never re-declared on a revise.
 *   - archive is a supersede (lifecycle "archived"), never a delete.
 *   - the local registry JSON file is a read-through cache, never the authority: reads
 *     refresh it and serve it only when Cortex is provably unreachable; writes always go
 *     to Cortex first and never fall back to the file. Cache rows with no live record id
 *     are LOCAL-ONLY (pre-migration rows) — visible on this machine until
 *     `migrateLocalProjects` publishes them.
 *
 * Both transports: `cortexProjectTransport` (direct Cortex HTTP) and
 * `gatewayProjectTransport` (core/projects-gateway.ts, `keon.cortex.curation.batch.v1` +
 * `keon.cortex.memory.search.v1`) implement the same `ProjectRecordTransport` seam.
 *
 * The registry lock (TASK-131, still fail-closed) now guards the CACHE file and
 * serializes local writers; the cross-writer authority is the Cortex supersede chain.
 */

import {
  acquireLock,
  projectRegistryPath,
  PROJECT_REGISTRY_PROFILE,
  ProjectError,
  readSnapshot,
  requireActor,
  visible,
  writeSnapshot,
  type ProjectCaller,
  type ProjectRecord,
  type ProjectStore,
  type RegistryLockOptions,
  type RegistrySnapshot,
} from "./projects.ts";
import { CortexClient, CortexError, grant, type CortexTransport, type Identity, type SearchShard } from "../src/cortex.ts";
import { derivedId, mintId } from "../src/ids.ts";
import { loadConfig, loadSecret } from "../src/config.ts";
import { actorForRuntimeName, normalizeRuntimeName, roleForRuntimeName, type Runtime } from "./runtime.ts";

// ---------- the `project/1` record shape ----------

/** The record tag every registry record's content starts with (also the enumeration query). */
export const PROJECT_RECORD_TAG = "[project/1]";

/** The record's fields as published. Device-local fields (workspaceRoot, workspacePendingReason) never travel. */
export type ProjectRecordFields = Omit<ProjectRecord, "tenantId" | "recordId" | "workspaceRoot" | "workspacePendingReason">;

const ACTOR_ID_RE = /^[A-Za-z][A-Za-z0-9_-]{0,64}$/;
const GRANT_ID_RE = /^(proj|actor)_[a-z0-9_]+$/;
const PROJECT_SLUG_RE = /^proj_[a-z][a-z0-9_]{0,62}$/;
const LIFECYCLES = new Set(["pending", "active", "archived"]);
const RIGORS = new Set(["T0", "T1", "T2"]);

/** Canonical JSON: object keys sorted, arrays kept in order, no insignificant whitespace. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

/** The TASK-133 unique keys this project claims in the registry profile's keyspace. */
export function registryUniqueKeys(record: Pick<ProjectRecord, "projectId" | "slug">): string[] {
  return [`project-id:${record.projectId}`, `project-slug:${record.slug}`];
}

/** The record's JSON body — the `project/1` shape minus the searchable prefix. */
function recordJson(record: ProjectRecordFields): Record<string, unknown> {
  return {
    version: "Project/1",
    projectId: record.projectId,
    slug: record.slug,
    title: record.title,
    ownerRef: record.ownerRef,
    lifecycle: record.lifecycle,
    defaultRigor: record.defaultRigor,
    workspace: record.workspace,
    satelliteGrants: record.satelliteGrants,
    acl: record.acl,
    revision: record.revision,
    boardNamespace: record.boardNamespace,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    ...(record.adoption ? { adoption: record.adoption } : {}),
  };
}

/**
 * The record content: the searchable prefix (shape tag + exactly the two unique keys)
 * followed by the canonical record JSON. One line; the JSON is the shape.
 */
export function projectRecordContent(record: ProjectRecordFields): string {
  return `${PROJECT_RECORD_TAG} project-id:${record.projectId} project-slug:${record.slug} ${canonicalJson(recordJson(record))}`;
}

/**
 * The record's shared shape: everything EXCEPT `revision` and `updatedAt`. Two snapshots
 * with equal shapes differ only in bookkeeping — publishing that would supersede the chain
 * for a no-op (a second device re-binding the same workspace would invalidate every other
 * device's expectedRevision). A no-op is a no-op: no new chain step.
 */
export function sharedShape(record: ProjectRecordFields): string {
  const { revision: _r, updatedAt: _u, ...shape } = recordJson(record);
  return canonicalJson(shape);
}

function invalid(message: string): ProjectError {
  return new ProjectError("invalid_shape", message, 500, 1);
}

function oneLine(value: unknown, label: string, max: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max || /[\r\n\u0000]/.test(value)) {
    throw invalid(`project/1 ${label} must be a single line of 1..${max} characters`);
  }
  return value;
}

function timestamp(value: unknown, label: string): string {
  const s = oneLine(value, label, 64);
  if (!Number.isFinite(Date.parse(s))) throw invalid(`project/1 ${label} must be an ISO-8601 time`);
  return s;
}

function stringArray(value: unknown, label: string, test: RegExp, cap: number): string[] {
  if (!Array.isArray(value) || value.length > cap) throw invalid(`project/1 ${label} must be an array of at most ${cap}`);
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || !test.test(entry)) throw invalid(`project/1 ${label} entries must match ${test}`);
    if (!out.includes(entry)) out.push(entry);
  }
  return out;
}

function assertKeys(input: Record<string, unknown>, allowed: readonly string[], optional: readonly string[] = []): void {
  for (const key of Object.keys(input)) {
    if (!allowed.includes(key) && !optional.includes(key)) {
      throw invalid(`project/1 record carries unknown field ${JSON.stringify(key)} — a shape from another version is refused, never guessed at`);
    }
  }
}

/**
 * Parse one `project/1` record's content. STRICT: an unknown field, a type mismatch, or a
 * prefix/body disagreement refuses the record (fail closed — a shape from a future version
 * is never guessed at). Throws `ProjectError("invalid_shape")`.
 */
export function parseProjectRecord(content: string): ProjectRecordFields {
  const m = /^\[project\/1\] project-id:(\S+) project-slug:(\S+) (\{.*\})$/.exec(content.trim());
  if (!m) throw invalid("record content is not a [project/1] registry record");
  let input: unknown;
  try {
    input = JSON.parse(m[3]!);
  } catch {
    throw invalid("project/1 record body is not valid JSON");
  }
  if (input === null || typeof input !== "object" || Array.isArray(input)) throw invalid("project/1 record body must be an object");
  const rec = input as Record<string, unknown>;
  assertKeys(rec, ["version", "projectId", "slug", "title", "ownerRef", "lifecycle", "defaultRigor", "workspace", "satelliteGrants", "acl", "revision", "boardNamespace", "createdAt", "updatedAt"], ["adoption"]);
  if (rec.version !== "Project/1") throw invalid('project/1 record version must be "Project/1"');
  const projectId = oneLine(rec.projectId, "projectId", 128);
  if (!/^prj_[a-z0-9]{16,64}$/.test(projectId)) throw invalid("project/1 projectId must match prj_<16-64 lowercase alphanumerics>");
  const slug = oneLine(rec.slug, "slug", 64);
  if (!PROJECT_SLUG_RE.test(slug)) throw invalid("project/1 slug must be canonical proj_<lowercase>");
  if (projectId !== m[1] || slug !== m[2]) throw invalid("project/1 record prefix disagrees with its body");
  const title = oneLine(rec.title, "title", 200);
  const ownerRef = oneLine(rec.ownerRef, "ownerRef", 64);
  if (!ACTOR_ID_RE.test(ownerRef)) throw invalid("project/1 ownerRef is not a valid actor reference");
  const lifecycle = oneLine(rec.lifecycle, "lifecycle", 16);
  if (!LIFECYCLES.has(lifecycle)) throw invalid('project/1 lifecycle must be "pending", "active", or "archived"');
  const defaultRigor = oneLine(rec.defaultRigor, "defaultRigor", 8);
  if (!RIGORS.has(defaultRigor)) throw invalid('project/1 defaultRigor must be "T0", "T1", or "T2"');
  const workspaceInput = rec.workspace;
  if (workspaceInput === null || typeof workspaceInput !== "object" || Array.isArray(workspaceInput)) {
    throw invalid("project/1 workspace must be an object");
  }
  const ws = workspaceInput as Record<string, unknown>;
  assertKeys(ws, ["state"], ["ref"]);
  let workspace: ProjectRecordFields["workspace"];
  if (ws.state === "none") workspace = { state: "none" };
  else if (ws.state === "pending") workspace = { state: "pending" };
  else if (ws.state === "bound") {
    const ref = oneLine(ws.ref, "workspace.ref", 200);
    workspace = { state: "bound", ref };
  } else throw invalid('project/1 workspace.state must be "none", "pending", or "bound"');
  const satelliteGrants = stringArray(rec.satelliteGrants ?? [], "satelliteGrants", GRANT_ID_RE, 64);
  if (satelliteGrants.some((g) => g.toLowerCase() === PROJECT_REGISTRY_PROFILE)) {
    throw invalid(`${PROJECT_REGISTRY_PROFILE} is the reserved registry profile and is never a satellite grant`);
  }
  const acl = stringArray(rec.acl ?? [], "acl", ACTOR_ID_RE, 64);
  const revision = rec.revision;
  if (typeof revision !== "number" || !Number.isInteger(revision) || revision < 0) {
    throw invalid("project/1 revision must be a non-negative integer");
  }
  const boardNamespace = oneLine(rec.boardNamespace, "boardNamespace", 64);
  const createdAt = timestamp(rec.createdAt, "createdAt");
  const updatedAt = timestamp(rec.updatedAt, "updatedAt");
  let adoption: ProjectRecordFields["adoption"];
  if (rec.adoption !== undefined) {
    const a = rec.adoption;
    if (a === null || typeof a !== "object" || Array.isArray(a)) throw invalid("project/1 adoption must be an object");
    const adopt = a as Record<string, unknown>;
    assertKeys(adopt, ["legacyProfileId", "provenance", "reviewedAt"]);
    adoption = {
      legacyProfileId: oneLine(adopt.legacyProfileId, "adoption.legacyProfileId", 64),
      provenance: oneLine(adopt.provenance, "adoption.provenance", 500),
      reviewedAt: timestamp(adopt.reviewedAt, "adoption.reviewedAt"),
    };
  }
  return {
    version: "Project/1",
    projectId,
    slug,
    title,
    ownerRef,
    lifecycle: lifecycle as ProjectRecordFields["lifecycle"],
    defaultRigor: defaultRigor as ProjectRecordFields["defaultRigor"],
    workspace,
    satelliteGrants,
    acl,
    revision,
    boardNamespace,
    createdAt,
    updatedAt,
    ...(adoption ? { adoption } : {}),
  };
}

// ---------- the transport seam ----------

export interface ProjectTransportRecord {
  /** Shard id of the shared record in the registry profile. */
  recordId: string;
  /** The record content: `[project/1] project-id:… project-slug:… {json}`. */
  content: string;
  /** Cortex record status; "superseded" rows are chain history, never heads. */
  status: string;
}

/**
 * What the registry needs from a Cortex transport. `load` returns every `project/1`
 * record (heads and superseded history); `publish` claims the unique keys;
 * `supersede` is the compare-and-swap on the head. Implementations classify
 * "provably never reached the store" as `ProjectRegistryUnreachable`.
 */
export interface ProjectRecordTransport {
  load(): Promise<ProjectTransportRecord[]>;
  publish(record: ProjectRecordFields): Promise<string>;
  supersede(headRecordId: string, record: ProjectRecordFields): Promise<string>;
}

/**
 * The transport provably never reached the authority (connection refused, DNS, gateway
 * down). Reads may serve the read-through cache; writes never do.
 */
export class ProjectRegistryUnreachable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProjectRegistryUnreachable";
  }
}

/** The refusal text mapping (docs/doc-ingest-architecture.md): keon-cortex owns the wording. */
export function mapRegistryWriteError(e: unknown, record: Pick<ProjectRecord, "slug" | "projectId">): unknown {
  if (e instanceof ProjectError) return e;
  const message = e instanceof Error ? e.message : String(e);
  if (/already superseded/i.test(message)) {
    return new ProjectError(
      "revision_conflict",
      `project ${record.slug} changed under this update: its previous record is already superseded (the compare-and-swap lost). Nothing was written — re-read and retry.`,
      409,
      1,
    );
  }
  if (/unique key is already claimed|already claimed/i.test(message)) {
    return new ProjectError(
      "instance_collision",
      `refusing to publish ${record.slug} (${record.projectId}): ${message} — this project id or slug is already in the registry (another machine, or an earlier attempt of ours whose result was lost, already holds it — check the listing before retrying).`,
      409,
      1,
    );
  }
  return e;
}

/** The role-private source note every publication writes first (audit trail; never a registry record). */
export function projectSourceNote(record: ProjectRecordFields): string {
  return `[note] project registry source write: ${record.slug} (${record.projectId}) revision ${record.revision}`;
}

// ---------- direct Cortex transport ----------

function isUnreachable(e: unknown): boolean {
  return e instanceof CortexError && e.status === 0;
}

async function writeSource(agent: CortexTransport, record: ProjectRecordFields): Promise<string> {
  const res = await agent.remember({
    content: projectSourceNote(record),
    memoryType: "observation",
    source: "continuity/project-registry",
    subjectKeys: ["continuity", "project/1", `project-id:${record.projectId}`, `project-slug:${record.slug}`],
    // Deterministic: a retry of the same publish/revision replays the write instead of a 409.
    idempotencyKey: derivedId("prjsrc", record.projectId, String(record.revision)),
    provenance: {
      source: "continuity/project-registry",
      agentId: agent.identity.actorId,
      sourceKind: "user_confirmed",
      sourceUri: `urn:continuity:project-registry:${record.projectId}:${record.revision}`,
      checkpointAt: record.updatedAt,
      extra: { captured_by: "continuity", continuity_version: "0.1" },
    },
  });
  return res.shard_id;
}

/**
 * The direct transport: `POST /v1/shards/search` to read, and write + proposal +
 * disposition to publish (`approve` carrying the two `unique_keys`) or revise/archive
 * (`supersede` — the keys move, never re-declared). Both clients must already be bound
 * to the registry profile (`runtimeProjectTransport` builds them).
 */
export function cortexProjectTransport(agent: CortexTransport, owner: CortexTransport): ProjectRecordTransport {
  return {
    async load() {
      let res;
      try {
        res = await agent.search(PROJECT_RECORD_TAG, 100);
      } catch (e) {
        if (isUnreachable(e)) throw new ProjectRegistryUnreachable(`the project registry is unreachable (${e instanceof CortexError ? String(e.detail) : "transport"})`);
        throw e;
      }
      if (res.total > res.shards.length) {
        throw new ProjectError(
          "enumeration_truncated",
          `the project registry enumeration was truncated (${res.shards.length} of ${res.total} records) — refusing to serve an incomplete listing`,
          500,
          1,
        );
      }
      return res.shards
        .filter((s: SearchShard) => s.provenance?.extra?.scope_class !== "role_private")
        .map((s: SearchShard) => ({ recordId: s.shard_id, content: s.content, status: s.status ?? "active" }));
    },
    async publish(record) {
      try {
        const sourceId = await writeSource(agent, record);
        const prop = await agent.propose({
          kind: "lesson",
          sourceRecordIds: [sourceId],
          content: projectRecordContent(record),
          reason: `project registry publish ${record.slug}`,
        });
        const disp = await owner.dispose({
          proposalId: prop.proposal_id,
          action: "approve",
          approvalReceiptRef: mintId("rcpt_approve"),
          uniqueKeys: registryUniqueKeys(record),
          reason: `project registry publish ${record.slug}`,
        });
        if (!disp.derived_shard_id) throw invalid(`publish of ${record.slug} returned no derived record (status ${disp.status})`);
        return disp.derived_shard_id;
      } catch (e) {
        throw mapRegistryWriteError(e, record);
      }
    },
    async supersede(headRecordId, record) {
      try {
        const sourceId = await writeSource(agent, record);
        const prop = await agent.propose({
          kind: "lesson",
          sourceRecordIds: [sourceId],
          content: projectRecordContent(record),
          reason: `project registry revise ${record.slug} to revision ${record.revision}`,
        });
        const disp = await owner.dispose({
          proposalId: prop.proposal_id,
          action: "supersede",
          supersedesRecordId: headRecordId,
          approvalReceiptRef: mintId("rcpt_supersede"),
          reason: `project registry revise ${record.slug} to revision ${record.revision}`,
        });
        if (!disp.derived_shard_id) throw invalid(`revise of ${record.slug} returned no derived record (status ${disp.status})`);
        return disp.derived_shard_id;
      } catch (e) {
        throw mapRegistryWriteError(e, record);
      }
    },
  };
}

/** Registry-profile identities for one runtime: its agent role writes, its owner role approves. */
export function registryIdentities(rt: Runtime): { agent: Identity; owner: Identity } {
  const agentRole = rt.agent.identity.roleId;
  const ownerRole = rt.owner.identity.roleId;
  return {
    agent: {
      actorId: rt.agent.identity.actorId,
      roleId: agentRole,
      profileId: PROJECT_REGISTRY_PROFILE,
      grants: [grant.role(PROJECT_REGISTRY_PROFILE, agentRole), grant.profileShared(PROJECT_REGISTRY_PROFILE)],
    },
    owner: {
      actorId: rt.owner.identity.actorId,
      roleId: ownerRole,
      profileId: PROJECT_REGISTRY_PROFILE,
      grants: [grant.role(PROJECT_REGISTRY_PROFILE, ownerRole), grant.profileShared(PROJECT_REGISTRY_PROFILE), grant.curationApprove],
    },
  };
}

/** The direct transport for one runtime (its connection, registry-profile identities). */
export function runtimeProjectTransport(rt: Runtime): ProjectRecordTransport {
  const ids = registryIdentities(rt);
  return cortexProjectTransport(rt.agent.as(ids.agent), rt.owner.as(ids.owner));
}

/** Build the transport lazily. A construction failure degrades READS to the cache (never writes);
 * once built, the transport's own errors propagate loud — a contract bug must never silently
 * downgrade into serve-stale (big brother review 2026-11-07). */
export function lazyProjectTransport(build: () => ProjectRecordTransport): ProjectRecordTransport {
  let built: ProjectRecordTransport | undefined;
  const get = (): ProjectRecordTransport => {
    if (built) return built;
    try {
      built = build();
    } catch (e) {
      throw new ProjectRegistryUnreachable(`the project registry transport could not be built (${e instanceof Error ? e.message : String(e)})`);
    }
    return built;
  };
  return {
    load: () => get().load(),
    publish: (record) => get().publish(record),
    supersede: (head, record) => get().supersede(head, record),
  };
}

/** The config-driven direct transport (spawns, deck, and any call site without a runtime in hand). */
export function defaultProjectTransport(): ProjectRecordTransport {
  return lazyProjectTransport(() => {
    const cfg = loadConfig();
    const { secret } = loadSecret(cfg);
    const runtimeName = normalizeRuntimeName(undefined);
    const agentRole = roleForRuntimeName(cfg, runtimeName);
    const agentId: Identity = {
      actorId: actorForRuntimeName(cfg, runtimeName),
      roleId: agentRole,
      profileId: PROJECT_REGISTRY_PROFILE,
      grants: [grant.role(PROJECT_REGISTRY_PROFILE, agentRole), grant.profileShared(PROJECT_REGISTRY_PROFILE)],
    };
    const ownerId: Identity = {
      actorId: cfg.ownerActor,
      roleId: cfg.ownerRole,
      profileId: PROJECT_REGISTRY_PROFILE,
      grants: [grant.role(PROJECT_REGISTRY_PROFILE, cfg.ownerRole), grant.profileShared(PROJECT_REGISTRY_PROFILE), grant.curationApprove],
    };
    const agent = new CortexClient({ baseUrl: cfg.cortexUrl, secret, tenantId: cfg.tenantId, timeoutMs: 8000 }, agentId);
    return cortexProjectTransport(agent, agent.as(ownerId));
  });
}

// ---------- the read-through cache store ----------

export interface CortexProjectStoreOptions {
  transport: ProjectRecordTransport | (() => ProjectRecordTransport);
  /** Cache file per tenant. Default `projectRegistryPath` — the pre-TASK-136 registry file becomes the cache. */
  cachePath?: (tenantId: string) => string;
  lock?: RegistryLockOptions;
}

interface ParsedRecord {
  fields: ProjectRecordFields;
  record: ProjectTransportRecord;
}

/** Parse every registry record; group by project; the head is the one live (non-superseded) record.
 * Search hits that merely mention the tag are skipped out loud (a prose shard quoting
 * `[project/1]` must not brick the listing); a hit that STARTS with the record prefix but
 * refuses to parse is real corruption and fails closed. */
function selectHeads(records: ProjectTransportRecord[], tenantId: string): ProjectRecord[] {
  const byProject = new Map<string, ParsedRecord[]>();
  for (const record of records) {
    const trimmed = record.content.trimStart();
    if (!trimmed.startsWith(PROJECT_RECORD_TAG)) {
      note(`skipped a registry search hit that is not a project/1 record (${record.recordId}) — never parsed, never guessed`);
      continue;
    }
    const fields = parseProjectRecord(record.content);
    const group = byProject.get(fields.projectId);
    if (group) group.push({ fields, record });
    else byProject.set(fields.projectId, [{ fields, record }]);
  }
  const heads: ProjectRecord[] = [];
  for (const [projectId, group] of byProject) {
    const live = group.filter((g) => g.record.status !== "superseded");
    if (live.length !== 1) {
      throw invalid(
        live.length === 0
          ? `every project/1 record of ${projectId} is superseded — the chain has no live head (registry corruption; refusing to guess)`
          : `the registry holds ${live.length} live project/1 records for ${projectId} — the chain forked (registry corruption; refusing to guess)`,
      );
    }
    heads.push({ ...live[0]!.fields, tenantId, recordId: live[0]!.record.recordId });
  }
  return heads;
}

/**
 * Merge the authority's heads with the cache: a transport record wins for its project
 * (the cache contributes only device-local fields); any other cache row stays as a
 * LOCAL-ONLY row with its record id stripped — a copied or stale id must never authorize
 * a supersede.
 */
function mergeSnapshot(heads: ProjectRecord[], cache: RegistrySnapshot, tenantId: string): RegistrySnapshot {
  const cacheByProject = new Map(cache.projects.map((p) => [p.projectId, p]));
  const projects: ProjectRecord[] = [];
  const seen = new Set<string>();
  for (const head of heads) {
    const cached = cacheByProject.get(head.projectId);
    projects.push({
      ...head,
      ...(cached?.workspaceRoot ? { workspaceRoot: cached.workspaceRoot } : {}),
      ...(cached?.workspacePendingReason ? { workspacePendingReason: cached.workspacePendingReason } : {}),
    });
    seen.add(head.projectId);
  }
  for (const row of cache.projects) {
    if (seen.has(row.projectId)) continue;
    const { recordId: _stripped, ...localOnly } = row;
    projects.push(localOnly);
  }
  return { projects, legacyTasks: cache.legacyTasks };
}

function note(message: string): void {
  process.stderr.write(`project registry: ${message}\n`);
}

/**
 * The production `ProjectStore` (TASK-136): Cortex is the authority, the local JSON file
 * is a read-through cache. Reads refresh the cache and serve it only when the transport
 * provably never reached Cortex; writes run against Cortex first and never fall back.
 */
export function createCortexProjectStore(opts: CortexProjectStoreOptions): ProjectStore {
  const cachePath = opts.cachePath ?? projectRegistryPath;
  const lockOpts = opts.lock ?? {};
  const transport = (): ProjectRecordTransport => (typeof opts.transport === "function" ? opts.transport() : opts.transport);
  const chains = new Map<string, Promise<unknown>>();
  const queue = <T>(tenantId: string, fn: () => Promise<T>): Promise<T> => {
    const prev = chains.get(tenantId) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    chains.set(tenantId, run.then(() => undefined, () => undefined));
    return run;
  };

  async function readThrough<T>(tenantId: string, fn: (snapshot: RegistrySnapshot) => T | Promise<T>): Promise<T> {
    const path = cachePath(tenantId);
    let heads: ProjectRecord[] | undefined;
    let degraded: string | undefined;
    try {
      heads = selectHeads(await transport().load(), tenantId);
    } catch (e) {
      if (e instanceof ProjectRegistryUnreachable) degraded = e.message;
      else throw e;
    }
    const release = await acquireLock(path, lockOpts);
    try {
      const cache = readSnapshot(path);
      const snapshot = heads ? mergeSnapshot(heads, cache, tenantId) : cache;
      if (heads !== undefined && canonicalJson(snapshot) !== canonicalJson(cache)) {
        // Read-through: a successful refresh FILLS the cache (a read-only device's cache is
        // as fresh as its last read — degraded reads later serve that, never an empty file).
        writeSnapshot(path, snapshot);
      }
      if (degraded !== undefined) {
        note(
          cache.projects.length > 0
            ? `Cortex unreachable — served ${cache.projects.length} cached project(s) (read-through cache; may be stale)`
            : `Cortex unreachable and no cache — served an empty listing (may be incomplete)`,
        );
      }
      return await fn(snapshot);
    } finally {
      release();
    }
  }

  async function readModifyWrite<T>(
    tenantId: string,
    fn: (snapshot: RegistrySnapshot) => { snapshot: RegistrySnapshot; result: T } | Promise<{ snapshot: RegistrySnapshot; result: T }>,
  ): Promise<T> {
    const path = cachePath(tenantId);
    const t = transport();
    // The lock now serializes local writers and guards the cache file; the cross-writer
    // authority is the Cortex supersede chain (TASK-131's lock still fails closed, and a
    // slow network is kept alive by the lock heartbeat instead of silently losing the CAS).
    const release = await acquireLock(path, lockOpts);
    try {
      const heads = await loadHeadsForWrite(t, tenantId);
      const cache = readSnapshot(path);
      const old = mergeSnapshot(heads, cache, tenantId);
      // The diff baseline is taken before `fn` runs, so in-place mutation cannot hide a change.
      const baseline = new Map(
        old.projects.map((p) => [p.projectId, { content: projectRecordContent(p), shape: sharedShape(p), recordId: p.recordId, revision: p.revision, updatedAt: p.updatedAt }]),
      );
      const out = await fn(old);
      await persist(t, baseline, out.snapshot);
      writeSnapshot(path, out.snapshot);
      return out.result;
    } finally {
      release();
    }
  }

  async function loadHeadsForWrite(t: ProjectRecordTransport, tenantId: string): Promise<ProjectRecord[]> {
    try {
      return selectHeads(await t.load(), tenantId);
    } catch (e) {
      if (e instanceof ProjectRegistryUnreachable) {
        throw new ProjectError("busy", `the project registry is unreachable (${e.message}); nothing was changed — retry later`, 503);
      }
      throw e;
    }
  }

  /**
   * Translate the snapshot diff into registry publications: a new row publishes (claiming
   * the unique keys), a changed published row supersedes its head (the compare-and-swap),
   * a change whose SHARED SHAPE is unchanged (only revision/updatedAt moved — e.g. a second
   * device re-binding the same workspace) is a no-op and does NOT advance the chain, a
   * changed local-only row stays local-only, and a removed row is refused — the registry
   * never deletes.
   */
  async function persist(
    t: ProjectRecordTransport,
    baseline: Map<string, { content: string; shape: string; recordId?: string; revision: number; updatedAt: string }>,
    next: RegistrySnapshot,
  ): Promise<void> {
    for (const record of next.projects) {
      const before = baseline.get(record.projectId);
      const content = projectRecordContent(record);
      if (!before) {
        record.recordId = await t.publish(record);
        continue;
      }
      if (before.content === content) {
        if (before.recordId) record.recordId = before.recordId;
        else delete record.recordId;
        continue;
      }
      if (before.shape === sharedShape(record)) {
        // A no-op wrote only bookkeeping: keep the chain (and the CAS token) where it is.
        // Device-local fields on the record (workspaceRoot) still persist via the cache write.
        record.revision = before.revision;
        record.updatedAt = before.updatedAt;
        if (before.recordId) record.recordId = before.recordId;
        else delete record.recordId;
        continue;
      }
      if (before.recordId) {
        record.recordId = await t.supersede(before.recordId, record);
      } else {
        delete record.recordId; // local-only until `project migrate` publishes it
      }
    }
    for (const projectId of baseline.keys()) {
      if (!next.projects.some((p) => p.projectId === projectId)) {
        throw new ProjectError("invalid_shape", `registry records are never removed (${projectId} vanished from the snapshot)`, 500, 1);
      }
    }
  }

  return {
    read: (tenantId, fn) => queue(tenantId, () => readThrough(tenantId, fn)),
    update: (tenantId, fn) => queue(tenantId, () => readModifyWrite(tenantId, fn)),
  };
}

// ---------- migration (device-local file → Cortex) ----------

export interface MigrationRow {
  projectId: string;
  slug: string;
  title: string;
  revision: number;
  /** The row's state in the registry profile. */
  state: "published" | "local-only";
  /** Recorded satellite grants the migration refuses to carry (reported; never silently dropped). */
  grantsDropped: string[];
  outcome: "publishable" | "published" | "refused" | "skipped";
  reason?: string;
}

export interface MigrateLocalResult {
  rows: MigrationRow[];
  published: ProjectRecord[];
  /** True when nothing was published because the owner's confirmation is missing (the listing is the whole result). */
  needsConfirmation: boolean;
}

/**
 * The migration plan (docs/doc-ingest-architecture.md §Project/1 registry records):
 * list the device-local rows and publish the unpublished ones — only with the owner's
 * explicit confirmation (`--user-confirmed`). Owner provenance travels verbatim
 * (`ownerRef`, `createdAt`, `updatedAt`, `adoption`); satellite grants are published
 * EMPTY (a migration never carries grants across the trust boundary of a new shared
 * record — anything recorded is reported here and must be re-confirmed afterwards).
 * A slug or id the registry already holds is refused by the unique key and reported;
 * re-running skips published rows. Nothing is deleted from the local file.
 */
export async function migrateLocalProjects(opts: {
  transport: ProjectRecordTransport;
  tenantId: string;
  caller: ProjectCaller;
  confirmed?: boolean;
  /** Cache file per tenant. Default `projectRegistryPath` — the pre-TASK-136 registry file. */
  cachePath?: (tenantId: string) => string;
  lock?: RegistryLockOptions;
}): Promise<MigrateLocalResult> {
  requireActor(opts.caller);
  const path = (opts.cachePath ?? projectRegistryPath)(opts.tenantId);
  // The whole read-modify-write — listing, publications, and the cache write — runs under
  // the registry lock, the same guard as the store's updates: a concurrent local writer can
  // neither interleave with the migration nor be clobbered by its cache write (big brother
  // review 2026-11-07). The transport is the authority; the lock only guards the cache side.
  const release = await acquireLock(path, opts.lock ?? {});
  try {
    let remoteIds: Set<string>;
    try {
      remoteIds = new Set(selectHeads(await opts.transport.load(), opts.tenantId).map((p) => p.projectId));
    } catch (e) {
      if (e instanceof ProjectRegistryUnreachable) {
        throw new ProjectError("busy", `the project registry is unreachable (${e.message}); nothing was changed — retry later`, 503);
      }
      throw e;
    }
    const cache = readSnapshot(path);
    const candidates = cache.projects.filter((p) => visible(p, opts.caller));
    const rows: MigrationRow[] = [];
    const published: ProjectRecord[] = [];
    for (const row of candidates) {
      const grantsDropped = remoteIds.has(row.projectId) ? [] : row.satelliteGrants.filter((g) => g.toLowerCase() !== PROJECT_REGISTRY_PROFILE);
      if (remoteIds.has(row.projectId)) {
        rows.push({ projectId: row.projectId, slug: row.slug, title: row.title, revision: row.revision, state: "published", grantsDropped: [], outcome: "skipped", reason: "already published" });
        continue;
      }
      if (opts.confirmed !== true) {
        rows.push({
          projectId: row.projectId,
          slug: row.slug,
          title: row.title,
          revision: row.revision,
          state: "local-only",
          grantsDropped,
          outcome: "publishable",
          ...(grantsDropped.length > 0 ? { reason: `satellite grants ${grantsDropped.join(", ")} are NOT carried across — re-confirm with \`continuity project grants\` after migration` } : {}),
        });
        continue;
      }
      const record: ProjectRecord = { ...row, satelliteGrants: [], recordId: undefined };
      delete record.recordId;
      try {
        record.recordId = await opts.transport.publish(record);
        published.push(record);
        rows.push({
          projectId: row.projectId,
          slug: row.slug,
          title: row.title,
          revision: row.revision,
          state: "local-only",
          grantsDropped,
          outcome: "published",
          ...(grantsDropped.length > 0 ? { reason: `satellite grants ${grantsDropped.join(", ")} were dropped to empty — re-confirm with \`continuity project grants\`` } : {}),
        });
      } catch (e) {
        const mapped = mapRegistryWriteError(e, row);
        rows.push({
          projectId: row.projectId,
          slug: row.slug,
          title: row.title,
          revision: row.revision,
          state: "local-only",
          grantsDropped,
          outcome: "refused",
          reason: mapped instanceof Error ? mapped.message : String(mapped),
        });
      }
    }
    // The cache learns the record ids of what just published; rows refused or pending stay local-only.
    if (published.length > 0) {
      const byId = new Map(published.map((p) => [p.projectId, p]));
      writeSnapshot(path, {
        ...cache,
        projects: cache.projects.map((p) => {
          const done = byId.get(p.projectId);
          return done ? { ...done } : p;
        }),
      });
    }
    return { rows, published, needsConfirmation: opts.confirmed !== true };
  } finally {
    release();
  }
}
