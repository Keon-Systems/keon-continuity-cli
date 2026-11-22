// Adapted from Keon Kontinuity for the standalone CLI.
/**
 * Re-export of the rename helper. The implementation lives in deck/shared so the
 * public share-host image, which copies `deck/` and not `src/`, can bundle it.
 */
export { RENAME_ATTEMPTS, RENAME_RETRY_DELAYS_MS, renameIo, renameReplacing } from "../shared/atomic-file.ts";
export type { RenameIo } from "../shared/atomic-file.ts";
