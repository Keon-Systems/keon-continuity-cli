/**
 * Memory items: the extraction contract shared by every runtime.
 *   - pi: the extension calls a model with EXTRACTION_PROMPT and parses the reply.
 *   - other harnesses: the agent IS the model; the skill tells it to produce this JSON
 *     itself and hand it to `continuity stage`.
 */

import type { Tag } from "./runtime.ts";

export interface ExtractedItem {
  tag: Tag;
  text: string;
  why?: string;
  /** Model flagged uncertainty → default unchecked in the confirm UI. */
  unsure?: boolean;
  /**
   * 3-5 recall keywords the model attached to this item. Stored as `kw:` tokens at the
   * end of the content line (see itemContent) so lexical recall hits without embeddings.
   */
  keywords?: string[];
}

export const EXTRACTION_PROMPT = `You extract durable project memory from a coding-agent transcript.

Return ONLY a JSON object, no prose, no code fences:
{
  "decisions":  [{"text": "...", "why": "...", "unsure": false, "keywords": ["...", "...", "..."]}],
  "rejected":   [{"text": "...", "why": "...", "unsure": false, "keywords": ["...", "...", "..."]}],
  "open_loops": [{"text": "...", "why": "blocked on / next step", "unsure": false, "keywords": ["...", "...", "..."]}],
  "lessons":    [{"text": "...", "why": "...", "unsure": false, "keywords": ["...", "...", "..."]}]
}

Rules:
- Only include things actually present in the transcript. Never invent.
- Prefer "the user said X" over "the user wants X". If you are inferring a goal or preference, set "unsure": true.
- decisions: choices that were made and will matter next session (architecture, naming, process, scope).
- rejected: options considered and turned down, WITH the reason — the most valuable thing a future agent can know is what not to re-suggest.
- open_loops: unfinished work, blocked items, promises ("I'll do X after Y").
- lessons: non-obvious facts learned about this codebase/tooling that would save time later.
- Each "text" is one sentence, ≤ 200 characters, self-contained (no "this"/"that" referring outside itself).
- Skip trivia, greetings, and anything already obvious from the code.
- keywords: 3-5 per item — the single words a future agent would type to find this item. Include
  words the sentence does not use ("database" for "Use Postgres, not Mongo"). Lowercase letters,
  digits and hyphens only, no spaces, no punctuation, short single words: each becomes a
  "kw:"-prefixed exact-match recall token in the stored record.
- If a category has nothing, return an empty array. Up to 8 items per category.`;

export function parseItems(raw: string): ExtractedItem[] {
  const cleaned = raw.replace(/^```(?:json)?\s*/m, "").replace(/```\s*$/m, "").trim();
  const first = cleaned.indexOf("{");
  const last = cleaned.lastIndexOf("}");
  if (first < 0 || last < 0) return [];
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(cleaned.slice(first, last + 1)) as Record<string, unknown>;
  } catch {
    return [];
  }
  const out: ExtractedItem[] = [];
  const take = (key: string, tag: Tag) => {
    const arr = obj[key];
    if (!Array.isArray(arr)) return;
    for (const it of arr.slice(0, 8)) {
      if (!it || typeof it !== "object") continue;
      const text = String((it as { text?: unknown }).text ?? "").trim();
      if (!text) continue;
      const why = (it as { why?: unknown }).why;
      out.push({ tag, text: text.slice(0, 240), why: typeof why === "string" && why.trim() ? why.trim().slice(0, 240) : undefined, unsure: Boolean((it as { unsure?: unknown }).unsure), keywords: cleanKeywords((it as { keywords?: unknown }).keywords) });
    }
  };
  take("decisions", "decision");
  take("rejected", "rejected");
  take("open_loops", "open-loop");
  take("lessons", "lesson");
  // Idle Insights proposals (core/offering.ts): staged by the dream worker, reviewed by the user.
  take("offerings", "offering");
  return out;
}

/**
 * Normalise raw model keywords into exact-match recall tokens: Cortex recall scores exact
 * whitespace-delimited tokens (lowercase split), so a keyword must be one lowercase word with
 * no punctuation attached — "Postgres!" would never match "postgres". A multi-word entry is
 * split into its words; a stray "kw:" prefix the model copied from this contract is stripped,
 * not doubled. 2-15 chars: longest tag + text + why + 5 keywords then fits the 600-char
 * one-line budget (see oneLine / the retained fixture test).
 */
export function cleanKeywords(raw: unknown, max = 5): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const k of raw) {
    for (const piece of String(k ?? "").toLowerCase().split(/\s+/)) {
      const s = piece.replace(/^kw:/, "").replace(/[^a-z0-9-]+/g, "").replace(/^-+|-+$/g, "");
      if (s.length < 2 || s.length > 15) continue;
      if (!out.includes(s)) out.push(s);
      if (out.length >= max) break;
    }
    if (out.length >= max) break;
  }
  return out;
}

/**
 * Render an item as the single-line content Cortex stores. Keywords are appended as 3-5
 * "kw:" tokens — reliable exact tokens like "[decision]", so a query of "kw:postgres" finds
 * this item even when its sentence used a different word.
 */
export function itemContent(it: ExtractedItem): string {
  const why = it.why && it.tag !== "lesson" ? ` — ${it.tag === "rejected" ? "why" : it.tag === "open-loop" ? "next" : "why"}: ${it.why}` : "";
  const kw = cleanKeywords(it.keywords);
  return `[${it.tag}] ${it.text}${why}${kw.length ? ` ${kw.map((k) => `kw:${k}`).join(" ")}` : ""}`;
}
