import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';

let requests = 0;
const server = createServer((_req, res) => { requests++; res.writeHead(500).end(); });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
after(() => server.close());
const endpoint = `http://127.0.0.1:${server.address().port}/mcp`;
const runtimeUrl = new URL('../core/runtime.ts', import.meta.url).href;
const cliPath = fileURLToPath(new URL('../dist/cli/continuity.js', import.meta.url));

async function run({ requested, configured = 'proj_alpha', auth = 'api-key', cwdName = 'beta', cli } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'gateway-scope-'));
  try {
    const cwd = join(root, cwdName);
    const config = join(root, '.config', 'continuity');
    const stateDir = join(root, 'state', 'continuity', 'tnt_test');
    mkdirSync(cwd, { recursive: true });
    mkdirSync(config, { recursive: true });
    mkdirSync(stateDir, { recursive: true });
    const sentinel = join(stateDir, 'proj_alpha.json');
    const content = '{"version":1,"pending":[],"shared":[],"sentinel":"unchanged"}';
    writeFileSync(sentinel, content);
    writeFileSync(join(config, 'config.json'), JSON.stringify({ gatewayUrl: endpoint, gatewayProfileId: configured, tenantId: 'tnt_test' }));
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(KEON_MCP_|CONTINUITY_|CORTEX_)/i.test(key)));
    Object.assign(env, { HOME: root, USERPROFILE: root, XDG_STATE_HOME: join(root, 'state') });
    if (auth === 'api-key') Object.assign(env, { KEON_MCP_API_KEY: 'fixture', KEON_MCP_TENANT_ID: 'tnt_test', KEON_MCP_ACTOR_ID: 'agent_test' });
    else env.KEON_MCP_BEARER_TOKEN = 'fixture';
    const script = `import {createRuntime} from ${JSON.stringify(runtimeUrl)};
      try { const r = await createRuntime(${JSON.stringify({ cwd, profileId: requested })});
        console.log(JSON.stringify({profileId:r.profileId,label:r.projectLabel,source:r.profileSource}));
      } catch(e) { console.log(JSON.stringify({error:e.name,message:e.message})); }`;
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, cli ? [cliPath, ...cli] : ['--input-type=module', '-e', script], { env, cwd });
      let stdout = '', stderr = '';
      child.stdout.on('data', chunk => stdout += chunk);
      child.stderr.on('data', chunk => stderr += chunk);
      child.on('error', reject);
      child.on('close', code => resolve({ code, stdout, stderr }));
    });
    assert.equal(readFileSync(sentinel, 'utf8'), content);
    assert.equal(existsSync(join(stateDir, 'proj_beta.json')), false);
    if (cli) return result;
    assert.equal(result.code, 0, result.stderr);
    return JSON.parse(result.stdout);
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test('Gateway rejects an incompatible explicit project before requests or state changes', async () => {
  for (const auth of ['api-key', 'bearer']) {
    const before = requests;
    const result = await run({ requested: 'proj_beta', auth });
    assert.equal(result.error, 'GatewayProfileError');
    assert.match(result.message, /proj_beta.*proj_alpha.*Nothing was sent/);
    assert.equal(requests, before);
  }
});

test('ordinary and explicit Gateway commands reject the mismatch before any operation', async () => {
  const before = requests;
  for (const args of [
    ['--as', 'codex', 'briefing'],
    ['--as', 'codex', 'remember', 'Synthetic note', '--user-confirmed'],
    ['--as', 'codex', 'outbox', 'flush'],
    ['gateway', 'recall', 'Synthetic note'],
  ]) {
    const result = await run({ cli: ['--project', 'proj_beta', ...args] });
    assert.equal(result.code, 5, result.stderr);
    assert.match(result.stderr, /proj_beta.*proj_alpha.*Nothing was sent/);
  }
  assert.equal(requests, before);
});

test('matching projects and aliases remain usable', async () => {
  assert.deepEqual(await run({ requested: 'proj_alpha' }), { profileId: 'proj_alpha', label: 'proj_alpha', source: 'explicit' });
  assert.deepEqual(await run({ requested: 'actor_me', configured: 'proj_me' }), { profileId: 'proj_me', label: 'actor_me', source: 'explicit' });
});

test('inferred project describes the effective Gateway profile', async () => {
  assert.deepEqual(await run(), { profileId: 'proj_alpha', label: 'proj_alpha', source: 'gateway' });
  assert.deepEqual(await run({ cwdName: 'alpha' }), { profileId: 'proj_alpha', label: 'alpha', source: 'cwd' });
  assert.deepEqual(await run({ configured: '', auth: 'bearer' }), { profileId: 'proj_beta', label: 'beta', source: 'cwd' });
});
