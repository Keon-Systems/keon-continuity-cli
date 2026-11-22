/**
 * Pheromone salience (TASK-146; docs/salience.md): how loudly a [lesson]/[rejected] trail
 * speaks. DERIVED at read time from the record's own age plus the local feedback ledger — never
 * a stored field, never a schema change, never a deletion. A trail that keeps proving useful
 * (applied / successful outcome / cited) reinforces; a stale one evaporates from the *ordering*
 * that decides what survives a cut. It stays recallable, superseding keeps history, and an
 * exact-token tripwire match is never silenced by low salience.
 */

import type { FeedbackNote } from "./state.ts";

/** Only failure/miss trails are graded; every other kind keeps its existing order (salience 1). */
export const SALIENCE_TAGS: ReadonlySet<string> = new Set(["lesson", "rejected"]);

export const BASE_HALF_LIFE_DAYS = 60;
/** Reinforcement stretches the half-life by 1 + points, capped so no trail becomes immortal-loud. */
export const MAX_REINFORCEMENT = 4;
/** Evaporation never reaches zero: the floor keeps an old trail findable, only quieter. */
export const SALIENCE_FLOOR = 0.1;
/** Confidence of an inferred (unconfirmed) trail relative to a user-confirmed one. */
export const INFERRED_CONFIDENCE = 0.6;

const DAY_MS = 86_400_000;

export interface Reinforcement {
  /** Weighted useful-signals: application 1, successful outcome 1, citation 0.25. */
  points: number;
  /** When the trail last proved useful (ms epoch), if ever. */
  lastAt?: number;
}

const WEIGHT: Record<string, (n: FeedbackNote) => number> = {
  application: () => 1,
  outcome: (n) => (n.status === "success" ? 1 : 0), // access is not usefulness; a failed/unknown outcome is not reinforcement
  consideration: () => 0.25, // cited is not applied (core/feedback.ts)
  non_applicability: () => 0,
};

/** Reinforcement per memory id from the feedback ledger. Pure. */
export function reinforcementIndex(feedback: readonly FeedbackNote[] | undefined): Map<string, Reinforcement> {
  const out = new Map<string, Reinforcement>();
  for (const n of feedback ?? []) {
    const w = WEIGHT[n.kind]?.(n) ?? 0;
    if (w <= 0) continue;
    const at = Date.parse(n.at);
    const cur = out.get(n.memoryId) ?? { points: 0 };
    cur.points += w;
    if (Number.isFinite(at) && (cur.lastAt === undefined || at > cur.lastAt)) cur.lastAt = at;
    out.set(n.memoryId, cur);
  }
  return out;
}

export interface SalienceInput {
  tag: string;
  /** Event time of the record (ISO); unknown → treated as fresh (fail loud, not quiet). */
  occurredAt?: string;
  /** True for user-confirmed/shared records. */
  confirmed: boolean;
  reinforcement?: Reinforcement;
  now?: number;
}

/**
 * salience = confidence × (floor + (1 − floor) × 0.5^(age / halfLife)), in (0, 1].
 * age runs from the later of the record's date and its last reinforcement; halfLife grows with
 * reinforcement points. Non-trail tags return 1 so they are never reordered.
 */
export function salience(i: SalienceInput): number {
  if (!SALIENCE_TAGS.has(i.tag)) return 1;
  const now = i.now ?? Date.now();
  const born = Date.parse(i.occurredAt ?? "");
  const last = Math.max(Number.isFinite(born) ? born : now, i.reinforcement?.lastAt ?? 0);
  const ageDays = Math.max(0, (now - last) / DAY_MS);
  const halfLife = BASE_HALF_LIFE_DAYS * (1 + Math.min(MAX_REINFORCEMENT, i.reinforcement?.points ?? 0));
  const decay = Math.pow(0.5, ageDays / halfLife);
  const confidence = i.confirmed ? 1 : INFERRED_CONFIDENCE;
  return confidence * (SALIENCE_FLOOR + (1 - SALIENCE_FLOOR) * decay);
}
