import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

const [archive, manifest] = process.argv.slice(2);
const npm = process.env.npm_execpath;
assert(archive && manifest && npm, 'Run npm run verify:release -- <tarball> <SHA256SUMS>.');

const tarball = resolve(archive);
const digest = createHash('sha256').update(readFileSync(tarball)).digest('hex');
assert.equal(readFileSync(manifest, 'utf8').trim(), `${digest}  ${basename(tarball)}`);

const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const scratch = mkdtempSync(join(tmpdir(), 'continuity-release-'));
const home = join(scratch, 'home');
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  !/^(CONTINUITY_|CORTEX_|KEON_MCP_)/i.test(key)));
Object.assign(env, { HOME: home, USERPROFILE: home, XDG_STATE_HOME: join(home, 'state') });

function run(args) {
  const result = spawnSync(process.execPath, [npm, ...args], { cwd: scratch, env, encoding: 'utf8' });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

try {
  mkdirSync(home);
  writeFileSync(join(scratch, 'package.json'), JSON.stringify({
    private: true,
    scripts: {
      'version:primary': 'continuity --version',
      'version:alias': 'kontinuity --version',
      'demo:installed': 'continuity demo --json',
    },
  }));
  run(['install', '--offline', '--no-audit', '--no-fund', '--no-package-lock', tarball]);
  for (const command of ['version:primary', 'version:alias']) {
    const output = run(['run', '--silent', command]);
    assert.equal(output.split(/\s+/).at(-1), version);
  }
  const demo = JSON.parse(run(['run', '--silent', 'demo:installed']));
  assert.equal(demo.synthetic, true);
  assert.deepEqual(demo.steps.map((step) => step.action), ['stage', 'private_read', 'confirm_share', 'shared_read']);
  console.log(`Verified ${basename(tarball)} (${digest}) on ${process.platform} ${process.version}.`);
} finally {
  if (dirname(resolve(scratch)) === resolve(tmpdir())) rmSync(scratch, { recursive: true, force: true });
}
