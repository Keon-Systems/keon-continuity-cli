/** Presentation-only task fields, carried in the SAME superseded board record.
 * Source specifications and TaskContract/1 remain immutable through this surface.
 * The suffix is inert JSON, never a task/status/authority grammar.
 */
import { sha256Text } from "./ingest.ts";

export interface BoardDisplayFields {
  title: string;
  notes: string;
}
export const BOARD_TITLE_MAX = 200;
export const BOARD_NOTES_MAX = 4000;
/** Supplied only from a server-read, curation-linked capture, NEVER from task text. */
export interface BoardDisplayMetadata { footerHash: string }
export interface BoardDisplaySource {
  revision: string;
  kind: "user_said" | "user_confirmed" | "imported" | "agent_inferred" | null;
}
const MARKER = "\n[board-display/1] ";
const TRANSITION = / \[transition:transition_[a-f0-9]{40}\]$/;

export function boardDisplayError(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "Editable fields must be an object.";
  const fields = value as Record<string, unknown>;
  if (Object.keys(fields).some((k) => k !== "title" && k !== "notes")) return "Only display title and planning notes are editable.";
  if (typeof fields.title !== "string" || !fields.title.trim() || fields.title.length > BOARD_TITLE_MAX) return `Display title is required (1–${BOARD_TITLE_MAX} characters).`;
  if (/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(fields.title)) return "Display title must be a single line without control characters.";
  if (typeof fields.notes !== "string" || fields.notes.length > BOARD_NOTES_MAX) return `Planning notes must be at most ${BOARD_NOTES_MAX} characters.`;
  if (/[\p{Cf}\p{Zl}\p{Zp}]|[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(fields.notes)) return "Planning notes contain unsupported control characters.";
  return null;
}

/** Without independent record metadata even a perfectly shaped footer is SOURCE.
 * Only generated records may shed the generated footer/transition, never legacy literals.
 */
export function splitBoardDisplay(content: string, metadata?: BoardDisplayMetadata): { source: string; fields?: BoardDisplayFields; provenance?: BoardDisplaySource } {
  if (!metadata) return { source: content };
  const withoutTransition = content.replace(TRANSITION, "");
  const at = withoutTransition.lastIndexOf(MARKER);
  if (at < 0 || sha256Text(withoutTransition.slice(at)) !== metadata.footerHash) return { source: content };
  try {
    const envelope = JSON.parse(withoutTransition.slice(at + MARKER.length));
    if (!envelope || Object.keys(envelope).sort().join(",") !== "fields,provenance" || boardDisplayError(envelope.fields) !== null) return { source: content };
    const p = envelope.provenance;
    if (!p || Object.keys(p).sort().join(",") !== "kind,revision" || typeof p.revision !== "string" || !p.revision || p.revision.length > 256 || ![null, "user_said", "user_confirmed", "imported", "agent_inferred"].includes(p.kind)) return { source: content };
    return { source: withoutTransition.slice(0, at), fields: envelope.fields, provenance: p };
  } catch {
    return { source: content };
  }
}

export function boardDisplayFooter(fields: BoardDisplayFields, provenance: BoardDisplaySource): string {
  const error = boardDisplayError(fields);
  if (error) throw new Error(error);
  return MARKER + JSON.stringify({ fields, provenance });
}

/** Source has ALREADY been resolved against independent metadata; never parse it here. */
export function withBoardDisplay(source: string, fields: BoardDisplayFields, provenance: BoardDisplaySource): string {
  return source + boardDisplayFooter(fields, provenance);
}

export function boardDisplayMetadata(fields: BoardDisplayFields, provenance: BoardDisplaySource): BoardDisplayMetadata {
  return { footerHash: sha256Text(boardDisplayFooter(fields, provenance)) };
}
