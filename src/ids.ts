import { createHash, randomBytes } from "node:crypto";

/**
 * Cortex ids must match [A-Za-z0-9_.-]{1,128}. We mint `cont_<time36>_<hex>`:
 * sortable-ish, unique, and obviously ours when they show up in receipts.
 */
export function mintId(prefix = "cont"): string {
  const t = Date.now().toString(36);
  const r = randomBytes(8).toString("hex");
  return `${prefix}_${t}_${r}`;
}

/**
 * Deterministic id: the same logical operation always yields the same id, so a retry reuses
 * the operation identity instead of minting a new one (retries must not multiply reinforcement).
 * Parts are length-prefixed so ("ab","c") and ("a","bc") cannot collide.
 */
export function derivedId(prefix: string, ...parts: string[]): string {
  const h = createHash("sha256");
  for (const p of parts) h.update(`${p.length}:${p}\n`);
  return `${prefix}_${h.digest("hex").slice(0, 40)}`;
}

const ID_RE = /^[A-Za-z0-9_.-]{1,128}$/;

export function assertId(value: string, label: string): string {
  if (!ID_RE.test(value)) {
    throw new Error(`${label} must match [A-Za-z0-9_.-]{1,128}, got ${JSON.stringify(value)}`);
  }
  return value;
}

/** Turn an arbitrary string (git remote, dir name) into a safe id segment. */
export function slugify(input: string): string {
  const s = input
    .toLowerCase()
    .replace(/\.git$/, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64);
  return s.length > 0 ? s : "unnamed";
}
