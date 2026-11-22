/**
 * Input guards shared by every write path (CLI, pi extension, harvest scripts).
 *
 *   - No credentials in memory. A match refuses the write and names the RULE, never the value.
 *   - Size bounds match Cortex's served path (content ≤ 32,768 bytes; query ≤ 4,096 bytes), so
 *     oversize input fails here with a clear message instead of as an opaque server error.
 *   - Recalled memory is data, not instructions: before it is rendered into a prompt it is
 *     flattened to one line with control and bidi characters removed, so a stored record cannot
 *     forge headings, fake briefing sections or hide text.
 *
 * Heuristic by design. It catches the common shapes (tokens, keys, private keys, bearer headers,
 * `name=value` credentials); it is a seatbelt, not a DLP product. Review what you stage.
 */

export const MAX_CONTENT_BYTES = 32_768;
export const MAX_QUERY_BYTES = 4_096;

export class GuardError extends Error {
  readonly rule: string;
  constructor(rule: string, message: string) {
    super(message);
    this.name = "GuardError";
    this.rule = rule;
  }
}

interface SecretRule {
  name: string;
  re: RegExp;
}

const RULES: SecretRule[] = [
  { name: "private-key-block", re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/ },
  { name: "keon-api-key", re: /\bkeon_[a-z]+_[A-Za-z0-9]{4,}_[A-Za-z0-9_-]{16,}/ },
  { name: "github-token", re: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})/ },
  { name: "aws-access-key-id", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { name: "slack-token", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/ },
  { name: "llm-api-key", re: /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{24,}/ },
  { name: "jwt", re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
  { name: "bearer-credential", re: /\bBearer\s+[A-Za-z0-9._~+/=-]{24,}/i },
  { name: "connection-string-key", re: /\b(?:AccountKey|SharedAccessKey|Password)=[^;\s]{12,}/i },
  { name: "named-secret-assignment", re: /\b(?:api[_-]?key|secret|token|passwd|password|service[_-]?secret|client[_-]?secret)\b["']?\s*[:=]\s*["']?[A-Za-z0-9/+_.=-]{16,}/i },
  { name: "cortex-secret-header", re: /X-Keon-Cortex-Secret\s*[:=]\s*\S{8,}/i },
];

/** Returns the name of the first matching rule, or undefined. Never returns or logs the matched text. */
export function findSecret(text: string): string | undefined {
  for (const r of RULES) if (r.re.test(text)) return r.name;
  return undefined;
}

/** Refuse content that looks like a credential. */
export function assertNoSecret(text: string, what = "content"): void {
  const rule = findSecret(text);
  if (rule) {
    throw new GuardError(
      rule,
      `refused: ${what} looks like it contains a credential (rule: ${rule}). Memory never stores secrets — remove it and say where it lives instead (a file path or vault name), then retry.`,
    );
  }
}

export function assertContentBounds(content: string): void {
  const bytes = Buffer.byteLength(content, "utf8");
  if (content.trim().length === 0) throw new GuardError("empty", "refused: content is empty");
  if (content.includes("\u0000")) throw new GuardError("nul", "refused: content contains a NUL byte");
  if (bytes > MAX_CONTENT_BYTES) throw new GuardError("too-large", `refused: content is ${bytes} bytes; the limit is ${MAX_CONTENT_BYTES}. Split it or summarize it.`);
}

export function assertQueryBounds(query: string): void {
  const bytes = Buffer.byteLength(query, "utf8");
  if (bytes > MAX_QUERY_BYTES) throw new GuardError("query-too-large", `refused: query is ${bytes} bytes; the limit is ${MAX_QUERY_BYTES}`);
}

/** Everything a write must satisfy before it leaves the process or lands in the outbox. */
export function assertWritable(content: string): void {
  assertContentBounds(content);
  assertNoSecret(content);
}

// C0/C1 controls (keeping nothing: newlines become spaces below), zero-width and bidi override/isolate marks.
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g;

/** Flatten recalled text to a single safe line for rendering into an agent prompt. */
export function oneLine(text: string, max = 600): string {
  const flat = text.replace(/[\r\n\u2028\u2029]+/g, " ").replace(CONTROL_RE, "").replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * The same control/bidi stripping as `oneLine`, but keeping newlines (normalised to \n):
 * for showing full recalled content in a plain `<pre>` (the Deck's Inspector,
 * deck-architecture.md §6). Never render the result as HTML or Markdown.
 */
// eslint-disable-next-line no-control-regex
const CONTROL_KEEP_NEWLINE = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g;

export function stripControls(text: string): string {
  return text.replace(/\r\n?/g, "\n").replace(CONTROL_KEEP_NEWLINE, "");
}

/**
 * A throwable reduced to display text without coercion garbage: an Error keeps its message,
 * a string stays itself, anything else is JSON — never "[object Object]".
 */
export function describeError(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  try {
    return JSON.stringify(e) ?? "unknown error";
  } catch {
    return "unknown error";
  }
}
