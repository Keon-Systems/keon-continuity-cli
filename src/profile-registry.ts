/**
 * Profile naming taxonomy (TASK-85) — the registry of profile kinds and the read-through
 * alias layer (docs/profile-naming.md).
 *
 * Owner policy: a profile's prefix must describe what it actually represents. `proj_` is for
 * project scopes; the human life profile `proj_me` is misnamed (it is an actor's cross-project
 * scope, not a project) and becomes `actor_me`; a uniform prefix is pointless. The registry was
 * decided by an agent under blanket owner authority 2026-11-03 (owner review welcome): kinds
 * must register here before first use, and gateway enrollments reference these kinds in
 * AllowedProfiles (docs/profile-naming.md §Enrollment).
 *
 * NON-DESTRUCTIVE (README: changing an ID does not migrate memory): IDs never move silently.
 * This module is the read-through alias layer — every legacy id keeps resolving to the same
 * live profile as its canonical name. New writes go to the new id only after the owner reviews
 * the migration preview (`kontinuity profiles migrate-preview`) and approves the physical move;
 * until then `writesTo` keeps every write on the legacy id and nothing splits.
 */

import { assertId } from "./ids.ts";

/** The registered kinds. A new kind must appear here before an id carrying it is used anywhere. */
export type ProfileKind = "proj" | "actor" | "vocab" | "star";

export interface ProfileKindSpec {
  kind: ProfileKind;
  /** Id prefix for this kind's profiles (exactly one of `prefix` / `ids`). */
  prefix?: string;
  /** Fixed registered ids, for kinds that are a single named profile. */
  ids?: readonly string[];
  /** What a profile of this kind actually represents. */
  meaning: string;
  /** When the kind entered the registry. */
  registered: string;
}

export const PROFILE_KINDS: readonly ProfileKindSpec[] = [
  {
    kind: "proj",
    prefix: "proj_",
    meaning: "project scopes — one repository, product or workspace per profile (proj_continuity, proj_deck, proj_<repo>)",
    registered: "2026-11-03",
  },
  {
    kind: "actor",
    prefix: "actor_",
    meaning: "cross-project scopes of an actor, human or autonomous (actor_me = the human life profile, actor_<name> for agents)",
    registered: "2026-11-03",
  },
  {
    kind: "vocab",
    ids: ["proj_vocabulary"],
    meaning: "the shared vocabulary (governed shapes); grandfathered id — the kind is registered so enrollments can cite it",
    registered: "2026-11-03",
  },
  {
    kind: "star",
    ids: ["proj_north_star"],
    meaning: "the north star (the deferred vision); grandfathered id — the kind is registered so enrollments can cite it",
    registered: "2026-11-03",
  },
];

export interface ProfileAlias {
  kind: ProfileKind;
  /** The taxonomy name the profile goes by (what it "becomes"). */
  canonical: string;
  /** Pre-taxonomy ids that must keep resolving — an old id is never retired, only aliased. */
  legacy: readonly string[];
  /**
   * Where identity, local state and writes point TODAY. New writes go to `canonical` only after
   * the owner reviews `kontinuity profiles migrate-preview` and approves the physical migration
   * (docs/profile-naming.md §Migration) — never automatically, never silently.
   */
  writesTo: string;
  note: string;
}

export const PROFILE_ALIASES: readonly ProfileAlias[] = [
  {
    kind: "actor",
    canonical: "actor_me",
    legacy: ["proj_me"],
    writesTo: "proj_me",
    note: "the human life profile (cross-project [preference] items). proj_me is misnamed — this is an actor scope, not a project. Both names resolve to one live profile; writes land in proj_me until the owner reviews the migration preview and approves the physical move.",
  },
];

/** The alias row this id belongs to (canonical or any legacy name), if any. */
export function aliasFor(id: string): ProfileAlias | undefined {
  return PROFILE_ALIASES.find((a) => a.canonical === id || a.legacy.includes(id));
}

/** The taxonomy name of the profile this id names (aliases resolve to their canonical id). */
export function canonicalProfileId(id: string): string {
  return aliasFor(id)?.canonical ?? id;
}

/**
 * Read-through alias resolution: any name of a profile — legacy or canonical — resolves to the
 * id the live profile is written and stored under today. Old ids keep resolving; nothing moves
 * until the owner says so. The aliased target is re-validated so the moment `writesTo` flips
 * (migration step 3) it cannot become an unchecked trust edge; non-aliased ids pass through
 * untouched (accept boundaries grandfather old ids — see docs/profile-naming.md §Enforcement).
 */
export function resolveProfileId(id: string): string {
  const alias = aliasFor(id);
  return alias ? assertId(alias.writesTo, "profile alias writesTo") : id;
}

export type ProfileValidation =
  | { ok: true; kind: ProfileKind; alias?: ProfileAlias }
  | { ok: false; reason: string };

function kindForFixedOrPrefix(id: string): ProfileKind | undefined {
  for (const k of PROFILE_KINDS) {
    if (k.ids?.includes(id)) return k.kind;
  }
  for (const k of PROFILE_KINDS) {
    if (k.prefix && id.startsWith(k.prefix)) return k.kind;
  }
  return undefined;
}

/**
 * Registry validation: an id is valid when the alias layer covers it (grandfathered legacy ids
 * keep resolving) or it carries a registered kind — a fixed id, or a registered prefix. A new
 * kind must register in PROFILE_KINDS before first use; an unregistered prefix is refused here
 * so it is caught before it becomes memory.
 */
export function validateProfileId(id: string): ProfileValidation {
  const alias = aliasFor(id);
  if (alias) return { ok: true, kind: alias.kind, alias };
  const kind = kindForFixedOrPrefix(id);
  if (kind) return { ok: true, kind };
  return {
    ok: false,
    reason: `unregistered profile id ${JSON.stringify(id)}: no registered kind covers its prefix — new kinds must register before first use (src/profile-registry.ts, docs/profile-naming.md)`,
  };
}

/** Fail-closed registry check for ids minted or accepted at a registration boundary. */
export function assertRegisteredProfileId(id: string, label = "profile id"): string {
  const v = validateProfileId(id);
  if (!v.ok) throw new Error(`${label}: ${v.reason}`);
  return id;
}

/**
 * Project/1 instance admission is separate from naming-kind resolution above.
 * `resolveProfileId` / `aliasFor` keep `actor_me` → `proj_me` and `proj_north_star`
 * as aliases. They do not create instances, copy grants, or adopt old memory.
 * The check here is the only admission path for a user-created `proj_<slug>`.
 *
 * `proj_projects` is the reserved registry profile (TASK-136): one shared `project/1`
 * record per Project/1 lives there. It joins this list beside `proj_me` /
 * `proj_north_star` / `proj_vocabulary` — never a Project/1 instance, and never a
 * satellite grant.
 */
export const RESERVED_PROJECT_INSTANCE_SLUGS = ["proj_me", "proj_north_star", "proj_vocabulary", "proj_projects", "actor_me"] as const;

export interface ProjectInstanceRef {
  projectId: string;
  slug: string;
}

export type ProjectSlugCollisionCode = "invalid_slug" | "reserved_slug" | "instance_collision" | "legacy_profile";

export type ProjectSlugCollision =
  | { ok: true; slug: string }
  | { ok: false; code: ProjectSlugCollisionCode; slug: string; message: string; projectId?: string };

const PROJECT_SLUG_RE = /^proj_[a-z][a-z0-9_]{0,62}$/;

/** Fold case and treat spaces, dots, and hyphens as underscores. */
export function foldProjectSlugToken(raw: string): string {
  return raw.trim().toLowerCase().replace(/[\s.\-]+/g, "_").replace(/_+/g, "_").replace(/^_+|_+$/g, "");
}

/**
 * Canonical `proj_<slug>` form. `actor_*` is left intact so `actor_me` stays reserved
 * instead of being rewritten into a project slug. A bare name (`alpha`) gains `proj_`.
 */
export function canonicalizeProjectSlug(raw: string): string {
  const folded = foldProjectSlugToken(raw);
  if (!folded) return "";
  if (folded.startsWith("proj_") || folded.startsWith("actor_")) return folded;
  return `proj_${folded}`;
}

function reservedKey(slug: string): string {
  return foldProjectSlugToken(slug).replace(/_/g, "");
}

/** True for the satellite ids and their case / separator variants (`PROJ-ME`, `actor-me`, …). */
export function isReservedProjectSlug(raw: string): boolean {
  const slug = canonicalizeProjectSlug(raw);
  if (!slug) return false;
  const key = reservedKey(slug);
  for (const reserved of RESERVED_PROJECT_INSTANCE_SLUGS) {
    if (slug === reserved || key === reservedKey(reserved)) return true;
  }
  return false;
}

/**
 * Deterministic Project/1 slug admission across registered instances and legacy derived
 * profiles. A hit refuses. It never adopts `proj_demo` memory as a new empty project
 * and never grants satellites. Alias resolution is not a side effect of this call.
 */
export function checkProjectInstanceSlug(
  raw: string,
  known: { instances?: readonly ProjectInstanceRef[]; legacyProfiles?: readonly string[] } = {},
): ProjectSlugCollision {
  const slug = canonicalizeProjectSlug(raw);
  if (!slug) {
    return { ok: false, code: "invalid_slug", slug: "", message: "project slug is empty" };
  }
  if (isReservedProjectSlug(slug)) {
    return {
      ok: false,
      code: "reserved_slug",
      slug,
      message: `${slug} is a profile alias or grandfathered id, not a Project/1 instance`,
    };
  }
  if (!PROJECT_SLUG_RE.test(slug)) {
    return { ok: false, code: "invalid_slug", slug, message: `project slug ${slug} is not canonical proj_<lowercase>` };
  }
  const instance = (known.instances ?? []).find((item) => canonicalizeProjectSlug(item.slug) === slug);
  if (instance) {
    return {
      ok: false,
      code: "instance_collision",
      slug,
      projectId: instance.projectId,
      message: `project slug ${slug} is already a Project/1 instance (${instance.projectId})`,
    };
  }
  const legacy = (known.legacyProfiles ?? []).some((id) => canonicalizeProjectSlug(id) === slug);
  if (legacy) {
    return {
      ok: false,
      code: "legacy_profile",
      slug,
      message: `project slug ${slug} already has legacy records and is not an empty project; refusing implicit adoption`,
    };
  }
  return { ok: true, slug };
}
