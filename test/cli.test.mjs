import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { FakeCortex } from './support/fake-cortex.ts';
import { testTmpDir } from './support/tmp.ts';

const cli = fileURLToPath(new URL('../dist/cli/continuity.js', import.meta.url));
const fake = await new FakeCortex().start();
fake.grantScopedReads = true;
fake.lexicalSearch = true;
after(() => fake.stop());

function machine() {
  const root = testTmpDir('continuity-cli-machine-');
  const configDir = join(root, '.config', 'continuity');
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, 'config.json'), JSON.stringify({
    cortexUrl: fake.url,
    tenantId: 'tnt_test',
    ownerActor: 'owner',
  }));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/^(KEON_MCP_|CONTINUITY_|CORTEX_)/i.test(key)));
  return {
    cwd: root,
    env: {
      ...env,
      HOME: root,
      USERPROFILE: root,
      XDG_STATE_HOME: join(root, 'state'),
      CORTEX_GATEWAY_SERVICE_SECRET: ['fixture', 'only', 'secret'].join('-'),
    },
  };
}

function run(args, machineConfig, input = '') {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], machineConfig);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}

test('malformed writes submit nothing and a delimiter preserves literal option-like notes', async () => {
  const local = machine();
  const identity = ['--as', 'codex', '--project', 'proj_arguments'];
  const before = fake.requests.length;
  const malformed = await run([...identity, 'remember', 'A fixture decision.', '--user-confirmed', '--ouput', 'json'], local);
  assert.equal(malformed.code, 2, malformed.stderr);
  assert.match(malformed.stderr, /unknown option "--ouput"/);
  assert.equal(fake.requests.length, before);

  const literal = await run([...identity, 'remember', '--user-confirmed', '--', '--example is a literal note.'], local);
  assert.equal(literal.code, 0, literal.stderr + literal.stdout);
  assert.ok([...fake.shards.values()].some((item) => item.content.includes('--example is a literal note.')));
});

test('the built CLI is usable and requires explicit runtime identity', async () => {
  const local = machine();
  const help = await run(['--help'], local);
  assert.equal(help.code, 0, help.stderr);
  assert.match(help.stdout, /briefing.*--ids/);
  const missingIdentity = await run(['status'], local);
  assert.equal(missingIdentity.code, 2);
  assert.match(missingIdentity.stderr, /requires an explicit agent identity/);
});

test('a staged record stays private until the owner confirms it, then another machine can brief', async () => {
  const first = machine();
  const second = machine();
  const claude = ['--as', 'claude', '--project', 'proj_release'];
  const codex = ['--as', 'codex', '--project', 'proj_release'];
  const record = 'Cap retry attempts at two for the release.';
  const staged = await run([...claude, 'stage'], first, JSON.stringify({
    decisions: [{ text: record, keywords: ['retry', 'limit', 'release'] }],
  }));
  assert.equal(staged.code, 0, staged.stderr + staged.stdout);
  const pending = await run([...claude, 'pending'], first);
  assert.equal(pending.code, 0, pending.stderr);
  assert.match(pending.stdout, /Cap retry attempts at two/);
  const source = [...fake.shards.values()].find((item) => item.content.includes(record));
  assert.ok(source);
  const before = await run([...codex, 'briefing'], second);
  assert.equal(before.code, 0, before.stderr);
  assert.doesNotMatch(before.stdout, /Cap retry attempts at two/);
  const unconfirmed = await run([...claude, 'share', source.id], first);
  assert.equal(unconfirmed.code, 3, unconfirmed.stderr);
  const shared = await run([...claude, 'share', source.id, '--user-confirmed'], first);
  assert.equal(shared.code, 0, shared.stderr + shared.stdout);
  const afterShare = await run([...codex, 'briefing'], second);
  assert.equal(afterShare.code, 0, afterShare.stderr);
  assert.match(afterShare.stdout, /Cap retry attempts at two/);
});
