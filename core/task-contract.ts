// Adapted from Keon Kontinuity for the standalone CLI.
/**
 * TaskContract/1 — canonical imported task, plus the board projection legacy readers already parse.
 *
 * The contract is the source of truth for acceptance, scope, provenance, and the execution
 * hold. The projection is one `[open-loop] TASK-nn` line so `parseTask` keeps working.
 * While `executionState` is `held`, that line carries a USER gate. Legacy claim/idle readers
 * already refuse USER, and they cannot tell that gate apart from a source-declared one — the
 * contract field `sourceGates` is the distinction. Nothing in this module clears the hold:
 * activation is a separate operation and is not implemented here.
 *
 * Task numbers stay inside 1..999. A wider id would be dropped by the legacy `\d{1,3}` parser.
 * @Cortex is the transactional allocator (docs/doc-ingest-architecture.md); the helpers here
 * are the fail-closed width gate a caller must pass before any number is published.
 */

import { addedContent, isClaimable, isCompleted, parseTask, type Task, type WaitingOn } from "./board.ts";
import type { BoardTaskContract } from "./task-allocator.ts";
import {
  allocateDestinationNumbers,
  IngestRefusal,
  materializeContracts,
  type IdMapping,
  type ImportPlanV1,
  type ProjectV1,
  type TaskContractV1,
} from "../shared/ingest.ts";

export {
  allocateDestinationNumbers,
  assertTaskNumberWidth,
  parseTaskNumberToken,
  TASK_NUMBER_MAX,
  TASK_NUMBER_MIN,
} from "../shared/ingest.ts";
export type { IdMapping, TaskContractV1 } from "../shared/ingest.ts";

export interface CommitProjection {
  contracts: TaskContractV1[];
  projections: string[];
  tasks: Task[];
  mappings: IdMapping[];
}

/**
 * Board line for a contract. Held imports always project a USER gate so a pre-contract
 * reader cannot claim them. Source USER/EXT gates are included as well and stay listed
 * separately on the contract.
 */
export function renderContract(contract: TaskContractV1): string {
  const waiting: WaitingOn[] = [];
  if (contract.executionState === "held" || contract.unresolvedBlockers.length > 0) waiting.push("user");
  for (const gate of contract.sourceGates) {
    if (!waiting.includes(gate)) waiting.push(gate);
  }
  const text = contract.description.length > 0 ? `${contract.title}: ${contract.description}` : contract.title;
  return addedContent(contract.taskNumber, {
    text,
    ...(contract.size ? { size: contract.size } : {}),
    ...(contract.next ? { next: contract.next } : {}),
    ...(contract.blockedOn.length > 0 ? { blockedOn: contract.blockedOn } : {}),
    ...(waiting.length > 0 ? { waitingOn: waiting } : {}),
  });
}

/** Text records stay readable without a contract. The contract is not embedded in the line. */
export function readBoardRecord(content: string): { task: Task; contract: null } | undefined {
  const task = parseTask(content);
  return task ? { task, contract: null } : undefined;
}

/** The projection and the contract name the same task, the same blockers, and the hold. */
export function projectionAgrees(contract: TaskContractV1, task: Task): boolean {
  if (task.n !== contract.taskNumber) return false;
  if (!task.text.startsWith(contract.title)) return false;
  if (contract.executionState === "held" && !task.waitingOn.includes("user")) return false;
  if (task.blockedOn.length !== contract.blockedOn.length) return false;
  if (contract.blockedOn.some((n, i) => task.blockedOn[i] !== n)) return false;
  for (const gate of contract.sourceGates) {
    if (!task.waitingOn.includes(gate)) return false;
  }
  return true;
}

/**
 * Fields a claim reader needs. `TaskContract/1` and the allocator's stored contract
 * both satisfy this. Legacy lines pass null.
 */
export interface ClaimContract {
  executionState?: "held" | "open" | "active";
  unresolvedBlockers?: readonly { clientKey?: string; reason?: string }[];
  effectiveRigor?: "T0" | "T1" | "T2";
  rigorTier?: "T0" | "T1" | "T2";
  projectId?: string;
  blockedOn?: readonly number[];
  qualifiedBlockedOn?: readonly { projectId: string; taskNumber: number }[];
  existingTaskRefs?: readonly { projectId: string; taskNumber: number }[];
  sourceGates?: readonly ("user" | "external")[];
  recordProvenance?: string;
}

/**
 * Claim-path seam (TASK-130): the `TaskContract/1` for one composite task identity —
 * project + task number — or null for a legacy task with no contract. Every claim path
 * (`claimTask`, task spawn, the idle-daemon picker, the deck claim routes, `/ci` and
 * `/sa`) resolves the contract through a reader and lets `importClaimable` decide; the
 * projected board line alone never makes a task claimable.
 *
 * Fail closed: when a contract exists for the task number, a reader returns it even if
 * the caller's project is unknown or differs. The hold is cleared by activation — never
 * by a key miss. For a store keyed by the pair, a pair miss falls back to the number and
 * the held record wins a conflict: a naive strict pair lookup is fail-open here and
 * re-opens the bypass this seam exists to close.
 */
export interface ContractReader {
  taskContract(projectId: string | undefined, taskNumber: number): BoardTaskContract | null;
}

/**
 * Reader over the process-local contract table (task number → `TaskContract/1`) — the
 * allocator's store view. Task numbers are unique per profile in that store, so the
 * lookup falls back to the number and fails closed, as the seam requires.
 */
export function mapContractReader(contracts: ReadonlyMap<number, BoardTaskContract>): ContractReader {
  return {
    taskContract(_projectId, taskNumber) {
      return contracts.get(taskNumber) ?? null;
    },
  };
}

/**
 * Claim predicate for a contract-aware reader. A hold, a T2 tier, an unresolved
 * plan-batch or cross-project blocker, a source gate, or an unfinished dependency
 * refuses even if the projected line were AVAILABLE. A null contract is a legacy
 * record: the board rule stands unchanged.
 */
export function importClaimable(contract: ClaimContract | null, task: Task, tasks: ReadonlyMap<number, Task>): boolean {
  if (contract?.executionState === "held") return false;
  if (contract?.effectiveRigor === "T2" || contract?.rigorTier === "T2") return false;
  if (contract?.unresolvedBlockers && contract.unresolvedBlockers.length > 0) return false;
  if (contract?.sourceGates && contract.sourceGates.length > 0) return false;
  const projectId = contract?.projectId;
  const refs = [...(contract?.existingTaskRefs ?? []), ...(contract?.qualifiedBlockedOn ?? [])];
  for (const ref of refs) {
    if (projectId && ref.projectId !== projectId) return false;
    if (!isCompleted(tasks.get(ref.taskNumber))) return false;
  }
  if (contract?.blockedOn?.some((n) => !isCompleted(tasks.get(n)))) return false;
  return isClaimable(task, tasks as Map<number, Task>);
}

export function previewCommit(
  plan: ImportPlanV1,
  selectedKeys: readonly string[],
  project: ProjectV1,
  firstTaskNumber: number,
): { projection?: CommitProjection; refusals: IngestRefusal[] } {
  const count = plan.drafts.filter((draft) => selectedKeys.includes(draft.clientKey)).length;
  let numbers: number[] = [];
  try {
    numbers = plan.outcome === "summary" && selectedKeys.length === 0 ? [] : allocateDestinationNumbers(firstTaskNumber, count);
  } catch (error) {
    if (error instanceof IngestRefusal) return { refusals: [error] };
    throw error;
  }
  const materialized = materializeContracts(plan, selectedKeys, project, numbers);
  if (materialized.refusals.length > 0) return { refusals: materialized.refusals };
  const projections = materialized.contracts.map(renderContract);
  const tasks: Task[] = [];
  for (const content of projections) {
    const task = parseTask(content);
    if (!task) return { refusals: [new IngestRefusal("invalid_shape", "board projection was not readable by parseTask")] };
    tasks.push(task);
  }
  return {
    projection: { contracts: materialized.contracts, projections, tasks, mappings: materialized.mappings },
    refusals: [],
  };
}

export function projectCommit(
  plan: ImportPlanV1,
  selectedKeys: readonly string[],
  project: ProjectV1,
  firstTaskNumber: number,
): CommitProjection {
  const result = previewCommit(plan, selectedKeys, project, firstTaskNumber);
  if (!result.projection) throw result.refusals[0] ?? new IngestRefusal("invalid_shape", "commit produced no projection");
  return result.projection;
}
