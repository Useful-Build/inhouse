// scripts/check-product-build.mjs part 4: the test-build proof is always hard (exit 1 when the test build has no canary),
// whatever the server folder holds. Part 5: the eval trace in the eval build only. Builds are fixtures in temp dirs.
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'
import { SCRIPTED_MODEL_CANARY } from '../test/scripted-model/index.ts'
import { EVAL_TRACE_CANARY } from '../server/eval-trace/on.ts'

const script = fileURLToPath(new URL('./check-product-build.mjs', import.meta.url))
const CANARY = 'INHOUSE_TEST_ISSUER_CANARY_7f3c'
const put = (file, text) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, text) }

/** A build folder as the Vite plugin writes it: client/, client-modules.json, one Worker folder, server-modules.json. */
function build(dir, { html = '<p>ok</p>', clientModules = ['src/main.tsx'], workerJs = 'export default {}', serverModules = ['server/index.ts'], extra = {} } = {}) {
  put(join(dir, 'client/index.html'), html)
  put(join(dir, 'client-modules.json'), JSON.stringify(clientModules))
  put(join(dir, 'inhouse_product/wrangler.json'), '{}')
  put(join(dir, 'inhouse_product/index.js'), workerJs)
  put(join(dir, 'server-modules.json'), JSON.stringify(serverModules))
  for (const [rel, text] of Object.entries(extra)) put(join(dir, rel), text)
  return dir
}

// The eval build as vite.config.ts makes it: the eval trace's module in its graph and its canary in its Worker.
const EVAL = 'inhouse-eval-trace-canary-5d1e8a40'
const EVAL_MODULE = 'server/eval-trace/on.ts'
const EVAL_OK = { workerJs: `const f = 'eval (${EVAL})'`, serverModules: ['server/index.ts', EVAL_MODULE, 'server/eval-trace/off.ts'] }

function run({ server = {}, productTest = {}, product: productOpts = {}, productEval = EVAL_OK } = {}) {
  const tmp = mkdtempSync(join(tmpdir(), 'check-product-build-'))
  const product = build(join(tmp, 'product'), productOpts)
  // The demo build trips parts 1 to 3: a marker canary, a mock module and a public-demo/ file.
  const demo = build(join(tmp, 'demo'), { html: 'inhouse-canary:mock', clientModules: ['src/agent/mock.ts'], extra: { 'client/avatars/a.png': 'x' } })
  const test = build(join(tmp, 'product-test'), productTest)
  // null: no eval build folder at all.
  const evalBuild = productEval === null ? join(tmp, 'product-eval') : build(join(tmp, 'product-eval'), productEval)
  const serverDir = join(tmp, 'server')
  mkdirSync(serverDir)
  for (const [rel, text] of Object.entries(server)) put(join(serverDir, rel), text)
  return spawnSync('node', [script, '--product', product, '--demo', demo, '--product-test', test, '--product-eval', evalBuild, '--server', serverDir], { encoding: 'utf8' })
}

const PROOF_FAILED = `no "${CANARY}" in the test build`

test.each([
  ['nothing test-issuer shaped anywhere', {}],
  ['server/auth/test-issuer.ts exists', { server: { 'auth/test-issuer.ts': 'export {}' } }],
  ['the canary is in a file under server/', { server: { 'auth/other.ts': `export const c = '${CANARY}'` } }],
  ['the test build lists a test-issuer module', { productTest: { serverModules: ['server/index.ts', 'server/auth/test-issuer.ts'] } }],
])('%s: the proof fails with no canary in the test build', (_name, setup) => {
  const r = run(setup)
  expect(r.stderr).toContain(PROOF_FAILED)
  expect(r.stdout).not.toContain('note  server bundle')
  expect(r.status).toBe(1)
})

test('the issuer exists and the test build has the canary: the proof passes', () => {
  const r = run({ server: { 'auth/test-issuer.ts': `export const c = '${CANARY}'` }, productTest: { workerJs: `const c = '${CANARY}'` } })
  expect(r.stdout).toContain('ok    server bundle: caught the test build')
  expect(r.status).toBe(0)
})

// P3 PR0: the scripted model (app/test/scripted-model/) never ships, and once the server imports it the test build must
// carry its canary. The canary is written out here, and checked against the module's own constant and the script's.
const SCRIPTED = 'inhouse-scripted-model-canary-7f3c9b21'
const ISSUER_OK = { server: { 'auth/test-issuer.ts': `export const c = '${CANARY}'` }, productTest: { workerJs: `const c = '${CANARY}'` } }

test('the scripted canary is the module\'s and the script\'s', () => {
  expect(SCRIPTED_MODEL_CANARY).toBe(SCRIPTED)
  expect(readFileSync(script, 'utf8')).toContain(`const SCRIPTED_CANARY = '${SCRIPTED}'`)
})

test.each([
  ['its canary in the deployable Worker', { workerJs: `const c = '${SCRIPTED}'` }],
  ['its module in the deployable Worker\'s graph', { serverModules: ['server/index.ts', 'test/scripted-model/index.ts'] }],
])('the scripted model ships: %s fails the check', (_name, product) => {
  const r = run({ ...ISSUER_OK, product })
  expect(r.stderr).toContain('has the test issuer or the scripted model')
  expect(r.status).toBe(1)
})

test('the server imports @scripted-model: the test build must carry its canary', () => {
  const server = { ...ISSUER_OK.server, 'egress/model.ts': "import { createScriptedModel } from '@scripted-model'" }
  const without = run({ ...ISSUER_OK, server })
  expect(without.stderr).toContain(`the server imports @scripted-model but the test build`)
  expect(without.status).toBe(1)
  const withIt = run({ server, productTest: { workerJs: `const c = '${CANARY}'; const s = '${SCRIPTED}'` } })
  expect(withIt.stdout).toContain('ok    server bundle: caught the scripted model in the test build.')
  expect(withIt.status).toBe(0)
})

test('nothing imports @scripted-model yet: a note, and a test build without its canary passes', () => {
  const r = run(ISSUER_OK)
  expect(r.stdout).toContain('note  scripted model: no server source imports @scripted-model yet')
  expect(r.status).toBe(0)
  // A test file importing it doesn't count: only what the Worker can bundle.
  const testOnly = run({ ...ISSUER_OK, server: { ...ISSUER_OK.server, 'egress/model.test.ts': "import { x } from '@scripted-model'" } })
  expect(testOnly.status).toBe(0)
})

// Part 5 (p3-eval-observability rev 2, rec 1): the eval trace (`@eval-trace`, server/eval-trace/on.ts) is in the eval build
// and nowhere else; the eval build has no scripted model. Ways it can fail, written down first:
//  1. the eval trace's canary or module reaches the deployable Worker;
//  2. it reaches the test build (built from PR code on every PR, so its `io` path must not ride along);
//  3. the eval build has no canary or no module, so the scan proves nothing (it scanned the wrong folder, or the alias
//     stopped resolving to on.ts);
//  4. the eval build carries the scripted model (a paid eval would grade it);
//  5. the canary written here drifts from the module's and the script's.
test('the eval canary is the module\'s and the script\'s (failure 5)', () => {
  expect(EVAL_TRACE_CANARY).toBe(EVAL)
  expect(readFileSync(script, 'utf8')).toContain(`const EVAL_CANARY = '${EVAL}'`)
})

test('the eval build carries the eval trace and the others don\'t: the check passes', () => {
  const r = run(ISSUER_OK)
  expect(r.stdout).toContain('ok    eval trace: not in the deployable Worker')
  expect(r.stdout).toContain('ok    eval trace: not in the test build')
  expect(r.stdout).toContain('ok    eval trace: caught the eval build')
  expect(r.status).toBe(0)
})

test.each([
  ['its canary in the deployable Worker', 'product', { workerJs: `const f = 'eval (${EVAL})'` }, 'the deployable Worker'],
  ['its module in the deployable Worker\'s graph', 'product', { serverModules: ['server/index.ts', EVAL_MODULE] }, 'the deployable Worker'],
  ['its canary in the test build', 'productTest', { workerJs: `const c = '${CANARY}'; const f = '${EVAL}'` }, 'the test build'],
  ['its module in the test build\'s graph', 'productTest', { workerJs: `const c = '${CANARY}'`, serverModules: ['server/index.ts', EVAL_MODULE] }, 'the test build'],
])('the eval trace ships: %s fails the check (failures 1, 2)', (_name, where, opts, label) => {
  const r = run({ ...ISSUER_OK, [where]: opts })
  expect(r.stderr).toContain(`FAIL  eval trace: ${label}`)
  expect(r.status).toBe(1)
})

test.each([
  ['no canary', { workerJs: 'export default {}', serverModules: ['server/index.ts', EVAL_MODULE] }],
  ['no module', { workerJs: `const f = 'eval (${EVAL})'`, serverModules: ['server/index.ts', 'server/eval-trace/off.ts'] }],
])('the eval build has %s: the scan proves nothing and fails (failure 3)', (_name, productEval) => {
  const r = run({ ...ISSUER_OK, productEval })
  expect(r.stderr).toContain('FAIL  eval trace: the eval build')
  expect(r.status).toBe(1)
})

test.each([
  ['its canary', { workerJs: `const f = 'eval (${EVAL})'; const s = '${SCRIPTED}'` }],
  ['its module', { ...EVAL_OK, serverModules: [...EVAL_OK.serverModules, 'test/scripted-model/index.ts'] }],
])('the scripted model in the eval build (%s) fails the check (failure 4)', (_name, productEval) => {
  const r = run({ ...ISSUER_OK, productEval })
  expect(r.stderr).toContain('FAIL  eval trace: the eval build carries the scripted model')
  expect(r.status).toBe(1)
})

test('no eval build folder: a usage failure (exit 2), never a pass (failure 3)', () => {
  const r = run({ ...ISSUER_OK, productEval: null })
  expect(r.stderr).toContain('product-eval build folder')
  expect(r.status).toBe(2)
})
