/** Test-only scratch directories. Never import this helper from production code. */
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { after } from "node:test";

// Install at import time, in the file's root scope. Calling the global after()
// inside beforeEach attaches to the *hook* and removes its fixture before the
// test body; helpers reached through async setup can inherit that same scope.
// File-scoped ownership also keeps shared HOME/state alive for later tests.
const directories: string[] = [];
// This root hook precedes later after() hooks. Fixtures holding deletion-blocking
// handles must close them before removal; ordinary fixture files hold no handles.
// A plain script (smoke/linux-occupancy-recovery-native.mjs) imports testTmpDir and
// removes its own directory. Calling after() outside node --test starts the test
// runner, which appends TAP and turns an assertion failure into exit 7. Under
// node --test, NODE_TEST_CONTEXT is set before this module evaluates.
if (process.env.NODE_TEST_CONTEXT) {
  after(() => {
    for (const dir of directories.reverse()) {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
    }
  });
}

/**
 * Enrol immediately, before fixture setup can throw. Every directory is removed
 * at file teardown, even on assertion failures. Resolve macOS temp symlinks so
 * git worktree paths compare correctly. Never use an unregistered fs.mkdtemp.
 */
export function testTmpDir(prefix = "continuity-test-"): string {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), prefix));
  directories.push(dir);
  return dir;
}

/**
 * Prove a path a test intentionally leaves behind (a product salvage directory, a
 * deliberate trap fixture) sits INSIDE a registered fixture root. The suite temp guard
 * would report a mis-owned path only at the very end, anonymously; this fails at the
 * point of creation, with the test's name attached. It never replaces or weakens the
 * guard — it is an earlier, attributed failure for the same condition.
 */
export function assertOwnedByFixture(target: string, what = "path"): void {
  const norm = (p: string): string => (process.platform === "win32" ? p.toLowerCase() : p);
  const t = norm(resolve(target));
  const owned = directories.some((d) => t === norm(d) || t.startsWith(norm(d) + sep));
  assert.ok(owned, `${what} (${target}) must live inside a registered testTmpDir — anything outside it is exactly what the suite temp guard reports as a leak`);
}

/**
 * Chromium may terminate a renderer between creating and unlinking a shared-memory
 * backing file (--disable-dev-shm-usage). Playwright owns its profile/artifacts,
 * not arbitrary files in the inherited suite TMPDIR. Give each browser launch a
 * registered scratch root, removed at file teardown AFTER awaited browser.close().
 * Keep the prefix short: Chromium's Unix singleton socket has a 108-byte path limit.
 * Pass this environment to the browser only; never mutate the test/suite environment.
 */
export function testBrowserEnv(): NodeJS.ProcessEnv {
  const root = testTmpDir("ctb-");
  return { ...process.env, TMPDIR: root, TMP: root, TEMP: root };
}
