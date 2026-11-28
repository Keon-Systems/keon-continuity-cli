/**
 * Cross-profile recall (TASK-43): the union behind every search surface.
 *
 * Rule: anything the briefing can tell you, recall can find. The briefing folds the
 * cross-project profiles — proj_me (life profile) and proj_north_star (north star) — into
 * every project, so every search surface (the CLI's `kontinuity recall`, GET /api/recall,
 * the Concierge/MCP recall tool) runs the SAME lexical query against the project profile
 * AND those two, and unions the hits so a [preference] is findable by its words.
 *
 * Search stays lexical: one exact-token query per profile (Cortex scores each profile on its
 * own). This module only unions — it never re-ranks across profiles, because per-profile
 * relevance scores are not comparable — and every hit keeps the home profile it came from
 * (`profileId` + the provenance ribbon's `home` mark), so a cross-project hit still shows
 * where it lives (life profile / north star).
 *
 * Delivery accounting stays per profile: each profile's recall event gets its own
 * access / access_omitted reports through that profile's client (as core/preferences.ts
 * does), never the project one. A read surface (GET /api/recall) reports nothing at all —
 * a lookup is not a delivery.
 */

import type { RecallResult, RecallResultItem, ShardDetail } from "../src/cortex.ts";
import { tolerateReplay, warnEventFailure } from "./feedback.ts";
import { northStar } from "./later.ts";
import { meProfile } from "./preferences.ts";
import type { Runtime } from "./runtime.ts";

/** One profile's share of a unioned recall: its hits and the runtime they live in. */
export interface ProfileRecall {
  /** The home profile the hits live in (provenance profile_id). */
  profileId: string;
  /** The provenance ribbon's home mark: "life profile" / "north star" / the project label. */
  home: string;
  /** Runtime bound to this profile — its client carries the profile's grants. */
  rt: Runtime;
  result: RecallResult;
}

/** A unioned hit, still paired with the leg that produced it (per-profile accounting, home mark). */
export interface RecallRow {
  id: string;
  content: string;
  verified: boolean;
  detail: ShardDetail | undefined;
  item: RecallResultItem;
  profileId: string;
  home: string;
  leg: ProfileRecall;
}

/** The ribbon's home mark for a profile: proj_me is the life profile, proj_north_star the north star, anything else is a project. */
export function homeLabel(rt: Runtime, profileId: string): string {
  if (profileId === rt.cfg.meProfile) return "life profile";
  if (profileId === rt.cfg.northStarProfile) return "north star";
  return rt.projectLabel;
}

/**
 * The same lexical query against the project profile and the cross-project profiles, in that
 * order (the project leg first — it is where the search runs). A profile already covered is
 * not asked twice (`--project proj_me` finds life-profile memory behind the project leg).
 * Failures are not swallowed: a recall without a recall_event_id already fails closed
 * (src/cortex.ts), and silent cross-profile amnesia is worse than an error.
 */
export async function crossProfileRecall(
  rt: Runtime,
  opts: { query: string; sessionId: string; limit?: number; kind?: "recall" | "briefing" },
): Promise<ProfileRecall[]> {
  const limit = opts.limit ?? 8;
  const kind = opts.kind ?? "recall";
  const seen = new Set<string>();
  const legs: ProfileRecall[] = [];
  for (const legRt of [rt, meProfile(rt), northStar(rt)]) {
    if (seen.has(legRt.profileId)) continue;
    seen.add(legRt.profileId);
    const result = await legRt.agent.recall({ query: opts.query, kind, limit, sessionId: opts.sessionId });
    legs.push({ profileId: legRt.profileId, home: homeLabel(rt, legRt.profileId), rt: legRt, result });
  }
  return legs;
}

/**
 * Hydrate one leg's hits: content and provenance detail for the ribbon. A detail that cannot
 * be fetched is kept without one — fail open toward showing the hit, never toward deleting it.
 */
export async function recallRows(leg: ProfileRecall): Promise<RecallRow[]> {
  const details = await Promise.all(leg.result.results.map((r) => leg.rt.agent.getShard(r.shard_id).catch(() => undefined)));
  return leg.result.results.map((r, i) => ({
    id: r.shard_id,
    content: details[i]?.content ?? r.content,
    verified: r.verified,
    detail: details[i],
    item: r,
    profileId: leg.profileId,
    home: leg.home,
    leg,
  }));
}

/**
 * Account one leg's share of a unioned delivery against ITS recall event, through ITS client:
 * delivered hits are `access`, recalled-but-cut hits `access_omitted` — never trimmed silently.
 */
export async function reportProfileAccess(
  leg: ProfileRecall,
  sessionId: string,
  deliveredIds: string[],
  omitted?: { ids: string[]; reason: string },
): Promise<void> {
  if (deliveredIds.length > 0) {
    await tolerateReplay(() => leg.rt.agent.reportAccess({ sessionId, recallEventId: leg.result.recall_event_id, recordIds: deliveredIds }));
  }
  if (omitted && omitted.ids.length > 0) {
    await leg.rt.agent
      .reportAccessOmitted({ sessionId, recallEventId: leg.result.recall_event_id, recordIds: omitted.ids, reason: omitted.reason })
      .catch((e) => warnEventFailure("access_omitted", e));
  }
}
