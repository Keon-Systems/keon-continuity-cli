/**
 * Life / preference profile — who the user is, across every project and runtime.
 *
 * A preference is an ordinary user-confirmed shared memory in the "me" profile:
 *     [preference] prefers dark mode in every editor
 *
 * Confirmed-only: there is no inference path into the profile. A preference enters only when
 * the user states it and an agent records it with --user-confirmed, and only the profile_shared
 * copy is ever read back — private drafts and other roles' writes are never injected.
 *
 * Cross-project: the profile is proj_me (cfg.meProfile), not the repository profile, so every
 * briefing in every runtime and every project carries it — under the same token budget and
 * delivery accounting as project memory.
 */

import type { ShardDetail } from "../src/cortex.ts";
import { grant } from "../src/cortex.ts";
import type { Runtime } from "./runtime.ts";
import { stripTag, tagOf } from "./runtime.ts";
import { share, writePrivate } from "./memory.ts";
import { tolerateReplay, warnEventFailure } from "./feedback.ts";
import { GuardError } from "./guard.ts";
import { candidateContent } from "./imports.ts";
import { writePrivateDurable, type WriteOutcome } from "./outbox.ts";
import { loadState, saveState } from "./state.ts";

export interface PreferenceItem {
  id: string;
  content: string;
  /** Content without the [preference] tag. */
  text: string;
  occurredAt?: string;
  status: string;
}

export interface PreferenceList {
  items: PreferenceItem[];
  recallEventId: string;
}

export function preferenceContent(text: string): string {
  return `[preference] ${text.trim().replace(/^\[preference\]\s*/, "")}`;
}

/** A runtime bound to the life/preference profile (same roles, different profile). */
export function meProfile(rt: Runtime): Runtime {
  const profileId = rt.cfg.meProfile;
  if (rt.profileId === profileId) return rt;
  const a = rt.agent.identity;
  const o = rt.owner.identity;
  const agent = rt.agent.as({ ...a, profileId, grants: [grant.role(profileId, a.roleId), grant.profileShared(profileId)] });
  const owner = rt.owner.as({ ...o, profileId, grants: [grant.role(profileId, o.roleId), grant.profileShared(profileId), grant.curationApprove] });
  const state = loadState(rt.cfg.tenantId, profileId);
  return { ...rt, profileId, projectLabel: "life profile", agent, owner, state, persist: () => saveState(rt.cfg.tenantId, profileId, state) };
}

/**
 * Record a user-stated preference. Confirmed-only: it is shared immediately, there is no
 * pending path and nothing is ever promoted automatically.
 */
export async function addPreference(rt: Runtime, text: string, sessionId: string, via: string): Promise<{ sourceId: string; derivedId: string; content: string }> {
  const me = meProfile(rt);
  const content = preferenceContent(text);
  const sourceId = await writePrivate(me, { content, sourceKind: "user_said", sessionId, entryRef: "preference", occurredAt: new Date().toISOString() });
  const derivedId = await share(me, sourceId, content, `user stated a life preference (via ${via})`, sessionId, "preference");
  return { sourceId, derivedId, content };
}

/** All current, user-confirmed preferences in the me profile, sorted oldest first. */
export async function listPreferences(rt: Runtime, sessionId: string): Promise<PreferenceList | undefined> {
  const me = meProfile(rt);
  const rec = await me.agent.recall({ query: "[preference]", kind: "briefing", limit: 50, sessionId });
  if (rec.results.length === 0) return undefined;
  const details = await Promise.all(rec.results.map((r) => me.agent.getShard(r.shard_id).catch((): ShardDetail | undefined => undefined)));
  const items: PreferenceItem[] = [];
  const seen = new Set<string>();
  rec.results.forEach((r, i) => {
    const d = details[i];
    const content = d?.content ?? r.content;
    if (tagOf(content) !== "preference") return;
    if (d && (d.status === "superseded" || d.status === "archived")) return;
    // Confirmed-only, fail closed: only the user-confirmed shared copy counts — never a
    // private draft, and never a record whose scope could not be established.
    if (!d || d.provenance?.extra?.scope_class !== "profile_shared") return;
    if (seen.has(content)) return;
    seen.add(content);
    items.push({
      id: r.shard_id,
      content,
      text: stripTag(content),
      occurredAt: d.provenance?.checkpoint_at ?? d.created_at,
      status: d.status,
    });
  });
  items.sort((a, b) => (a.occurredAt ?? "").localeCompare(b.occurredAt ?? "") || a.id.localeCompare(b.id));
  return { items, recallEventId: rec.recall_event_id };
}

/**
 * Honest delivery accounting for the briefing: preferences that made it into the text get
 * `access`, ones cut by the budget get `access_omitted` — against the preference recall event
 * (its own profile), never the project one.
 */
export async function reportPreferenceDelivery(rt: Runtime, sessionId: string, recallEventId: string, deliveredIds: string[], omittedIds: string[]): Promise<void> {
  const me = meProfile(rt);
  if (deliveredIds.length > 0) await tolerateReplay(() => me.agent.reportAccess({ sessionId, recallEventId, recordIds: deliveredIds }));
  if (omittedIds.length > 0) await me.agent.reportAccessOmitted({ sessionId, recallEventId, recordIds: omittedIds, reason: "briefing_cap" }).catch((e) => warnEventFailure("access_omitted (preferences)", e));
}

/** Retire a preference: supersede it out of the [preference] stream; history is kept. */
export async function retirePreference(rt: Runtime, item: PreferenceItem, sessionId: string, via: string): Promise<string> {
  const me = meProfile(rt);
  const content = `[note] retired:${new Date().toISOString().slice(0, 10)} ${item.text}`;
  const sourceId = await writePrivate(me, { content, sourceKind: "user_confirmed", sessionId, entryRef: `preference:${item.id.slice(0, 12)}`, occurredAt: new Date().toISOString() });
  const why = `user retired a life preference (via ${via})`;
  const prop = await me.agent.propose({ kind: "preference", sourceRecordIds: [sourceId], content, reason: why });
  const disp = await me.owner.dispose({ proposalId: prop.proposal_id, action: "supersede", supersedesRecordId: item.id, reason: why });
  if (!disp.derived_shard_id) throw new Error(`supersede returned no derived_shard_id (${disp.status})`);
  return disp.derived_shard_id;
}

export function formatPreferences(items: PreferenceItem[]): string {
  return items
    .map((i) => `- ${i.text}  (${i.occurredAt?.slice(0, 10) ?? "?"})  id=${i.id.slice(0, 10)}`)
    .join("\n");
}

// ---------- preference candidates (imported, awaiting user review) ----------

/** A vendor claim staged for review: `[imported] …`, private + pending in the me profile. */
export interface PreferenceCandidate {
  id: string;
  content: string;
  /** Content without the [imported] tag. */
  text: string;
  createdAt: string;
  runtime: string;
}

export type CandidateOutcome = WriteOutcome | { status: "refused"; error: string };

/**
 * Stage statements a vendor claimed to remember (`import --from vendor-memory`) as [imported]
 * preference CANDIDATES in the me profile: private + pending, never shared. The confirmed profile
 * is user-confirmed only (fail closed), so an import can only ever propose — the user reviews
 * (`prefs candidates`) and accepts (`prefs accept --user-confirmed`) or rejects.
 */
export async function importPreferenceCandidates(rt: Runtime, statements: string[], sessionId: string, occurredAt: string, entryRef: string): Promise<{ content: string; outcome: CandidateOutcome }[]> {
  const me = meProfile(rt);
  const results: { content: string; outcome: CandidateOutcome }[] = [];
  for (const [i, s] of statements.entries()) {
    const content = candidateContent(s);
    try {
      const outcome = await writePrivateDurable(me, { content, sourceKind: "imported", sessionId, entryRef: `${entryRef}:${i}`, occurredAt, source: "continuity/import" }, { pending: true });
      results.push({ content, outcome });
    } catch (e) {
      if (e instanceof GuardError) results.push({ content: "(withheld)", outcome: { status: "refused", error: e.message } });
      else throw e;
    }
  }
  return results;
}

/** All [imported] preference candidates awaiting review in the me profile — any runtime's: the queue is per profile, acceptance never needs the importing role. */
export function listPreferenceCandidates(rt: Runtime): PreferenceCandidate[] {
  const me = meProfile(rt);
  return me.state.pending
    .filter((p) => tagOf(p.content) === "imported")
    .map((p) => ({ id: p.shardId, content: p.content, text: stripTag(p.content), createdAt: p.createdAt, runtime: p.runtime ?? "pi" }))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}

/**
 * The user accepts a candidate: it becomes a user-confirmed [preference] in the me profile and
 * leaves the review queue. The imported shard stays private as the provenance of the claim.
 */
export async function acceptPreferenceCandidate(rt: Runtime, item: PreferenceCandidate, sessionId: string, via: string): Promise<{ sourceId: string; derivedId: string; content: string }> {
  const r = await addPreference(rt, item.text, sessionId, `${via} (accepted imported candidate ${item.id.slice(0, 12)})`);
  const me = meProfile(rt);
  me.state.pending = me.state.pending.filter((p) => p.shardId !== item.id);
  me.persist();
  return r;
}

/** The user rejects a candidate: it leaves the review queue; the imported shard stays private. */
export function rejectPreferenceCandidate(rt: Runtime, item: PreferenceCandidate): void {
  const me = meProfile(rt);
  me.state.pending = me.state.pending.filter((p) => p.shardId !== item.id);
  me.persist();
}

export function formatPreferenceCandidates(items: PreferenceCandidate[]): string {
  return items
    .map((c) => `- ${c.text}  (${c.createdAt.slice(0, 10)}, from ${c.runtime})  id=${c.id.slice(0, 10)}`)
    .join("\n");
}
