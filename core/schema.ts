/**
 * Schemas as memory — level 2 pliability.
 *
 * A shape is itself a governed record in the vocabulary profile:
 *
 *   [schema] later/1 deferred idea with a revisit date | fields: revisit:date | pii: none | scope: northstar
 *
 * Lifecycle (identical to content — no new Cortex machinery):
 *   propose  → role-private shard by the proposing runtime: usable by that runtime only
 *   approve  → curation proposal + owner approval → profile_shared: shared vocabulary
 *   retire   → supersede with [retired-schema]: history kept, no longer current
 *
 * Items are validated here, by the consumer, against the approved (or own-private) schema
 * before they're written. The envelope is the skull; this is the synapses.
 *
 * Hard lines (Cortex charter §3): a schema can never grant authority — field names that
 * look like permissions are refused — and nothing is promoted automatically.
 */

import { grant, type ShardDetail } from "../src/cortex.ts";
import { share, writePrivate } from "./memory.ts";
import { loadState, saveState } from "./state.ts";
import type { Runtime } from "./runtime.ts";
import { mintId } from "../src/ids.ts";

export type FieldType = "string" | "date" | "int" | "number" | "bool" | "id" | { enum: string[] };

export interface SchemaField {
  name: string;
  type: FieldType;
  optional: boolean;
}

export interface Schema {
  id: string; // shard id of the record
  name: string; // e.g. "later"
  version: number; // e.g. 1
  key: string; // "later/1"
  description: string;
  fields: SchemaField[];
  pii: string[]; // field names that are personal data; [] = declared none
  scope: "project" | "northstar";
  state: "approved" | "private" | "unknown";
  ownedBy?: string; // runtime role that proposed it (private only)
  content: string;
}

export const SCHEMA_RE = /^\[schema\]\s+([a-z][a-z0-9-]*)\/(\d+)\s+(.*?)\s+\|\s+fields:\s*(.*?)\s+\|\s+pii:\s*(\S+)\s+\|\s+scope:\s*(project|northstar)\s*$/;
// Field names may carry `_` as well as `-` (shape fields like `measured_at`, `target_ref`); schema names (NAME_RE) stay hyphen-only.
const FIELD_RE = /^([a-z][a-z0-9_-]*):(string|date|int|number|bool|id|enum\(([^)]+)\))(\?)?$/;
const NAME_RE = /^[a-z][a-z0-9-]*$/;

/**
 * Tombstone written by retireSchema: `[retired-schema] <key> source:<shard-id> retired:<YYYY-MM-DD> <reason…>`.
 * The source id is any valid Cortex id ([A-Za-z0-9_.-]{1,128}) — never assume one id-minting
 * format: a mismatch here must not silently un-retire a schema. Anchored on the grammar so the
 * free-text reason cannot spoof a source id.
 */
const RETIRED_RE = /^\[retired-schema\]\s+([a-z][a-z0-9-]*\/\d+)\s+source:([A-Za-z0-9_.-]{1,128})\s+retired:\d{4}-\d{2}-\d{2}(?:\s|$)/;

/** Content whose tag is exactly [schema] / [retired-schema]: a governed vocabulary record. */
function isVocabularyRecord(content: string, tag: "schema" | "retired-schema"): boolean {
  return new RegExp(`^\\[${tag}\\](?:\\s|$)`).test(content.trim());
}

/** Field names that read as authority. Memory is contextual data, never a capability (charter §3). */
const FORBIDDEN_FIELD_NAMES = new Set(["grant", "grants", "cap", "capability", "permission", "permissions", "allow", "deny", "exec", "execute", "run", "command", "instruction", "instructions", "role", "scope", "tenant", "secret", "token", "key"]);

/** Reserved by Continuity itself ("none" is the pii: sentinel — a field named "none" would make `pii: none` ambiguous). */
const RESERVED_FIELD_NAMES = new Set(["text", "id", "schema", "tag", "none"]);

// ---------- parsing ----------

export function parseFieldSpec(spec: string): SchemaField[] {
  const out: SchemaField[] = [];
  for (const raw of spec.split(/[\s,]+/).filter(Boolean)) {
    const m = FIELD_RE.exec(raw);
    if (!m) throw new Error(`bad field "${raw}" — expected name:type[?] with type string|date|int|number|bool|id|enum(a|b|c)`);
    const name = m[1];
    if (out.some((field) => field.name === name)) throw new Error(`duplicate field "${name}"`);
    if (FORBIDDEN_FIELD_NAMES.has(name)) throw new Error(`field "${name}" is refused: a schema can never grant authority or name scopes/secrets (Cortex charter §3)`);
    if (RESERVED_FIELD_NAMES.has(name)) throw new Error(`field "${name}" is reserved by Continuity`);
    const type: FieldType = m[3] ? { enum: m[3].split("|").map((s) => s.trim()).filter(Boolean) } : (m[2] as Exclude<FieldType, { enum: string[] }>);
    if (typeof type === "object" && type.enum.length === 0) throw new Error(`bad field "${raw}" — enum(...) needs at least one value`);
    out.push({ name, type, optional: Boolean(m[4]) });
  }
  if (out.length > 16) throw new Error("a schema may declare at most 16 fields");
  return out;
}

export function fieldSpecToString(fields: SchemaField[]): string {
  return fields.length ? fields.map((f) => `${f.name}:${typeof f.type === "string" ? f.type : `enum(${f.type.enum.join("|")})`}${f.optional ? "?" : ""}`).join(" ") : "-";
}

export function schemaContent(s: Pick<Schema, "name" | "version" | "description" | "fields" | "pii" | "scope">): string {
  const pii = s.pii.length ? s.pii.join(",") : "none";
  return `[schema] ${s.name}/${s.version} ${s.description.trim()} | fields: ${fieldSpecToString(s.fields)} | pii: ${pii} | scope: ${s.scope}`;
}

export function parseSchema(content: string, d?: ShardDetail, selfRole?: string): Schema | undefined {
  const m = SCHEMA_RE.exec(content.trim());
  if (!m) return undefined;
  let fields: SchemaField[];
  try {
    fields = m[4] === "-" ? [] : parseFieldSpec(m[4]);
  } catch {
    return undefined;
  }
  const pii = m[5] === "none" ? [] : m[5].split(",").map((s) => s.trim()).filter(Boolean);
  // Same rule as proposeSchema: a PII declaration names real fields (or "text"), nothing else.
  if (pii.some((p) => p !== "text" && !fields.some((f) => f.name === p))) return undefined;
  const sc = d?.provenance?.extra?.scope_class;
  const state: Schema["state"] = sc === "profile_shared" ? "approved" : sc === "role_private" ? "private" : "unknown";
  return {
    id: d?.shard_id ?? "",
    name: m[1],
    version: Number(m[2]),
    key: `${m[1]}/${m[2]}`,
    description: m[3],
    fields,
    pii,
    scope: m[6] as Schema["scope"],
    state,
    ownedBy: state === "private" ? (d?.provenance?.extra?.role_id ?? selfRole) : undefined,
    content,
  };
}

// ---------- vocabulary profile runtime ----------

export function vocabulary(rt: Runtime): Runtime {
  const profileId = rt.cfg.vocabularyProfile;
  if (rt.profileId === profileId) return rt;
  const a = rt.agent.identity;
  const o = rt.owner.identity;
  const agent = rt.agent.as({ ...a, profileId, grants: [grant.role(profileId, a.roleId), grant.profileShared(profileId)] });
  const owner = rt.owner.as({ ...o, profileId, grants: [grant.role(profileId, o.roleId), grant.profileShared(profileId), grant.curationApprove] });
  const state = loadState(rt.cfg.tenantId, profileId);
  return { ...rt, profileId, projectLabel: "vocabulary", agent, owner, state, persist: () => saveState(rt.cfg.tenantId, profileId, state) };
}

// ---------- listing ----------

async function retiredSchemas(rt: Runtime, sessionId: string): Promise<{ sharedKeys: Set<string>; privateIds: Set<string>; keys: Set<string> }> {
  const v = vocabulary(rt);
  const retired = await v.agent.recall({ query: "[retired-schema]", kind: "briefing", limit: 50, sessionId });
  if (retired.results.length >= 50 || retired.verification_meta?.truncated) throw new Error("vocabulary inventory may be incomplete (recall limit reached)");
  const details = await Promise.all(retired.results.filter((r) => isVocabularyRecord(r.content, "retired-schema")).map((r) => v.agent.getShard(r.shard_id)));
  const sharedKeys = new Set<string>();
  const privateIds = new Set<string>();
  const keys = new Set<string>();
  for (const d of details) {
    if (d.status === "superseded" || d.status === "archived") continue;
    // Fail closed: a retirement marker that cannot be parsed is a governance record the inventory
    // cannot interpret. Skipping it silently could un-retire a schema — worse than refusing to list.
    const match = RETIRED_RE.exec(d.content.trim());
    if (!match) throw new Error(`retirement record ${d.shard_id} is malformed — the vocabulary inventory cannot be decided`);
    const scope = d.provenance?.extra?.scope_class;
    if (scope === "profile_shared") { sharedKeys.add(match[1]); keys.add(match[1]); }
    else if (scope === "role_private") { privateIds.add(match[2]); keys.add(match[1]); }
    else throw new Error("retired schema scope is unknown");
  }
  return { sharedKeys, privateIds, keys };
}

/** Approved schemas + this runtime's private proposals. Approved wins on key collision. */
export async function listSchemas(rt: Runtime, sessionId: string): Promise<Schema[]> {
  const v = vocabulary(rt);
  const rec = await v.agent.recall({ query: "[schema]", kind: "briefing", limit: 50, sessionId });
  if (rec.results.length >= 50 || rec.verification_meta?.truncated) throw new Error("vocabulary inventory may be incomplete (recall limit reached)");
  if (rec.results.length === 0) return [];
  const retired = await retiredSchemas(rt, sessionId);
  // A partial inventory cannot safely decide which schemas are approved or current.
  const details = await Promise.all(rec.results.map((r) => v.agent.getShard(r.shard_id)));
  const byKey = new Map<string, Schema>();
  rec.results.forEach((r, i) => {
    const d = details[i];
    if (d && (d.status === "superseded" || d.status === "archived")) return;
    const content = d?.content ?? r.content;
    const s = parseSchema(content, d, rt.agent.identity.roleId);
    if (!s) {
      // Fail closed: a record tagged [schema] that does not parse is a malformed governed record,
      // not noise. Silently skipping it would fail open (e.g. a refused field name could hide a
      // schema from the inventory while still existing in Cortex).
      if (isVocabularyRecord(content, "schema")) throw new Error(`schema record ${r.shard_id} is malformed — the vocabulary inventory cannot be decided`);
      return;
    }
    if (s.state === "unknown") throw new Error(`schema ${s.key} has unknown scope`);
    if (retired.sharedKeys.has(s.key) || (s.state === "private" && retired.privateIds.has(s.id))) return;
    const prev = byKey.get(s.key);
    if (!prev || (prev.state !== "approved" && s.state === "approved")) byKey.set(s.key, s);
  });
  return [...byKey.values()].sort((a, b) => a.key.localeCompare(b.key));
}

export async function findSchema(rt: Runtime, sessionId: string, nameOrKey: string): Promise<Schema | undefined> {
  const all = await listSchemas(rt, sessionId);
  if (nameOrKey.includes("/")) return all.find((s) => s.key === nameOrKey);
  // bare name → highest approved version, else highest private
  const cands = all.filter((s) => s.name === nameOrKey);
  const approved = cands.filter((s) => s.state === "approved").sort((a, b) => b.version - a.version);
  return approved[0] ?? cands.sort((a, b) => b.version - a.version)[0];
}

// ---------- lifecycle ----------

export interface ProposeInput {
  name: string;
  version?: number;
  description: string;
  fields: string; // spec string
  pii: string; // "none" or comma list
  scope?: "project" | "northstar";
}

export async function proposeSchema(rt: Runtime, sessionId: string, input: ProposeInput): Promise<{ schema: Schema; shardId: string }> {
  if (!NAME_RE.test(input.name)) throw new Error(`schema name must match ${NAME_RE}`);
  if (["schema", "retired-schema", "note", "imported"].includes(input.name)) throw new Error(`"${input.name}" is reserved`);
  const fields = parseFieldSpec(input.fields === "-" ? "" : input.fields);
  const pii = input.pii.trim().toLowerCase() === "none" ? [] : input.pii.split(",").map((s) => s.trim()).filter(Boolean);
  for (const p of pii) if (!fields.some((f) => f.name === p) && p !== "text") throw new Error(`pii names unknown field "${p}" (use field names, or "text" for the free text)`);
  if (!input.pii.trim() || (input.pii.trim().toLowerCase() !== "none" && pii.length === 0)) throw new Error(`pii declaration required: "none" or a comma list of fields`);
  const existing = await listSchemas(rt, sessionId);
  const { keys: retiredKeys } = await retiredSchemas(rt, sessionId);
  const retiredVersions = [...retiredKeys].filter((key) => key.startsWith(`${input.name}/`)).map((key) => Number(key.split("/")[1]));
  const version = input.version ?? Math.max(0, ...retiredVersions, ...existing.filter((s) => s.name === input.name).map((s) => s.version)) + 1;
  if (retiredKeys.has(`${input.name}/${version}`) || existing.some((s) => s.key === `${input.name}/${version}`)) throw new Error(`${input.name}/${version} already exists or was retired; bump the version`);
  const draft = { name: input.name, version, description: input.description.replace(/\|/g, "/"), fields, pii, scope: input.scope ?? "project" };
  const content = schemaContent(draft);
  const v = vocabulary(rt);
  const shardId = await writePrivate(v, { content, sourceKind: "agent_inferred", sessionId, entryRef: `schema:${draft.name}/${draft.version}`, occurredAt: new Date().toISOString() });
  return { schema: { ...draft, id: shardId, key: `${draft.name}/${draft.version}`, state: "private", ownedBy: rt.agent.identity.roleId, content }, shardId };
}

export async function approveSchema(rt: Runtime, sessionId: string, key: string): Promise<Schema> {
  const s = await findSchema(rt, sessionId, key);
  if (!s) throw new Error(`no schema "${key}" visible to ${rt.runtimeName} (propose it first, or approve from the runtime that proposed it)`);
  if (s.state === "approved") return s;
  if (s.state !== "private") throw new Error(`cannot approve "${key}": schema scope is unknown`);
  if (s.ownedBy && s.ownedBy !== rt.agent.identity.roleId) throw new Error(`"${key}" was proposed by ${s.ownedBy}; approve it from that runtime`);
  const all = await listSchemas(rt, sessionId);
  const approvedCount = all.filter((x) => x.state === "approved").length;
  if (approvedCount >= rt.cfg.maxSchemas) throw new Error(`vocabulary cap reached (${rt.cfg.maxSchemas} approved schemas); retire one first`);
  const v = vocabulary(rt);
  const derivedId = await share(v, s.id, s.content, `user approved schema ${s.key} via ${rt.runtimeName}`, sessionId);
  // id is the shard id of the record that is now current — the approved derived one, not the
  // private proposal (which stays behind as the write trail).
  return { ...s, id: derivedId, state: "approved", ownedBy: undefined };
}

export async function retireSchema(rt: Runtime, sessionId: string, key: string, reason: string): Promise<string> {
  const s = await findSchema(rt, sessionId, key);
  if (!s) throw new Error(`no schema "${key}"`);
  if (s.state !== "approved" && s.state !== "private") throw new Error("cannot retire a schema with unknown scope");
  const v = vocabulary(rt);
  const content = `[retired-schema] ${s.key} source:${s.id} retired:${new Date().toISOString().slice(0, 10)} ${reason.trim() || "no reason given"}`;
  const sourceId = await writePrivate(v, { content, sourceKind: "user_confirmed", sessionId, entryRef: `retire:${s.key}`, occurredAt: new Date().toISOString() });
  if (s.state === "private") return sourceId;
  const prop = await v.agent.propose({ kind: "lesson", sourceRecordIds: [sourceId], content, reason: `retire schema ${s.key}` });
  const disp = await v.owner.dispose({ proposalId: prop.proposal_id, action: "supersede", supersedesRecordId: s.id, approvalReceiptRef: mintId("rcpt_retire"), reason: `retire schema ${s.key}` });
  if (!disp.derived_shard_id) throw new Error(`supersede returned no derived_shard_id (${disp.status})`);
  return disp.derived_shard_id;
}

// ---------- validation ----------

export interface ParsedItem {
  fields: Record<string, string>;
  extras: Record<string, string>; // x-<runtime>: prefixed
  text: string;
}

/** Split `key:value` tokens from free text. Values can't contain whitespace. */
export function splitItemTokens(tokens: string[]): ParsedItem {
  const fields: Record<string, string> = {};
  const extras: Record<string, string> = {};
  const text: string[] = [];
  let inText = false;
  for (const t of tokens) {
    if (inText) {
      text.push(t);
      continue;
    }
    const x = /^(x-[a-z0-9_]+:[a-z][a-z0-9_-]*):(\S+)$/.exec(t); // x-<runtime>:<field>:<value>
    const m = x ?? /^([a-z][a-z0-9_-]*):(\S+)$/.exec(t);
    if (m && !/^https?$/.test(m[1])) {
      if (m[1].startsWith("x-")) extras[m[1]] = m[2];
      else fields[m[1]] = m[2];
    } else {
      inText = true;
      text.push(t);
    }
  }
  return { fields, extras, text: text.join(" ").trim() };
}

export function validateItem(schema: Schema, item: ParsedItem, runtimeName: string): string[] {
  const errors: string[] = [];
  const known = new Set(schema.fields.map((f) => f.name));
  for (const f of schema.fields) {
    const v = item.fields[f.name];
    if (v === undefined) {
      if (!f.optional) errors.push(`missing required field ${f.name}:${typeof f.type === "string" ? f.type : "enum"}`);
      continue;
    }
    const err = checkType(f, v);
    if (err) errors.push(err);
  }
  for (const k of Object.keys(item.fields)) if (!known.has(k)) errors.push(`unknown field "${k}" for ${schema.key}; prefix experimental fields as x-${runtimeName}:${k}:value or propose ${schema.name}/${schema.version + 1}`);
  for (const k of Object.keys(item.extras)) if (!k.startsWith(`x-${runtimeName}:`)) errors.push(`extra "${k}" must be prefixed with your own runtime: x-${runtimeName}:`);
  if (!item.text) errors.push("item needs free text after the fields");
  return errors;
}

export function checkType(f: SchemaField, v: string): string | undefined {
  const t = f.type;
  if (typeof t !== "string") return t.enum.includes(v) ? undefined : `${f.name} must be one of ${t.enum.join("|")}`;
  switch (t) {
    case "date": return /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v)) && new Date(v).toISOString().slice(0, 10) === v ? undefined : `${f.name} must be a valid YYYY-MM-DD date`;
    case "int": return /^-?\d+$/.test(v) ? undefined : `${f.name} must be an integer`;
    case "number": return /^-?\d+(\.\d+)?$/.test(v) ? undefined : `${f.name} must be a number`;
    case "bool": return /^(true|false)$/.test(v) ? undefined : `${f.name} must be true|false`;
    case "id": return /^[A-Za-z0-9_.-]{1,128}$/.test(v) ? undefined : `${f.name} must be an identifier`;
    default: return undefined;
  }
}

/** Render a validated item as the content Cortex stores: [name] k:v k:v x-rt:k:v text */
export function itemToContent(schema: Schema, item: ParsedItem): string {
  const ordered = schema.fields.filter((f) => item.fields[f.name] !== undefined).map((f) => `${f.name}:${item.fields[f.name]}`);
  const extras = Object.entries(item.extras).map(([k, v]) => `${k}:${v}`);
  return `[${schema.name}] ${[...ordered, ...extras, item.text].join(" ")}`;
}

/**
 * Parse stored item content back into its tag and fields/text — the inverse of itemToContent.
 * A validated item round-trips exactly: its fields and extras were token-parsed at write time,
 * so the same grammar recovers them (free text only absorbs `k:v`-looking tokens after its
 * first plain word, and such tokens were already fields — or refused — at write time).
 */
export function parseItemContent(content: string): { name: string; item: ParsedItem } | undefined {
  const m = /^\[([a-z][a-z0-9-]*)\]\s+(\S.*)$/.exec(content.trim());
  return m ? { name: m[1], item: splitItemTokens(m[2].split(/\s+/)) } : undefined;
}

/**
 * Item references at promotion (core/memory.ts `share`): every `schema:<key>` subject key an
 * item cites must name an approved current schema — the exact version — and the item content
 * must match it. The reference is enforced, not decorative: a share puts the record in front of
 * every agent, so the cited schema is the promise the record makes about its own shape.
 */
export async function assertItemMatchesSchemas(rt: Runtime, content: string, refs: string[]): Promise<void> {
  for (const ref of refs) {
    const key = ref.slice("schema:".length);
    const schema = await findSchema(rt, mintId("sess"), key);
    if (!schema || schema.state !== "approved") throw new Error(`cannot share item: ${ref} is not an approved current schema`);
    if (ref !== `schema:${schema.key}`) throw new Error(`cannot share item: ${ref} must cite the exact schema version, e.g. schema:${schema.key}`);
    const parsed = parseItemContent(content);
    if (!parsed || parsed.name !== schema.name) throw new Error(`cannot share item: ${ref} is cited but the content is not a ${schema.name} item`);
    const errors = validateItem(schema, parsed.item, rt.runtimeName);
    if (errors.length) throw new Error(`cannot share item: content does not match ${ref}: ${errors.join("; ")}`);
  }
}

/** One-line vocabulary summary for briefings. */
export function vocabularyLine(schemas: Schema[]): string | undefined {
  const approved = schemas.filter((s) => s.state === "approved");
  if (approved.length === 0) return undefined;
  return `Shapes you may use (continuity add <shape> …): ${approved.map((s) => `${s.key} (${fieldSpecToString(s.fields)})`).join(" · ")}`;
}
