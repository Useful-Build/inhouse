// scripts/check-product-build.mjs part 4: the test-build proof is always hard (exit 1 when the test build has no canary),
// whatever the server folder holds. Builds are fixtures in temp dirs.
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'
import { SCRIPTED_MODEL_CANARY } from '../test/scripted-model/index.ts'
import { TEST_CONTROLS_CANARY } from '../server/ops/test-controls.ts'

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
  // P4 wave 4: the message names the test controls too (was "has the test issuer or the scripted model").
  expect(r.stderr).toContain('has the test issuer, the scripted model or the test controls')
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

// P4 wave 4 (p4-w6.md OC 2): the test-build controls (server/ops/test-controls.ts, `@test-controls`, route 67) never ship,
// and once the server imports them the test build must carry their canary. The canary is written out here.
const CONTROLS = 'inhouse-test-controls-canary-5d81e0a7'
const IMPORTS_CONTROLS = { ...ISSUER_OK.server, 'ops/alarm-now.ts': "import { runAlarmNow } from '@test-controls'" }

test('the controls canary is the module\'s and the script\'s', () => {
  expect(TEST_CONTROLS_CANARY).toBe(CONTROLS)
  expect(readFileSync(script, 'utf8')).toContain(`const CONTROLS_CANARY = '${CONTROLS}'`)
})

test.each([
  ['its canary in the deployable Worker', { workerJs: `const c = '${CONTROLS}'` }],
  ['its module in the deployable Worker\'s graph', { serverModules: ['server/index.ts', 'server/ops/test-controls.ts'] }],
])('the test controls ship: %s fails the check', (_name, product) => {
  const r = run({ ...ISSUER_OK, product })
  expect(r.stderr).toContain('has the test issuer, the scripted model or the test controls')
  expect(r.status).toBe(1)
})

test('the off stand-in in the deployable Worker\'s graph passes', () => {
  const r = run({ ...ISSUER_OK, product: { serverModules: ['server/index.ts', 'server/ops/test-controls-off.ts'] } })
  expect(r.stderr).toBe('')
  expect(r.status).toBe(0)
})

test('the server imports @test-controls: the test build must carry their canary', () => {
  const without = run({ ...ISSUER_OK, server: IMPORTS_CONTROLS })
  expect(without.stderr).toContain('the server imports @test-controls but the test build')
  expect(without.status).toBe(1)
  const withIt = run({ server: IMPORTS_CONTROLS, productTest: { workerJs: `const c = '${CANARY}'; const t = '${CONTROLS}'` } })
  expect(withIt.stdout).toContain('ok    server bundle: caught the test controls in the test build.')
  expect(withIt.status).toBe(0)
})

// P4 (p4-h1.md OC 4): the hub is its own Worker. The product Worker names hub/index/contract.ts as types only.
test.each([
  ['a hub module in the deployable Worker\'s graph', { product: { serverModules: ['server/index.ts', 'hub/index/contract.ts'] } }, 'the product Worker reaches hub code'],
  ['a hub module in the test build\'s graph', { productTest: { workerJs: `const c = '${CANARY}'`, serverModules: ['server/index.ts', 'hub/signin/index.ts'] } }, "the test build's product Worker bundles hub modules"],
  ['a value import of the contract', { server: { 'egress/hub.ts': "import { ReadGateway } from '../../hub/index/contract.ts'" } }, "egress/hub.ts: import { ReadGateway } from '../../hub/index/contract.ts'"],
  ['an inline type import of the contract (kept as an import)', { server: { 'egress/hub.ts': "import { type ReadGateway } from '../../hub/index/contract.ts'" } }, 'egress/hub.ts: import { type ReadGateway }'],
  ['a type import of another hub file', { server: { 'egress/hub.ts': "import type { HubError } from '../../hub/index/errors.ts'" } }, 'hub/index/errors.ts'],
  ['a type re-export of the contract', { server: { 'egress/hub.ts': "export type { ReadGateway } from '../../hub/index/contract.ts'" } }, 'export type { ReadGateway }'],
  ['a dynamic import of a hub file', { server: { 'egress/hub.ts': "const m = await import('../../hub/index/index.ts')" } }, "import('../../hub/index/index.ts'"],
])('the hub: %s fails the check', (_name, setup, says) => {
  const r = run({ ...ISSUER_OK, ...setup, server: { ...ISSUER_OK.server, ...setup.server } })
  expect(r.stderr).toContain(says)
  expect(r.status).toBe(1)
})

test('the hub: `import type` of hub/index/contract.ts (with or without .ts, over lines) passes', () => {
  const server = {
    ...ISSUER_OK.server,
    'egress/hub.ts': "import type { ReadGateway } from '../../hub/index/contract.ts'",
    'egress/hub-two.ts': "import type {\n  CallerScope,\n  HubResult,\n} from '../../hub/index/contract'",
    'egress/hub.test.ts': "import { x } from '../../hub/index/index.ts'",
  }
  const r = run({ ...ISSUER_OK, server })
  expect(r.stderr).toBe('')
  expect(r.stdout).toContain('ok    hub: no hub module in the deployable Worker')
  expect(r.status).toBe(0)
})

// Review fold (#237): a build with no server-modules.json gets the clean "is missing" message, not a crash in the hub check.
test.each([['product'], ['productTest']])('no server-modules.json in the %s build: exit 2 with "is missing"', which => {
  const tmp = mkdtempSync(join(tmpdir(), 'check-product-build-'))
  const dirs = { product: build(join(tmp, 'product')), demo: build(join(tmp, 'demo'), { html: 'inhouse-canary:mock', clientModules: ['src/agent/mock.ts'], extra: { 'client/avatars/a.png': 'x' } }), productTest: build(join(tmp, 'product-test'), { workerJs: `const c = '${CANARY}'` }) }
  rmSync(join(dirs[which], 'server-modules.json'))
  const serverDir = join(tmp, 'server')
  mkdirSync(serverDir)
  const r = spawnSync('node', [script, '--product', dirs.product, '--demo', dirs.demo, '--product-test', dirs.productTest, '--server', serverDir], { encoding: 'utf8' })
  expect(r.stderr).toContain('server-modules.json is missing')
  expect(r.stderr).not.toContain('ENOENT')
  expect(r.status).toBe(2)
})
