import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const cli = fileURLToPath(new URL('../dist/cli/continuity.js', import.meta.url));
const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url))).version;
function run(...args) {
  const cwd = mkdtempSync(join(tmpdir(), 'continuity-args-'));
  try {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(CONTINUITY_|CORTEX_|KEON_MCP_)/i.test(key)));
    Object.assign(env, { HOME: cwd, USERPROFILE: cwd, XDG_STATE_HOME: cwd });
    const result = spawnSync(process.execPath, [cli, ...args], { cwd, env, encoding: 'utf8' });
    return { ...result, files: readdirSync(cwd) };
  } finally { rmSync(cwd, { recursive: true, force: true }); }
}
test('help and package version work without identity or configuration', () => {
  for (const args of [['--help'], ['remember', '--help'], ['project', 'create', '--help'], ['gateway', 'login', '--help'], ['gateway', 'project', 'create', '--help'], ['demo', '--help']]) {
    const r = run(...args); assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /kontinuity/); assert.deepEqual(r.files, []);
  }
  for (const args of [['--version'], ['remember', '--version']]) assert.equal(run(...args).stdout.trim(), version);
});
test('invalid arguments fail before runtime setup or writes', () => {
  for (const args of [['remember', 'text', '--bogus'], ['stage', '--bogus'], ['unknown'], ['project', 'bogus'], ['gateway', 'bogus'], ['remember', '--as'], ['schema', 'propose', 'x', '--scope', 'wrong'], ['scorecard', '--days', '0']]) {
    const r = run(...args); assert.equal(r.status, 2, `${args}: ${r.stderr}`); assert.deepEqual(r.files, []); assert.doesNotMatch(r.stderr, /explicit agent identity|not configured/);
  }
});
test('literal text and legacy project and gateway options pass parsing', () => {
  for (const args of [['remember', '--', '--bogus'], ['project', 'create', '--title', 'Title', '--slug', 'slug', '--workspace', 'none', '--rigor', 'T1', '--adopt', '--provenance', 'owner'], ['gateway', 'login', '--endpoint', 'https://example.test', '--tenant', 'x', '--actor', 'x', '--profile', 'x', '--api-key', 'x', '--bearer', '--no-verify', '--help']]) {
    const r = run(...args); assert.doesNotMatch(r.stderr, /unknown option|requires a value|unknown command/);
  }
});
