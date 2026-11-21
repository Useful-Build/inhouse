// scripts/check-product-build.mjs part 4: the test-build proof is always hard (exit 1 when the test build has no canary),
// whatever the server folder holds. Builds are fixtures in temp dirs.
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'
import { SCRIPTED_MODEL_CANARY } from '../test/scripted-model/index.ts'

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

function run({ server = {}, productTest = {}, product: productOpts = {} } = {}) {
  const tmp = mkdtempSync(join(tmpdir(), 'check-product-build-'))
  const product = build(join(tmp, 'product'), productOpts)
  // The demo build trips parts 1 to 3: a marker canary, a mock module and a public-demo/ file.
  const demo = build(join(tmp, 'demo'), { html: 'inhouse-canary:mock', clientModules: ['src/agent/mock.ts'], extra: { 'client/avatars/a.png': 'x' } })
  const test = build(join(tmp, 'product-test'), productTest)
  const serverDir = join(tmp, 'server')
  mkdirSync(serverDir)
  for (const [rel, text] of Object.entries(server)) put(join(serverDir, rel), text)
  return spawnSync('node', [script, '--product', product, '--demo', demo, '--product-test', test, '--server', serverDir], { encoding: 'utf8' })
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
