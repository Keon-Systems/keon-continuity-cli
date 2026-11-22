/**
 * `continuity resync` — rebuild the local mirror (core/state.ts) from Cortex after it was
 * lost, corrupted, or clobbered (the 2026-11-02 whole-file-save bug made this a trust
 * question, not polish: the mirror must be repairable from the source of truth).
 *
 * The mirror is a cache of what Cortex already holds, so a resync reads Cortex and rewrites
 * the local rows. It is a BOUNDED read (the internal `search` search, no delivery semantics —
 * a repair must never report access events), and every bound is surfaced: when any query is
 * capped (TASK-37's `truncated` flag) the resync never prunes — a capped search cannot prove
 * a row is gone, and deleting on incomplete evidence is exactly the clobber this command
 * exists to repair.
 *
 * What is authoritative, and what is not:
 *   - Existence and liveness come from Cortex (`status`): a row search cannot find is pruned
 *     only when the search was complete for that row's tag; a `superseded`/`archived` row is
 *     history, and its successor id is kept from local knowledge when known. Cortex does not
 *     expose successor ids (the lineage limit core/delta.ts documents), so an unknown
 *     successor is stamped `SUPERSEDED_UNKNOWN` — history that can never read as live.
 *   - Local-only review state is NOT in Cortex and is preserved: rows deliberately dropped
 *     from review (`continuity drop`, the `dropped` ledger) stay dropped — the private shard
 *     still exists in Cortex, and a resync must not resurrect what the user already handled.
 *     Promoted private sources (share/supersede write-trail) are identified by content —
 *     Cortex derives shard identity from content+scope, so a private shard whose content
 *     equals a shared record is that record's write trail, not a review item.
 *   - Rows another runtime owns (its role-private shards are invisible to this identity) are
 *     never touched; run `resync` from that runtime to rebuild its half.
 */

import { type SearchShard } from "../src/cortex.ts";
import { isBatonContent } from "./handoff.ts";
import { SUPERSEDED_UNKNOWN, writeStamp, type DroppedItem, type PendingItem, type SharedItem } from "./state.ts";
import { TAGS, tagOf, type Runtime } from "./runtime.ts";

/** Same bound as core/board.ts: a search is a bounded read, never an enumeration. */
const SEARCH_MAX = 100;

/**
 * Tags in the lexical hit surface beyond the runtime vocabulary: deck records (core/deckstore.ts)
 * and governance tombstones. Shaped items use their schema name — those tags join the surface
 * from the local rows themselves (below). A tag outside the surface is never pruned (absence
 * from an unasked query proves nothing) and is only restored when a query happens to hit it.
 */
const EXTRA_TAGS = ["layout", "lens", "retired-layout", "retired-lens", "schema", "retired-schema"];

export interface ResyncCounts {
  /** Rows rebuilt from Cortex that the mirror did not have (or that a repair changed). */
  restored: number;
  /** Rows the mirror already had, unchanged. */
  kept: number;
  /** Rows removed: absent from a COMPLETE search for their tag (ghosts and consumed items). */
  pruned: number;
}

export interface ResyncReport {
  /** True when any search was capped (TASK-37): the mirror may be incomplete and nothing was pruned. */
  truncated: boolean;
  queries: number;
  found: number;
  shared: ResyncCounts & {
    /** History rows rebuilt whose successor Cortex does not expose (stamped SUPERSEDED_UNKNOWN). */
    supersededUnknown: number;
    /** sourceId recovered for rebuilt rows (the unique private shard with the same content). */
    sourceIdsRecovered: number;
  };
  pending: ResyncCounts & {
    /** Rows left untouched because another runtime's role owns their shard. */
    foreignKept: number;
    /** Deliberately dropped items that stayed dropped. */
    droppedKept: number;
    /** Private write-trail shards (promoted sources) not re-offered for review. */
    promotedSkipped: number;
    /** Baton shards skipped: consumed on delivery, never review items. */
    batonSkipped: number;
  };
}

function counts(): ResyncCounts {
  return { restored: 0, kept: 0, pruned: 0 };
}

/** Event time of a search row: the checkpoint (event time) when present, else the row time. */
function occurredAtOf(s: SearchShard): string {
  const prov = s.provenance as { checkpoint_at?: string } | undefined;
  const at = prov?.checkpoint_at ?? (typeof s.created_at === "string" ? s.created_at : undefined);
  return at && at.length > 0 ? at : new Date().toISOString();
}

/** Who wrote a shard, per the provenance we stamp on our own writes (`sessionUrn`). */
function attributionOf(s: SearchShard, fallbackRuntime: string): { runtime: string; sessionId: string } {
  const prov = s.provenance as { source_uri?: unknown; extra?: { captured_by?: unknown } } | undefined;
  // urn:continuity:<runtime>:<session>:<entry…> — the entry may contain ':'.
  const parts = String(prov?.source_uri ?? "").split(":");
  const runtime = parts.length >= 4 && parts[0] === "urn" && parts[1] === "continuity" ? parts[2] : undefined;
  return {
    runtime: runtime || (typeof prov?.extra?.captured_by === "string" ? prov.extra.captured_by : fallbackRuntime),
    sessionId: runtime && parts.length >= 4 ? parts[3] : "",
  };
}

/**
 * Rebuild `state.pending` and `state.shared` for this runtime from Cortex, then persist
 * (through the three-way merge + lock: a resync racing another writer loses nothing).
 */
export async function resyncMirror(rt: Runtime, sessionId: string): Promise<ResyncReport> {
  const surface = new Set<string>([...TAGS, ...EXTRA_TAGS]);
  for (const r of [...rt.state.shared, ...rt.state.pending]) surface.add(tagOf(r.content));

  const found = new Map<string, SearchShard>();
  let truncated = false;
  for (const tag of surface) {
    const r = await rt.agent.search(`[${tag}]`, SEARCH_MAX);
    for (const s of r.shards) found.set(s.shard_id, s);
    if (r.truncated || r.total > r.shards.length) truncated = true;
  }

  const sharedFound: SearchShard[] = [];
  const privateFound: SearchShard[] = [];
  for (const s of found.values()) {
    const sc = s.provenance?.extra?.scope_class;
    if (sc === "profile_shared") sharedFound.push(s);
    else if (sc === "role_private") privateFound.push(s); // handoff and unknown scopes are not mirror rows
  }

  const stamp = writeStamp(rt.runtimeName, sessionId);
  const report: ResyncReport = {
    truncated,
    queries: surface.size,
    found: found.size,
    shared: { ...counts(), supersededUnknown: 0, sourceIdsRecovered: 0 },
    pending: { ...counts(), foreignKept: 0, droppedKept: 0, promotedSkipped: 0, batonSkipped: 0 },
  };

  // ----- shared: existence and liveness from Cortex, chain knowledge from the mirror -----
  const localShared = new Map(rt.state.shared.map((r) => [r.derivedId, r]));
  const rebuiltShared: SharedItem[] = [];
  for (const s of sharedFound) {
    const local = localShared.get(s.shard_id);
    const notLive = s.status === "superseded" || s.status === "archived";
    // A supersede marks history in Cortex before the mirror learns the successor id; local
    // knowledge wins when present, an unknown successor is stamped (never left reading live).
    const supersededBy = local?.supersededBy ?? (notLive ? SUPERSEDED_UNKNOWN : undefined);
    if (supersededBy === SUPERSEDED_UNKNOWN) report.shared.supersededUnknown++;
    const content = typeof s.content === "string" ? s.content : local?.content ?? "";
    const row: SharedItem = { derivedId: s.shard_id, sourceId: local?.sourceId ?? "", content, approvedAt: local?.approvedAt ?? occurredAtOf(s) };
    if (supersededBy) row.supersededBy = supersededBy;
    if (local?.runtime) row.runtime = local.runtime;
    if (local) row.written = local.written;
    if (!local || local.content !== content || local.supersededBy !== supersededBy) {
      // this row was added or repaired by this resync: the resync process is its last writer
      row.written = stamp;
      report.shared.restored++;
    } else {
      report.shared.kept++;
    }
    rebuiltShared.push(row);
  }
  // A shared row without a local source id can recover it from its private source shard: Cortex
  // derives shard identity from content+scope, so the ONE private shard with the same content
  // is that record's write trail. Ambiguous matches (two roles, same text) recover nothing.
  const privateByContent = new Map<string, SearchShard[]>();
  for (const s of privateFound) {
    const list = privateByContent.get(s.content) ?? [];
    list.push(s);
    privateByContent.set(s.content, list);
  }
  for (const row of rebuiltShared) {
    if (row.sourceId || !row.content) continue;
    const matches = privateByContent.get(row.content) ?? [];
    if (matches.length === 1) {
      row.sourceId = matches[0].shard_id;
      report.shared.sourceIdsRecovered++;
    }
  }

  // ----- pending: this runtime's role-private shards, minus what the user already handled -----
  const sharedContents = new Set(rebuiltShared.map((r) => r.content));
  for (const r of rt.state.shared) sharedContents.add(r.content); // out-of-surface rows count too
  const droppedIds = new Set(((rt.state.dropped ?? []) as DroppedItem[]).map((d) => d.shardId));
  const localPending = new Map(rt.state.pending.map((r) => [r.shardId, r]));
  const rebuiltPending: PendingItem[] = [];
  for (const s of privateFound) {
    const content = typeof s.content === "string" ? s.content : "";
    if (isBatonContent(content)) {
      report.pending.batonSkipped++;
      continue;
    }
    // Promoted source / write-trail shard: share() and supersede() keep the content, so the
    // private source shard's content equals a shared record's. It is the write trail, not a
    // review item (and re-offering it is the resurrection bug this command must not repeat).
    if (sharedContents.has(content)) {
      report.pending.promotedSkipped++;
      continue;
    }
    if (droppedIds.has(s.shard_id)) {
      report.pending.droppedKept++;
      continue;
    }
    const { runtime, sessionId: shardSession } = attributionOf(s, rt.runtimeName);
    const local = localPending.get(s.shard_id);
    if (local) {
      rebuiltPending.push(local);
      report.pending.kept++;
      continue;
    }
    rebuiltPending.push({ shardId: s.shard_id, content, createdAt: occurredAtOf(s), sessionId: shardSession, runtime, written: stamp });
    report.pending.restored++;
  }

  // ----- prune or keep what the mirror had that the rebuild did not carry -----
  const keptShared = new Set(rebuiltShared.map((r) => r.derivedId));
  for (const r of rt.state.shared) {
    if (keptShared.has(r.derivedId)) continue;
    if (!truncated && surface.has(tagOf(r.content))) {
      report.shared.pruned++; // absent from a complete search of its tag: provably not in Cortex
      continue;
    }
    rebuiltShared.push(r); // unsearched tag or capped search: not ours to delete
    report.shared.kept++;
  }
  const keptPending = new Set(rebuiltPending.map((r) => r.shardId));
  for (const r of rt.state.pending) {
    if (keptPending.has(r.shardId)) continue;
    const mine = (r.runtime ?? "pi") === rt.runtimeName;
    if (!mine) {
      rebuiltPending.push(r); // another runtime's role owns this shard: never ours to prune
      report.pending.foreignKept++;
    } else if (!truncated && surface.has(tagOf(r.content))) {
      report.pending.pruned++;
    } else {
      rebuiltPending.push(r);
      report.pending.kept++;
    }
  }

  rt.state.shared = rebuiltShared;
  rt.state.pending = rebuiltPending;
  rt.persist();
  return report;
}

export function formatResync(rt: Runtime, r: ResyncReport): string[] {
  const s = r.shared;
  const p = r.pending;
  const lines = [`resync (${rt.profileId} as ${rt.runtimeName}): local mirror rebuilt from Cortex`];
  lines.push(`  shared: ${s.restored} restored · ${s.kept} kept · ${s.pruned} pruned · ${s.supersededUnknown} history with unresolved successor · ${s.sourceIdsRecovered} source id(s) recovered`);
  lines.push(`  pending (runtime ${rt.runtimeName}): ${p.restored} restored · ${p.kept} kept · ${p.pruned} pruned · ${p.droppedKept} dropped item(s) stayed dropped · ${p.promotedSkipped} promoted source(s) not re-offered`);
  if (p.foreignKept) lines.push(`  ${p.foreignKept} pending row(s) belong to another runtime and were left alone (run resync from that runtime to rebuild theirs)`);
  if (p.batonSkipped) lines.push(`  ${p.batonSkipped} baton shard(s) skipped (consumed on delivery, never review items)`);
  if (r.truncated) lines.push(`  search was capped (truncated): NOTHING was pruned and rows may be missing — re-run when the search fits`);
  return lines;
}
