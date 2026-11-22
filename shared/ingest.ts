/**
 * Document-ingestion contracts (ING-01).
 *
 * Browser-safe on purpose: no `node:*` and no `core/*` imports, so a later Deck
 * preview can share these types without pulling the server. Validators refuse
 * closed. They do not allocate board rows, call a model, fetch a URL, or treat
 * acceptance text as a command. Uploads are untrusted data — this module never
 * labels them `user_said` and never clears `executionState: "held"`.
 *
 * Offset rule (`utf8-lf/1`): strip a leading UTF-8 BOM and fold CR/CRLF to LF.
 * Every other byte sequence is preserved. A citation names both the normalized
 * UTF-16 window and the raw byte window that normalizes back to it.
 */

export const TEXT_VERSION = "utf8-lf/1" as const;
export const PARCEL_GRAMMAR = "continuity-task-parcel/1" as const;
export const POLICY_VERSION = "ingest-policy/1" as const;
export const MAX_COMMIT_BATCH = 8;
export const MAX_PLAN_CANDIDATES = 1000;
export const MAX_RAW_BYTES = 512 * 1024;
export const TASK_NUMBER_MIN = 1;
export const TASK_NUMBER_MAX = 999;

/** Profile ids that are naming aliases, the reserved registry profile, or grandfathered non-instances. Never minted as Project/1. */
export const RESERVED_PROJECT_SLUGS = ["proj_me", "proj_north_star", "proj_vocabulary", "proj_projects", "actor_me"] as const;

export const INGEST_REFUSAL_CODES = [
  "invalid_version",
  "invalid_shape",
  "invalid_encoding",
  "unsupported_media_type",
  "duplicate_client_key",
  "duplicate_source_task_id",
  "duplicate_field",
  "self_edge",
  "cycle",
  "unknown_client_key",
  "excluded_blocker",
  "cross_project_edge",
  "batch_cap",
  "import_limit",
  "resource_limit",
  "task_number_overflow",
  "forged_authority",
  "execution_hold_required",
  "provenance_refused",
  "unknown_field",
  "unknown_grammar",
  "citation_mismatch",
  "invalid_scope",
  "invalid_slug",
  "reserved_slug",
  "acceptance_not_inert",
  "unresolved_import",
  "subject_not_found",
  "empty_selection",
  "stale_operation",
  "rigor_downgrade",
] as const;

export type IngestRefusalCode = (typeof INGEST_REFUSAL_CODES)[number];

export class IngestRefusal extends Error {
  readonly code: IngestRefusalCode;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(code: IngestRefusalCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "IngestRefusal";
    this.code = code;
    this.details = details;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export function sortRefusals(items: readonly IngestRefusal[]): IngestRefusal[] {
  return [...items].sort((a, b) => a.code.localeCompare(b.code) || a.message.localeCompare(b.message));
}

function refusal(code: IngestRefusalCode, message: string, details: Record<string, unknown> = {}): IngestRefusal {
  return new IngestRefusal(code, message, details);
}

// ---------- sha256 (sync, browser-safe) ----------

const SHA_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotr(x: number, n: number): number {
  return ((x >>> n) | (x << (32 - n))) >>> 0;
}

/** SHA-256 of raw bytes, lowercase hex. Used for artifact and operation digests. */
export function sha256Hex(data: Uint8Array): string {
  const bytes = new Uint8Array(data);
  const bitLen = bytes.length * 8;
  const withOne = bytes.length + 1;
  const padLen = withOne % 64 <= 56 ? 56 - (withOne % 64) : 56 + 64 - (withOne % 64);
  const total = bytes.length + 1 + padLen + 8;
  const buf = new Uint8Array(total);
  buf.set(bytes);
  buf[bytes.length] = 0x80;
  const view = new DataView(buf.buffer);
  view.setUint32(total - 8, Math.floor(bitLen / 0x100000000), false);
  view.setUint32(total - 4, bitLen >>> 0, false);

  let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a;
  let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;
  const w = new Uint32Array(64);
  for (let off = 0; off < total; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4, false);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15]!, 7) ^ rotr(w[i - 15]!, 18) ^ (w[i - 15]! >>> 3);
      const s1 = rotr(w[i - 2]!, 17) ^ rotr(w[i - 2]!, 19) ^ (w[i - 2]! >>> 10);
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0;
    }
    let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
    for (let i = 0; i < 64; i++) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + s1 + ch + SHA_K[i]! + w[i]!) >>> 0;
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (s0 + maj) >>> 0;
      h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0; h5 = (h5 + f) >>> 0; h6 = (h6 + g) >>> 0; h7 = (h7 + h) >>> 0;
  }
  const out = new Uint8Array(32);
  const ov = new DataView(out.buffer);
  [h0, h1, h2, h3, h4, h5, h6, h7].forEach((v, i) => ov.setUint32(i * 4, v, false));
  return [...out].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function sha256Text(text: string): string {
  return sha256Hex(new TextEncoder().encode(text));
}

export function canonicalJson(value: unknown): string {
  if (value === undefined) throw refusal("invalid_shape", "canonical JSON cannot encode undefined");
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

// ---------- UTF-8 normalization ----------

export type OffsetPieceKind = "bom" | "identity" | "newline";

export interface OffsetPiece {
  kind: OffsetPieceKind;
  normStart: number;
  normEnd: number;
  rawStart: number;
  rawEnd: number;
}

export interface NormalizedText {
  text: string;
  pieces: OffsetPiece[];
}

const encoder = new TextEncoder();

function utf8ByteLength(text: string): number {
  return encoder.encode(text).length;
}

function invalidEncoding(): never {
  throw refusal("invalid_encoding", "upload is not valid UTF-8");
}

function decodeUtf8(bytes: Uint8Array): { text: string; byteAt: number[] } {
  const parts: string[] = [];
  const byteAt: number[] = [];
  let i = 0;
  while (i < bytes.length) {
    const b0 = bytes[i]!;
    let cp: number;
    let len = 1;
    if (b0 <= 0x7f) {
      cp = b0;
    } else if (b0 >= 0xc2 && b0 <= 0xdf) {
      len = 2;
      if (i + 1 >= bytes.length) invalidEncoding();
      const b1 = bytes[i + 1]!;
      if ((b1 & 0xc0) !== 0x80) invalidEncoding();
      cp = ((b0 & 0x1f) << 6) | (b1 & 0x3f);
    } else if (b0 >= 0xe0 && b0 <= 0xef) {
      len = 3;
      if (i + 2 >= bytes.length) invalidEncoding();
      const b1 = bytes[i + 1]!;
      const b2 = bytes[i + 2]!;
      if ((b1 & 0xc0) !== 0x80 || (b2 & 0xc0) !== 0x80) invalidEncoding();
      if (b0 === 0xe0 && b1 < 0xa0) invalidEncoding();
      if (b0 === 0xed && b1 >= 0xa0) invalidEncoding();
      cp = ((b0 & 0x0f) << 12) | ((b1 & 0x3f) << 6) | (b2 & 0x3f);
    } else if (b0 >= 0xf0 && b0 <= 0xf4) {
      len = 4;
      if (i + 3 >= bytes.length) invalidEncoding();
      const b1 = bytes[i + 1]!;
      const b2 = bytes[i + 2]!;
      const b3 = bytes[i + 3]!;
      if ((b1 & 0xc0) !== 0x80 || (b2 & 0xc0) !== 0x80 || (b3 & 0xc0) !== 0x80) invalidEncoding();
      if (b0 === 0xf0 && b1 < 0x90) invalidEncoding();
      if (b0 === 0xf4 && b1 >= 0x90) invalidEncoding();
      cp = ((b0 & 0x07) << 18) | ((b1 & 0x3f) << 12) | ((b2 & 0x3f) << 6) | (b3 & 0x3f);
    } else {
      invalidEncoding();
    }
    const s = String.fromCodePoint(cp);
    for (let k = 0; k < s.length; k++) {
      parts.push(s[k]!);
      byteAt.push(i);
    }
    i += len;
  }
  byteAt.push(bytes.length);
  return { text: parts.join(""), byteAt };
}

/** BOM strip + CR/CRLF → LF. Identity pieces are raw UTF-8 of the normalized slice. */
export function normalizeUtf8(raw: Uint8Array): NormalizedText {
  const bytes = new Uint8Array(raw);
  if (bytes.length > MAX_RAW_BYTES) {
    throw refusal("resource_limit", `upload is ${bytes.length} bytes; the v1 cap is ${MAX_RAW_BYTES}`);
  }
  const decoded = decodeUtf8(bytes);
  if (decoded.text.includes("\u0000")) invalidEncoding();
  const pieces: OffsetPiece[] = [];
  let text = "";
  let i = 0;
  if (decoded.text.charCodeAt(0) === 0xfeff) {
    pieces.push({ kind: "bom", normStart: 0, normEnd: 0, rawStart: decoded.byteAt[0]!, rawEnd: decoded.byteAt[1]! });
    i = 1;
  }
  let identSrc = i;
  const flushIdent = (srcEnd: number) => {
    if (srcEnd <= identSrc) return;
    const slice = decoded.text.slice(identSrc, srcEnd);
    const start = text.length;
    text += slice;
    pieces.push({
      kind: "identity",
      normStart: start,
      normEnd: text.length,
      rawStart: decoded.byteAt[identSrc]!,
      rawEnd: decoded.byteAt[srcEnd]!,
    });
  };
  while (i < decoded.text.length) {
    if (decoded.text[i] === "\r") {
      flushIdent(i);
      const two = decoded.text[i + 1] === "\n";
      const srcEnd = i + (two ? 2 : 1);
      const start = text.length;
      text += "\n";
      pieces.push({
        kind: "newline",
        normStart: start,
        normEnd: text.length,
        rawStart: decoded.byteAt[i]!,
        rawEnd: decoded.byteAt[srcEnd]!,
      });
      i = srcEnd;
      identSrc = i;
      continue;
    }
    i++;
  }
  flushIdent(decoded.text.length);
  return { text, pieces };
}

// ---------- contract types ----------

export type Rigor = "T0" | "T1" | "T2";
export type DraftKind = "task" | "spike" | "experiment";
export type CitationOrigin = "declared" | "inferred" | "user_edited";
export type RecordProvenance = "imported" | "inferred";
export type SourceGate = "user" | "external";
export type PlanClassification = "structured" | "research" | "mixed" | "unresolved";
export type PlanOutcome = "tasks" | "summary" | "unresolved";
export type SectionLane = "structured" | "research" | "unresolved";
export type EvidenceKind = "status" | "approval" | "signature" | "grant" | "policy" | "assertion";

export interface ProvenanceSpan {
  artifactId: string;
  rawHash: string;
  textVersion: typeof TEXT_VERSION;
  section: string;
  rawStart: number;
  rawEnd: number;
  start: number;
  end: number;
  origin: CitationOrigin;
}

export interface SourceEvidence {
  kind: EvidenceKind;
  /** Inert copy of the source line. Never a live status, grant, or signature. */
  text: string;
  verified: false;
  span?: ProvenanceSpan;
}

/**
 * Committed provenance (ING-08 rule, TASK-137): a pointer, not a quote. Committed
 * `TaskContract/1` provenance and the Cortex citations carry exactly
 * {artifactId, rawHash, textVersion, offsets} — no verbatim quote copies beyond the
 * fields the owner confirmed on the card.
 */
export interface CommittedProvenanceSpan {
  artifactId: string;
  rawHash: string;
  textVersion: typeof TEXT_VERSION;
  rawStart: number;
  rawEnd: number;
  start: number;
  end: number;
}

/** Narrow a parsed span to the committed shape. `section` and `origin` do not travel. */
export function committedSpan(span: ProvenanceSpan): CommittedProvenanceSpan {
  return {
    artifactId: span.artifactId,
    rawHash: span.rawHash,
    textVersion: span.textVersion,
    rawStart: span.rawStart,
    rawEnd: span.rawEnd,
    start: span.start,
    end: span.end,
  };
}

/**
 * Committed evidence: kind + span pointer. The verbatim source line stays in the draft
 * the owner reviewed; the committed contract keeps no quote copy of it.
 */
export interface CommittedSourceEvidence {
  kind: EvidenceKind;
  /** Always false. Evidence is never a live status, grant, or signature. */
  verified: false;
  span?: CommittedProvenanceSpan;
}

export function committedEvidence(evidence: SourceEvidence): CommittedSourceEvidence {
  return {
    kind: evidence.kind,
    verified: false,
    ...(evidence.span ? { span: committedSpan(evidence.span) } : {}),
  };
}

export interface AcceptanceCriterion {
  text: string;
  /** Literal true: the string is data. Import does not execute it and does not grant a shell. */
  inert: true;
}

export interface TaskScope {
  allowedPaths: string[];
  forbiddenPaths: string[];
}

export interface ExistingTaskRef {
  projectId: string;
  taskNumber: number;
}

export interface UnresolvedBlocker {
  clientKey: string;
  reason: "plan_batch";
}

export interface TaskDraftV1 {
  version: "TaskDraft/1";
  clientKey: string;
  sourceTaskId?: string;
  sourceOrder: number;
  title: string;
  description: string;
  kind: DraftKind;
  size?: string;
  next?: string;
  dependsOnClientKeys: string[];
  existingTaskRefs: ExistingTaskRef[];
  sourceGates: SourceGate[];
  unresolvedBlockers: UnresolvedBlocker[];
  acceptanceCriteria: AcceptanceCriterion[];
  scope: TaskScope;
  exitCriteria?: string;
  stopCriteria?: string;
  /** Document recommendation only. It does not change the project tier. */
  requestedRigor?: Rigor;
  provenance: ProvenanceSpan[];
  recordProvenance: RecordProvenance;
  executionState: "held";
  sourceEvidence: SourceEvidence[];
}

export interface TaskContractV1 {
  version: "TaskContract/1";
  projectId: string;
  taskNumber: number;
  clientKey: string;
  sourceTaskId?: string;
  sourceOrder: number;
  title: string;
  description: string;
  kind: DraftKind;
  size?: string;
  next?: string;
  /** Destination task numbers after the batch mapping. Source ids are not reused. */
  blockedOn: number[];
  existingTaskRefs: ExistingTaskRef[];
  /** Gates the source declared. The execution hold is `executionState`, not this list. */
  sourceGates: SourceGate[];
  unresolvedBlockers: UnresolvedBlocker[];
  acceptanceCriteria: AcceptanceCriterion[];
  scope: TaskScope;
  exitCriteria?: string;
  stopCriteria?: string;
  requestedRigor?: Rigor;
  /** Project default. A document cannot raise or lower it. */
  effectiveRigor: Rigor;
  /**
   * ING-08 rule (TASK-137): spans as {artifactId, rawHash, textVersion, offsets} only.
   * The committed contract carries the owner-confirmed card fields and these pointers —
   * no verbatim quote copies beyond them.
   */
  provenance: CommittedProvenanceSpan[];
  recordProvenance: RecordProvenance;
  executionState: "held" | "active";
  sourceEvidence: CommittedSourceEvidence[];
}

export interface SectionEvidence {
  sectionId: string;
  heading: string;
  lane: SectionLane;
  start: number;
  end: number;
  evidence: string;
}

export interface IngestDiagnostic {
  code: "unknown_grammar" | "ambiguous_task_prose" | "unverified_assertion" | "zero_task_outcome" | "unclosed_fence";
  section: string;
  message: string;
}

export interface InferredEdge {
  fromClientKey: string;
  toClientKey: string;
  origin: "inferred";
}

export interface DocumentArtifactV1 {
  version: "DocumentArtifact/1";
  artifactId: string;
  filename: string;
  mediaType: "text/markdown" | "text/plain";
  rawHash: string;
  textVersion: typeof TEXT_VERSION;
  rawByteLength: number;
  normalizedText: string;
  pieces: OffsetPiece[];
  sections: SectionEvidence[];
  sourceEvidence: SourceEvidence[];
  retention: { policy: "restricted"; export: "deny"; erasure: "tombstone" };
}

export interface ImportPlanV1 {
  version: "ImportPlan/1";
  planId: string;
  artifactId: string;
  targetProjectId: string;
  classification: PlanClassification;
  sections: SectionEvidence[];
  drafts: TaskDraftV1[];
  /** Nothing is confirmed by parsing. Selection is a separate owner action. */
  selectedKeys: string[];
  excludedKeys: string[];
  outcome: PlanOutcome;
  faithful: boolean;
  summary?: string;
  diagnostics: IngestDiagnostic[];
  inferredEdges: InferredEdge[];
  candidateCount: number;
  resumable: boolean;
  /**
   * `continuity-task-parcel/1` is the ING-01 fence grammar.
   * `foreman-spec-parcel/1` is the ING-06 SPEC-CONVENTION lane.
   * Research and unresolved plans keep the continuity parser id.
   */
  compiler: { parser: typeof PARCEL_GRAMMAR | "foreman-spec-parcel/1"; normalizer: typeof TEXT_VERSION; template: "ingest-compiler/1" };
}

export interface ImportOperationV1 {
  version: "ImportOperation/1";
  operationId: string;
  cardId: string;
  actor: string;
  tenant: string;
  targetProjectId: string;
  projectRevision: number;
  workspaceBindingRevision: number | null;
  artifactHash: string;
  draftHash: string;
  selectedKeys: string[];
  tier: Rigor;
  policyVersion: typeof POLICY_VERSION;
  boardRevision: number;
  expiresAt: string;
  state: "pending" | "committed" | "refused";
}

export type WorkspaceBinding =
  | { state: "none" }
  | { state: "pending" }
  | { state: "bound"; ref: string };

export interface ProjectV1 {
  version: "Project/1";
  /** Immutable instance id. Not a profile slug and not a grant. */
  projectId: string;
  /** Canonical `proj_<slug>` alias. `proj_me` and `proj_north_star` are not instances. */
  slug: string;
  title: string;
  ownerRef: string;
  lifecycle: "pending" | "active" | "archived";
  defaultRigor: Rigor;
  workspace: WorkspaceBinding;
  /** Explicit satellite profile ids. Default empty — no Life/North Star union. */
  satelliteGrants: string[];
  revision: number;
}

export interface IdMapping {
  clientKey: string;
  sourceTaskId?: string;
  sourceOrder: number;
  taskNumber: number;
}

export interface CompileInput {
  artifactId: string;
  planId: string;
  filename: string;
  mediaType: "text/markdown" | "text/plain";
  targetProjectId: string;
  raw: Uint8Array;
}

export interface CompileResult {
  artifact: DocumentArtifactV1;
  plan?: ImportPlanV1;
  refusals: IngestRefusal[];
}

export interface ResearchGoal {
  outcome: string;
  mode: "summary" | "experiments";
  /** Owner-typed names. The shaper will not invent an install queue from headings. */
  subjects?: string[];
  maxCandidates?: number;
}

// ---------- small predicates ----------

const CLIENT_KEY = /^[a-z][a-z0-9-]{0,63}$/;
const PROJECT_ID = /^prj_[a-z0-9]{16,64}$/;
const PROJECT_SLUG = /^proj_[a-z][a-z0-9_]{0,62}$/;
const ARTIFACT_ID = /^art_[a-z0-9]{8,64}$/;
const PLAN_ID = /^plan_[a-z0-9]{8,64}$/;
const OP_ID = /^op_[a-z0-9]{8,64}$/;
const CARD_ID = /^card_[a-z0-9]{8,64}$/;
const ACTOR_ID = /^[A-Za-z][A-Za-z0-9_-]{0,64}$/;
const HEX64 = /^[a-f0-9]{64}$/;
const SOURCE_TASK = /^TASK-\d{1,6}$/;
const SIZE_TOKEN = /^[a-z0-9-]{1,16}$/;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const RIGORS = new Set<Rigor>(["T0", "T1", "T2"]);
const KINDS = new Set<DraftKind>(["task", "spike", "experiment"]);
const ORIGINS = new Set<CitationOrigin>(["declared", "inferred", "user_edited"]);
const RECORD_PROVENANCE = new Set<RecordProvenance>(["imported", "inferred"]);
const PRIVILEGE_KEYS = new Set([
  "userConfirmed", "user_confirmed", "signature", "grant", "policyOverride", "policy_override",
  "approval", "approved", "receipt", "authority", "user_said",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function oneLine(value: string, label: string, max: number, bag: IngestRefusal[]): boolean {
  if (value.length === 0 || value.length > max || /[\r\n\u0000]/.test(value)) {
    bag.push(refusal("invalid_shape", `${label} must be a single line of 1..${max} characters`));
    return false;
  }
  return true;
}

export function assertTaskNumberWidth(n: number): void {
  if (!Number.isInteger(n) || n < TASK_NUMBER_MIN || n > TASK_NUMBER_MAX) {
    throw refusal(
      "task_number_overflow",
      `task number ${String(n)} is outside the v1 width ${TASK_NUMBER_MIN}..${TASK_NUMBER_MAX}; refusing so a 1..3-digit parser cannot drop or misread it`,
      { taskNumber: n },
    );
  }
}

/** Destination tokens only. `TASK-1000` and `1000` overflow; `TASK-999` is the last accepted id. */
export function parseTaskNumberToken(token: string | number): number {
  if (typeof token === "number") {
    assertTaskNumberWidth(token);
    return token;
  }
  const match = /^TASK-(\d+)$/.exec(token.trim());
  if (!match || match[1]!.length > 3) {
    throw refusal("task_number_overflow", `task token ${JSON.stringify(token)} is outside the v1 width TASK-1..TASK-999`, { token });
  }
  const n = Number(match[1]);
  assertTaskNumberWidth(n);
  return n;
}

export function allocateDestinationNumbers(first: number, count: number): number[] {
  if (!Number.isInteger(count) || count < 0) throw refusal("invalid_shape", "allocation count must be a non-negative integer");
  if (count === 0) return [];
  assertTaskNumberWidth(first);
  const last = first + count - 1;
  assertTaskNumberWidth(last);
  return Array.from({ length: count }, (_, i) => first + i);
}

function assertRelativePath(path: string, bag: IngestRefusal[]): void {
  if (path.length === 0 || path.length > 256 || /[\0\r\n\\]/.test(path) || path.startsWith("/") || /^[A-Za-z]:/.test(path) || path.includes("://")) {
    bag.push(refusal("invalid_scope", `path ${JSON.stringify(path)} is not a relative project path`));
    return;
  }
  const parts = path.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) {
    bag.push(refusal("invalid_scope", `path ${JSON.stringify(path)} escapes the project root`));
  }
}

function scanPrivilege(value: unknown, path: string, bag: IngestRefusal[]): void {
  if (Array.isArray(value)) {
    value.forEach((item, i) => scanPrivilege(item, `${path}[${i}]`, bag));
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, child] of Object.entries(value)) {
    const here = path ? `${path}.${key}` : key;
    if (PRIVILEGE_KEYS.has(key)) {
      bag.push(refusal("forged_authority", `${here} is not accepted from an upload or caller payload`, { path: here }));
    }
    if ((key === "sourceKind" || key === "recordProvenance") && (child === "user_said" || child === "user_confirmed")) {
      bag.push(refusal("provenance_refused", `${here} cannot be ${JSON.stringify(child)}; import provenance is imported or inferred`, { path: here }));
    }
    if (key === "provenance" && (child === "user_said" || child === "user_confirmed")) {
      bag.push(refusal("provenance_refused", `${here} cannot be ${JSON.stringify(child)}`, { path: here }));
    }
    if (key === "executionState" && child !== "held") {
      bag.push(refusal("execution_hold_required", `${here} must be "held" on import; activation is a separate operation`, { path: here, value: child }));
    }
    if (key === "status" && typeof child === "string" && /^(done|claimed|available|blocked)$/i.test(child)) {
      bag.push(refusal("forged_authority", `${here} is source text, not a live board status`, { path: here, value: child }));
    }
    if (key === "verified" && child === true) {
      bag.push(refusal("forged_authority", `${here} cannot mark source evidence as verified`, { path: here }));
    }
    scanPrivilege(child, here, bag);
  }
}

// ---------- citations ----------

export function rawOffsetOf(artifact: Pick<DocumentArtifactV1, "normalizedText" | "pieces">, index: number): number {
  const n = artifact.normalizedText.length;
  if (!Number.isInteger(index) || index < 0 || index > n) {
    throw refusal("citation_mismatch", `normalized offset ${index} is outside 0..${n}`);
  }
  const pieces = artifact.pieces.filter((piece) => piece.kind !== "bom");
  if (index === n) {
    if (pieces.length === 0) {
      const bom = artifact.pieces.find((piece) => piece.kind === "bom");
      return bom ? bom.rawEnd : 0;
    }
    return pieces[pieces.length - 1]!.rawEnd;
  }
  const piece = pieces.find((item) => index >= item.normStart && index < item.normEnd);
  if (!piece) throw refusal("citation_mismatch", `no offset piece covers normalized offset ${index}`);
  if (piece.kind === "newline") return piece.rawStart;
  return piece.rawStart + utf8ByteLength(artifact.normalizedText.slice(piece.normStart, index));
}

export function spanForRange(
  artifact: DocumentArtifactV1,
  start: number,
  end: number,
  section: string,
  origin: CitationOrigin,
): ProvenanceSpan {
  if (!Number.isInteger(start) || !Number.isInteger(end) || end <= start) {
    throw refusal("citation_mismatch", "a citation needs a non-empty normalized range");
  }
  return {
    artifactId: artifact.artifactId,
    rawHash: artifact.rawHash,
    textVersion: TEXT_VERSION,
    section,
    start,
    end,
    rawStart: rawOffsetOf(artifact, start),
    rawEnd: rawOffsetOf(artifact, end),
    origin,
  };
}

export function verifyCitation(artifact: DocumentArtifactV1, raw: Uint8Array, span: ProvenanceSpan): void {
  const hash = sha256Hex(raw);
  if (hash !== artifact.rawHash || span.rawHash !== artifact.rawHash) {
    throw refusal("citation_mismatch", "citation rawHash does not match the artifact bytes");
  }
  if (span.artifactId !== artifact.artifactId || span.textVersion !== artifact.textVersion || !ORIGINS.has(span.origin)) {
    throw refusal("citation_mismatch", "citation does not name this artifact version");
  }
  const rawStart = rawOffsetOf(artifact, span.start);
  const rawEnd = rawOffsetOf(artifact, span.end);
  if (span.rawStart !== rawStart || span.rawEnd !== rawEnd) {
    throw refusal("citation_mismatch", "citation raw offsets do not match the normalization table", { rawStart, rawEnd });
  }
  const expected = artifact.normalizedText.slice(span.start, span.end);
  const again = normalizeUtf8(raw.subarray(span.rawStart, span.rawEnd)).text;
  if (again !== expected) {
    throw refusal("citation_mismatch", "raw slice does not normalize to the cited text");
  }
}

export function citationForLiteral(artifact: DocumentArtifactV1, literal: string, section: string, origin: CitationOrigin): ProvenanceSpan {
  const start = artifact.normalizedText.indexOf(literal);
  if (start < 0) throw refusal("citation_mismatch", `literal ${JSON.stringify(literal)} is not in the artifact`);
  return spanForRange(artifact, start, start + literal.length, section, origin);
}

// ---------- project ----------

function pushUnknown(bag: IngestRefusal[], key: string, allowed: readonly string[]): void {
  if (!allowed.includes(key)) {
    if (PRIVILEGE_KEYS.has(key)) bag.push(refusal("forged_authority", `field ${key} is not accepted`, { field: key }));
    else bag.push(refusal("unknown_field", `field ${key} is not part of this contract`, { field: key }));
  }
}

export function parseProject(input: unknown): { project?: ProjectV1; refusals: IngestRefusal[] } {
  const bag: IngestRefusal[] = [];
  if (!isRecord(input)) return { refusals: [refusal("invalid_shape", "project must be an object")] };
  scanPrivilege(input, "", bag);
  const allowed = ["version", "projectId", "slug", "title", "ownerRef", "lifecycle", "defaultRigor", "workspace", "satelliteGrants", "revision"];
  for (const key of Object.keys(input)) pushUnknown(bag, key, allowed);
  if (input.version !== "Project/1") bag.push(refusal("invalid_version", 'project version must be "Project/1"'));
  const projectId = input.projectId;
  const slug = input.slug;
  if (typeof projectId !== "string" || !PROJECT_ID.test(projectId)) bag.push(refusal("invalid_shape", "projectId must match prj_<16-64 lowercase alphanumerics>"));
  if (typeof slug !== "string") bag.push(refusal("invalid_slug", "slug must be a string"));
  else {
    const folded = slug.toLowerCase();
    if ((RESERVED_PROJECT_SLUGS as readonly string[]).includes(folded)) {
      bag.push(refusal("reserved_slug", `${slug} is a profile alias or grandfathered id, not a Project/1 instance`, { slug }));
    } else if (!PROJECT_SLUG.test(slug)) bag.push(refusal("invalid_slug", "slug must be canonical proj_<lowercase>"));
  }
  if (typeof input.title !== "string" || !oneLine(input.title, "title", 200, bag)) {
    if (typeof input.title !== "string") bag.push(refusal("invalid_shape", "title must be a string"));
  }
  if (typeof input.ownerRef !== "string" || !ACTOR_ID.test(input.ownerRef)) bag.push(refusal("invalid_shape", "ownerRef is not a valid actor reference"));
  if (input.lifecycle !== "pending" && input.lifecycle !== "active" && input.lifecycle !== "archived") {
    bag.push(refusal("invalid_shape", 'lifecycle must be "pending", "active", or "archived"'));
  }
  if (!RIGORS.has(input.defaultRigor as Rigor)) bag.push(refusal("invalid_shape", 'defaultRigor must be "T0", "T1", or "T2"'));
  let workspace: WorkspaceBinding | undefined;
  if (!isRecord(input.workspace) || (input.workspace.state !== "none" && input.workspace.state !== "pending" && input.workspace.state !== "bound")) {
    bag.push(refusal("invalid_shape", 'workspace.state must be "none", "pending", or "bound"'));
  } else if (input.workspace.state === "bound") {
    const ref = input.workspace.ref;
    if (typeof ref !== "string") bag.push(refusal("invalid_shape", "bound workspace needs a ref"));
    else {
      assertRelativePath(ref, bag);
      workspace = { state: "bound", ref };
    }
  } else {
    workspace = input.workspace.state === "none" ? { state: "none" } : { state: "pending" };
    if ("ref" in input.workspace) bag.push(refusal("unknown_field", "only a bound workspace carries a ref"));
  }
  let satelliteGrants: string[] = [];
  if (input.satelliteGrants === undefined) satelliteGrants = [];
  else if (!Array.isArray(input.satelliteGrants) || !input.satelliteGrants.every((g) => typeof g === "string" && /^(proj|actor)_[a-z0-9_]+$/.test(g))) {
    bag.push(refusal("invalid_shape", "satelliteGrants must be an array of proj_/actor_ ids; omission means siloed"));
  } else if (input.satelliteGrants.some((g) => typeof g === "string" && g.toLowerCase() === "proj_projects")) {
    // TASK-136: the reserved registry profile is never a satellite grant.
    bag.push(refusal("reserved_slug", "proj_projects is the reserved registry profile and is never a satellite grant", { slug: "proj_projects" }));
  } else satelliteGrants = [...input.satelliteGrants];
  if (typeof input.revision !== "number" || !Number.isInteger(input.revision) || input.revision < 0) {
    bag.push(refusal("invalid_shape", "revision must be a non-negative integer"));
  }
  if (bag.length > 0 || typeof projectId !== "string" || typeof slug !== "string" || !workspace || typeof input.title !== "string") {
    return { refusals: sortRefusals(bag) };
  }
  const project: ProjectV1 = {
    version: "Project/1",
    projectId,
    slug,
    title: input.title,
    ownerRef: input.ownerRef as string,
    lifecycle: input.lifecycle as ProjectV1["lifecycle"],
    defaultRigor: input.defaultRigor as Rigor,
    workspace,
    satelliteGrants,
    revision: input.revision as number,
  };
  return { project, refusals: [] };
}

// ---------- drafts, plans, selection ----------

function requireSpan(span: unknown, bag: IngestRefusal[], label: string): ProvenanceSpan | undefined {
  if (!isRecord(span)) {
    bag.push(refusal("invalid_shape", `${label} span must be an object`));
    return undefined;
  }
  const origin = span.origin;
  if (
    typeof span.artifactId !== "string" || !ARTIFACT_ID.test(span.artifactId) ||
    typeof span.rawHash !== "string" || !HEX64.test(span.rawHash) ||
    span.textVersion !== TEXT_VERSION ||
    typeof span.section !== "string" ||
    typeof span.rawStart !== "number" || typeof span.rawEnd !== "number" ||
    typeof span.start !== "number" || typeof span.end !== "number" ||
    !ORIGINS.has(origin as CitationOrigin) ||
    span.end <= span.start
  ) {
    bag.push(refusal("citation_mismatch", `${label} span is not a utf8-lf/1 citation`));
    return undefined;
  }
  return span as unknown as ProvenanceSpan;
}

/**
 * Committed provenance (ING-08 rule, TASK-137): exactly
 * {artifactId, rawHash, textVersion, offsets}. A span that carries anything else — a
 * section label, an origin, or a verbatim quote copy — is refused, not silently trimmed.
 */
function requireCommittedSpan(span: unknown, bag: IngestRefusal[], label: string): CommittedProvenanceSpan | undefined {
  if (!isRecord(span)) {
    bag.push(refusal("invalid_shape", `${label} span must be an object`));
    return undefined;
  }
  const allowed = ["artifactId", "end", "rawEnd", "rawHash", "rawStart", "start", "textVersion"];
  const keys = Object.keys(span).sort();
  const ok =
    keys.length === allowed.length &&
    keys.every((key, index) => key === allowed[index]) &&
    typeof span.artifactId === "string" && ARTIFACT_ID.test(span.artifactId) &&
    typeof span.rawHash === "string" && HEX64.test(span.rawHash) &&
    span.textVersion === TEXT_VERSION &&
    Number.isInteger(span.rawStart) && (span.rawStart as number) >= 0 &&
    Number.isInteger(span.rawEnd) && (span.rawEnd as number) >= (span.rawStart as number) &&
    Number.isInteger(span.start) && (span.start as number) >= 0 &&
    Number.isInteger(span.end) && (span.end as number) > (span.start as number);
  if (!ok) {
    bag.push(refusal("citation_mismatch", `${label} span must carry {artifactId, rawHash, textVersion, offsets} only`));
    return undefined;
  }
  return span as unknown as CommittedProvenanceSpan;
}

export function parseUntrustedDraft(input: unknown): { draft?: TaskDraftV1; refusals: IngestRefusal[] } {
  const bag: IngestRefusal[] = [];
  if (!isRecord(input)) return { refusals: [refusal("invalid_shape", "draft must be an object")] };
  scanPrivilege(input, "", bag);
  const allowed = [
    "version", "clientKey", "sourceTaskId", "sourceOrder", "title", "description", "kind", "size", "next",
    "dependsOnClientKeys", "existingTaskRefs", "sourceGates", "unresolvedBlockers", "acceptanceCriteria",
    "scope", "exitCriteria", "stopCriteria", "requestedRigor", "provenance", "recordProvenance",
    "executionState", "sourceEvidence",
  ];
  for (const key of Object.keys(input)) pushUnknown(bag, key, allowed);
  if (input.version !== "TaskDraft/1") bag.push(refusal("invalid_version", 'draft version must be "TaskDraft/1"'));
  if (input.executionState !== undefined && input.executionState !== "held") {
    bag.push(refusal("execution_hold_required", 'imported drafts start at executionState "held"'));
  }
  if (typeof input.recordProvenance === "string" && !RECORD_PROVENANCE.has(input.recordProvenance as RecordProvenance)) {
    bag.push(refusal("provenance_refused", "record provenance must be imported or inferred"));
  }
  const draft = input as unknown as TaskDraftV1;
  const structural = structuralDraftRefusals({ ...draft, version: "TaskDraft/1", executionState: "held" });
  return { draft: bag.length + structural.length === 0 ? { ...draft, executionState: "held" } : undefined, refusals: sortRefusals([...bag, ...structural]) };
}

function structuralDraftRefusals(draft: TaskDraftV1, shape: "draft" | "contract" = "draft"): IngestRefusal[] {
  const bag: IngestRefusal[] = [];
  if (draft.version !== "TaskDraft/1") bag.push(refusal("invalid_version", 'draft version must be "TaskDraft/1"'));
  if (typeof draft.clientKey !== "string" || !CLIENT_KEY.test(draft.clientKey)) bag.push(refusal("invalid_shape", "clientKey must match [a-z][a-z0-9-]{0,63}"));
  if (draft.sourceTaskId !== undefined && (typeof draft.sourceTaskId !== "string" || !SOURCE_TASK.test(draft.sourceTaskId))) {
    bag.push(refusal("invalid_shape", "sourceTaskId must look like TASK-<digits> and is preserved as data"));
  }
  if (typeof draft.sourceOrder !== "number" || !Number.isInteger(draft.sourceOrder) || draft.sourceOrder < 0) {
    bag.push(refusal("invalid_shape", "sourceOrder must be a non-negative integer"));
  }
  if (typeof draft.title !== "string") bag.push(refusal("invalid_shape", "title must be a string"));
  else oneLine(draft.title, "title", 200, bag);
  if (typeof draft.description !== "string") bag.push(refusal("invalid_shape", "description must be a string"));
  else oneLine(draft.description, "description", 2000, bag);
  if (!KINDS.has(draft.kind)) bag.push(refusal("invalid_shape", 'kind must be "task", "spike", or "experiment"'));
  if (draft.size !== undefined && (typeof draft.size !== "string" || !SIZE_TOKEN.test(draft.size))) bag.push(refusal("invalid_shape", "size must be one short token"));
  if (draft.next !== undefined && typeof draft.next === "string") oneLine(draft.next, "next", 300, bag);
  if (!Array.isArray(draft.dependsOnClientKeys) || draft.dependsOnClientKeys.some((key) => typeof key !== "string" || !CLIENT_KEY.test(key))) {
    bag.push(refusal("invalid_shape", "dependsOnClientKeys must be client keys"));
  }
  if (draft.dependsOnClientKeys?.includes(draft.clientKey)) {
    bag.push(refusal("self_edge", `${draft.clientKey} depends on itself`, { clientKey: draft.clientKey }));
  }
  if (!Array.isArray(draft.existingTaskRefs)) bag.push(refusal("invalid_shape", "existingTaskRefs must be an array"));
  else {
    for (const ref of draft.existingTaskRefs) {
      if (!ref || typeof ref.projectId !== "string" || !PROJECT_ID.test(ref.projectId)) bag.push(refusal("invalid_shape", "existing task refs need a projectId"));
      else {
        try { assertTaskNumberWidth(ref.taskNumber); }
        catch (error) { if (error instanceof IngestRefusal) bag.push(error); }
      }
    }
  }
  if (!Array.isArray(draft.sourceGates) || draft.sourceGates.some((gate) => gate !== "user" && gate !== "external")) {
    bag.push(refusal("invalid_shape", 'sourceGates entries must be "user" or "external"'));
  }
  if (!Array.isArray(draft.unresolvedBlockers)) bag.push(refusal("invalid_shape", "unresolvedBlockers must be an array"));
  else {
    for (const blocker of draft.unresolvedBlockers) {
      if (!blocker || blocker.reason !== "plan_batch" || typeof blocker.clientKey !== "string" || !CLIENT_KEY.test(blocker.clientKey)) {
        bag.push(refusal("invalid_shape", 'unresolved blockers must be { clientKey, reason: "plan_batch" }'));
      } else if (!draft.dependsOnClientKeys?.includes(blocker.clientKey)) {
        bag.push(refusal("invalid_shape", `unresolved blocker ${blocker.clientKey} is not an edge`, { clientKey: blocker.clientKey }));
      }
    }
  }
  if (!Array.isArray(draft.acceptanceCriteria) || draft.acceptanceCriteria.length === 0) {
    bag.push(refusal("invalid_shape", "acceptanceCriteria must be a non-empty list of inert strings"));
  } else {
    for (const criterion of draft.acceptanceCriteria) {
      if (!criterion || criterion.inert !== true || typeof criterion.text !== "string") {
        bag.push(refusal("acceptance_not_inert", "acceptance criteria are inert strings and are not executed or granted"));
      } else oneLine(criterion.text, "acceptance", 500, bag);
    }
  }
  if (!draft.scope || !Array.isArray(draft.scope.allowedPaths) || !Array.isArray(draft.scope.forbiddenPaths)) {
    bag.push(refusal("invalid_scope", "scope.allowedPaths and scope.forbiddenPaths are required arrays"));
  } else {
    if (draft.recordProvenance === "imported" && draft.scope.allowedPaths.length === 0) {
      bag.push(refusal("invalid_scope", "a declared parcel task needs an explicit allowed path; empty is not allow-all"));
    }
    for (const path of [...draft.scope.allowedPaths, ...draft.scope.forbiddenPaths]) {
      if (typeof path !== "string") bag.push(refusal("invalid_scope", "scope paths must be strings"));
      else assertRelativePath(path, bag);
    }
  }
  if (draft.requestedRigor !== undefined && !RIGORS.has(draft.requestedRigor)) bag.push(refusal("invalid_shape", "requestedRigor must be T0, T1, or T2"));
  if (draft.executionState !== "held") bag.push(refusal("execution_hold_required", 'executionState must be "held"'));
  if (!RECORD_PROVENANCE.has(draft.recordProvenance)) bag.push(refusal("provenance_refused", "record provenance must be imported or inferred"));
  if (!Array.isArray(draft.provenance) || draft.provenance.length === 0) bag.push(refusal("citation_mismatch", "a draft needs at least one provenance span"));
  else draft.provenance.forEach((span, i) => (shape === "contract" ? requireCommittedSpan(span, bag, `provenance[${i}]`) : requireSpan(span, bag, `provenance[${i}]`)));
  if (!Array.isArray(draft.sourceEvidence)) bag.push(refusal("invalid_shape", "sourceEvidence must be an array"));
  else {
    for (const evidence of draft.sourceEvidence) {
      if (!evidence || evidence.verified !== false) {
        bag.push(refusal("forged_authority", "source evidence stays unverified"));
      } else if (shape === "contract") {
        // ING-08 rule (TASK-137): exact key set — {kind, verified, span?} only. A banned
        // key is one of many places a quote can hide, so anything else refuses outright.
        const raw = evidence as unknown as Record<string, unknown>;
        const keys = Object.keys(raw).sort();
        const allowed = raw.span === undefined ? ["kind", "verified"] : ["kind", "span", "verified"];
        const exact = keys.length === allowed.length && keys.every((key, index) => key === allowed[index]);
        if (raw.span !== undefined) requireCommittedSpan(raw.span, bag, "sourceEvidence span");
        if (!exact) {
          bag.push(refusal("forged_authority", "a committed contract carries no verbatim quote copy; source evidence is {kind, verified, span} only and the source line stays in the draft the owner confirmed"));
        }
      } else if (typeof evidence.text !== "string") {
        bag.push(refusal("forged_authority", "source evidence stays unverified"));
      }
    }
  }
  return bag;
}

export function validatePlan(plan: ImportPlanV1): IngestRefusal[] {
  const bag: IngestRefusal[] = [];
  if (plan.version !== "ImportPlan/1") bag.push(refusal("invalid_version", 'plan version must be "ImportPlan/1"'));
  if (!PLAN_ID.test(plan.planId) || !ARTIFACT_ID.test(plan.artifactId) || !PROJECT_ID.test(plan.targetProjectId)) {
    bag.push(refusal("invalid_shape", "plan ids are missing or malformed"));
  }
  if (plan.drafts.length > MAX_PLAN_CANDIDATES) {
    bag.push(refusal("import_limit", `import candidate limit is ${MAX_PLAN_CANDIDATES}; refusing a larger draft`, { count: plan.drafts.length }));
    return sortRefusals(bag);
  }
  const seenKeys = new Map<string, number>();
  const seenSource = new Map<string, number>();
  for (const draft of plan.drafts) {
    bag.push(...structuralDraftRefusals(draft));
    seenKeys.set(draft.clientKey, (seenKeys.get(draft.clientKey) ?? 0) + 1);
    if (draft.sourceTaskId) seenSource.set(draft.sourceTaskId, (seenSource.get(draft.sourceTaskId) ?? 0) + 1);
    for (const ref of draft.existingTaskRefs) {
      if (ref.projectId !== plan.targetProjectId) {
        bag.push(refusal("cross_project_edge", `${draft.clientKey} references ${ref.projectId} #${ref.taskNumber}, which is not the target project`, {
          clientKey: draft.clientKey,
          projectId: ref.projectId,
        }));
      }
    }
  }
  for (const [clientKey, count] of [...seenKeys].sort(([a], [b]) => a.localeCompare(b))) {
    if (count > 1) bag.push(refusal("duplicate_client_key", `clientKey ${clientKey} appears ${count} times`, { clientKey, count }));
  }
  for (const [sourceTaskId, count] of [...seenSource].sort(([a], [b]) => a.localeCompare(b))) {
    if (count > 1) bag.push(refusal("duplicate_source_task_id", `sourceTaskId ${sourceTaskId} appears ${count} times and is not merged into a live task`, { sourceTaskId, count }));
  }
  const keys = new Set(plan.drafts.map((draft) => draft.clientKey));
  for (const draft of plan.drafts) {
    for (const dep of draft.dependsOnClientKeys) {
      const typed = draft.unresolvedBlockers.some((blocker) => blocker.clientKey === dep);
      if (!keys.has(dep) && !typed) {
        bag.push(refusal("unknown_client_key", `${draft.clientKey} depends on unknown clientKey ${dep}`, { clientKey: draft.clientKey, dependency: dep }));
      }
    }
  }
  const ordered = [...plan.drafts].sort((a, b) => a.sourceOrder - b.sourceOrder || a.clientKey.localeCompare(b.clientKey));
  const edges = new Map(ordered.map((draft) => [draft.clientKey, draft.dependsOnClientKeys.filter((dep) => keys.has(dep) && dep !== draft.clientKey)]));
  const color = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];
  const walk = (key: string): string[] | undefined => {
    color.set(key, 1);
    stack.push(key);
    for (const next of edges.get(key) ?? []) {
      const state = color.get(next) ?? 0;
      if (state === 1) {
        const at = stack.indexOf(next);
        return [...stack.slice(at), next];
      }
      if (state === 0) {
        const found = walk(next);
        if (found) return found;
      }
    }
    stack.pop();
    color.set(key, 2);
    return undefined;
  };
  for (const draft of ordered) {
    if ((color.get(draft.clientKey) ?? 0) !== 0) continue;
    const cycle = walk(draft.clientKey);
    if (cycle) {
      bag.push(refusal("cycle", `dependency cycle ${cycle.join(" → ")}`, { cycle }));
      break;
    }
  }
  return sortRefusals(bag);
}

export function selectionRefusals(plan: ImportPlanV1, selectedKeys: readonly string[]): IngestRefusal[] {
  const bag: IngestRefusal[] = [];
  if (selectedKeys.length > MAX_COMMIT_BATCH) {
    bag.push(refusal("batch_cap", `a confirmed commit accepts at most ${MAX_COMMIT_BATCH} tasks; this plan stays a resumable draft`, { count: selectedKeys.length }));
  }
  const selected = new Set(selectedKeys);
  if (selected.size !== selectedKeys.length) bag.push(refusal("duplicate_client_key", "selectedKeys contains a duplicate"));
  const byKey = new Map(plan.drafts.map((draft) => [draft.clientKey, draft]));
  for (const key of selectedKeys) {
    const draft = byKey.get(key);
    if (!draft) {
      bag.push(refusal("unknown_client_key", `selected key ${key} is not in the plan`, { clientKey: key }));
      continue;
    }
    for (const dep of draft.dependsOnClientKeys) {
      if (selected.has(dep)) continue;
      const typed = draft.unresolvedBlockers.some((blocker) => blocker.clientKey === dep && blocker.reason === "plan_batch");
      if (typed) continue;
      if (!byKey.has(dep)) continue;
      bag.push(refusal("excluded_blocker", `${key} depends on ${dep}, which is excluded from this commit; refusing rather than marking ${key} AVAILABLE`, {
        clientKey: key,
        blocker: dep,
      }));
    }
  }
  return sortRefusals(bag);
}

export function materializeContracts(
  plan: ImportPlanV1,
  selectedKeys: readonly string[],
  project: ProjectV1,
  numbers: readonly number[],
): { contracts: TaskContractV1[]; mappings: IdMapping[]; refusals: IngestRefusal[] } {
  const bag = [...validatePlan(plan), ...selectionRefusals(plan, selectedKeys)];
  if (!plan.faithful || plan.outcome === "unresolved") {
    bag.push(refusal("unresolved_import", "an unresolved or unfaithful plan cannot be committed"));
  }
  if (plan.targetProjectId !== project.projectId) {
    bag.push(refusal("stale_operation", "plan target does not match the project instance"));
  }
  if (plan.outcome === "summary" && plan.drafts.length === 0 && selectedKeys.length === 0 && plan.faithful) {
    return { contracts: [], mappings: [], refusals: sortRefusals(bag) };
  }
  if (selectedKeys.length === 0) bag.push(refusal("empty_selection", "commit needs an explicit selection, or a summary outcome"));
  const ordered = plan.drafts.filter((draft) => selectedKeys.includes(draft.clientKey))
    .sort((a, b) => a.sourceOrder - b.sourceOrder || a.clientKey.localeCompare(b.clientKey));
  if (ordered.length !== selectedKeys.length) {
    return { contracts: [], mappings: [], refusals: sortRefusals(bag) };
  }
  if (numbers.length !== ordered.length) bag.push(refusal("invalid_shape", "allocator returned a number for every selected draft"));
  for (const n of numbers) {
    try { assertTaskNumberWidth(n); }
    catch (error) { if (error instanceof IngestRefusal) bag.push(error); }
  }
  if (new Set(numbers).size !== numbers.length) bag.push(refusal("invalid_shape", "allocated task numbers must be unique"));
  if (bag.length > 0) return { contracts: [], mappings: [], refusals: sortRefusals(bag) };
  const allocated = new Map(ordered.map((draft, i) => [draft.clientKey, numbers[i]!]));
  const selected = new Set(selectedKeys);
  const contracts: TaskContractV1[] = [];
  const mappings: IdMapping[] = [];
  for (const draft of ordered) {
    const taskNumber = allocated.get(draft.clientKey)!;
    const blockedOn: number[] = [];
    for (const dep of draft.dependsOnClientKeys) {
      if (!selected.has(dep)) continue;
      const n = allocated.get(dep);
      if (n !== undefined && !blockedOn.includes(n)) blockedOn.push(n);
    }
    for (const ref of draft.existingTaskRefs) {
      if (!blockedOn.includes(ref.taskNumber)) blockedOn.push(ref.taskNumber);
    }
    const unresolved = draft.unresolvedBlockers.filter((blocker) => !selected.has(blocker.clientKey));
    const contract: TaskContractV1 = {
      version: "TaskContract/1",
      projectId: project.projectId,
      taskNumber,
      clientKey: draft.clientKey,
      ...(draft.sourceTaskId ? { sourceTaskId: draft.sourceTaskId } : {}),
      sourceOrder: draft.sourceOrder,
      title: draft.title,
      description: draft.description,
      kind: draft.kind,
      ...(draft.size ? { size: draft.size } : {}),
      ...(draft.next ? { next: draft.next } : {}),
      blockedOn,
      existingTaskRefs: draft.existingTaskRefs.map((ref) => ({ ...ref })),
      sourceGates: [...draft.sourceGates],
      unresolvedBlockers: unresolved.map((blocker) => ({ ...blocker })),
      acceptanceCriteria: draft.acceptanceCriteria.map((criterion) => ({ text: criterion.text, inert: true as const })),
      scope: { allowedPaths: [...draft.scope.allowedPaths], forbiddenPaths: [...draft.scope.forbiddenPaths] },
      ...(draft.exitCriteria ? { exitCriteria: draft.exitCriteria } : {}),
      ...(draft.stopCriteria ? { stopCriteria: draft.stopCriteria } : {}),
      ...(draft.requestedRigor ? { requestedRigor: draft.requestedRigor } : {}),
      effectiveRigor: project.defaultRigor,
      provenance: draft.provenance.map(committedSpan),
      recordProvenance: draft.recordProvenance,
      executionState: "held",
      sourceEvidence: draft.sourceEvidence.map(committedEvidence),
    };
    contracts.push(contract);
    mappings.push({
      clientKey: draft.clientKey,
      ...(draft.sourceTaskId ? { sourceTaskId: draft.sourceTaskId } : {}),
      sourceOrder: draft.sourceOrder,
      taskNumber,
    });
  }
  return { contracts, mappings, refusals: [] };
}

const CONTRACT_KEYS = [
  "version", "projectId", "taskNumber", "clientKey", "sourceTaskId", "sourceOrder", "title", "description", "kind",
  "size", "next", "blockedOn", "existingTaskRefs", "sourceGates", "unresolvedBlockers", "acceptanceCriteria", "scope",
  "exitCriteria", "stopCriteria", "requestedRigor", "effectiveRigor", "provenance", "recordProvenance", "executionState",
  "sourceEvidence",
];

export function parseUntrustedContract(input: unknown): { contract?: TaskContractV1; refusals: IngestRefusal[] } {
  const bag: IngestRefusal[] = [];
  if (!isRecord(input)) return { refusals: [refusal("invalid_shape", "contract must be an object")] };
  scanPrivilege(input, "", bag);
  for (const key of Object.keys(input)) pushUnknown(bag, key, CONTRACT_KEYS);
  if (input.version !== "TaskContract/1") bag.push(refusal("invalid_version", 'contract version must be "TaskContract/1"'));
  if (input.executionState !== "held") bag.push(refusal("execution_hold_required", 'untrusted contracts cannot set executionState "active"'));
  if (typeof input.taskNumber === "number") {
    try { assertTaskNumberWidth(input.taskNumber); }
    catch (error) { if (error instanceof IngestRefusal) bag.push(error); }
  } else if (typeof input.taskNumber === "string") {
    try { parseTaskNumberToken(input.taskNumber); }
    catch (error) { if (error instanceof IngestRefusal) bag.push(error); }
  } else bag.push(refusal("invalid_shape", "taskNumber must be an integer"));
  if (input.effectiveRigor !== undefined && !RIGORS.has(input.effectiveRigor as Rigor)) {
    bag.push(refusal("rigor_downgrade", "effectiveRigor is not a tier"));
  }
  const asDraft: TaskDraftV1 = {
    version: "TaskDraft/1",
    clientKey: String(input.clientKey ?? ""),
    ...(typeof input.sourceTaskId === "string" ? { sourceTaskId: input.sourceTaskId } : {}),
    sourceOrder: typeof input.sourceOrder === "number" ? input.sourceOrder : -1,
    title: typeof input.title === "string" ? input.title : "",
    description: typeof input.description === "string" ? input.description : "",
    kind: input.kind as DraftKind,
    ...(typeof input.size === "string" ? { size: input.size } : {}),
    ...(typeof input.next === "string" ? { next: input.next } : {}),
    dependsOnClientKeys: [],
    existingTaskRefs: Array.isArray(input.existingTaskRefs) ? input.existingTaskRefs as ExistingTaskRef[] : [],
    sourceGates: Array.isArray(input.sourceGates) ? input.sourceGates as SourceGate[] : [],
    unresolvedBlockers: Array.isArray(input.unresolvedBlockers) ? input.unresolvedBlockers as UnresolvedBlocker[] : [],
    acceptanceCriteria: Array.isArray(input.acceptanceCriteria) ? input.acceptanceCriteria as AcceptanceCriterion[] : [],
    scope: isRecord(input.scope) ? input.scope as unknown as TaskScope : { allowedPaths: [], forbiddenPaths: [] },
    ...(typeof input.requestedRigor === "string" ? { requestedRigor: input.requestedRigor as Rigor } : {}),
    provenance: Array.isArray(input.provenance) ? input.provenance as ProvenanceSpan[] : [],
    recordProvenance: input.recordProvenance as RecordProvenance,
    executionState: "held",
    sourceEvidence: Array.isArray(input.sourceEvidence) ? input.sourceEvidence as SourceEvidence[] : [],
  };
  bag.push(...structuralDraftRefusals(asDraft, "contract"));
  if (!Array.isArray(input.blockedOn) || input.blockedOn.some((n) => typeof n !== "number")) {
    bag.push(refusal("invalid_shape", "blockedOn must be destination task numbers"));
  } else {
    for (const n of input.blockedOn as number[]) {
      try { assertTaskNumberWidth(n); }
      catch (error) { if (error instanceof IngestRefusal) bag.push(error); }
    }
  }
  if (bag.length > 0) return { refusals: sortRefusals(bag) };
  return { contract: input as unknown as TaskContractV1, refusals: [] };
}

// ---------- parcel compile ----------

const HEADER_KEYS = new Set(["clientKey", "sourceTaskId", "sourceOrder", "kind", "size", "rigor"]);
const BODY_KEYS = new Set(["title", "description", "next", "exit", "stop", "dependsOn", "acceptance", "allowed", "forbidden", "gate", "existing", "unresolved"]);
const FORGED_LINE_KEYS = new Set(["executionState", "sourceKind", "userConfirmed", "status", "signature", "grant", "policyOverride", "provenance", "approval", "approved"]);

interface FenceHit { start: number; end: number; bodyStart: number; bodyEnd: number; body: string }

function findFences(text: string): { fences: FenceHit[]; unclosed: boolean } {
  const fences: FenceHit[] = [];
  const open = /```continuity-task-parcel\/1\n/g;
  let match: RegExpExecArray | null;
  let unclosed = false;
  while ((match = open.exec(text))) {
    const bodyStart = match.index + match[0].length;
    const closeAt = text.indexOf("\n```", bodyStart);
    if (closeAt < 0) {
      unclosed = true;
      break;
    }
    fences.push({ start: match.index, end: closeAt + 4, bodyStart, bodyEnd: closeAt, body: text.slice(bodyStart, closeAt) });
    open.lastIndex = closeAt + 4;
  }
  return { fences, unclosed };
}

function maskRanges(text: string, ranges: { start: number; end: number }[]): string {
  const chars = text.split("");
  for (const range of ranges) {
    for (let i = range.start; i < range.end && i < chars.length; i++) if (chars[i] !== "\n") chars[i] = " ";
  }
  return chars.join("");
}

const TASK_LIKE: { code: IngestDiagnostic["code"]; re: RegExp; message: string }[] = [
  { code: "ambiguous_task_prose", re: /^#{1,6}[ \t]+task\b/im, message: "a heading that says task is not the supported parcel grammar" },
  { code: "ambiguous_task_prose", re: /^\s*(?:[-*]|\d+[.)])[ \t]+.*\btask\b/im, message: "a list item that says task is not the supported parcel grammar" },
  { code: "unknown_grammar", re: /^TASK-\d+\b/im, message: "a bare TASK-nn line is not the supported parcel grammar" },
  { code: "unknown_grammar", re: /\bblockedBy\b/, message: "blockedBy prose is not a typed edge" },
  { code: "ambiguous_task_prose", re: /\bdepends on task\b/i, message: "depends-on-task prose is not a typed edge" },
];

interface SectionDraft { heading: string; start: number; end: number; bodyStart: number }

function splitSections(text: string): SectionDraft[] {
  const marks: SectionDraft[] = [];
  const re = /^#{1,6}[ \t]+(.+)$/gm;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text))) {
    marks.push({ heading: match[1]!.trim(), start: match.index, end: text.length, bodyStart: match.index + match[0].length });
  }
  if (marks.length === 0) return [{ heading: "", start: 0, end: text.length, bodyStart: 0 }];
  const out: SectionDraft[] = [];
  if (marks[0]!.start > 0) out.push({ heading: "", start: 0, end: marks[0]!.start, bodyStart: 0 });
  for (let i = 0; i < marks.length; i++) {
    const end = i + 1 < marks.length ? marks[i + 1]!.start : text.length;
    out.push({ ...marks[i]!, end });
  }
  return out;
}

function evidenceKind(label: string): EvidenceKind {
  const key = label.toLowerCase().replace(/_/g, "");
  if (key === "status") return "status";
  if (key === "signature") return "signature";
  if (key === "grant") return "grant";
  if (key === "policyoverride" || key === "policy-override") return "policy";
  return "approval";
}

function collectNarrativeEvidence(text: string, artifact: DocumentArtifactV1, section: string): SourceEvidence[] {
  const evidence: SourceEvidence[] = [];
  const re = /^(status|approved-by|approved|approval|signature|grant|policyoverride|policy-override|userconfirmed|sourcekind)\s*[:=]\s*(.*)$/gim;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text))) {
    const start = match.index;
    const end = start + match[0].length;
    evidence.push({
      kind: evidenceKind(match[1]!),
      text: match[0],
      verified: false,
      span: spanForRange(artifact, start, end, section, "declared"),
    });
  }
  return evidence;
}

interface ParsedTask {
  draft: TaskDraftV1;
  refusals: IngestRefusal[];
}

function parseParcelBody(body: string, bodyStart: number, artifact: DocumentArtifactV1, sectionId: string, targetProjectId: string): { drafts: TaskDraftV1[]; refusals: IngestRefusal[]; evidence: SourceEvidence[] } {
  const refusals: IngestRefusal[] = [];
  const evidence: SourceEvidence[] = [];
  const lines = body.split("\n");
  let cursor = bodyStart;
  const blocks: { header: Record<string, string>; fields: { key: string; value: string; start: number; end: number }[]; start: number; end: number }[] = [];
  let current: (typeof blocks)[number] | undefined;
  for (const line of lines) {
    const start = cursor;
    const end = cursor + line.length;
    cursor += line.length + 1;
    if (line.trim() === "") continue;
    if (line.startsWith("task")) {
      const rest = line.slice(4).trim();
      const header: Record<string, string> = {};
      let bad = false;
      if (rest.length > 0) {
        for (const part of rest.split(/\s+/)) {
          const eq = part.indexOf("=");
          if (eq <= 0) {
            refusals.push(refusal("unknown_grammar", `bad parcel header token ${JSON.stringify(part)}`, { section: sectionId }));
            bad = true;
            continue;
          }
          const key = part.slice(0, eq);
          const value = part.slice(eq + 1);
          if (header[key] !== undefined) refusals.push(refusal("duplicate_field", `duplicate header field ${key}`, { field: key }));
          if (FORGED_LINE_KEYS.has(key) || PRIVILEGE_KEYS.has(key)) {
            refusals.push(refusal(key === "sourceKind" || key === "provenance" ? "provenance_refused" : key === "executionState" ? "execution_hold_required" : "forged_authority", `parcel field ${key} is not authority`, { field: key, value }));
            evidence.push({ kind: evidenceKind(key), text: line, verified: false, span: spanForRange(artifact, start, end, sectionId, "declared") });
          } else if (!HEADER_KEYS.has(key)) refusals.push(refusal("unknown_field", `header field ${key} is not in ${PARCEL_GRAMMAR}`, { field: key }));
          header[key] = value;
        }
      }
      if (bad) continue;
      current = { header, fields: [], start, end };
      blocks.push(current);
      continue;
    }
    const parsed = /^([A-Za-z][A-Za-z0-9_-]*)(?:[ \t]+(.*))?$/.exec(line);
    if (!parsed || !current) {
      refusals.push(refusal("unknown_grammar", `unsupported parcel line ${JSON.stringify(line)}`, { section: sectionId }));
      continue;
    }
    const key = parsed[1]!;
    const value = parsed[2] ?? "";
    if (FORGED_LINE_KEYS.has(key) || PRIVILEGE_KEYS.has(key)) {
      const code: IngestRefusalCode = key === "sourceKind" || key === "provenance" ? "provenance_refused" : key === "executionState" ? "execution_hold_required" : "forged_authority";
      refusals.push(refusal(code, `parcel field ${key} is not authority and was not applied`, { field: key, value }));
      evidence.push({ kind: evidenceKind(key), text: line, verified: false, span: spanForRange(artifact, start, end, sectionId, "declared") });
      continue;
    }
    if (!BODY_KEYS.has(key)) {
      refusals.push(refusal("unknown_field", `field ${key} is not in ${PARCEL_GRAMMAR} and was not dropped`, { field: key }));
      continue;
    }
    current.fields.push({ key, value, start, end });
    current.end = end;
  }
  if (blocks.length > MAX_PLAN_CANDIDATES) {
    return { drafts: [], refusals: [refusal("import_limit", `import candidate limit is ${MAX_PLAN_CANDIDATES}; refusing a larger draft`, { count: blocks.length })], evidence };
  }
  const drafts: TaskDraftV1[] = [];
  for (const block of blocks) {
    const bag: IngestRefusal[] = [];
    const take = (key: string) => block.fields.filter((field) => field.key === key).map((field) => field.value);
    const scalar = (key: string) => {
      const values = take(key);
      if (values.length > 1) bag.push(refusal("duplicate_field", `duplicate ${key} on ${block.header.clientKey ?? "?"}`, { field: key }));
      return values[0];
    };
    const clientKey = block.header.clientKey ?? "";
    const sourceOrder = Number(block.header.sourceOrder ?? "0");
    const kind = (block.header.kind ?? "task") as DraftKind;
    const depends = take("dependsOn");
    const unresolved = take("unresolved");
    const acceptance = take("acceptance");
    const allowed = take("allowed");
    const forbidden = take("forbidden");
    const gates = take("gate");
    const existing = take("existing");
    const refs: ExistingTaskRef[] = [];
    for (const item of existing) {
      const parts = item.trim().split(/\s+/);
      if (parts.length !== 2 || !PROJECT_ID.test(parts[0]!) || !/^\d+$/.test(parts[1]!)) {
        bag.push(refusal("invalid_shape", `existing ref ${JSON.stringify(item)} must be "<projectId> <taskNumber>"`));
        continue;
      }
      const taskNumber = Number(parts[1]);
      try { assertTaskNumberWidth(taskNumber); }
      catch (error) { if (error instanceof IngestRefusal) bag.push(error); }
      if (parts[0] !== targetProjectId) {
        bag.push(refusal("cross_project_edge", `existing ref ${parts[0]} is not target ${targetProjectId}`, { projectId: parts[0] }));
      }
      refs.push({ projectId: parts[0]!, taskNumber });
    }
    const sourceGates: SourceGate[] = [];
    for (const gate of gates) {
      if (gate === "user" || gate === "external") sourceGates.push(gate);
      else bag.push(refusal("invalid_shape", `gate ${JSON.stringify(gate)} must be user or external`));
    }
    const rigor = block.header.rigor as Rigor | undefined;
    if (rigor !== undefined && !RIGORS.has(rigor)) bag.push(refusal("invalid_shape", `rigor ${String(rigor)} is not T0, T1, or T2`));
    if (block.header.executionState !== undefined && block.header.executionState !== "held") {
      bag.push(refusal("execution_hold_required", "parcel executionState cannot activate a task"));
    }
    const span = spanForRange(artifact, block.start, Math.max(block.end, block.start + 1), sectionId, "declared");
    const draft: TaskDraftV1 = {
      version: "TaskDraft/1",
      clientKey,
      ...(block.header.sourceTaskId ? { sourceTaskId: block.header.sourceTaskId } : {}),
      sourceOrder: Number.isInteger(sourceOrder) ? sourceOrder : -1,
      title: scalar("title") ?? "",
      description: scalar("description") ?? "",
      kind,
      ...(block.header.size ? { size: block.header.size } : {}),
      ...(scalar("next") ? { next: scalar("next") } : {}),
      dependsOnClientKeys: depends,
      existingTaskRefs: refs,
      sourceGates,
      unresolvedBlockers: unresolved.map((clientKey) => ({ clientKey, reason: "plan_batch" as const })),
      acceptanceCriteria: acceptance.map((text) => ({ text, inert: true as const })),
      scope: { allowedPaths: allowed, forbiddenPaths: forbidden },
      ...(scalar("exit") ? { exitCriteria: scalar("exit") } : {}),
      ...(scalar("stop") ? { stopCriteria: scalar("stop") } : {}),
      ...(rigor && RIGORS.has(rigor) ? { requestedRigor: rigor } : {}),
      provenance: [span],
      recordProvenance: "imported",
      executionState: "held",
      sourceEvidence: [],
    };
    bag.push(...structuralDraftRefusals(draft));
    refusals.push(...bag);
    if (bag.length === 0) drafts.push(draft);
  }
  return { drafts, refusals, evidence };
}

function classify(sections: SectionEvidence[]): PlanClassification {
  const lanes = new Set(sections.map((section) => section.lane));
  if (lanes.has("unresolved") && !lanes.has("structured")) return "unresolved";
  if (lanes.has("structured") && (lanes.has("research") || lanes.has("unresolved"))) return "mixed";
  if (lanes.has("structured")) return "structured";
  if (lanes.has("unresolved")) return "unresolved";
  return "research";
}

function finishPlan(input: CompileInput, artifact: DocumentArtifactV1, drafts: TaskDraftV1[], sections: SectionEvidence[], diagnostics: IngestDiagnostic[], evidence: SourceEvidence[]): CompileResult {
  const classification = classify(sections);
  const unresolved = classification === "unresolved" || diagnostics.some((item) => item.code === "unknown_grammar" || item.code === "ambiguous_task_prose" || item.code === "unclosed_fence");
  const outcome: PlanOutcome = unresolved && drafts.length === 0 ? "unresolved" : drafts.length === 0 ? "summary" : "tasks";
  const faithful = !unresolved && diagnostics.every((item) => item.code === "unverified_assertion" || item.code === "zero_task_outcome");
  const plan: ImportPlanV1 = {
    version: "ImportPlan/1",
    planId: input.planId,
    artifactId: input.artifactId,
    targetProjectId: input.targetProjectId,
    classification: faithful ? classification : classification === "structured" ? "unresolved" : classification,
    sections,
    drafts: faithful ? drafts : [],
    selectedKeys: [],
    excludedKeys: [],
    outcome: faithful ? outcome : "unresolved",
    faithful,
    ...(drafts.length === 0 ? { summary: "No goal required tasks. Source text stays evidence, not a board." } : {}),
    diagnostics,
    inferredEdges: [],
    candidateCount: faithful ? drafts.length : 0,
    resumable: drafts.length > MAX_COMMIT_BATCH,
    compiler: { parser: PARCEL_GRAMMAR, normalizer: TEXT_VERSION, template: "ingest-compiler/1" },
  };
  const stored: DocumentArtifactV1 = { ...artifact, sections, sourceEvidence: evidence };
  const refusals = faithful ? validatePlan(plan) : [];
  if (refusals.length > 0) return { artifact: stored, refusals };
  return { artifact: stored, plan: { ...plan, sections }, refusals: [] };
}

export function compileDocument(input: CompileInput): CompileResult {
  const bag: IngestRefusal[] = [];
  if (!ARTIFACT_ID.test(input.artifactId)) bag.push(refusal("invalid_shape", "artifactId must match art_<id>"));
  if (!PLAN_ID.test(input.planId)) bag.push(refusal("invalid_shape", "planId must match plan_<id>"));
  if (!PROJECT_ID.test(input.targetProjectId)) bag.push(refusal("invalid_shape", "targetProjectId must be an immutable prj_ id"));
  if (input.mediaType !== "text/markdown" && input.mediaType !== "text/plain") {
    bag.push(refusal("unsupported_media_type", "v1 accepts UTF-8 .md and .txt only"));
  }
  if (typeof input.filename !== "string" || input.filename.length === 0 || input.filename.length > 200 || /[\\/\0]/.test(input.filename)) {
    bag.push(refusal("invalid_shape", "filename must be a single path segment"));
  }
  if (bag.length > 0) {
    const empty = normalizeUtf8(new Uint8Array());
    return {
      artifact: emptyArtifact(input, empty, sha256Hex(new Uint8Array())),
      refusals: sortRefusals(bag),
    };
  }
  let normalized: NormalizedText;
  try {
    normalized = normalizeUtf8(input.raw);
  } catch (error) {
    if (error instanceof IngestRefusal) {
      const empty = normalizeUtf8(new Uint8Array());
      return { artifact: emptyArtifact(input, empty, sha256Hex(new Uint8Array(input.raw))), refusals: [error] };
    }
    throw error;
  }
  const rawHash = sha256Hex(input.raw);
  const shell = baseArtifact(input, normalized, rawHash);
  const { fences, unclosed } = findFences(normalized.text);
  const diagnostics: IngestDiagnostic[] = [];
  if (unclosed) diagnostics.push({ code: "unclosed_fence", section: "document", message: "a continuity-task-parcel/1 fence was not closed; it was not parsed as tasks" });
  const masked = maskRanges(normalized.text, fences);
  const sections = splitSections(normalized.text).map((section, index): SectionEvidence => {
    const sectionId = `sec-${index + 1}`;
    const slice = masked.slice(section.start, section.end);
    const hit = TASK_LIKE.find((rule) => rule.re.test(slice));
    const hasFence = fences.some((fence) => fence.start >= section.start && fence.start < section.end);
    if (hit && !hasFence) diagnostics.push({ code: hit.code, section: sectionId, message: hit.message });
    const lane: SectionLane = hasFence && !hit ? "structured" : hit ? "unresolved" : "research";
    const evidence = hasFence
      ? `fenced ${PARCEL_GRAMMAR}`
      : hit
        ? hit.message
        : "narrative section; numbered headings alone are not tasks";
    return { sectionId, heading: section.heading, lane, start: section.start, end: section.end, evidence };
  });
  const drafts: TaskDraftV1[] = [];
  const evidence = collectNarrativeEvidence(masked, shell, "document");
  const hard: IngestRefusal[] = [];
  for (const fence of fences) {
    const section = sections.find((item) => fence.start >= item.start && fence.start < item.end);
    const parsed = parseParcelBody(fence.body, fence.bodyStart, shell, section?.sectionId ?? "document", input.targetProjectId);
    drafts.push(...parsed.drafts);
    hard.push(...parsed.refusals);
    evidence.push(...parsed.evidence);
  }
  if (hard.length > 0) {
    return { artifact: { ...shell, sections, sourceEvidence: evidence }, refusals: sortRefusals(hard) };
  }
  return finishPlan(input, shell, drafts, sections, diagnostics, evidence);
}

function emptyArtifact(input: CompileInput, normalized: NormalizedText, rawHash: string): DocumentArtifactV1 {
  return baseArtifact(input, normalized, rawHash);
}

function baseArtifact(input: CompileInput, normalized: NormalizedText, rawHash: string): DocumentArtifactV1 {
  return {
    version: "DocumentArtifact/1",
    artifactId: input.artifactId,
    filename: input.filename,
    mediaType: input.mediaType === "text/plain" ? "text/plain" : "text/markdown",
    rawHash,
    textVersion: TEXT_VERSION,
    rawByteLength: input.raw.length,
    normalizedText: normalized.text,
    pieces: normalized.pieces,
    sections: [],
    sourceEvidence: [],
    retention: { policy: "restricted", export: "deny", erasure: "tombstone" },
  };
}

// ---------- research lane ----------

const ASSERTION_LITERALS: { literal: string; message: string }[] = [
  { literal: "vendor numbers", message: "vendor benchmark wording is an unverified source assertion, not a measurement and not an install task" },
  { literal: "self-reported", message: "self-reported scores stay unverified source assertions" },
  { literal: "excludes EU, UK, South Korea, and the United States", message: "MiniMax H3 territorial exclusion is an unverified license prerequisite, not an authorized install" },
];

function slugSubject(subject: string): string {
  const slug = subject.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return slug.length > 0 ? slug : "subject";
}

export function shapeResearch(artifact: DocumentArtifactV1, goal: ResearchGoal | undefined, planId: string, targetProjectId: string): { plan?: ImportPlanV1; refusals: IngestRefusal[] } {
  if (!PLAN_ID.test(planId) || !PROJECT_ID.test(targetProjectId)) {
    return { refusals: [refusal("invalid_shape", "research shaping needs a plan id and a target project id")] };
  }
  const mode = goal?.mode ?? "summary";
  const outcome = goal?.outcome?.trim() ?? "";
  const assertions: SourceEvidence[] = [];
  const diagnostics: IngestDiagnostic[] = [];
  for (const item of ASSERTION_LITERALS) {
    if (!artifact.normalizedText.includes(item.literal)) continue;
    const span = citationForLiteral(artifact, item.literal, "research", "declared");
    assertions.push({ kind: "assertion", text: item.literal, verified: false, span });
    diagnostics.push({ code: "unverified_assertion", section: "research", message: item.message });
  }
  const base = (drafts: TaskDraftV1[], planOutcome: PlanOutcome, summary: string): ImportPlanV1 => ({
    version: "ImportPlan/1",
    planId,
    artifactId: artifact.artifactId,
    targetProjectId,
    classification: "research",
    sections: artifact.sections.length > 0 ? artifact.sections : [{
      sectionId: "sec-research",
      heading: "",
      lane: "research",
      start: 0,
      end: artifact.normalizedText.length,
      evidence: "research lane; no supported parcel fence",
    }],
    drafts,
    selectedKeys: [],
    excludedKeys: [],
    outcome: planOutcome,
    faithful: true,
    summary,
    diagnostics: planOutcome === "summary" ? [...diagnostics, { code: "zero_task_outcome", section: "research", message: "no goal required tasks" }] : diagnostics,
    inferredEdges: [],
    candidateCount: drafts.length,
    resumable: drafts.length > MAX_COMMIT_BATCH,
    compiler: { parser: PARCEL_GRAMMAR, normalizer: TEXT_VERSION, template: "ingest-compiler/1" },
  });
  if (mode === "summary" || outcome.length === 0) {
    return {
      plan: base([], "summary", "Summary only. No goal required tasks, so nothing was queued for install or execution. Vendor benchmarks and license lines stay unverified source assertions."),
      refusals: [],
    };
  }
  const subjects = goal?.subjects ?? [];
  const cap = goal?.maxCandidates ?? MAX_COMMIT_BATCH;
  if (!Number.isInteger(cap) || cap < 1) return { refusals: [refusal("invalid_shape", "maxCandidates must be a positive integer")] };
  if (cap > MAX_COMMIT_BATCH || subjects.length > MAX_COMMIT_BATCH) {
    return { refusals: [refusal("batch_cap", `experiment drafts are capped at ${MAX_COMMIT_BATCH}; narrow the goal instead of dropping subjects`, { count: subjects.length })] };
  }
  if (subjects.length === 0) return { refusals: [refusal("invalid_shape", "experiment mode needs owner-typed subjects; the document's queues are not tasks")] };
  const missing = subjects.filter((subject) => !artifact.normalizedText.includes(subject));
  if (missing.length > 0) return { refusals: [refusal("subject_not_found", `subject not in the artifact: ${missing.join(", ")}`, { missing })] };
  const spans = subjects.map((subject) => citationForLiteral(artifact, subject, "research", "inferred"));
  const clientKey = `exp-${subjects.map(slugSubject).join("-")}`.slice(0, 64).replace(/-$/, "");
  if (!CLIENT_KEY.test(clientKey)) return { refusals: [refusal("invalid_shape", "could not derive a stable client key for the experiment")] };
  const draft: TaskDraftV1 = {
    version: "TaskDraft/1",
    clientKey,
    sourceOrder: 1,
    title: `Evaluation spike: ${subjects.join(" and ")}`,
    description: `${outcome} Cited spans only. Vendor scores and license restrictions stay unverified assertions, not install work.`,
    kind: "experiment",
    size: "small",
    next: "Define the corpus and the measurement. Do not install from a source queue.",
    dependsOnClientKeys: [],
    existingTaskRefs: [],
    sourceGates: [],
    unresolvedBlockers: [],
    acceptanceCriteria: [
      { text: "The report cites the named source spans and does not treat vendor benchmarks as measurements.", inert: true },
      { text: "No package install, fetch, or worker launch is performed from this draft.", inert: true },
    ],
    scope: { allowedPaths: [], forbiddenPaths: [] },
    stopCriteria: "Stop if this draft is read as an install queue or as a license grant.",
    requestedRigor: "T1",
    provenance: spans,
    recordProvenance: "inferred",
    executionState: "held",
    sourceEvidence: assertions,
  };
  const plan = base([draft], "tasks", `Bounded experiment draft for ${subjects.join(", ")}. Source queues were not promoted to tasks.`);
  const refusals = validatePlan(plan);
  return refusals.length > 0 ? { refusals } : { plan, refusals: [] };
}

export function mergePlans(base: ImportPlanV1, extra: ImportPlanV1): { plan?: ImportPlanV1; refusals: IngestRefusal[] } {
  const keys = new Set(base.drafts.map((draft) => draft.clientKey));
  const refusals: IngestRefusal[] = [];
  for (const draft of extra.drafts) {
    if (keys.has(draft.clientKey)) refusals.push(refusal("duplicate_client_key", `merge collided on ${draft.clientKey}`, { clientKey: draft.clientKey }));
    keys.add(draft.clientKey);
  }
  if (base.targetProjectId !== extra.targetProjectId || base.artifactId !== extra.artifactId) {
    refusals.push(refusal("stale_operation", "merged plans must share an artifact and a target project"));
  }
  if (refusals.length > 0) return { refusals: sortRefusals(refusals) };
  const sections = [...base.sections];
  for (const section of extra.sections) {
    if (!sections.some((item) => item.sectionId === section.sectionId)) sections.push(section);
  }
  const drafts = [...base.drafts, ...extra.drafts];
  const classification = classify(sections.length > 0 ? sections : base.sections);
  const plan: ImportPlanV1 = {
    ...base,
    classification: classification === "research" && base.classification === "structured" ? "mixed" : classification === "unresolved" ? base.classification : classification === "structured" && extra.drafts.length > 0 ? "mixed" : base.classification === "structured" && extra.classification === "research" ? "mixed" : classification,
    sections: sections.length > 0 ? sections : base.sections,
    drafts,
    outcome: drafts.length === 0 ? "summary" : "tasks",
    summary: extra.summary ?? base.summary,
    diagnostics: [...base.diagnostics, ...extra.diagnostics],
    inferredEdges: [...base.inferredEdges, ...extra.inferredEdges],
    candidateCount: drafts.length,
    resumable: drafts.length > MAX_COMMIT_BATCH,
    faithful: base.faithful && extra.faithful,
  };
  if (plan.classification !== "mixed" && base.sections.some((section) => section.lane === "structured") && extra.classification === "research") {
    plan.classification = "mixed";
  }
  const checked = validatePlan(plan);
  return checked.length > 0 ? { refusals: checked } : { plan, refusals: [] };
}

export function addInferredEdge(plan: ImportPlanV1, fromClientKey: string, toClientKey: string): ImportPlanV1 {
  if (!CLIENT_KEY.test(fromClientKey) || !CLIENT_KEY.test(toClientKey)) throw refusal("invalid_shape", "inferred edge needs client keys");
  const drafts = plan.drafts.map((draft) => draft.clientKey === fromClientKey
    ? { ...draft, dependsOnClientKeys: draft.dependsOnClientKeys.includes(toClientKey) ? draft.dependsOnClientKeys : [...draft.dependsOnClientKeys, toClientKey] }
    : draft);
  if (!drafts.some((draft) => draft.clientKey === fromClientKey) || !drafts.some((draft) => draft.clientKey === toClientKey)) {
    throw refusal("unknown_client_key", "inferred edge endpoints must already be plan keys", { fromClientKey, toClientKey });
  }
  const next: ImportPlanV1 = {
    ...plan,
    drafts,
    inferredEdges: [...plan.inferredEdges, { fromClientKey, toClientKey, origin: "inferred" }],
  };
  const refusals = validatePlan(next);
  if (refusals.length > 0) throw refusals[0];
  return next;
}

// ---------- operation binding ----------

export function planDigest(plan: ImportPlanV1, selectedKeys: readonly string[]): string {
  const selected = new Set(selectedKeys);
  const payload = {
    artifactId: plan.artifactId,
    drafts: plan.drafts.filter((draft) => selected.has(draft.clientKey)).sort((a, b) => a.sourceOrder - b.sourceOrder || a.clientKey.localeCompare(b.clientKey)),
    selectedKeys: [...selectedKeys],
    targetProjectId: plan.targetProjectId,
    version: plan.version,
  };
  return sha256Text(canonicalJson(payload));
}

/**
 * One selected draft in the `DraftHash/1` payload.
 * `executionState` is always `held`. `recordProvenance` is `imported` or `inferred`.
 * `sourceTaskId` is JSON null when the draft has none, so the key is never omitted.
 */
export interface DraftHashEntry {
  acceptanceCriteria: { inert: true; text: string }[];
  clientKey: string;
  dependsOnClientKeys: string[];
  description: string;
  executionState: "held";
  existingTaskRefs: { projectId: string; taskNumber: number }[];
  recordProvenance: RecordProvenance;
  scope: { allowedPaths: string[]; forbiddenPaths: string[] };
  sourceOrder: number;
  sourceTaskId: string | null;
  title: string;
  unresolvedBlockers: { clientKey: string; reason: "plan_batch" }[];
}

/** Selected keys ordered by source order, then clientKey. That order is the canonical list. */
export function canonicalSelectedClientKeys(plan: ImportPlanV1, selectedClientKeys: readonly string[]): string[] {
  const byKey = new Map(plan.drafts.map((draft) => [draft.clientKey, draft]));
  return [...selectedClientKeys].sort((a, b) => {
    const left = byKey.get(a)?.sourceOrder ?? Number.MAX_SAFE_INTEGER;
    const right = byKey.get(b)?.sourceOrder ?? Number.MAX_SAFE_INTEGER;
    return left - right || a.localeCompare(b);
  });
}

export function draftHashEntries(plan: ImportPlanV1, selectedClientKeys: readonly string[]): DraftHashEntry[] {
  const byKey = new Map(plan.drafts.map((draft) => [draft.clientKey, draft]));
  return canonicalSelectedClientKeys(plan, selectedClientKeys).map((key) => {
    const draft = byKey.get(key);
    if (!draft) {
      return {
        acceptanceCriteria: [],
        clientKey: key,
        dependsOnClientKeys: [],
        description: "",
        executionState: "held",
        existingTaskRefs: [],
        recordProvenance: "imported",
        scope: { allowedPaths: [], forbiddenPaths: [] },
        sourceOrder: -1,
        sourceTaskId: null,
        title: "",
        unresolvedBlockers: [],
      };
    }
    return {
      acceptanceCriteria: draft.acceptanceCriteria.map((criterion) => ({ inert: true as const, text: criterion.text })),
      clientKey: draft.clientKey,
      dependsOnClientKeys: [...draft.dependsOnClientKeys],
      description: draft.description,
      executionState: "held",
      existingTaskRefs: draft.existingTaskRefs.map((ref) => ({ projectId: ref.projectId, taskNumber: ref.taskNumber })),
      recordProvenance: draft.recordProvenance === "inferred" ? "inferred" : "imported",
      scope: { allowedPaths: [...draft.scope.allowedPaths], forbiddenPaths: [...draft.scope.forbiddenPaths] },
      sourceOrder: draft.sourceOrder,
      sourceTaskId: draft.sourceTaskId ?? null,
      title: draft.title,
      unresolvedBlockers: draft.unresolvedBlockers.map((blocker) => ({ clientKey: blocker.clientKey, reason: "plan_batch" as const })),
    };
  });
}

/** UTF-8 canonical JSON for `DraftHash/1`. Keys are sorted by `canonicalJson`. */
export function draftHashCanonical(plan: ImportPlanV1, selectedClientKeys: readonly string[]): string {
  const drafts = draftHashEntries(plan, selectedClientKeys);
  return canonicalJson({
    version: "DraftHash/1",
    selectedClientKeys: drafts.map((draft) => draft.clientKey),
    drafts,
  });
}

/** SHA-256 hex of `draftHashCanonical`. Shared by ING-10, ING-08, and ING-13. */
export function computeDraftHash(plan: ImportPlanV1, selectedClientKeys: readonly string[]): string {
  return sha256Text(draftHashCanonical(plan, selectedClientKeys));
}

/**
 * The exact tuple hashed into a server-held import capability.
 * Every field is present. Null is encoded; undefined is not used.
 * `newProject` is null unless this capability also activates a `Project/1` record.
 */
export interface ConfirmDigestInput {
  purpose: string;
  tenantId: string;
  actorId: string;
  roleId: string;
  targetProjectId: string;
  targetProfileId: string;
  expectedProjectRevision: number | null;
  expectedWorkspaceBindingRevision: number | null;
  expectedBoardRevision: string | null;
  artifactId: string;
  artifactRawHash: string;
  draftHash: string;
  selectedClientKeys: readonly string[];
  rigorTier: Rigor;
  policyVersion: string;
  newProject: ProjectV1 | null;
}

/** UTF-8 canonical JSON for `ConfirmDigest/1`. Lexicographic keys, no whitespace. */
export function confirmDigestCanonical(input: ConfirmDigestInput): string {
  return canonicalJson({
    version: "ConfirmDigest/1",
    purpose: input.purpose,
    tenantId: input.tenantId,
    actorId: input.actorId,
    roleId: input.roleId,
    targetProjectId: input.targetProjectId,
    targetProfileId: input.targetProfileId,
    expectedProjectRevision: input.expectedProjectRevision,
    expectedWorkspaceBindingRevision: input.expectedWorkspaceBindingRevision,
    expectedBoardRevision: input.expectedBoardRevision,
    artifactId: input.artifactId,
    artifactRawHash: input.artifactRawHash,
    draftHash: input.draftHash,
    selectedClientKeys: [...input.selectedClientKeys],
    rigorTier: input.rigorTier,
    policyVersion: input.policyVersion,
    newProject: input.newProject,
  });
}

/**
 * SHA-256 hex (lowercase) of the UTF-8 bytes of `confirmDigestCanonical`.
 * ING-08 and ING-13 must hash this exact string. Do not re-order fields or drop nulls.
 */
export function computeImportConfirmDigest(input: ConfirmDigestInput): string {
  return sha256Text(confirmDigestCanonical(input));
}

/**
 * Fingerprint of the existing board rows a selection depends on.
 * Null when the selection has no qualified existing-task edge, so an unrelated
 * claim does not invalidate the card. A change to a referenced row changes the hash.
 */
export function computeBoardRevisionFingerprint(
  tasks: readonly { n: number; id: string; status: string; content: string }[],
): string | null {
  if (tasks.length === 0) return null;
  const ordered = [...tasks].sort((a, b) => a.n - b.n || a.id.localeCompare(b.id));
  return sha256Text(canonicalJson({
    version: "BoardRevision/1",
    tasks: ordered.map((task) => ({ n: task.n, id: task.id, status: task.status, content: task.content })),
  }));
}

export interface OperationBindInput {
  operationId: string;
  cardId: string;
  actor: string;
  tenant: string;
  project: ProjectV1;
  plan: ImportPlanV1;
  artifactHash: string;
  selectedKeys: readonly string[];
  boardRevision: number;
  expiresAt: string;
}

export function bindOperation(input: OperationBindInput): { operation?: ImportOperationV1; refusals: IngestRefusal[] } {
  const workspaceBindingRevision = input.project.workspace.state === "bound" ? input.project.revision : null;
  const operation: ImportOperationV1 = {
    version: "ImportOperation/1",
    operationId: input.operationId,
    cardId: input.cardId,
    actor: input.actor,
    tenant: input.tenant,
    targetProjectId: input.project.projectId,
    projectRevision: input.project.revision,
    workspaceBindingRevision,
    artifactHash: input.artifactHash,
    draftHash: planDigest(input.plan, input.selectedKeys),
    selectedKeys: [...input.selectedKeys],
    tier: input.project.defaultRigor,
    policyVersion: POLICY_VERSION,
    boardRevision: input.boardRevision,
    expiresAt: input.expiresAt,
    state: "pending",
  };
  const parsed = parseOperation(operation);
  return parsed.refusals.length > 0 ? { refusals: parsed.refusals } : { operation, refusals: [] };
}

export function parseOperation(input: unknown): { operation?: ImportOperationV1; refusals: IngestRefusal[] } {
  const bag: IngestRefusal[] = [];
  if (!isRecord(input)) return { refusals: [refusal("invalid_shape", "operation must be an object")] };
  scanPrivilege(input, "", bag);
  if ("userConfirmed" in input) bag.push(refusal("forged_authority", "userConfirmed on an operation payload is ignored and refused"));
  const allowed = [
    "version", "operationId", "cardId", "actor", "tenant", "targetProjectId", "projectRevision",
    "workspaceBindingRevision", "artifactHash", "draftHash", "selectedKeys", "tier", "policyVersion",
    "boardRevision", "expiresAt", "state",
  ];
  for (const key of Object.keys(input)) pushUnknown(bag, key, allowed);
  if (input.version !== "ImportOperation/1") bag.push(refusal("invalid_version", 'operation version must be "ImportOperation/1"'));
  if (typeof input.operationId !== "string" || !OP_ID.test(input.operationId)) bag.push(refusal("invalid_shape", "operationId must match op_<id>"));
  if (typeof input.cardId !== "string" || !CARD_ID.test(input.cardId)) bag.push(refusal("invalid_shape", "cardId must match card_<id>"));
  if (typeof input.actor !== "string" || !ACTOR_ID.test(input.actor)) bag.push(refusal("invalid_shape", "actor is not a valid id"));
  if (typeof input.tenant !== "string" || !ACTOR_ID.test(input.tenant)) bag.push(refusal("invalid_shape", "tenant is not a valid id"));
  if (typeof input.targetProjectId !== "string" || !PROJECT_ID.test(input.targetProjectId)) bag.push(refusal("invalid_shape", "operation targetProjectId is not a project instance"));
  if (typeof input.projectRevision !== "number" || !Number.isInteger(input.projectRevision) || input.projectRevision < 0) bag.push(refusal("invalid_shape", "projectRevision must be a non-negative integer"));
  if (input.workspaceBindingRevision !== null && (typeof input.workspaceBindingRevision !== "number" || !Number.isInteger(input.workspaceBindingRevision))) {
    bag.push(refusal("invalid_shape", "workspaceBindingRevision must be an integer or null"));
  }
  if (typeof input.artifactHash !== "string" || !HEX64.test(input.artifactHash)) bag.push(refusal("invalid_shape", "artifactHash must be sha256 hex"));
  if (typeof input.draftHash !== "string" || !HEX64.test(input.draftHash)) bag.push(refusal("invalid_shape", "draftHash must be sha256 hex"));
  if (!Array.isArray(input.selectedKeys) || input.selectedKeys.some((key) => typeof key !== "string")) bag.push(refusal("invalid_shape", "selectedKeys must be strings"));
  else if (input.selectedKeys.length > MAX_COMMIT_BATCH) bag.push(refusal("batch_cap", `operation selection exceeds ${MAX_COMMIT_BATCH}`));
  if (!RIGORS.has(input.tier as Rigor)) bag.push(refusal("invalid_shape", "operation tier must be T0, T1, or T2"));
  if (input.policyVersion !== POLICY_VERSION) bag.push(refusal("invalid_version", `policyVersion must be ${POLICY_VERSION}`));
  if (typeof input.boardRevision !== "number" || !Number.isInteger(input.boardRevision) || input.boardRevision < 0) bag.push(refusal("invalid_shape", "boardRevision must be a non-negative integer"));
  if (typeof input.expiresAt !== "string" || !ISO_TIME.test(input.expiresAt) || Number.isNaN(Date.parse(input.expiresAt))) {
    bag.push(refusal("invalid_shape", "expiresAt must be an ISO-8601 UTC timestamp"));
  }
  if (input.state !== "pending" && input.state !== "committed" && input.state !== "refused") bag.push(refusal("invalid_shape", "operation state is invalid"));
  if (bag.length > 0) return { refusals: sortRefusals(bag) };
  return { operation: input as unknown as ImportOperationV1, refusals: [] };
}

export function assertOperationBinds(operation: ImportOperationV1, plan: ImportPlanV1, project: ProjectV1, nowIso: string): IngestRefusal[] {
  const bag: IngestRefusal[] = [];
  if (operation.targetProjectId !== project.projectId || operation.targetProjectId !== plan.targetProjectId) {
    bag.push(refusal("stale_operation", "operation project does not match the plan"));
  }
  if (operation.projectRevision !== project.revision) bag.push(refusal("stale_operation", "project revision moved; the card is stale"));
  if (operation.tier !== project.defaultRigor) bag.push(refusal("rigor_downgrade", "operation tier does not match the project default; a document cannot change it"));
  if (Date.parse(operation.expiresAt) <= Date.parse(nowIso)) bag.push(refusal("stale_operation", "operation card is expired"));
  const digest = planDigest(plan, operation.selectedKeys);
  if (digest !== operation.draftHash) bag.push(refusal("stale_operation", "draft hash does not match the selected plan"));
  if (operation.state !== "pending") bag.push(refusal("stale_operation", "only a pending operation can be committed"));
  return sortRefusals(bag);
}
