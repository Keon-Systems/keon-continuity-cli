/**
 * Cortex's POST /v1/memory-events body schemas, mirrored from keon-cortex
 * `src/keon/cortex/services/memory_events.py` (checked against fba159b): a discriminated union on
 * `kind`, every model `extra="forbid"`, required fields per kind, field length bounds, the
 * explicit-timezone rule, and the kind-specific rules (outcome evidence, consideration disposition).
 *
 * The fake Cortex runs every event body through this, so a body real Cortex would answer 422 — a
 * missing `disposition`, an unknown `target_ref` on a correction — fails here too, instead of being
 * accepted and hiding the bug. Update this file when memory_events.py changes; the opt-in contract
 * test (smoke/contract.test.ts, CONTINUITY_CONTRACT_CORTEX) checks it against the real app.
 */

type Rule = "id" | "ref" | "time" | "reason" | "ids" | "str1024";
interface Kind {
  required: Record<string, Rule | readonly string[]>;
  optional: Record<string, Rule | readonly string[]>;
}

const KINDS: Record<string, Kind> = {
  access: { required: { recall_event_id: "id", record_ids: "ids", occurred_at: "time" }, optional: {} },
  access_omitted: { required: { recall_event_id: "id", record_ids: "ids", reason: "reason", occurred_at: "time" }, optional: {} },
  consideration: {
    required: { access_ref: "id", memory_id: "id", disposition: ["not_applicable", "considered_rejected"], context_ref: "ref", occurred_at: "time" },
    optional: {},
  },
  application: {
    required: { access_ref: "id", memory_id: "id", target_ref: "ref", occurred_at: "time" },
    optional: { attribution: ["self_reported", "supported"], evidence_ref: "ref" },
  },
  outcome: {
    required: { memory_id: "id", target_ref: "ref", status: ["success", "failure", "unknown", "not_executed"], observed_at: "time" },
    optional: { access_ref: "id", evidence_ref: "ref" },
  },
  non_applicability: { required: { access_ref: "id", memory_id: "id", context_ref: "ref", reason: "reason", occurred_at: "time" }, optional: {} },
  correction: {
    required: { corrects_ref: "id", new_content_ref: "id", reason: "reason", occurred_at: "time" },
    optional: { approved_by: "ref" },
  },
  feedback: { required: { memory_id: "id", occurred_at: "time" }, optional: { access_ref: "id", detail: "str1024" } },
};

const ID_RE = /^[A-Za-z0-9_][A-Za-z0-9_.:-]*$/; // identifier alphabet, approximated (T-35)
const REF_RE = /^[^\s\x00-\x1f\x7f-\x9f]{1,256}$/u;
const TZ_RE = /(Z|[+-]\d\d:?\d\d)$/;

function check(rule: Rule | readonly string[], v: unknown): string | undefined {
  if (Array.isArray(rule)) return typeof v === "string" && rule.includes(v) ? undefined : `must be one of ${rule.join("|")}`;
  switch (rule as Rule) {
    case "id":
      return typeof v === "string" && v.length >= 1 && v.length <= 128 && ID_RE.test(v) ? undefined : "must be an identifier (1-128 chars)";
    case "ref":
      return typeof v === "string" && REF_RE.test(v) ? undefined : "must be an opaque reference (1-256 chars, no whitespace/control)";
    case "time":
      return typeof v === "string" && v.length <= 64 && !Number.isNaN(Date.parse(v)) && TZ_RE.test(v) ? undefined : "must be an ISO-8601 instant with an explicit timezone";
    case "reason":
      return typeof v === "string" && v.length >= 1 && v.length <= 1024 ? undefined : "must be 1-1024 characters";
    case "str1024":
      return typeof v === "string" && v.length <= 1024 ? undefined : "must be at most 1024 characters";
    case "ids":
      return Array.isArray(v) && v.length >= 1 && v.length <= 100 && v.every((x) => check("id", x) === undefined) && new Set(v).size === v.length
        ? undefined
        : "must be 1-100 distinct identifiers";
  }
}

export interface SchemaError {
  loc: string[];
  msg: string;
  type: string;
}

/** Errors Cortex would 422 on (empty array = accepted). Shape mirrors pydantic's `detail` list. */
export function validateMemoryEvent(body: unknown): SchemaError[] {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return [{ loc: ["body"], msg: "body must be an object", type: "model_attributes_type" }];
  const b = body as Record<string, unknown>;
  const kind = typeof b.kind === "string" ? b.kind : "";
  const spec = KINDS[kind];
  if (!spec) return [{ loc: ["body", "kind"], msg: `unknown kind; expected one of ${Object.keys(KINDS).join("|")}`, type: "union_tag_invalid" }];
  const errs: SchemaError[] = [];
  const at = (f: string) => ["body", kind, f];
  for (const [f, rule] of Object.entries(spec.required)) {
    if (!(f in b)) errs.push({ loc: at(f), msg: "Field required", type: "missing" });
    else {
      const m = check(rule, b[f]);
      if (m) errs.push({ loc: at(f), msg: m, type: "value_error" });
    }
  }
  for (const [f, rule] of Object.entries(spec.optional)) {
    if (f in b && b[f] !== null) {
      const m = check(rule, b[f]);
      if (m) errs.push({ loc: at(f), msg: m, type: "value_error" });
    }
  }
  for (const f of Object.keys(b)) {
    if (f !== "kind" && !(f in spec.required) && !(f in spec.optional)) errs.push({ loc: at(f), msg: "Extra inputs are not permitted", type: "extra_forbidden" });
  }
  if (kind === "outcome" && errs.length === 0) {
    const ev = b.evidence_ref != null;
    if ((b.status === "success" || b.status === "failure") && !ev) errs.push({ loc: at("evidence_ref"), msg: `outcome status '${b.status}' requires evidence_ref`, type: "value_error" });
    if ((b.status === "unknown" || b.status === "not_executed") && ev) errs.push({ loc: at("evidence_ref"), msg: `outcome status '${b.status}' must not carry evidence_ref`, type: "value_error" });
  }
  if (kind === "application" && b.attribution === "supported") errs.push({ loc: at("attribution"), msg: "supported_attribution_unavailable", type: "value_error" });
  return errs;
}
