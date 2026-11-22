/** A self-contained simulation using the same private-write and curation operations as the CLI. */
import { addPending, share, writePrivate } from "./memory.ts";
import type { Runtime } from "./runtime.ts";
import type { CortexTransport, ProposalInput, RememberInput } from "../src/cortex.ts";

const DECISION = "[decision] Use a short review checklist before each release.";
type Row = { id: string; content: string; role: string; scope: "role_private" | "profile_shared"; subjectKeys: string[] };

/** Minimal in-memory protocol model, scoped to this demonstration; never contacts Cortex. */
class DemoStore {
  private rows: Row[] = [];
  private proposal?: { source: string; content: string; role: string };
  private confirmed = false;
  confirm(): void { this.confirmed = true; }
  client(role: string, owner = false): CortexTransport {
    const visible = (r: Row) => r.scope === "profile_shared" || r.role === role;
    return {
      identity: { actorId: `agent_${role}`, roleId: `role_${role}`, profileId: "proj_demo", grants: [] },
      remember: async (input: RememberInput) => {
        const row: Row = { id: `demo-private-${this.rows.length + 1}`, content: input.content, role, scope: "role_private", subjectKeys: input.subjectKeys ?? [] };
        this.rows.push(row);
        return { shard_id: row.id };
      },
      search: async (query: string) => ({ shards: this.rows.filter(r => visible(r) && r.content.includes(query)).map(r => ({ shard_id: r.id, content: r.content, memory_type: "decision", provenance: { extra: { scope_class: r.scope } } })), total: this.rows.filter(r => visible(r) && r.content.includes(query)).length, truncated: false }),
      getShard: async (id: string) => {
        const row = this.rows.find(r => r.id === id && visible(r));
        if (!row) throw new Error("demo record is not visible to this role");
        return { shard_id: row.id, content: row.content, subject_keys: row.subjectKeys, provenance: { extra: { scope_class: row.scope } } };
      },
      propose: async (input: ProposalInput) => {
        const source = this.rows.find(r => r.id === input.sourceRecordIds[0] && r.role === role && r.scope === "role_private");
        if (!source || input.sourceRecordIds.length !== 1 || source.content !== input.content) throw new Error("invalid demo proposal");
        this.proposal = { source: source.id, content: input.content, role };
        return { proposal_id: "demo-proposal" };
      },
      dispose: async (input: { proposalId: string; action: string }) => {
        if (!owner || !this.confirmed || input.proposalId !== "demo-proposal" || input.action !== "approve" || !this.proposal) throw new Error("demo confirmation required");
        const row: Row = { id: "demo-shared", content: this.proposal.content, role: this.proposal.role, scope: "profile_shared", subjectKeys: [] };
        this.rows.push(row);
        return { derived_shard_id: row.id, status: "approved" };
      },
    } as unknown as CortexTransport;
  }
}

export interface DemoResult {
  synthetic: true;
  decision: string;
  steps: { action: string; outcome: string }[];
}

/** Run a fresh, credential-free simulation. All state lives in memory and is discarded on return. */
export async function runHandoffDemo(): Promise<DemoResult> {
  const store = new DemoStore();
  const runtime = (name: string): Runtime => ({
    // Mark the synthetic profile as a satellite so share never renders into the caller's files.
    cfg: { northStarProfile: "proj_demo" }, runtimeName: name, profileId: "proj_demo", projectLabel: "Synthetic demo", profileSource: "explicit", transport: "cortex",
    agent: store.client(name), owner: store.client("owner", true), state: { version: 1, pending: [], shared: [] }, persist() {}, secretSource: "none",
  } as unknown as Runtime);
  const first = runtime("agent_a"), second = runtime("agent_b");
  const id = await writePrivate(first, { content: DECISION, sourceKind: "agent_inferred", sessionId: "demo", entryRef: "stage", occurredAt: "2026-01-01T00:00:00.000Z", branch: "" });
  addPending(first, id, DECISION, "demo");
  const before = await second.agent.search(DECISION);
  if (before.shards.length !== 0 || first.state.pending.length !== 1) throw new Error("demo privacy check failed");
  // This is an explicit scripted confirmation, not a claim of real user consent.
  store.confirm();
  await share(first, id, DECISION, "Synthetic confirmation for demo", "demo");
  const after = await second.agent.search(DECISION);
  if (after.shards.length !== 1 || after.shards[0].content !== DECISION || first.state.pending.some(p => p.shardId === id)) throw new Error("demo share check failed");
  return { synthetic: true, decision: DECISION, steps: [
    { action: "stage", outcome: "Agent A staged a private decision for review." },
    { action: "private_read", outcome: "Agent B cannot see the private decision." },
    { action: "confirm_share", outcome: "Synthetic confirmation approved sharing the decision." },
    { action: "shared_read", outcome: "Agent B can now see the shared decision." },
  ] };
}

export function renderHandoffDemo(result: DemoResult): string {
  return ["Continuity handoff demo (synthetic; no credentials or network)", ...result.steps.map((step, i) => `${i + 1}. ${step.outcome}`), `Decision: ${result.decision}`].join("\n");
}
