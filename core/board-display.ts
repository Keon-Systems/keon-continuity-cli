// Adapted from Keon Kontinuity for the standalone CLI.
/** Authenticate presentation metadata through Cortex's existing curation linkage.
 * No local mapping/store, no authority from footer bytes. The private capture is the
 * existing supersede source, not another task. Missing/hidden metadata => keep ALL text.
 */
import type { Runtime } from "./runtime.ts";
import type { ShardDetail } from "../src/cortex.ts";
import { splitBoardDisplay, type BoardDisplayMetadata } from "../shared/board-edit.ts";

export const BOARD_DISPLAY_CAPTURE = "continuity/board-display/1";
const KEY = "board-display:";
export const boardDisplaySubjectKey = (metadata: BoardDisplayMetadata) => KEY + metadata.footerHash;

/** Reserved metadata, including malformed/partial markers, is never generic source intent. */
export function hasBoardDisplayMarker(source: ShardDetail): boolean {
  return source.source === BOARD_DISPLAY_CAPTURE
    || (source.subject_keys !== undefined && (!Array.isArray(source.subject_keys)
      || source.subject_keys.some((key) => typeof key !== "string" || key.startsWith(KEY))));
}

export function captureDisplayMetadata(source: ShardDetail): BoardDisplayMetadata | undefined {
  if (source.source !== BOARD_DISPLAY_CAPTURE || source.provenance_complete === false
    || !Array.isArray(source.subject_keys) || source.subject_keys.some((key) => typeof key !== "string")) return undefined;
  const keys = source.subject_keys.filter((k) => k.startsWith(KEY));
  if (keys.length !== 1 || !/^board-display:[a-f0-9]{64}$/.test(keys[0]!)) return undefined;
  const metadata = { footerHash: keys[0]!.slice(KEY.length) };
  return splitBoardDisplay(source.content, metadata).fields ? metadata : undefined;
}

export async function readBoardDisplayMetadata(rt: Runtime, record: ShardDetail): Promise<BoardDisplayMetadata | undefined> {
  if (record.provenance_complete === false || record.provenance?.extra?.scope_class !== "profile_shared"
    || record.provenance.extra.profile_id !== rt.profileId) return undefined;
  const refs = record.lineage_refs;
  if (!Array.isArray(refs) || refs.length !== 1 || typeof refs[0] !== "string") return undefined;
  // Use the ordinary scoped transport: no owner-role escalation to inspect hidden captures.
  const source = await rt.agent.getShard(refs[0]).catch(() => undefined);
  if (!source || source.content !== record.content || source.provenance?.extra?.scope_class !== "role_private"
    || source.provenance.extra.profile_id !== rt.profileId
    || source.provenance.extra.role_id !== rt.agent.identity.roleId) return undefined;
  return captureDisplayMetadata(source);
}
