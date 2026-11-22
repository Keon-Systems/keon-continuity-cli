import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Read the installed package version in both source and compiled layouts. */
export function packageVersion(): string {
  const base = dirname(fileURLToPath(import.meta.url));
  const path = [join(base, "..", "package.json"), join(base, "..", "..", "package.json")].find(existsSync);
  if (!path) throw new Error("cannot locate package metadata");
  return JSON.parse(readFileSync(path, "utf8")).version;
}
