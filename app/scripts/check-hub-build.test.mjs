// The hub bundle scan's own tests (Node's built-in runner, no dependencies). Run in app/:
//   node --test scripts/check-hub-build.test.mjs
// Each fixture under scripts/check-hub-build-fixtures/ is a bundle folder (a script and the esbuild metafile wrangler
// writes). Runs the script as CI does, with --deploy and --test: 0 only for a clean deployable bundle beside a caught
// test bundle, 1 for a refusal, 2 when the scan can't run.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const app = fileURLToPath(new URL('..', import.meta.url))
const FIXTURES = 'scripts/check-hub-build-fixtures'
const TEST = `${FIXTURES}/test-seam`

// Deployable fixture -> [exit code, what the output must name].
const EXPECTED = {
  'deploy-clean': [0, /ok {4}module graph: clean/],
  'deploy-dependency-testing': [0, /ok {4}module graph: clean/],
  'deploy-canary': [1, /FAIL {2}canary string: the deployable/],
  'deploy-shopify-canary': [1, /FAIL {2}shopify upstream canary: the deployable.*\n.*INHOUSE_SHOPIFY_UPSTREAM_CANARY_7c2d/],
  'deploy-mcp-canary': [1, /FAIL {2}mcp upstream canary: the deployable.*\n.*INHOUSE_MCP_UPSTREAM_CANARY_7c2d/],
  'deploy-hub-testing': [1, /module hub\/testing\/index\.ts/],
  'deploy-registry-testing': [1, /module hub\/registry\/testing\/fake-registry\.ts/],
  'deploy-test-module': [1, /module hub\/scope\/scope\.test\.ts/],
  'deploy-upstreams': [1, /module test\/upstreams\/shopify\/recorded\.ts/],
  'deploy-malformed-meta': [2, /isn't JSON/],
  'deploy-outputs-elsewhere': [2, /outputs aren't in .*\.\.\/dist-hub\/index\.js/],
  // Its output, from app/, lands outside app/; from app/hub/ it would be this folder's stale index.js.
  'deploy-stale-output': [2, /outputs aren't in .*deploy-stale-output\/index\.js/],
}

const run = (...args) => {
  const r = spawnSync(process.execPath, ['scripts/check-hub-build.mjs', ...args], { cwd: app, encoding: 'utf8' })
  return { status: r.status, out: r.stdout + r.stderr }
}

test('every fixture folder has an expectation, and every expectation a folder', () => {
  const dirs = readdirSync(join(app, FIXTURES)).filter(d => d !== 'test-seam').sort()
  assert.deepEqual(dirs, Object.keys(EXPECTED).sort())
})

for (const [dir, [status, pattern]] of Object.entries(EXPECTED)) {
  test(`${dir} exits ${status}`, () => {
    const r = run('--deploy', `${FIXTURES}/${dir}`, '--test', TEST)
    assert.equal(r.status, status, r.out)
    assert.match(r.out, pattern)
  })
}

test('a test bundle that is clean fails the scan: it proves nothing', () => {
  const r = run('--deploy', `${FIXTURES}/deploy-clean`, '--test', `${FIXTURES}/deploy-clean`)
  assert.equal(r.status, 1, r.out)
  assert.match(r.out, /found nothing in the test bundle/)
})

test('a missing folder or a flag with no value exits 2, never 0 or 1', () => {
  assert.equal(run('--deploy', `${FIXTURES}/does-not-exist`, '--test', TEST).status, 2)
  assert.equal(run('--deploy').status, 2)
})
