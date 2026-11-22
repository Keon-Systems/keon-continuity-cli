/**
 * Capture at compaction: turn an agent transcript that is about to be summarised away into
 * bounded, private-review items.
 *
 * Two callers, one contract:
 *   - Claude Code PreCompact hook → `continuity capture` (this module): hooks have no model,
 *     so the capture is deterministic — verbatim user/assistant messages become `[imported]`
 *     items, exactly like a vendor conversation import.
 *   - pi compaction event → the extension extracts with its model instead (extension/extract.ts).
 *
 * Pure: the same transcript always yields the same items, so outbox retries stay byte-identical
 * (a different checkpointAt on the same content is a 409, not a dedupe — see core/outbox.ts).
 */

import { MAX_MESSAGE_CHARS, MIN_MESSAGE_CHARS, importedContent } from "./imports.ts";

export interface TranscriptMessage {
  speaker: "user" | "assistant";
  text: string;
  /** Event time from the transcript entry. Messages without one are skipped, never invented. */
  occurredAt: string;
}

export interface CaptureItem {
  content: string;
  occurredAt: string;
}

/** One capture run stages at most this many messages; the rest wait for the next run. */
export const CAPTURE_MAX_MESSAGES = 40;

/** A Claude Code hook event (PreCompact) as it arrives on the hook's stdin. */
export interface HookInput {
  transcriptPath: string;
  sessionId?: string;
  trigger?: string;
}

/** Recognise a Claude Code hook event: `{ "session_id": …, "transcript_path": …, "trigger": … }`. */
export function parseHookInput(raw: string): HookInput | undefined {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  const rec = v as Record<string, unknown>;
  const transcriptPath = typeof rec.transcript_path === "string" && rec.transcript_path.trim() ? rec.transcript_path.trim() : undefined;
  if (!transcriptPath) return undefined;
  return {
    transcriptPath,
    sessionId: typeof rec.session_id === "string" && rec.session_id.trim() ? rec.session_id.trim() : undefined,
    trigger: typeof rec.trigger === "string" && rec.trigger.trim() ? rec.trigger.trim() : undefined,
  };
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b) => {
      const r = asRecord(b);
      return r?.type === "text" && typeof r.text === "string" ? r.text : "";
    })
    .filter(Boolean)
    .join("\n");
}

function isoOf(v: unknown): string | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return new Date(v * 1000).toISOString(); // unix seconds
  if (typeof v === "string" && v.trim()) {
    const d = new Date(v);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  return undefined;
}

/** Claude Code transcript JSONL → user/assistant text messages, oldest first. */
export function parseTranscript(raw: string): TranscriptMessage[] {
  const out: TranscriptMessage[] = [];
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    let e: Record<string, unknown> | undefined;
    try {
      e = asRecord(JSON.parse(t));
    } catch {
      continue;
    }
    if (!e) continue;
    const speaker = e.type === "user" ? "user" : e.type === "assistant" ? "assistant" : undefined;
    if (!speaker) continue; // summary, system, tool scaffolding
    if (e.isMeta === true) continue;
    const m = asRecord(e.message);
    if (!m || m.role !== speaker) continue;
    const text = textOf(m.content).replace(/\s+/g, " ").trim();
    if (text.length < MIN_MESSAGE_CHARS) continue; // trivia
    // Slash-command plumbing, not conversation.
    if (/^<(?:command-|local-command-)/.test(text)) continue;
    const occurredAt = isoOf(e.timestamp);
    if (!occurredAt) continue;
    out.push({ speaker, text: text.slice(0, MAX_MESSAGE_CHARS), occurredAt });
  }
  return out;
}

/**
 * Messages → `[imported] <speaker>: <text>` items (same shape as a vendor conversation import:
 * verbatim content brought in without inference, each keeping its own event time).
 */
export function captureItems(messages: TranscriptMessage[]): CaptureItem[] {
  return messages.slice(0, CAPTURE_MAX_MESSAGES).map((m) => ({
    content: importedContent({ speaker: m.speaker, text: m.text, occurredAt: m.occurredAt }),
    occurredAt: m.occurredAt,
  }));
}
