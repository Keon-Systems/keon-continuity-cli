// Adapted from Keon Kontinuity. Keeps the briefing timeline reconstruction.
/** The only label an as-of view may carry. Never "everything you knew". */
export const AS_OF_LABEL = "what your records show" as const;

/** One record on the timeline. Structurally satisfied by BriefingShard and GraphNode. */
export interface AsOfRecord {
  id: string;
  content: string;
  /** Event time (checkpointAt — when the record says this happened). */
  occurredAt?: string;
  /** Status now: "superseded"/"archived" mean gone NOW — the record alone does not say when. */
  status: string;
}

/** A supersede Kontinuity recorded: `toId` replaced this record and became current at `at`. */
export interface SupersedeLink {
  toId: string;
  at: string;
}

/** Supersede history, keyed by the replaced record's id. */
export type SupersedeHistory = Map<string, SupersedeLink>;

export interface AsOfView {
  /** Existed at the date and not superseded then — this is what was current. */
  current: AsOfRecord[];
  /** Superseded at or before the date: history then, not advice. */
  history: AsOfRecord[];
  /** Gone now, but the records do not say when the supersede happened — cannot be placed at the date. */
  unplaced: AsOfRecord[];
  /** Event time after the date: did not exist yet. */
  future: AsOfRecord[];
}

const MAX_CHAIN_HOPS = 8;
const isGoneStatus = (s: string): boolean => s === "superseded" || s === "archived";

/**
 * The named date is inclusive: "as of 2026-11-01" covers the whole day, so the instant the
 * view is rebuilt at is the END of that day (same rule as `briefing --as-of`).
 */
export function asOfInstant(date: string): string {
  return new Date(Date.parse(`${date}T23:59:59.999Z`)).toISOString();
}

/**
 * Supersede history from local state (core/memory.ts `supersede()`): a replacement's
 * `approvedAt` is the moment its version became current — exactly when the version it
 * replaced stopped being current. A link whose replacement is unknown is left out; the
 * replaced record then cannot be placed and is reported as `unplaced`, never guessed.
 */
export function supersedeHistoryOf(shared: { derivedId: string; approvedAt: string; supersededBy?: string }[]): SupersedeHistory {
  const history: SupersedeHistory = new Map();
  for (const s of shared) {
    if (!s.supersededBy) continue;
    const to = shared.find((x) => x.derivedId === s.supersededBy);
    if (!to) continue;
    history.set(s.derivedId, { toId: to.derivedId, at: to.approvedAt });
  }
  return history;
}

/**
 * The as-of reconstruction itself: pure, same input → same view. For every record that
 * existed at `asOf` (event time ≤ the date), follow the supersede chain forward while the
 * supersedes happened at or before the date; the record the walk lands on is the version
 * that was current then. A record that is gone NOW but whose supersede no record dates is
 * `unplaced` — the view says so instead of guessing (see the label).
 */
export function asOfView(records: AsOfRecord[], history: SupersedeHistory, asOf: string): AsOfView {
  const at = Date.parse(asOf);
  const byId = new Map(records.map((r) => [r.id, r]));
  const view: AsOfView = { current: [], history: [], unplaced: [], future: [] };
  const judged = new Set<string>();
  const place = (r: AsOfRecord, bucket: keyof AsOfView) => {
    if (judged.has(r.id)) return;
    judged.add(r.id);
    view[bucket].push(r);
  };
  for (const r of records) {
    if (judged.has(r.id)) continue;
    const t = Date.parse(r.occurredAt ?? "");
    if (!Number.isNaN(t) && t > at) {
      place(r, "future");
      continue;
    }
    // Walk forward through supersedes that had already happened at the date.
    let node = r;
    let incomplete = false;
    for (let hop = 0; ; hop++) {
      const link = history.get(node.id);
      if (!link) break;
      const lt = Date.parse(link.at);
      if (Number.isNaN(lt)) {
        incomplete = true; // a supersede with no date cannot be placed on either side of the date
        break;
      }
      if (lt > at) break; // the supersede had not happened yet at the date: `node` was still current
      const next = byId.get(link.toId);
      if (!next || hop >= MAX_CHAIN_HOPS) {
        incomplete = true; // the replacement is not in these records: the chain cannot be placed
        break;
      }
      node = next;
    }
    if (incomplete) place(r, "unplaced");
    else if (node.id !== r.id) place(r, "history"); // superseded at or before the date
    else if (isGoneStatus(r.status) && !history.has(r.id)) place(r, "unplaced"); // gone now, supersede date unknown
    else place(r, "current");
  }
  return view;
}
