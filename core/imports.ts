/**
 * Vendor chat-export parsing for the web-chat bridge.
 *
 * A web chat (claude.ai / ChatGPT / Gemini) cannot run the CLI and cannot reach Cortex, so the
 * round trip is: `kontinuity briefing --clipboard` into the web chat, converse, then export the
 * vendor's data and import it here. Each message becomes one `[imported]` item whose own timestamp
 * is the event time (→ provenance.checkpointAt), so history keeps its dates. Nothing is shared:
 * imports land private + pending for user review, exactly like `stage`.
 *
 * The parsers are pure: same file in, same messages out (order and timestamps included), which is
 * what makes retries byte-identical — a different checkpointAt on the same content is a 409, not
 * a dedupe. Shapes mirror real exports:
 *   - chatgpt-export: OpenAI's `conversations.json` (array of conversations with a `mapping` tree
 *     of messages; `create_time` is unix seconds, `content.parts` holds the text).
 *   - claude-export: claude.ai's `conversations.json` (array of conversations with `chat_messages`;
 *     `created_at` is ISO-8601 with microseconds, `text` holds the message).
 * Both parsers accept a single conversation object too (the per-conversation export).
 */

export type VendorKind = "chatgpt-export" | "claude-export";
/** `import --from vendor-memory`: the pasted output of a vendor's "what do you remember about me". */
export type ImportKind = VendorKind | "vendor-memory";

export interface ImportedMessage {
  /** Conversation title, when the export has one. */
  title?: string;
  /** "user" or "assistant" — who wrote the message in the web chat. */
  speaker: "user" | "assistant";
  text: string;
  /** Per-message event time (ISO-8601, milliseconds). Becomes the checkpointAt. */
  occurredAt: string;
}

export const VENDOR_KINDS: VendorKind[] = ["chatgpt-export", "claude-export"];
export const VENDOR_MEMORY = "vendor-memory";
export const IMPORT_KINDS: ImportKind[] = [...VENDOR_KINDS, VENDOR_MEMORY];

/** Messages are authored units (unlike document paragraphs), so the bounds differ from chunkDocument. */
export const MIN_MESSAGE_CHARS = 20;
export const MAX_MESSAGE_CHARS = 2_000;
/** A whole vendor export can be huge; bound one import run so the outbox is never flooded. */
export const IMPORT_MAX_MESSAGES = 200;

export function isVendorKind(v: string): v is VendorKind {
  return (VENDOR_KINDS as string[]).includes(v);
}

export function isImportKind(v: string): v is ImportKind {
  return (IMPORT_KINDS as string[]).includes(v);
}

export function parseVendorExport(kind: VendorKind, raw: string): ImportedMessage[] {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error("not valid JSON");
  }
  return kind === "chatgpt-export" ? parseChatGptExport(data) : parseClaudeExport(data);
}

/** `[imported] <title> · <speaker>: <text>` — the label is what recall and the briefing key on. */
export function importedContent(m: ImportedMessage): string {
  return `[imported] ${m.title ? `${m.title} · ` : ""}${m.speaker}: ${m.text}`;
}

/** Collapse whitespace, enforce the size bounds. Returns "" when the message is not worth a shard. */
function normalizeMessage(text: unknown): string {
  if (typeof text !== "string") return "";
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length < MIN_MESSAGE_CHARS) return "";
  return flat.slice(0, MAX_MESSAGE_CHARS);
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

function conversationsOf(data: unknown, looksLikeConversation: (c: unknown) => boolean): Record<string, unknown>[] {
  const arr = Array.isArray(data) ? data : asRecord(data)?.conversations;
  if (Array.isArray(arr)) {
    const convos = arr.map(asRecord).filter((c): c is Record<string, unknown> => Boolean(c) && looksLikeConversation(c));
    if (arr.length > 0 && convos.length === 0) throw new Error("expected an array of conversations in the vendor export shape");
    return convos;
  }
  if (looksLikeConversation(data)) return [asRecord(data)!];
  throw new Error("expected an array of conversations in the vendor export shape");
}

function isoOrThrow(v: unknown, fallback?: unknown): string | undefined {
  for (const t of [v, fallback]) {
    if (typeof t === "number" && Number.isFinite(t)) return new Date(t * 1000).toISOString(); // unix seconds
    if (typeof t === "string" && t.trim()) {
      const d = new Date(t); // V8 truncates sub-millisecond ISO fractions (…:05.123456Z → …:05.123Z)
      if (!Number.isNaN(d.getTime())) return d.toISOString();
    }
  }
  return undefined;
}

/** OpenAI `conversations.json`: walk each conversation's `mapping` tree, keep user/assistant text. */
export function parseChatGptExport(data: unknown): ImportedMessage[] {
  const out: ImportedMessage[] = [];
  for (const convo of conversationsOf(data, (c) => Boolean(asRecord(c)?.mapping))) {
    const title = typeof convo.title === "string" && convo.title.trim() ? convo.title.trim() : undefined;
    const messages: ImportedMessage[] = [];
    const mapping = asRecord(convo.mapping) ?? {};
    for (const node of Object.values(mapping)) {
      const message = asRecord(asRecord(node)?.message);
      if (!message) continue;
      const role = asRecord(message.author)?.role;
      const speaker = role === "user" ? "user" : role === "assistant" ? "assistant" : undefined;
      if (!speaker) continue; // system, tool, hidden scaffolding
      const content = asRecord(message.content);
      if (content?.content_type !== "text") continue;
      const parts = Array.isArray(content.parts) ? content.parts : [];
      const text = normalizeMessage(parts.filter((p): p is string => typeof p === "string").join("\n"));
      if (!text) continue;
      const occurredAt = isoOrThrow(message.create_time, convo.create_time ?? convo.update_time);
      if (!occurredAt) continue;
      messages.push({ title, speaker, text, occurredAt });
    }
    out.push(...sortByTime(messages));
  }
  return out;
}

/** claude.ai `conversations.json`: flat `chat_messages` per conversation; `sender` human|assistant. */
export function parseClaudeExport(data: unknown): ImportedMessage[] {
  const out: ImportedMessage[] = [];
  for (const convo of conversationsOf(data, (c) => Array.isArray(asRecord(c)?.chat_messages))) {
    const title = typeof convo.name === "string" && convo.name.trim() ? convo.name.trim() : undefined;
    const messages: ImportedMessage[] = [];
    for (const msg of convo.chat_messages as unknown[]) {
      const m = asRecord(msg);
      if (!m) continue;
      const speaker = m.sender === "human" ? "user" : m.sender === "assistant" ? "assistant" : undefined;
      if (!speaker) continue;
      const text = normalizeMessage(m.text ?? m.content);
      if (!text) continue;
      const occurredAt = isoOrThrow(m.created_at, convo.created_at);
      if (!occurredAt) continue;
      messages.push({ title, speaker, text, occurredAt });
    }
    out.push(...sortByTime(messages));
  }
  return out;
}

/** Chronological per conversation; equal timestamps keep export order (stable sort). */
function sortByTime(messages: ImportedMessage[]): ImportedMessage[] {
  return [...messages].sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
}

// ---------- vendor-memory: "what do you remember about me" ----------

/**
 * A vendor's memory dump (ChatGPT saved memories, a claude.ai memory summary, …) is one claim per
 * line or bullet. Each becomes one `[imported]` preference CANDIDATE — never a preference: the
 * vendor's claim is data about the user, and only the user can confirm it into the proj_me profile.
 * Pure, like the export parsers: same paste in, same candidates out (retries stay byte-identical).
 */
export const MIN_MEMORY_CHARS = 10;
export const MAX_MEMORY_CHARS = 600;
export const MAX_MEMORY_CANDIDATES = 100;

const BULLET_MARKER = /^\s*(?:[-*•–—]|\d{1,3}[.)])\s+/;
const MARKDOWN_HEADING = /^#{1,6}\s+\S/;

/** `[imported] <statement>` — the label is what recall and the review queue key on. */
export function candidateContent(statement: string): string {
  return `[imported] ${statement}`;
}

export function parseVendorMemory(raw: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const line of raw.replace(/\r\n?/g, "\n").split("\n")) {
    const text = line.replace(BULLET_MARKER, "").replace(/\s+/g, " ").trim();
    // The echoed prompt, section headers and blank scaffolding are not memories:
    // "What do you remember about me?", "Here is what I know:", "## Saved memories".
    if (!text || MARKDOWN_HEADING.test(text) || /[?:]$/.test(text)) continue;
    const statement = text.slice(0, MAX_MEMORY_CHARS);
    if (statement.length < MIN_MEMORY_CHARS || seen.has(statement)) continue;
    seen.add(statement);
    out.push(statement);
    if (out.length >= MAX_MEMORY_CANDIDATES) break;
  }
  return out;
}
