/**
 * Publish a file by renaming a temp in the same directory over the destination.
 *
 * On Windows, `rename` of an existing file fails with EPERM, EACCES, or EBUSY while
 * another process has the destination open — a reader such as `kontinuity deck` or
 * `kontinuity mcp`, or antivirus and the search indexer. The failure is transient.
 * graceful-fs retries those three codes, yielding between attempts so the locker can
 * finish (isaacs/node-graceful-fs `polyfills.js`, the win32 `fs.rename` patch). That
 * patch waits up to 60 seconds and only retries when the destination is absent, which
 * does not cover rename-over of a file another process already has open. This helper
 * retries the replace itself, ten attempts over about one second, then gives up.
 *
 * The replace stays a rename, so readers never observe a partial file. On a final
 * failure the temp is removed and the destination is left as it was.
 *
 * Callers that share one temp name across processes (the per-project state file uses
 * `<path>.tmp`) must already serialize writers. `saveState` holds its lock across this
 * whole retry. Writers that mint a unique temp (pid, uuid) do not share that name.
 *
 * This file lives in deck/shared because the public share-host image copies `deck/` and
 * not `src/`. `deck/server/share-store.ts` is bundled into that image, so its replace
 * helper has to resolve inside `deck/`.
 */

import * as fs from "node:fs";

/** Attempts including the first try. Ten tries, then the rename error propagates. */
export const RENAME_ATTEMPTS = 10;

/**
 * Sleep before each retry (attempts 2..10). The waits sum to 1000ms: a short increasing
 * backoff, the same shape graceful-fs uses, scaled to this budget instead of a minute.
 */
export const RENAME_RETRY_DELAYS_MS: readonly number[] = [25, 50, 75, 100, 125, 125, 150, 150, 200];

const RETRYABLE = new Set(["EPERM", "EACCES", "EBUSY"]);

export interface RenameIo {
  rename(from: string, to: string): void;
  unlink(path: string): void;
  sleep(ms: number): void;
}

function syncSleep(ms: number): void {
  if (ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Production bindings. Tests replace methods here, or pass their own `RenameIo`. */
export const renameIo: RenameIo = {
  rename: (from, to) => fs.renameSync(from, to),
  unlink: (path) => fs.unlinkSync(path),
  sleep: syncSleep,
};

function errno(e: unknown): string | undefined {
  if (typeof e !== "object" || e === null || !("code" in e)) return undefined;
  const code = (e as { code: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function discardTemp(io: RenameIo, path: string): void {
  try {
    io.unlink(path);
  } catch (e) {
    if (errno(e) === "ENOENT") return;
    // The rename error is the one the caller must see. A temp left behind is the same
    // residue as a crash between write and rename; the next successful publish replaces it.
  }
}

/**
 * Rename `from` onto `to`, replacing `to` when it exists. Retries EPERM, EACCES, and
 * EBUSY. Any other error fails immediately. The temp is removed if the rename does not
 * succeed; it is not removed after a successful rename (it is the destination then).
 */
export function renameReplacing(from: string, to: string, io: RenameIo = renameIo): void {
  for (let attempt = 0; attempt < RENAME_ATTEMPTS; attempt++) {
    try {
      io.rename(from, to);
      return;
    } catch (e) {
      const retry = RETRYABLE.has(errno(e) ?? "") && attempt < RENAME_ATTEMPTS - 1;
      if (!retry) {
        discardTemp(io, from);
        throw e;
      }
      io.sleep(RENAME_RETRY_DELAYS_MS[attempt] ?? 0);
    }
  }
}
