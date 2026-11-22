import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { runHandoffDemo, renderHandoffDemo } from "../dist/core/demo.js";

test("synthetic handoff stages privately, then shares after confirmation", async () => {
  const result = await runHandoffDemo();
  assert.deepEqual(result, await runHandoffDemo());
  assert.equal(result.synthetic, true);
  assert.deepEqual(result.steps.map(s => s.action), ["stage", "private_read", "confirm_share", "shared_read"]);
  assert.match(renderHandoffDemo(result), /Agent B cannot see the private decision/);
  assert.match(renderHandoffDemo(result), /Agent B can now see the shared decision/);
  assert.match(renderHandoffDemo(result), /Synthetic confirmation/);
});

test("demo ignores caller config, performs no network, and leaves files unchanged", async () => {
  const dir = await mkdtemp(join(tmpdir(), "continuity-demo-test-"));
  try {
    const marker = "<!-- continuity:begin -->\nkeep me\n<!-- continuity:end -->\n";
    await writeFile(join(dir, "AGENTS.md"), marker);
    const module = resolve("dist/core/demo.js");
    const script = `globalThis.fetch = () => { throw new Error('network attempted'); }; const m = await import(${JSON.stringify(new URL(`file:///${module.replaceAll("\\", "/")}`).href)}); console.log(JSON.stringify(await m.runHandoffDemo()));`;
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], { cwd: dir, encoding: "utf8", env: { ...process.env, HOME: dir, USERPROFILE: dir, XDG_STATE_HOME: dir, CONTINUITY_SECRET: "must-not-be-used", CONTINUITY_URL: "http://invalid.example" } });
    assert.equal(child.status, 0, child.stderr);
    assert.equal(JSON.parse(child.stdout).synthetic, true);
    assert.equal(await readFile(join(dir, "AGENTS.md"), "utf8"), marker);
    assert.deepEqual(await readdir(dir), ["AGENTS.md"]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
