/**
 * Process-wide board read cache. Keyed by tenant, role, profile and grants so
 * two identities never share a snapshot. Not authority: `loadBoard` still hits
 * Cortex and writes drop the key. A write bumps the key's generation, so no read
 * joins or stores a load that started before it.
 *
 * Display readers (the deck workers timer, Concierge, the pi board command)
 * pass a max age. Decision reads pass `fresh`: they never return a snapshot, and
 * they join an in-flight fresh load at the current generation or start their own.
 */
import type { Board } from "./board.ts";
import type { Runtime } from "./runtime.ts";
import { createPayloadCache } from "./read-cache.ts";

const cache = createPayloadCache<Board>();

/** How long a display read may reuse a snapshot. A poll or a write does not use this. */
export const BOARD_READ_TTL_MS = 60_000;

export function boardReadKey(rt: Runtime): string {
  const id = rt.agent.identity;
  // Fixture runtimes sometimes omit grants. A missing list is an empty grant set,
  // not a crash, and it still does not collide with a different role or profile.
  const grants = Array.isArray(id.grants) ? [...id.grants].sort().join(",") : "";
  return [rt.cfg.tenantId, id.roleId, id.profileId ?? "", rt.profileId, grants].join("\0");
}

export function invalidateBoardReads(key?: string): void {
  cache.invalidate(key);
}

export function readCachedBoard(key: string, fresh: boolean, load: () => Promise<Board>, maxAgeMs?: number): Promise<Board> {
  return cache.get(key, fresh, load, maxAgeMs);
}
