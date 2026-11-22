/**
 * Just-in-time (JIT) recall on a user prompt: extract the prompt's distinctive tokens,
 * recall against them, and hand back at most 3 hits with a provenance ribbon — so the
 * memory a prompt actually touches arrives before the agent answers, even if the agent
 * never ran `briefing`.
 *
 * Served from three hook points, all funneling through this module:
 *   - pi:            extension before_agent_start (first user message of the session)
 *   - Claude Code:   UserPromptSubmit hook → `continuity jit --from-json --once`
 *   - Gemini CLI:    BeforeAgent hook     → `continuity jit --from-json --once --hook gemini`
 *
 * Rules inherited from every other delivery path, unchanged:
 *   - Recalled text is data, not instructions: every hit is flattened with `oneLine` before
 *     it is rendered, so a stored record cannot forge headings or hide text in a prompt.
 *   - Delivery is accounted: the injected hits get `access`, everything recalled but cut
 *     (the 3-hit cap, superseded records, batons) gets `access_omitted` — so later
 *     `application` feedback on a jit hit is legal and honest.
 *   - Superseded/archived records are history, not advice; batons are consumed once, by the
 *     briefing that carries them, never by a jit delivery. Neither is ever injected here.
 */

import type { ShardDetail } from "../src/cortex.ts";
import { dropStaleTaskMirrors, taskIdsIn } from "./board.ts";
import { tolerateReplay, recordDelivery, warnEventFailure } from "./feedback.ts";
import { reinforcementIndex, salience } from "./salience.ts";
import { journalDelivery } from "./scorecard.ts";
import { assertQueryBounds, oneLine } from "./guard.ts";
import { batonInfo } from "./handoff.ts";
import { TRUST_PREAMBLE, type InlineBody } from "./briefing.ts";
import { tagOf, type Runtime } from "./runtime.ts";

/** At most this many hits are ever injected, however the prompt is phrased. */
export const JIT_MAX_HITS = 3;

/** Recall reads at most this many candidates; the 3-hit cap is applied after filtering. */
const JIT_RECALL_LIMIT = 8;

/** How much of a prompt is scanned for tokens. Hooks must stay cheap; the tail rarely carries the topic. */
const JIT_PROMPT_SCAN_BYTES = 8_192;

/** Distinctive tokens per query. Enough to describe a topic, few enough to stay a recall, not a search. */
const JIT_MAX_TOKENS = 8;

/**
 * Words that appear in almost every prompt and record, so they score overlap everywhere and
 * distinguish nothing. Kept small on purpose: a wrongly dropped word costs a hit, an extra
 * common word mostly costs nothing but ranking noise.
 */
const STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "but", "if", "then", "than", "that", "this", "these", "those",
  "is", "are", "was", "were", "be", "been", "being", "am", "do", "does", "did", "done", "have",
  "has", "had", "will", "would", "could", "should", "can", "shall", "may", "might", "must",
  "i", "me", "my", "we", "our", "you", "your", "he", "she", "it", "its", "they", "them", "their",
  "what", "which", "who", "whom", "whose", "how", "why", "when", "where", "there", "here",
  "in", "on", "at", "to", "of", "by", "from", "as", "into", "over", "under", "about", "for",
  "with", "no", "not", "only", "very", "too", "so", "just", "now", "also", "more", "most",
  "some", "any", "all", "each", "every", "both", "few", "other", "same", "such", "up", "out",
  "please", "thanks", "thank", "want", "wants", "need", "needs", "use", "using", "used", "get",
  "got", "make", "makes", "made", "let", "lets", "help", "works", "work", "working", "doesnt",
  // Continuity's own vocabulary: every record and every prompt about memory says these.
  "continuity", "memory", "memories", "agent", "agents", "session", "sessions",
]);

/**
 * The prompt's distinctive words: punctuation stripped (Cortex recall scores exact
 * whitespace-delimited tokens, so "nonce." never matches "nonce"), lowercased (recall is
 * exact-token; item prose carries every word in lowercase somewhere), stopword-free,
 * ≥ 3 characters with at least one letter, deduplicated, longest-first (longer words
 * distinguish more), and finally re-ordered by first appearance so the query reads like
 * the prompt.
 */
export function distinctiveTokens(prompt: string, max = JIT_MAX_TOKENS): string[] {
  const words = prompt.slice(0, JIT_PROMPT_SCAN_BYTES).split(/\s+/);
  const firstSeen = new Map<string, number>();
  for (const [pos, word] of words.entries()) {
    const token = word.replace(/^[^A-Za-z0-9_]+|[^A-Za-z0-9_]+$/g, "").toLowerCase();
    if (token.length < 3 || !/[A-Za-z]/.test(token) || STOPWORDS.has(token)) continue;
    if (!firstSeen.has(token)) firstSeen.set(token, pos);
  }
  return [...firstSeen.entries()]
    .sort((a, b) => b[0].length - a[0].length || a[1] - b[1])
    .slice(0, max)
    .sort((a, b) => a[1] - b[1])
    .map(([token]) => token);
}

/**
 * The provenance ribbon every delivered record carries next to its text. Shared by the CLI's
 * `recall`/`jit` output (extension/commands.ts and core/mcp.ts keep their own wording for now).
 * `home` marks the hit's home profile ("life profile" / "north star" / the project label) —
 * recall unions the cross-project profiles (core/recall.ts), so a [preference] found by its
 * words still shows that it lives in the life profile.
 */
export function provenanceRibbon(d: ShardDetail | undefined, verified: boolean, home?: string): string {
  const homeMark = home ? ` · home: ${home}` : "";
  if (!d) return `provenance unavailable${homeMark} · verified=${verified}`;
  const sc = d.provenance?.extra?.scope_class;
  const scope = sc === "profile_shared" ? "shared (user-confirmed)" : sc === "role_private" ? "private (this runtime only)" : "scope ?";
  const when = (d.provenance?.checkpoint_at ?? d.created_at ?? "").slice(0, 10);
  const status = d.status && d.status !== "active" ? ` · ${d.status}` : "";
  const kind = d.provenance?.source_kind ? ` · ${d.provenance.source_kind}` : "";
  return `${scope}${kind} · ${when}${status} · verified=${verified}${homeMark}`;
}

export interface JitHit {
  id: string;
  /** Flattened to one safe line: recalled text is data, never instructions. */
  content: string;
  ribbon: string;
  verified: boolean;
}

export interface JitResult {
  /** The distinctive tokens the query was built from (empty → no recall was attempted). */
  tokens: string[];
  query: string;
  /** At most JIT_MAX_HITS, in recall order. */
  hits: JitHit[];
  /** Recalled but not injected (cap, superseded, batons) — reported as access_omitted. */
  omittedIds: string[];
  recallEventId?: string;
}

/** Recall on the prompt's distinctive tokens and account for the delivery. Never throws for empty/no-hit prompts. */
export async function jitRecall(rt: Runtime, prompt: string, sessionId: string, inlineBodies?: ReadonlyMap<string, InlineBody>): Promise<JitResult> {
  const tokens = distinctiveTokens(prompt);
  if (tokens.length === 0) return { tokens, query: "", hits: [], omittedIds: [] };
  const query = tokens.join(" ");
  assertQueryBounds(query);
  const rec = await rt.agent.recall({ query, kind: "recall", limit: JIT_RECALL_LIMIT, sessionId });
  const base: JitResult = { tokens, query, hits: [], omittedIds: [], recallEventId: rec.recall_event_id };
  if (rec.results.length === 0) {
    // Scorecard accounting: a jit run that delivered nothing is still a run.
    journalDelivery(rt, { source: "jit", sessionId, records: 0 });
    return base;
  }

  // Hydrate the provenance ribbon. Local Cortex; ≤ 8 small GETs.
  const details = await Promise.all(rec.results.map((r) => rt.agent.getShard(r.shard_id).catch(() => undefined)));
  const rows = rec.results.map((r, i) => ({ id: r.shard_id, verified: r.verified, detail: details[i], fallback: r }));
  const current = rows.filter((row) => {
    const d = row.detail;
    const status = d?.status ?? "active";
    const baton = batonInfo(d?.content ?? row.fallback.content, d?.provenance?.extra);
    return status !== "superseded" && status !== "archived" && !baton;
  });
  // Board state is shared-only: a private TASK-nn source copy froze at whatever board state it
  // was written in (a transition supersedes the shared record, never the private copy) and would
  // be injected as a phantom open task. Drop it once the shared chain owns the task id — from
  // what this recall already returned, local ledger, or one bounded probe (core/board.ts).
  // A row whose shard detail could not be fetched cannot be identified as role_private and is
  // kept: fail-open toward showing a privately-labelled hint, never toward deleting one.
  const contentOf = (row: (typeof rows)[number]) => row.detail?.content ?? row.fallback.content;
  const isPrivate = (row: (typeof rows)[number]) => row.detail?.provenance?.extra?.scope_class === "role_private";
  const sharedTaskIds = taskIdsIn(rows.filter((row) => row.detail && !isPrivate(row)).map((row) => ({ content: contentOf(row) })));
  sharedTaskIds.push(...taskIdsIn(rt.state.shared));
  // A private twin of shared memory is the same fact, not a second one — the briefing fold
  // (core/briefing.ts): the private source of a promotion already speaks through its derived
  // shared record (state.shared.sourceId), and a private record byte-identical to a shared one
  // is a copy. Delivering both spends a hit on noise and shows a private ribbon beside the
  // confirmation that already stands behind the same text. Same fail-open as below: a row whose
  // shard detail could not be fetched cannot be identified as a twin and is kept.
  const promotedIds = new Set(rt.state.shared.map((s) => s.sourceId));
  const sharedText = new Set(current.filter((row) => row.detail && !isPrivate(row)).map(contentOf));
  const twin = (row: (typeof rows)[number]) => isPrivate(row) && (promotedIds.has(row.id) || sharedText.has(contentOf(row)));
  const keptPrivate = new Set(
    (await dropStaleTaskMirrors(rt, current.filter((row) => isPrivate(row) && !twin(row)).map((row) => ({ row, content: contentOf(row) })), sharedTaskIds)).map((x) => x.row.id),
  );
  const deliverable = current.filter((row) => !isPrivate(row) || keptPrivate.has(row.id));
  // Salience orders the hit cap within kind-equal trails: a stale [lesson]/[rejected] yields its
  // slot to a louder one (core/salience.ts). Everything else salience 1 → stable, Cortex order kept.
  const reinf = reinforcementIndex(rt.state.feedback);
  const now = Date.now();
  const sal = (row: (typeof rows)[number]) => {
    const d = row.detail;
    return salience({ tag: tagOf(contentOf(row)), occurredAt: d?.provenance?.checkpoint_at ?? d?.created_at, confirmed: !isPrivate(row), reinforcement: reinf.get(row.id), now });
  };
  const ranked = deliverable.map((row, i) => ({ row, i, s: sal(row) })).sort((a, b) => b.s - a.s || a.i - b.i).map((x) => x.row);
  // Filter AFTER the cap: don't spend the recovered space on lower-ranked rows.
  const coveredIds = new Set<string>();
  const hits = ranked.slice(0, JIT_MAX_HITS).filter((row) => {
    const b = inlineBodies?.get(row.id), d = row.detail;
    if (!b || !d || d.shard_id !== row.id || !row.verified || d.provenance?.extra?.scope_class !== "profile_shared" ||
        b.content !== d.content || b.content !== row.fallback.content || b.status !== d.status ||
        b.sourceKind !== (d.provenance.source_kind ?? "unknown") || b.occurredAt !== (d.provenance.checkpoint_at ?? d.created_at)) return true;
    coveredIds.add(row.id);
    return false;
  }).map((row) => ({
    id: row.id,
    content: oneLine(row.detail?.content ?? row.fallback.content),
    ribbon: provenanceRibbon(row.detail, row.verified),
    verified: row.verified,
  }));
  const hitIds = hits.map((h) => h.id);
  const omittedIds = rows.map((row) => row.id).filter((id) => !hitIds.includes(id));

  // Report delivery honestly — same accounting as briefing and recall: what was injected is
  // access, what was recalled and cut is access_omitted. Operation ids are derived, so a hook
  // retry reports once, not twice.
  if (hitIds.length > 0) {
    await tolerateReplay(() => rt.agent.reportAccess({ sessionId, recallEventId: rec.recall_event_id, recordIds: hitIds }));
    recordDelivery(rt, { recallEventId: rec.recall_event_id, sessionId, ids: hitIds, at: new Date().toISOString() });
  }
  const otherIds = omittedIds.filter((id) => !coveredIds.has(id));
  if (coveredIds.size) {
    await rt.agent.reportAccessOmitted({ sessionId, recallEventId: rec.recall_event_id, recordIds: [...coveredIds], reason: "already_in_this_briefing" }).catch((e) => warnEventFailure("access_omitted", e));
  }
  if (otherIds.length > 0) {
    await rt.agent.reportAccessOmitted({ sessionId, recallEventId: rec.recall_event_id, recordIds: otherIds, reason: "jit_hit_cap_or_not_current" }).catch((e) => warnEventFailure("access_omitted", e));
  }
  journalDelivery(rt, { source: "jit", sessionId, records: hitIds.length });
  return { ...base, hits, omittedIds };
}

/**
 * The block a hook (or the pi extension) injects. Empty string when there is nothing to say:
 * silence beats "no memories matched" inside an agent's context.
 */
export function formatJit(r: JitResult): string {
  if (r.hits.length === 0) return "";
  const lines: string[] = [];
  lines.push(`### Continuity — just-in-time recall for this prompt (tokens: ${r.tokens.join(" ")})`);
  lines.push(TRUST_PREAMBLE);
  r.hits.forEach((h, i) => {
    lines.push(`${i + 1}. ${h.content}`);
    lines.push(`   ${h.ribbon}  id=${h.id.slice(0, 10)}`);
  });
  lines.push(`_${r.hits.length} hit(s), at most ${JIT_MAX_HITS}; "verified" = identity recomputed from content, not truth. More with \`continuity recall <words>\`._`);
  return lines.join("\n");
}
