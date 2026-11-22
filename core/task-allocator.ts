// Adapted from Keon Kontinuity for the standalone CLI.
/**
 * Canonical 1..999 task allocator (ING-09, shared with Cortex `/v1/tasks/allocate`).
 *
 * One counter per `(tenant, profile)`. Import and direct board adds share it.
 * The same `operationId` replays. A different payload is `CORTEX_IDEMPOTENCY_CONFLICT`.
 * Passing TASK-999 is `TASK_NUMBER_OVERFLOW` and does not move the counter.
 * Legacy boards without a contract stay readable: this module only records a
 * contract when a writer goes through `allocate`.
 */

import { addedContent, parseTask, taskId, type WaitingOn } from "./board.ts";
import type { ProvenanceKind } from "../src/cortex.ts";
import { canonicalJson, computeBoardRevisionFingerprint, sha256Text } from "../shared/ingest.ts";

export const TASK_NUMBER_MAX = 999;

export type AllocateProvenance = "user_said" | "imported" | "inferred";
export type AllocateExecution = "open" | "held";
export type AllocateRigor = "T0" | "T1" | "T2";

export class TaskAllocatorError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "TaskAllocatorError";
    this.status = status;
    this.code = code;
  }
}

export interface AllocateScope {
  tenantId: string;
  profileId: string;
  projectId: string;
  actorId: string;
  roleId: string;
}

export interface AllocateItemInput {
  title?: string;
  text?: string;
  description?: string;
  size?: string;
  next?: string;
  blockedOn?: number[];
  qualifiedBlockedOn?: { projectId: string; taskNumber: number }[];
  waitingOn?: string[];
  executionState?: string;
  recordProvenance?: string;
  rigorTier?: string;
  acceptanceCriteria?: { text?: string; inert?: boolean }[];
  scope?: { allowedPaths?: string[]; forbiddenPaths?: string[] };
  citations?: unknown[];
  /** Import markers. A caller cannot relabel these `user_said`. */
  sourceTaskId?: string;
  origin?: string;
  sourceKind?: string;
}

export interface AllocateRequest {
  schemaVersion?: string;
  operationId: string;
  targetProjectId?: string;
  expectedBoardRevision?: string | null;
  maxTaskNumber?: number;
  items: AllocateItemInput[];
}

export interface BoardTaskContract {
  version: "TaskContract/1";
  projectId: string;
  taskNumber: number;
  taskId: string;
  title: string;
  description: string;
  blockedOn: number[];
  qualifiedBlockedOn: { projectId: string; taskNumber: number }[];
  /** Source USER/EXT gates. The execution hold is not stored here. */
  sourceGates: WaitingOn[];
  unresolvedBlockers: { clientKey?: string; reason: string }[];
  executionState: AllocateExecution;
  recordProvenance: AllocateProvenance;
  rigorTier: "T0" | "T1";
  acceptanceCriteria: { text: string; inert: true }[];
  scope: { allowedPaths: string[]; forbiddenPaths: string[] };
  citations: string[];
  status: string;
}

export interface AllocatedTask extends BoardTaskContract {
  shardId: string;
  content: string;
}

export interface CortexTaskAllocateResponse {
  schemaVersion: "CortexTaskAllocateResponse/1";
  operationId: string;
  targetProfileId: string;
  targetProjectId: string;
  newBoardRevision: string | null;
  replayed: boolean;
  tasks: AllocatedTask[];
}

export interface CortexTaskListResponse {
  schemaVersion: "CortexTaskListResponse/1";
  profileId: string;
  projectId: string | null;
  lastTaskNumber: number;
  nextTaskNumber: number;
  maxTaskNumber: 999;
  boardRevision: string | null;
  project: null;
  tasks: { contract: BoardTaskContract; shardId: string; content: string; claimable: boolean }[];
}

export interface CortexTaskGetResponse {
  schemaVersion: "CortexTaskGetResponse/1";
  profileId: string;
  taskNumber: number;
  contract: BoardTaskContract;
  shardId: string;
  content: string;
  claimable: boolean;
}

interface StoredOp {
  fingerprint: string;
  response: CortexTaskAllocateResponse;
}

const chains = new Map<string, Promise<unknown>>();

function exclusive<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = chains.get(key) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  chains.set(key, run.then(() => undefined, () => undefined));
  return run;
}

function refuse(status: number, code: string, message: string): never {
  throw new TaskAllocatorError(status, code, message);
}

export function sourceKindForProvenance(provenance: AllocateProvenance): ProvenanceKind {
  if (provenance === "imported") return "imported";
  if (provenance === "inferred") return "agent_inferred";
  return "user_said";
}

/** Server-owned provenance. Imported or inferred markers are never stored as `user_said`. */
export function canonicalizeProvenance(item: AllocateItemInput): AllocateProvenance {
  const raw = item.recordProvenance;
  const inferred = raw === "inferred" || raw === "agent_inferred" || item.origin === "inferred" || item.sourceKind === "agent_inferred";
  if (inferred) return "inferred";
  const importedMarker = raw === "imported"
    || item.origin === "imported"
    || item.sourceKind === "imported"
    || (typeof item.sourceTaskId === "string" && item.sourceTaskId.length > 0)
    || (Array.isArray(item.citations) && item.citations.length > 0);
  if (importedMarker) return "imported";
  if (raw === undefined || raw === "user_said" || raw === "user_confirmed") return "user_said";
  refuse(400, "FORBIDDEN_PROVENANCE", "recordProvenance must be user_said, imported, or inferred");
}

export function canonicalizeExecution(item: AllocateItemInput, provenance: AllocateProvenance): AllocateExecution {
  if (provenance === "imported" || provenance === "inferred") return "held";
  if (item.executionState === undefined || item.executionState === "open" || item.executionState === "active") return "open";
  if (item.executionState === "held") return "held";
  refuse(400, "INVALID_EXECUTION_STATE", 'executionState must be "open" or "held"');
}

function asWaiting(values: string[] | undefined): WaitingOn[] {
  const out: WaitingOn[] = [];
  for (const value of values ?? []) {
    if (/^user$/i.test(value)) {
      if (!out.includes("user")) out.push("user");
      continue;
    }
    if (/^(?:ext|external)$/i.test(value)) {
      if (!out.includes("external")) out.push("external");
      continue;
    }
    refuse(400, "INVALID_SHAPE", 'waitingOn entries must be "user" or "external"');
  }
  return out;
}

function asNumbers(values: number[] | undefined, label: string): number[] {
  if (values === undefined) return [];
  if (!Array.isArray(values)) refuse(400, "INVALID_SHAPE", `${label} must be an array of task numbers`);
  const out: number[] = [];
  for (const value of values) {
    if (!Number.isInteger(value) || value < 1 || value > TASK_NUMBER_MAX) {
      refuse(400, "INVALID_EXISTING_DEPENDENCY", `${label} entries must be task numbers 1..999`);
    }
    if (!out.includes(value)) out.push(value);
  }
  return out;
}

interface PreparedItem {
  title: string;
  description: string;
  size?: string;
  next?: string;
  blockedOn: number[];
  qualifiedBlockedOn: { projectId: string; taskNumber: number }[];
  sourceGates: WaitingOn[];
  executionState: AllocateExecution;
  recordProvenance: AllocateProvenance;
  rigorTier: "T0" | "T1";
  acceptanceCriteria: { text: string; inert: true }[];
  scope: { allowedPaths: string[]; forbiddenPaths: string[] };
  citations: string[];
}

function prepareItem(raw: AllocateItemInput): PreparedItem {
  if (typeof raw !== "object" || raw === null) refuse(400, "INVALID_SHAPE", "allocate items must be objects");
  const provenance = canonicalizeProvenance(raw);
  const executionState = canonicalizeExecution(raw, provenance);
  const rigor = raw.rigorTier ?? "T0";
  if (rigor === "T2") refuse(409, "T2_UNAVAILABLE", "T2 allocation is refused. The tier was not downgraded.");
  if (rigor !== "T0" && rigor !== "T1") refuse(400, "INVALID_SHAPE", 'rigorTier must be "T0" or "T1"');
  const titleSource = typeof raw.title === "string" && raw.title.trim() ? raw.title.trim() : typeof raw.text === "string" ? raw.text.trim() : "";
  if (!titleSource) refuse(400, "INVALID_SHAPE", "each item needs a title or text");
  const description = typeof raw.description === "string" ? raw.description.trim() : "";
  const qualified: { projectId: string; taskNumber: number }[] = [];
  for (const ref of raw.qualifiedBlockedOn ?? []) {
    if (!ref || typeof ref.projectId !== "string" || !ref.projectId.trim()) {
      refuse(400, "INVALID_EXISTING_DEPENDENCY", "qualifiedBlockedOn.projectId is required");
    }
    const taskNumber = ref.taskNumber;
    if (!Number.isInteger(taskNumber) || taskNumber < 1 || taskNumber > TASK_NUMBER_MAX) {
      refuse(400, "INVALID_EXISTING_DEPENDENCY", "qualifiedBlockedOn.taskNumber must be 1..999");
    }
    qualified.push({ projectId: ref.projectId.trim(), taskNumber });
  }
  const acceptance: { text: string; inert: true }[] = [];
  for (const row of raw.acceptanceCriteria ?? []) {
    if (!row || row.inert !== true || typeof row.text !== "string" || row.text.trim() === "") {
      refuse(400, "NON_INERT_CRITERIA", "acceptance criteria must be inert data");
    }
    acceptance.push({ text: row.text.trim(), inert: true });
  }
  const citations = (raw.citations ?? []).map((row) => {
    if (typeof row === "string") return row;
    if (row && typeof row === "object" && "text" in row && typeof (row as { text?: unknown }).text === "string") {
      return (row as { text: string }).text;
    }
    return JSON.stringify(row);
  });
  return {
    title: titleSource,
    description,
    ...(typeof raw.size === "string" && raw.size.trim() ? { size: raw.size.trim() } : {}),
    ...(typeof raw.next === "string" && raw.next.trim() ? { next: raw.next.trim() } : {}),
    blockedOn: asNumbers(raw.blockedOn, "blockedOn"),
    qualifiedBlockedOn: qualified,
    sourceGates: asWaiting(raw.waitingOn),
    executionState,
    recordProvenance: provenance,
    rigorTier: rigor,
    acceptanceCriteria: acceptance,
    scope: {
      allowedPaths: [...(raw.scope?.allowedPaths ?? [])],
      forbiddenPaths: [...(raw.scope?.forbiddenPaths ?? [])],
    },
    citations,
  };
}

function fingerprintOf(scope: AllocateScope, projectId: string, expected: string | null, items: PreparedItem[], operationId: string): string {
  return sha256Text(canonicalJson({
    expectedBoardRevision: expected,
    items,
    maxTaskNumber: TASK_NUMBER_MAX,
    operationId,
    targetProfileId: scope.profileId,
    targetProjectId: projectId,
    tenantId: scope.tenantId,
  }));
}

function lineFor(n: number, item: PreparedItem): string {
  const text = item.description ? `${item.title}: ${item.description}` : item.title;
  const waiting = [...item.sourceGates];
  if (item.executionState === "held" && !waiting.includes("user")) waiting.unshift("user");
  const blocked = [...item.blockedOn];
  for (const ref of item.qualifiedBlockedOn) {
    if (!blocked.includes(ref.taskNumber)) blocked.push(ref.taskNumber);
  }
  return addedContent(n, {
    text,
    ...(item.size ? { size: item.size } : {}),
    ...(item.next ? { next: item.next } : {}),
    ...(blocked.length ? { blockedOn: blocked } : {}),
    ...(waiting.length ? { waitingOn: waiting } : {}),
  });
}

function contractFor(n: number, projectId: string, item: PreparedItem, content: string): BoardTaskContract {
  const parsed = parseTask(content);
  const blocked = [...item.blockedOn];
  for (const ref of item.qualifiedBlockedOn) {
    if (ref.projectId === projectId && !blocked.includes(ref.taskNumber)) blocked.push(ref.taskNumber);
  }
  return {
    version: "TaskContract/1",
    projectId,
    taskNumber: n,
    taskId: taskId(n),
    title: item.title,
    description: item.description,
    blockedOn: blocked,
    qualifiedBlockedOn: item.qualifiedBlockedOn.map((ref) => ({ ...ref })),
    sourceGates: [...item.sourceGates],
    unresolvedBlockers: item.qualifiedBlockedOn
      .filter((ref) => ref.projectId !== projectId)
      .map((ref) => ({ reason: `cross-project ${ref.projectId}#${taskId(ref.taskNumber)}` })),
    executionState: item.executionState,
    recordProvenance: item.recordProvenance,
    rigorTier: item.rigorTier,
    acceptanceCriteria: item.acceptanceCriteria.map((row) => ({ ...row })),
    scope: { allowedPaths: [...item.scope.allowedPaths], forbiddenPaths: [...item.scope.forbiddenPaths] },
    citations: [...item.citations],
    status: parsed?.status ?? "available",
  };
}

export interface AllocateHooks {
  /**
   * Highest task number already on the board — or already claimed elsewhere (a lost
   * unique-key race, core/board.ts `addBoardTasks`): the counter never moves backward,
   * so a retry skips the number whose write lost to a concurrent minter.
   */
  boardMax?: () => Promise<number>;
  /** Task numbers the live board already has. Blockers must be in this set or this store. */
  knownTasks?: () => Promise<Iterable<number>>;
  /**
   * Persist projections. Throw to leave the counter unmoved.
   * Return the same tasks with durable shard ids.
   */
  publish?: (tasks: AllocatedTask[]) => Promise<AllocatedTask[]>;
}

/**
 * Process-local Cortex allocate store. Writers on one `(tenant, profile)` share
 * one chain, so two overlapping allocates cannot take the same number.
 */
export class InMemoryTaskAllocator {
  private counters = new Map<string, number>();
  private ops = new Map<string, StoredOp>();
  private tasks = new Map<string, AllocatedTask>();

  private scopeKey(scope: AllocateScope): string {
    return `${scope.tenantId}\0${scope.profileId}`;
  }

  lastNumber(scope: AllocateScope): number {
    return this.counters.get(this.scopeKey(scope)) ?? 0;
  }

  /** Test and recovery hook. Does not allocate. Refuses a seed outside 0..999. */
  seedLast(scope: AllocateScope, last: number): void {
    if (!Number.isInteger(last) || last < 0 || last > TASK_NUMBER_MAX) {
      refuse(422, "TASK_NUMBER_OVERFLOW", "seed is outside 0..999");
    }
    this.counters.set(this.scopeKey(scope), last);
  }

  contract(scope: AllocateScope, n: number): BoardTaskContract | undefined {
    return this.tasks.get(`${this.scopeKey(scope)}\0${n}`);
  }

  contracts(scope: Pick<AllocateScope, "tenantId" | "profileId">): Map<number, BoardTaskContract> {
    const prefix = `${scope.tenantId}\0${scope.profileId}\0`;
    const out = new Map<number, BoardTaskContract>();
    for (const [key, task] of this.tasks) {
      if (!key.startsWith(prefix)) continue;
      out.set(task.taskNumber, task);
    }
    return out;
  }

  /** Keep provenance and the execution hold. Status transitions may update status only. */
  remember(scope: AllocateScope, task: AllocatedTask): void {
    const key = `${this.scopeKey(scope)}\0${task.taskNumber}`;
    const prev = this.tasks.get(key);
    const recordProvenance = prev && prev.recordProvenance !== "user_said" ? prev.recordProvenance : task.recordProvenance;
    const executionState = task.executionState;
    this.tasks.set(key, { ...task, recordProvenance, executionState });
    const last = this.counters.get(this.scopeKey(scope)) ?? 0;
    if (task.taskNumber > last) this.counters.set(this.scopeKey(scope), task.taskNumber);
  }

  async allocate(scope: AllocateScope, request: AllocateRequest, hooks: AllocateHooks = {}): Promise<CortexTaskAllocateResponse> {
    return exclusive(this.scopeKey(scope), async () => {
      if (hooks.boardMax) {
        const seen = await hooks.boardMax();
        const key = this.scopeKey(scope);
        const cur = this.counters.get(key) ?? 0;
        if (Number.isInteger(seen) && seen > cur) this.counters.set(key, seen);
      }
      const known = new Set<number>();
      if (hooks.knownTasks) {
        for (const n of await hooks.knownTasks()) known.add(n);
      }
      return this.allocateLocked(scope, request, hooks.publish, known);
    });
  }

  private async allocateLocked(
    scope: AllocateScope,
    request: AllocateRequest,
    publish: AllocateHooks["publish"],
    extraKnown: Set<number>,
  ): Promise<CortexTaskAllocateResponse> {
    if (request.schemaVersion !== undefined && request.schemaVersion !== "CortexTaskAllocateRequest/1") {
      refuse(400, "INVALID_SCHEMA", 'schemaVersion must be "CortexTaskAllocateRequest/1"');
    }
    if (typeof request.operationId !== "string" || request.operationId.trim() === "") {
      refuse(400, "INVALID_SHAPE", "operationId is required");
    }
    const operationId = request.operationId.trim();
    if (request.maxTaskNumber !== undefined && request.maxTaskNumber !== TASK_NUMBER_MAX) {
      refuse(422, "TASK_NUMBER_OVERFLOW", "maxTaskNumber must be 999");
    }
    if (!Array.isArray(request.items) || request.items.length < 1 || request.items.length > 8) {
      refuse(400, "INVALID_BATCH_SIZE", "allocate accepts 1 to 8 items");
    }
    const projectId = (request.targetProjectId ?? scope.projectId).trim();
    if (!projectId) refuse(400, "INVALID_SHAPE", "targetProjectId is required");
    const expected = request.expectedBoardRevision ?? null;
    if (expected !== null && !/^[a-f0-9]{64}$/.test(expected)) {
      refuse(400, "INVALID_SHAPE", "expectedBoardRevision must be 64 hex characters or null");
    }
    const items = request.items.map(prepareItem);
    const fingerprint = fingerprintOf(scope, projectId, expected, items, operationId);
    const opKey = `${scope.tenantId}\0${operationId}`;
    const prior = this.ops.get(opKey);
    if (prior) {
      if (prior.fingerprint !== fingerprint) {
        refuse(409, "CORTEX_IDEMPOTENCY_CONFLICT", "operationId was reused with a different payload");
      }
      return { ...prior.response, tasks: prior.response.tasks.map((task) => ({ ...task })), replayed: true };
    }
    const key = this.scopeKey(scope);
    const last = this.counters.get(key) ?? 0;
    if (last + items.length > TASK_NUMBER_MAX) {
      refuse(422, "TASK_NUMBER_OVERFLOW", "allocating this batch would pass TASK-999. Nothing was written.");
    }
    const known = new Set<number>(extraKnown);
    for (const [id, task] of this.tasks) {
      if (id.startsWith(`${key}\0`)) known.add(task.taskNumber);
    }
    if (expected !== null) {
      const rows = [...this.tasks.entries()]
        .filter(([id]) => id.startsWith(`${key}\0`))
        .map(([, task]) => ({ n: task.taskNumber, id: task.shardId, status: task.status, content: task.content }));
      const full = computeBoardRevisionFingerprint(rows);
      if (full !== expected) refuse(409, "REVISION_CONFLICT", "board revision moved. Nothing was written.");
    }
    for (const item of items) {
      for (const n of item.blockedOn) {
        if (!known.has(n)) refuse(400, "INVALID_EXISTING_DEPENDENCY", `${taskId(n)} is not on this profile board`);
      }
      for (const ref of item.qualifiedBlockedOn) {
        if (ref.projectId === projectId && !known.has(ref.taskNumber)) {
          refuse(400, "INVALID_EXISTING_DEPENDENCY", `${taskId(ref.taskNumber)} is not on this profile board`);
        }
      }
    }
    let planned: AllocatedTask[] = items.map((item, index) => {
      const n = last + 1 + index;
      const content = lineFor(n, item);
      return { ...contractFor(n, projectId, item, content), shardId: `pending_${scope.profileId}_${n}`, content };
    });
    if (publish) planned = await publish(planned);
    this.counters.set(key, last + items.length);
    for (const task of planned) this.tasks.set(`${key}\0${task.taskNumber}`, task);
    const boardRows = [...this.tasks.entries()]
      .filter(([id]) => id.startsWith(`${key}\0`))
      .map(([, task]) => ({ n: task.taskNumber, id: task.shardId, status: task.status, content: task.content }));
    const response: CortexTaskAllocateResponse = {
      schemaVersion: "CortexTaskAllocateResponse/1",
      operationId,
      targetProfileId: scope.profileId,
      targetProjectId: projectId,
      newBoardRevision: computeBoardRevisionFingerprint(boardRows),
      replayed: false,
      tasks: planned,
    };
    this.ops.set(opKey, { fingerprint, response });
    return { ...response, tasks: response.tasks.map((task) => ({ ...task })) };
  }

  async list(scope: AllocateScope, query: { projectId?: string; includeClaimableOnly?: boolean } = {}): Promise<CortexTaskListResponse> {
    const key = this.scopeKey(scope);
    const tasks = [...this.tasks.entries()]
      .filter(([id]) => id.startsWith(`${key}\0`))
      .map(([, task]) => task)
      .filter((task) => !query.projectId || task.projectId === query.projectId)
      .sort((a, b) => a.taskNumber - b.taskNumber);
    const byNumber = new Map(tasks.map((task) => [task.taskNumber, task]));
    const rows = tasks
      .map((task) => ({ task, claimable: storedClaimable(task, byNumber) }))
      .filter((row) => !query.includeClaimableOnly || row.claimable)
      .map((row) => ({ contract: row.task, shardId: row.task.shardId, content: row.task.content, claimable: row.claimable }));
    const last = this.counters.get(key) ?? 0;
    const boardRows = tasks.map((task) => ({ n: task.taskNumber, id: task.shardId, status: task.status, content: task.content }));
    return {
      schemaVersion: "CortexTaskListResponse/1",
      profileId: scope.profileId,
      projectId: query.projectId ?? tasks[0]?.projectId ?? null,
      lastTaskNumber: last,
      nextTaskNumber: last + 1,
      maxTaskNumber: 999,
      boardRevision: computeBoardRevisionFingerprint(boardRows),
      project: null,
      tasks: rows,
    };
  }

  async get(scope: AllocateScope, taskNumber: number): Promise<CortexTaskGetResponse> {
    if (!Number.isInteger(taskNumber) || taskNumber < 1 || taskNumber > TASK_NUMBER_MAX) {
      refuse(404, "TASK_NOT_FOUND", "task is not on this board");
    }
    const task = this.contract(scope, taskNumber);
    const stored = this.tasks.get(`${this.scopeKey(scope)}\0${taskNumber}`);
    if (!task || !stored) refuse(404, "TASK_NOT_FOUND", "task is not on this board");
    const listed = await this.list(scope);
    const row = listed.tasks.find((item) => item.contract.taskNumber === taskNumber);
    return {
      schemaVersion: "CortexTaskGetResponse/1",
      profileId: scope.profileId,
      taskNumber,
      contract: stored,
      shardId: stored.shardId,
      content: stored.content,
      claimable: row?.claimable ?? false,
    };
  }
}

function storedClaimable(task: AllocatedTask, board: Map<number, AllocatedTask>): boolean {
  if (task.executionState === "held") return false;
  if (task.sourceGates.length > 0) return false;
  if (task.unresolvedBlockers.length > 0) return false;
  if (task.status !== "available" && task.status !== "blocked") return false;
  for (const ref of task.qualifiedBlockedOn) {
    if (ref.projectId !== task.projectId) return false;
    if (!["done", "archive"].includes(board.get(ref.taskNumber)?.status ?? "")) return false;
  }
  for (const n of task.blockedOn) {
    if (!["done", "archive"].includes(board.get(n)?.status ?? "")) return false;
  }
  return true;
}

let shared: InMemoryTaskAllocator | undefined;

export function sharedAllocator(): InMemoryTaskAllocator {
  return shared ??= new InMemoryTaskAllocator();
}

export function resetSharedAllocator(): void {
  shared = new InMemoryTaskAllocator();
}
