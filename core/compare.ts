/**
 * Owner-only second-opinion view (`kontinuity review --compare`).
 *
 * Two lexical-overlap hints for the HUMAN OWNER deciding what to confirm:
 *
 *   1. Inferences independently staged by multiple runtimes — a prioritisation
 *      hint (several runtimes inferred it separately: look at it first). It is
 *      explicitly NOT evidence of truth: two agents repeating each other is not
 *      corroboration.
 *   2. Private notes that overlap heavily with a confirmed record — possible
 *      contradictions (or duplicates, or refinements), shown side by side so the
 *      owner can decide whether one of them needs superseding.
 *
 * Overlap here is lexical (exact content words), never semantic: nothing in this
 * module claims two records contradict each other — it only says where to look.
 * The view writes nothing and changes no ranking.
 *
 * The view must read OTHER runtimes' role-private notes, so it runs on the owner
 * identity — never on the agent identity (each runtime's unconfirmed inferences
 * stay private to it). It is owner-only: the CLI gates it behind --user-confirmed
 * and the pi extension behind the interactive review UI.
 *
 * Owner-role recall across all role grants is CONFIG, not a Cortex ask. Verified
 * against keon-cortex `tenancy/scope.py`:
 *   - `X-Keon-Grant-Scopes` is trusted carriage once the Gateway secret is
 *     authenticated (api.py `_caller_scope`), and Kontinuity holds that secret;
 *   - `effective_scopes()` keeps every supplied `role:{profile}:{role}` token
 *     (only misplaced `op:legacy` and foreign `handoff:` tokens are refused);
 *   - `is_visible()`: a `role_private` record is visible to "a caller holding
 *     the exact `role:{profile}:{role}` scope — … unless the Gateway granted
 *     that scope explicitly".
 * So the owner identity just carries one role grant per known runtime. The T-35
 * grant grammar has no wildcard (`role:*` is malformed), so roles are enumerated:
 * the configured roles, the canonical runtime names, and every runtime observed
 * in local state. If enumeration ever becomes the bottleneck, THAT would be the
 * Cortex ask (a wildcard grant or a role-listing route) — not needed today, so
 * there is nothing to file.
 */

import { CortexError, grant, type CortexTransport, type ShardDetail } from "../src/cortex.ts";
import { tolerateReplay, recordDelivery } from "./feedback.ts";
import { oneLine } from "./guard.ts";
import { agentRoleFor, stripTag, type Runtime } from "./runtime.ts";

/** A pair is a hint when it shares ≥ MIN_SHARED_TOKENS content words and ≥ OVERLAP_MIN of the smaller side. */
export const OVERLAP_MIN = 0.55;
export const MIN_SHARED_TOKENS = 3;

/** The tag tokens every Kontinuity record carries — the same collision-free briefing key the briefing uses. */
const COMPARE_QUERY = "[decision] [rejected] [open-loop] [lesson] [note] [imported]";

/** Runtimes whose roles are always part of the owner scan. Anything else is picked up from local state. */
const KNOWN_RUNTIMES = ["pi", "claude", "codex", "gemini", "grok"];

const STOPWORDS = new Set(
  "a an and are as at be been but by can could did do does for from had has have he her him his how i if in into is it its may might must my no nor not of on or our out over own same she should so than that the their them then there these they this those through to too under up very was we were what when where which while who whom why will with would you your".split(" "),
);
// Tag words describe the shape of a record, not its subject: two [decision] records are not related just because both are decisions.
const TAG_WORDS = new Set(["decision", "rejected", "open", "loop", "lesson", "note", "imported", "later", "preference", "handoff", "milestone"]);

/** Content words of a record: tag stripped, lowercased, punctuation gone, stopwords and tag words removed. */
export function contentTokens(content: string): Set<string> {
  const out = new Set<string>();
  for (const w of stripTag(content).toLowerCase().split(/[^a-z0-9]+/)) {
    if (w.length >= 2 && !STOPWORDS.has(w) && !TAG_WORDS.has(w)) out.add(w);
  }
  return out;
}

/** Overlap coefficient: shared content words over the smaller side (short-vs-long matches stay meaningful). */
export function overlapScore(a: Set<string>, b: Set<string>): { shared: number; score: number } {
  const [small, big] = a.size <= b.size ? [a, b] : [b, a];
  let shared = 0;
  for (const t of small) if (big.has(t)) shared++;
  return { shared, score: small.size === 0 ? 0 : shared / small.size };
}

export interface CompareNote {
  id: string;
  content: string;
  /** Runtime whose role staged this inference ("pi", "claude", …); "unknown" when attribution is missing. */
  runtime: string;
  at?: string;
  origin: "pending" | "cortex";
}

export interface ConfirmedRecord {
  id: string;
  content: string;
  at?: string;
  /** The private source shard this record was derived from (local state only). */
  sourceId?: string;
  origin: "local" | "cortex";
}

export interface IndependentGroup {
  runtimes: string[];
  /** Highest pairwise overlap inside the group (0–1, two decimals). */
  overlap: number;
  notes: CompareNote[];
}

export interface ContradictionPair {
  note: CompareNote;
  confirmed: ConfirmedRecord;
  overlap: number;
}

export interface CompareReport {
  disclaimer: string;
  independent: IndependentGroup[];
  contradictions: ContradictionPair[];
  notesConsidered: number;
  confirmedConsidered: number;
  /** "owner-recall+local" when the owner scan reached Cortex; "local-only" when it could not. */
  source: "owner-recall+local" | "local-only";
  degraded?: string;
  recallEventId?: string;
}

export const COMPARE_DISCLAIMER =
  "Second opinion only. Every pairing is a lexical-overlap hint about where to look first — a prioritisation hint, explicitly NOT evidence of truth and NOT a verdict. The owner decides; this view changed nothing.";

/**
 * The owner identity widened with one role grant per known runtime, so an owner
 * recall sees every role's role_private notes. Config, not a Cortex ask — see the
 * module comment. Used ONLY by this view; the agent identity is never widened.
 */
export function ownerAcrossRoles(rt: Runtime): CortexTransport {
  const roleIds = new Set<string>([rt.cfg.agentRole, rt.owner.identity.roleId]);
  for (const name of KNOWN_RUNTIMES) roleIds.add(agentRoleFor(rt.cfg, name));
  for (const p of rt.state.pending) roleIds.add(agentRoleFor(rt.cfg, p.runtime ?? "pi"));
  const grants = new Set(rt.owner.identity.grants);
  for (const r of roleIds) grants.add(grant.role(rt.profileId, r));
  return rt.agent.as({ ...rt.owner.identity, grants: [...grants] });
}

/** Which runtime staged a private shard: provenance `captured_by` first, then the role id, else unknown. */
function runtimeOf(detail: ShardDetail, piRole: string): string {
  const extra = detail.provenance?.extra ?? {};
  const captured = extra.captured_by;
  if (typeof captured === "string" && captured.trim()) return captured.trim();
  const role = extra.role_id;
  if (typeof role === "string" && role) {
    if (role === piRole) return "pi";
    if (role.startsWith("role_")) return role.slice("role_".length) || "unknown";
  }
  return "unknown";
}

/** One owner-scope recall over the record tags, split into private notes and confirmed records. */
async function ownerScan(rt: Runtime, sessionId: string): Promise<{ notes: CompareNote[]; confirmed: ConfirmedRecord[]; recallEventId: string }> {
  const owner = ownerAcrossRoles(rt);
  const rec = await owner.recall({ query: COMPARE_QUERY, kind: "recall", limit: 40, sessionId });
  const ids = rec.results.map((r) => r.shard_id);
  const details = await Promise.all(ids.map((id) => owner.getShard(id).catch(() => undefined)));
  const notes: CompareNote[] = [];
  const confirmed: ConfirmedRecord[] = [];
  for (const d of details) {
    // Superseded and archived records are history, not second opinions.
    if (!d || (d.status && d.status !== "active")) continue;
    const sc = d.provenance?.extra?.scope_class;
    const at = d.provenance?.checkpoint_at ?? d.created_at ?? undefined;
    if (sc === "role_private") notes.push({ id: d.shard_id, content: d.content, runtime: runtimeOf(d, rt.cfg.agentRole), at, origin: "cortex" });
    else if (sc === "profile_shared") confirmed.push({ id: d.shard_id, content: d.content, at, origin: "cortex" });
  }
  // Delivered to the owner: account for it like every other delivery (access is not use).
  if (ids.length > 0) {
    await tolerateReplay(() => owner.reportAccess({ sessionId, recallEventId: rec.recall_event_id, recordIds: ids }));
    recordDelivery(rt, { recallEventId: rec.recall_event_id, sessionId, ids, at: new Date().toISOString() });
  }
  return { notes, confirmed, recallEventId: rec.recall_event_id };
}

function dedupeByContent<T extends { content: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const it of items) {
    const key = it.content.trim();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(it);
  }
  return out;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Connected components of pending/private notes joined by pairwise overlap,
 * keeping only components staged by ≥ 2 DIFFERENT runtimes: two near-duplicates
 * from one runtime are not "independently staged by multiple runtimes".
 */
export function independentGroups(notes: CompareNote[]): IndependentGroup[] {
  const toks = notes.map((n) => contentTokens(n.content));
  const parent = notes.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const union = (i: number, j: number) => {
    parent[find(i)] = find(j);
  };
  for (let i = 0; i < notes.length; i++) {
    for (let j = i + 1; j < notes.length; j++) {
      const { shared, score } = overlapScore(toks[i], toks[j]);
      if (shared >= MIN_SHARED_TOKENS && score >= OVERLAP_MIN) union(i, j);
    }
  }
  const comps = new Map<number, number[]>();
  for (let i = 0; i < notes.length; i++) {
    const r = find(i);
    const list = comps.get(r) ?? [];
    list.push(i);
    comps.set(r, list);
  }
  const groups: IndependentGroup[] = [];
  for (const idx of comps.values()) {
    const members = idx.map((i) => notes[i]);
    const runtimes = [...new Set(members.map((m) => m.runtime))];
    if (runtimes.length < 2) continue;
    let max = 0;
    for (let a = 0; a < idx.length; a++) {
      for (let b = a + 1; b < idx.length; b++) max = Math.max(max, overlapScore(toks[idx[a]], toks[idx[b]]).score);
    }
    groups.push({ runtimes: runtimes.sort(), overlap: round2(max), notes: members });
  }
  return groups.sort((a, b) => b.runtimes.length - a.runtimes.length || b.overlap - a.overlap);
}

/** Private notes overlapping a confirmed record heavily enough to be worth reading side by side. */
export function contradictionPairs(notes: CompareNote[], confirmed: ConfirmedRecord[]): ContradictionPair[] {
  const out: ContradictionPair[] = [];
  for (const n of notes) {
    const a = contentTokens(n.content);
    for (const c of confirmed) {
      if (c.sourceId === n.id) continue; // this note was already promoted into that record
      const { shared, score } = overlapScore(a, contentTokens(c.content));
      if (shared >= MIN_SHARED_TOKENS && score >= OVERLAP_MIN) out.push({ note: n, confirmed: c, overlap: round2(score) });
    }
  }
  return out.sort((x, y) => y.overlap - x.overlap);
}

/**
 * Note ids the owner already resolved out of review — the drop ledger (`kontinuity drop`,
 * an offerings dismissal, or either Second Opinion resolution). A resolved note never
 * reappears in a report: its private shard stays in Cortex and the owner scan would
 * otherwise re-pair it as a fresh second opinion on every run.
 */
export function resolvedOutNotes(state: { dropped?: { shardId: string }[] }): Set<string> {
  return new Set((state.dropped ?? []).map((d) => d.shardId));
}

/**
 * Note ids already promoted into a shared record — the note-level form of the pair rule
 * below ("this note was already promoted into that record") and of resync's
 * "promoted source(s) not re-offered": a promoted note is not a second opinion, its
 * confirmed record IS its answer. Superseded history counts too — the private source of a
 * replaced record must not re-pair with its own replacement after a supersede.
 */
export function promotedNoteIds(state: { shared: { sourceId: string }[] }): Set<string> {
  return new Set(state.shared.map((s) => s.sourceId).filter((id) => id.length > 0));
}

/**
 * Build the second-opinion report: an owner scan across all role grants plus the
 * local review queue. If Cortex is unreachable the view degrades to the local
 * queue and says so — it never pretends the scan happened.
 *
 * Notes already resolved out of review are skipped first (resolvedOutNotes): either
 * Second Opinion resolution — keep the shared one (drop the note) or supersede the
 * shared one with the note — spends the note, so the entry never reappears. Promoted
 * notes are skipped for the same reason (promotedNoteIds).
 */
export async function buildCompare(rt: Runtime, sessionId: string): Promise<CompareReport> {
  const resolvedOut = resolvedOutNotes(rt.state);
  const promoted = promotedNoteIds(rt.state);
  const localNotes: CompareNote[] = rt.state.pending.map((p) => ({ id: p.shardId, content: p.content, runtime: p.runtime ?? "pi", at: p.createdAt, origin: "pending" }));
  const localConfirmed: ConfirmedRecord[] = rt.state.shared.filter((s) => !s.supersededBy).map((s) => ({ id: s.derivedId, content: s.content, at: s.approvedAt, sourceId: s.sourceId, origin: "local" }));

  let remoteNotes: CompareNote[] = [];
  let remoteConfirmed: ConfirmedRecord[] = [];
  let recallEventId: string | undefined;
  let degraded: string | undefined;
  try {
    const scan = await ownerScan(rt, sessionId);
    remoteNotes = scan.notes;
    remoteConfirmed = scan.confirmed;
    recallEventId = scan.recallEventId;
  } catch (e) {
    const why = e instanceof CortexError ? `Cortex ${e.status}` : e instanceof Error ? e.message : String(e);
    degraded = `owner scan could not reach Cortex (${why}); compared the LOCAL review queue only — private notes held only in Cortex are not included`;
  }

  // One entry per exact content; the local review queue wins because it carries the runtime
  // attribution. A resolved note is gone for good — from the queue AND from the owner scan —
  // and a promoted note is not a second opinion at all.
  const notes = dedupeByContent([...localNotes, ...remoteNotes]).filter((n) => !resolvedOut.has(n.id) && !promoted.has(n.id));
  const confirmed = dedupeByContent([...localConfirmed, ...remoteConfirmed]);
  return {
    disclaimer: COMPARE_DISCLAIMER,
    independent: independentGroups(notes),
    contradictions: contradictionPairs(notes, confirmed),
    notesConsidered: notes.length,
    confirmedConsidered: confirmed.length,
    source: degraded ? "local-only" : "owner-recall+local",
    degraded,
    recallEventId,
  };
}

const shortId = (id: string) => id.slice(0, 12);

export function formatCompare(r: CompareReport): string {
  const lines: string[] = ["## Kontinuity review --compare — owner view (second opinion)", r.disclaimer, ""];
  if (r.degraded) lines.push(`NOTE: ${oneLine(r.degraded)}.`, "");

  if (r.independent.length === 0 && r.contradictions.length === 0) {
    lines.push(`No second opinion: nothing was inferred by more than one runtime, and no private note overlaps a confirmed record.`);
    return lines.join("\n");
  }

  lines.push(`### Inferences independently staged by multiple runtimes — prioritisation hint, NOT evidence of truth`);
  if (r.independent.length === 0) lines.push(`(none)`);
  for (const g of r.independent) {
    lines.push(`- inferred independently by ${g.runtimes.join(" + ")} (overlap ${g.overlap}) — worth a look first; that is ALL it means:`);
    for (const n of g.notes) lines.push(`    ${n.runtime}  ${n.at ? `${n.at.slice(0, 10)}  ` : ""}${oneLine(n.content, 160)}  id=${shortId(n.id)}`);
  }

  lines.push(``, `### Private notes vs confirmed records — possible contradictions; read side by side`);
  if (r.contradictions.length === 0) lines.push(`(none)`);
  for (const p of r.contradictions) {
    lines.push(`- overlap ${p.overlap} — may contradict, duplicate, or refine the confirmed record; lexical overlap is not a verdict:`);
    lines.push(`    private   (${p.note.runtime}${p.note.at ? `, ${p.note.at.slice(0, 10)}` : ""}): ${oneLine(p.note.content, 160)}  id=${shortId(p.note.id)}`);
    lines.push(`    confirmed (${p.confirmed.at ? p.confirmed.at.slice(0, 10) : "date ?"}): ${oneLine(p.confirmed.content, 160)}  id=${shortId(p.confirmed.id)}`);
    lines.push(`    if the confirmed record is wrong: continuity supersede ${shortId(p.confirmed.id)} "<new text>" --user-confirmed`);
  }

  lines.push(
    ``,
    `${r.notesConsidered} private note(s) · ${r.confirmedConsidered} confirmed record(s) · source: ${r.source === "local-only" ? "local review queue only" : "owner recall across role grants + local review queue"} · nothing here changed any record.`,
  );
  return lines.join("\n");
}
