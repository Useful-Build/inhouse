// The hub bundle scan's own tests (Node's built-in runner, no dependencies). Run in app/:
//   node --test scripts/check-hub-build.test.mjs
// Each fixture under scripts/check-hub-build-fixtures/ is a bundle folder (a script and the esbuild metafile wrangler
// writes). Runs the script as CI does, with --deploy and --test: 0 only for a clean deployable bundle beside a caught
// test bundle, 1 for a refusal, 2 when the scan can't run.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
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
  'deploy-shopify-write-canary': [1, /FAIL {2}shopify write upstream canary: the deployable.*\n.*INHOUSE_SHOPIFY_WRITE_UPSTREAM_CANARY_9f4e/],
  'deploy-mcp-canary': [1, /FAIL {2}mcp upstream canary: the deployable.*\n.*INHOUSE_MCP_UPSTREAM_CANARY_7c2d/],
  // Stage 1 M3-R (N30): the eval deployment's write log gateway is the test bundle's alone.
  'deploy-eval-write-gateway': [1, /FAIL {2}eval write gateway: the deployable.*\n.*"EvalWriteGateway" in/],
  // Stage 1 M3 (N31): the eval deployment's fake Slack workspace is the test bundle's alone.
  'deploy-eval-slack-canary': [1, /FAIL {2}eval slack canary: the deployable.*\n.*INHOUSE_EVAL_SLACK_CANARY_5d1e/],
  'deploy-fakes-canary': [1, /FAIL {2}test-fakes canary: the deployable.*\n.*INHOUSE_HUB_FAKES_CANARY_3a6f/],
  'deploy-fakes-globals': [1, /FAIL {2}test-fakes globals: the deployable.*\n.*__inhouseHubTestLogs/],
  // The deployable script keeps the define's dead branches as text: names inside `if (false)` only are fine.
  'deploy-fakes-globals-dead': [0, /ok {4}test-fakes globals: clean/],
  // A quote inside a regex in a dead block doesn't stretch the block: a global after it is still reachable code.
  'deploy-fakes-globals-regex': [1, /FAIL {2}test-fakes globals: the deployable.*\n.*__inhouseHubTestLogs.*outside/],
  // A dead block that never closes at its indentation fails the part, never counts the rest of the file as dead.
  'deploy-fakes-globals-unclosed': [1, /FAIL {2}test-fakes globals: the deployable.*\n.*never closes/],
  // An opener-looking line inside a template literal: the "block" holds a line no deeper than it, so the part fails as
  // ambiguous instead of counting the live global inside it as dead.
  'deploy-fakes-globals-template': [1, /FAIL {2}test-fakes globals: the deployable.*\n.*ambiguous/],
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

// Every shared test-fakes name, one by one: reachable in a deployable bundle it fails the scan naming it, and a test
// bundle that lacks it fails the scan too, so each name is proven present in the test bundle and absent from the deployable.
const FAKES_NAMES = [
  '__inhouseHubTestLogs',
  '"__test-fakes__"',
  '"test-fakes:vars"',
  '"X-Inhouse-Test-Throw"',
  '.testFakesOp(',
  '.testGetVars(',
  '.testRecordConnectBody(',
  '.testAppendLogs(',
]
const bundleFolder = (tmp, name, script) => {
  const dir = join(tmp, name)
  mkdirSync(dir)
  writeFileSync(join(dir, 'index.js'), script)
  const meta = JSON.parse(readFileSync(join(app, FIXTURES, 'deploy-clean/bundle-meta.json'), 'utf8'))
  writeFileSync(join(dir, 'bundle-meta.json'), JSON.stringify({ ...meta, outputs: { [join(dir, 'index.js')]: { bytes: script.length } } }))
  return dir
}
for (const name of FAKES_NAMES) {
  test(`test-fakes name ${name}: refused in the deployable bundle, required in the test bundle`, () => {
    const tmp = mkdtempSync(join(tmpdir(), 'check-hub-build-name-'))
    try {
      const seam = readFileSync(join(app, TEST, 'index.js'), 'utf8')
      const clean = bundleFolder(tmp, 'clean', 'export default 1\n')
      const leaky = bundleFolder(tmp, 'leaky', `const probe = 1\n${name}\n`)
      const found = run('--deploy', leaky, '--test', TEST)
      assert.equal(found.status, 1, found.out)
      assert.match(found.out, /FAIL {2}test-fakes globals: the deployable/)
      // The test bundle with this one name removed fails the names check.
      const without = bundleFolder(tmp, 'without', seam.split(name).join('REMOVED'))
      const stale = run('--deploy', clean, '--test', without)
      assert.equal(stale.status, 1, stale.out)
      assert.match(stale.out, /FAIL {2}test-fakes names: the test bundle .* lacks/)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
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

// The scan once hung at exit on the real bundles (node 26.13.1: a worker thread never joined, about 3 runs in 4) while
// every fixture passed: the fixtures are a few hundred bytes, the real script and map are megabytes and were read once
// per canary. Synthetic padded bundles never reproduced it, so this runs the real scan on the real bundles (CI builds
// them just before this test), 8 times, each under a time bound. Skipped, saying so, where the bundles aren't built.
const built = existsSync(join(app, 'dist-hub/bundle-meta.json')) && existsSync(join(app, 'dist-hub-test/bundle-meta.json'))
test('the scan finishes on the real hub bundles, every time', { skip: built ? false : 'run `npm run bundle` and `npm run bundle:test` in app/hub first' }, () => {
  for (let i = 0; i < 8; i++) {
    const r = spawnSync(process.execPath, ['scripts/check-hub-build.mjs'], { cwd: app, encoding: 'utf8', timeout: 20000 })
    assert.equal(r.error, undefined, `run ${i} did not finish in 20 s: ${r.error?.message}`)
    assert.equal(r.status, 0, `run ${i}: ${r.stdout}${r.stderr}`)
  }
})

// Regression: realistic multi-MB bundles with ~260 metafile inputs trigger concurrent Maglev compilation right before
// exit. Calling process.exit() from top-level ESM deadlocks Node 26's DisposePlatform() against Maglev's GC barrier;
// setting process.exitCode lets Node dispose the Isolate cleanly first.
test('realistic multi-MB bundles with hundreds of metafile inputs exit promptly without deadlocking', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'check-hub-build-large-'))
  try {
    const deployDir = join(tmp, 'deploy')
    const testDir = join(tmp, 'test')
    mkdirSync(deployDir)
    mkdirSync(testDir)
    const canaries = readFileSync(join(app, TEST, 'index.js'), 'utf8')
    const chunk = `export const a = 1; // ${'x'.repeat(100)}\n`
    const pad = bytes => chunk.repeat(Math.ceil(bytes / chunk.length))
    const deployInputs = Object.fromEntries(Array.from({ length: 250 }, (_, i) => [`hub/mod-${i}/index.ts`, { bytes: 100 }]))
    const testInputs = {
      ...deployInputs,
      'hub/testing/index.ts': { bytes: 100 },
      ...Object.fromEntries(Array.from({ length: 15 }, (_, i) => [`test/upstreams/mod-${i}.ts`, { bytes: 100 }])),
    }
    writeFileSync(join(deployDir, 'index.js'), pad(950_000))
    writeFileSync(join(deployDir, 'index.js.map'), pad(1_700_000))
    writeFileSync(join(deployDir, 'bundle-meta.json'), JSON.stringify({
      inputs: deployInputs,
      outputs: { [join(deployDir, 'index.js')]: { bytes: 950_000 } },
    }))
    writeFileSync(join(testDir, 'index.js'), `${pad(1_700_000)}\n${canaries}`)
    writeFileSync(join(testDir, 'index.js.map'), `${pad(2_600_000)}\n${canaries}`)
    writeFileSync(join(testDir, 'bundle-meta.json'), JSON.stringify({
      inputs: testInputs,
      outputs: { [join(testDir, 'index.js')]: { bytes: 1_700_000 } },
    }))

    for (let i = 0; i < 3; i++) {
      const r = spawnSync(process.execPath, ['scripts/check-hub-build.mjs', '--deploy', deployDir, '--test', testDir], {
        cwd: app,
        encoding: 'utf8',
        timeout: 10_000,
      })
      assert.equal(r.signal, null, `run ${i} hung and was killed by ${r.signal}`)
      assert.equal(r.status, 0, r.stdout + r.stderr)
      assert.match(r.stdout, /ok {4}module graph: caught the test bundle \(16 hits\)\./)
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})
