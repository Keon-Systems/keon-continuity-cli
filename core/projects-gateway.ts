/**
 * The Project/1 registry over the Keon MCP Gateway transport (TASK-136 "both transports"):
 * the same `ProjectRecordTransport` seam as core/projects-cortex.ts, wired to
 * `keon.cortex.curation.batch.v1` (publish/revise — one atomic batch item each, the
 * approve disposition carrying the two `unique_keys`) and `keon.cortex.memory.search.v1`
 * (enumeration). The gateway binds identity from the machine credential and enrollment —
 * never from arguments (G-1) — and the per-call profile is the registry profile.
 */

import {
  mapRegistryWriteError,
  projectRecordContent,
  projectSourceNote,
  registryUniqueKeys,
  ProjectRegistryUnreachable,
  type ProjectRecordFields,
  type ProjectRecordTransport,
  type ProjectTransportRecord,
} from "./projects-cortex.ts";
import { PROJECT_REGISTRY_PROFILE, ProjectError } from "./projects.ts";
import { GatewayClient, GatewayError, GatewayRefusedError, type GatewayCurationBatchItem } from "./gateway-client.ts";

/** A registry search: the record tag is the enumeration query (exact-token match). */
export const PROJECT_RECORD_QUERY = "[project/1]";

export function gatewayProjectTransport(client: GatewayClient, opts: { profileId?: string } = {}): ProjectRecordTransport {
  const profileId = opts.profileId ?? PROJECT_REGISTRY_PROFILE;
  return {
    async load() {
      try {
        const res = await client.search(PROJECT_RECORD_QUERY, { limit: 100, profileId });
        if (res.total > res.shards.length) {
          throw new ProjectError(
            "enumeration_truncated",
            `the project registry enumeration was truncated (${res.shards.length} of ${res.total} records) — refusing to serve an incomplete listing`,
            500,
            1,
          );
        }
        return res.shards.map((s) => ({ recordId: s.shard_id, content: s.content, status: s.status ?? "active" })) satisfies ProjectTransportRecord[];
      } catch (e) {
        throw classify(e);
      }
    },
    async publish(record) {
      const item: GatewayCurationBatchItem = {
        write: {
          content: projectSourceNote(record),
          source: "continuity/project-registry",
          subjectKeys: ["continuity", "project/1", `project-id:${record.projectId}`, `project-slug:${record.slug}`],
        },
        proposal: {
          kind: "lesson",
          content: projectRecordContent(record),
          reason: `project registry publish ${record.slug}`,
        },
        disposition: {
          action: "approve",
          reason: `project registry publish ${record.slug}`,
          uniqueKeys: registryUniqueKeys(record),
        },
      };
      return run(client, profileId, item, record);
    },
    async supersede(headRecordId, record) {
      const item: GatewayCurationBatchItem = {
        write: {
          content: projectSourceNote(record),
          source: "continuity/project-registry",
          subjectKeys: ["continuity", "project/1", `project-id:${record.projectId}`, `project-slug:${record.slug}`],
        },
        proposal: {
          kind: "lesson",
          content: projectRecordContent(record),
          reason: `project registry revise ${record.slug} to revision ${record.revision}`,
        },
        disposition: {
          // The compare-and-swap: the head must not be superseded yet. The unique keys
          // move from the old record to the replacement — never re-declared here.
          action: "supersede",
          supersedesRecordId: headRecordId,
          reason: `project registry revise ${record.slug} to revision ${record.revision}`,
        },
      };
      return run(client, profileId, item, record);
    },
  };
}

async function run(client: GatewayClient, profileId: string, item: GatewayCurationBatchItem, record: ProjectRecordFields): Promise<string> {
  try {
    const result = await client.curationBatch({ items: [item] }, { profileId });
    return result.items[0]!.derived_shard_id;
  } catch (e) {
    throw mapRegistryWriteError(classify(e), record);
  }
}

/** Unreachable (provably never delivered) vs. a real gateway answer. Refusals pass through. */
function classify(e: unknown): unknown {
  if (e instanceof GatewayRefusedError) return e;
  if (e instanceof GatewayError && /unreachable/i.test(e.message)) {
    return new ProjectRegistryUnreachable(`the project registry is unreachable (${e.message})`);
  }
  return e;
}
