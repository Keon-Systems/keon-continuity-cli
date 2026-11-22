/**
 * "Later" — the deferred 80%, kept in Cortex instead of a doc you'll lose.
 *
 * A later-item is an ordinary user-confirmed shared memory in the north-star profile:
 *     [later] revisit:2027-04-30 Decide Wave 1 after four weeks of scorecard data.
 * The date rides in the content (a lexical token), so it survives promotion and is
 * visible to anyone reading the record. Cortex has no scheduler; items are surfaced
 * when the user shows up — at session start in any runtime/project — and via `due`.
 */

import type { ShardDetail } from "../src/cortex.ts";
import { grant } from "../src/cortex.ts";
import type { Runtime } from "./runtime.ts";
import { share, writePrivate } from "./memory.ts";
import { warnEventFailure } from "./feedback.ts";
import { loadState, saveState } from "./state.ts";
import { findSchema, splitItemTokens, validateItem } from "./schema.ts";

export const REVISIT_RE = /\brevisit:(\d{4}-\d{2}-\d{2})\b/;

export interface LaterItem {
  id: string;
  content: string;
  text: string;
  revisit: string; // YYYY-MM-DD
  dueInDays: number; // negative = overdue
  status: string;
}

export function parseRevisit(content: string): string | undefined {
  return REVISIT_RE.exec(content)?.[1];
}

/** Accepts YYYY-MM-DD, +Nd, +Nw, +Nm, +Ny. */
export function resolveDate(spec: string, now = new Date()): string | undefined {
  if (/^\d{4}-\d{2}-\d{2}$/.test(spec)) {
    const time = Date.parse(spec);
    return !Number.isNaN(time) && new Date(time).toISOString().slice(0, 10) === spec ? spec : undefined;
  }
  const m = /^\+(\d+)([dwmy])$/.exec(spec);
  if (!m) return undefined;
  const n = Number(m[1]);
  const d = new Date(now);
  if (m[2] === "d") d.setUTCDate(d.getUTCDate() + n);
  if (m[2] === "w") d.setUTCDate(d.getUTCDate() + 7 * n);
  if (m[2] === "m") d.setUTCMonth(d.getUTCMonth() + n);
  if (m[2] === "y") d.setUTCFullYear(d.getUTCFullYear() + n);
  return d.toISOString().slice(0, 10);
}

export function laterContent(revisit: string, text: string): string {
  const clean = text.trim().replace(/^\[later\]\s*/, "").replace(REVISIT_RE, "").trim();
  return `[later] revisit:${revisit} ${clean}`;
}

/** A runtime bound to the north-star profile (same roles, different profile). */
export function northStar(rt: Runtime): Runtime {
  const profileId = rt.cfg.northStarProfile;
  if (rt.profileId === profileId) return rt;
  const a = rt.agent.identity;
  const o = rt.owner.identity;
  const agent = rt.agent.as({ ...a, profileId, grants: [grant.role(profileId, a.roleId), grant.profileShared(profileId)] });
  const owner = rt.owner.as({ ...o, profileId, grants: [grant.role(profileId, o.roleId), grant.profileShared(profileId), grant.curationApprove] });
  const state = loadState(rt.cfg.tenantId, profileId);
  return { ...rt, profileId, projectLabel: "north star", agent, owner, state, persist: () => saveState(rt.cfg.tenantId, profileId, state) };
}

export async function addLater(rt: Runtime, revisit: string, text: string, sessionId: string, via: string): Promise<{ sourceId: string; derivedId: string; content: string }> {
  const ns = northStar(rt);
  const content = laterContent(revisit, text);
  // If the user has approved a `later` schema, the convention is governed: validate against it.
  const schema = await findSchema(rt, sessionId, "later");
  if (schema && schema.state === "approved") {
    const errors = validateItem(schema, splitItemTokens(content.replace(/^\[later\]\s*/, "").split(/\s+/)), rt.runtimeName);
    if (errors.length) throw new Error(`later item does not match schema ${schema.key}: ${errors.join("; ")}`);
  }
  const sourceId = await writePrivate(ns, { content, sourceKind: "user_said", sessionId, entryRef: "later", occurredAt: new Date().toISOString(), subjectKeys: schema?.state === "approved" ? [`schema:${schema.key}`] : undefined });
  const derivedId = await share(ns, sourceId, content, `user deferred this (via ${via})`, sessionId);
  return { sourceId, derivedId, content };
}

/** All current later-items in the north-star profile, hydrated and sorted by revisit date. */
export async function listLater(rt: Runtime, sessionId: string, opts: { reportAccess?: boolean } = {}): Promise<{ items: LaterItem[]; recallEventId: string } | undefined> {
  const ns = northStar(rt);
  const rec = await ns.agent.recall({ query: "[later]", kind: "briefing", limit: 50, sessionId });
  if (rec.results.length === 0) return undefined;
  const details = await Promise.all(rec.results.map((r) => ns.agent.getShard(r.shard_id).catch((): ShardDetail | undefined => undefined)));
  const today = new Date().toISOString().slice(0, 10);
  const items: LaterItem[] = [];
  const seen = new Set<string>();
  rec.results.forEach((r, i) => {
    const d = details[i];
    const content = d?.content ?? r.content;
    const revisit = parseRevisit(content);
    if (!revisit) return;
    if (d && (d.status === "superseded" || d.status === "archived")) return;
    // Only the shared (user-confirmed) copy; skip the private source duplicate.
    if (d && d.provenance?.extra?.scope_class === "role_private") return;
    if (seen.has(content)) return;
    seen.add(content);
    items.push({
      id: r.shard_id,
      content,
      text: content.replace(/^\[later\]\s*/, "").replace(REVISIT_RE, "").trim(),
      revisit,
      dueInDays: Math.round((Date.parse(revisit) - Date.parse(today)) / 86_400_000),
      status: d?.status ?? "unknown",
    });
  });
  items.sort((a, b) => a.revisit.localeCompare(b.revisit));
  if (opts.reportAccess && items.length) {
    await ns.agent.reportAccess({ sessionId, recallEventId: rec.recall_event_id, recordIds: items.map((i) => i.id) }).catch((e) => warnEventFailure("access (north star)", e));
  }
  return { items, recallEventId: rec.recall_event_id };
}

export function dueItems(items: LaterItem[]): LaterItem[] {
  return items.filter((i) => i.dueInDays <= 0);
}

/** Supersede a later-item with a new date (snooze) or mark it done (leaves the [later] stream). */
export async function rescheduleLater(rt: Runtime, item: LaterItem, sessionId: string, mode: { snoozeTo: string; text?: string } | { done: true }, via: string): Promise<string> {
  const ns = northStar(rt);
  const content = "done" in mode ? `[note] done:${new Date().toISOString().slice(0, 10)} ${item.text}` : laterContent(mode.snoozeTo, mode.text?.trim() || item.text);
  const sourceId = await writePrivate(ns, { content, sourceKind: "user_confirmed", sessionId, entryRef: `later:${item.id.slice(0, 12)}`, occurredAt: new Date().toISOString() });
  const prop = await ns.agent.propose({ kind: "lesson", sourceRecordIds: [sourceId], content, reason: `user ${"done" in mode ? "completed" : "snoozed"} via ${via}` });
  const disp = await ns.owner.dispose({ proposalId: prop.proposal_id, action: "supersede", supersedesRecordId: item.id, reason: `user ${"done" in mode ? "completed" : "snoozed"} via ${via}` });
  if (!disp.derived_shard_id) throw new Error(`supersede returned no derived_shard_id (${disp.status})`);
  return disp.derived_shard_id;
}

export function formatDue(items: LaterItem[]): string {
  return items
    .map((i) => {
      const when = i.dueInDays === 0 ? "due today" : i.dueInDays < 0 ? `${-i.dueInDays}d overdue` : `in ${i.dueInDays}d`;
      return `- ${i.revisit} (${when}) ${i.text}  id=${i.id.slice(0, 10)}`;
    })
    .join("\n");
}
