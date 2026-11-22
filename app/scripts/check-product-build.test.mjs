// scripts/check-product-build.mjs part 4: the test-build proof is always hard (exit 1 when the test build has no canary),
// whatever the server folder holds. Part 6: the eval trace in the eval build only. Part 7: the test shop. Part 8: the test
// issuer's header. Builds are fixtures in temp dirs.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'
import { SCRIPTED_MODEL_CANARY } from '../test/scripted-model/index.ts'
import { TEST_CONTROLS_CANARY } from '../server/ops/test-controls.ts'
import { EVAL_TRACE_CANARY } from '../server/eval-trace/on.ts'
import { TEST_SHOP_CANARY } from '../server/egress/test-shop.ts'
import { TEST_ASSERTION_HEADER } from '../server/auth/test-issuer.ts'

const script = fileURLToPath(new URL('./check-product-build.mjs', import.meta.url))
const CANARY = 'INHOUSE_TEST_ISSUER_CANARY_7f3c'
/** Part 8: the test and eval builds name the test issuer's header (authenticate.ts reads it behind Access). */
const HEADER = 'X-Inhouse-Test-Assertion'
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
const EVAL_OK = { workerJs: `const f = 'eval (${EVAL})'; const h = '${HEADER}'`, serverModules: ['server/index.ts', EVAL_MODULE, 'server/eval-trace/off.ts'] }

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
  const r = run({ server: { 'auth/test-issuer.ts': `export const c = '${CANARY}'` }, productTest: { workerJs: `const c = '${CANARY}'; const h = '${HEADER}'` } })
  expect(r.stdout).toContain('ok    server bundle: caught the test build')
  expect(r.status).toBe(0)
})

// P3 PR0: the scripted model (app/test/scripted-model/) never ships, and once the server imports it the test build must
// carry its canary. The canary is written out here, and checked against the module's own constant and the script's.
const SCRIPTED = 'inhouse-scripted-model-canary-7f3c9b21'
const ISSUER_OK = { server: { 'auth/test-issuer.ts': `export const c = '${CANARY}'` }, productTest: { workerJs: `const c = '${CANARY}'; const h = '${HEADER}'` } }

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
  const withIt = run({ server, productTest: { workerJs: `const c = '${CANARY}'; const s = '${SCRIPTED}'; const h = '${HEADER}'` } })
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
  const withIt = run({ server: IMPORTS_CONTROLS, productTest: { workerJs: `const c = '${CANARY}'; const t = '${CONTROLS}'; const h = '${HEADER}'` } })
  expect(withIt.stdout).toContain('ok    server bundle: caught the test controls in the test build.')
  expect(withIt.status).toBe(0)
})

test('the routine tick\'s hook alone (routines/tick.ts) also makes the test build carry the controls\' canary', () => {
  const r = run({ ...ISSUER_OK, server: { ...ISSUER_OK.server, 'routines/tick.ts': "import { afterTickBatch } from '@test-controls'" } })
  expect(r.stderr).toContain('the server imports @test-controls but the test build')
  expect(r.status).toBe(1)
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

// Part 6 (p3-eval-observability rev 2, rec 1): the eval trace (`@eval-trace`, server/eval-trace/on.ts) is in the eval build
// and nowhere else; the eval build has no scripted model. Ways it can fail, written down first:
//  1. the eval trace's canary or module reaches the deployable Worker;
//  2. it reaches the test build (built from PR code on every PR, so its `io` path must not ride along);
//  3. the eval build has no canary or no module, so the scan proves nothing (it scanned the wrong folder, or the alias
//     stopped resolving to on.ts);
//  4. the eval build carries the scripted model (a paid eval would grade it);
//  5. the canary or module path written here drifts from the module's, the script's and vite.config.ts's alias.
test('the eval canary is the module\'s and the script\'s (failure 5)', () => {
  expect(EVAL_TRACE_CANARY).toBe(EVAL)
  expect(readFileSync(script, 'utf8')).toContain(`const EVAL_CANARY = '${EVAL}'`)
})

test('the eval module path is the real file and the one vite.config.ts aliases (failure 5)', () => {
  const source = readFileSync(script, 'utf8')
  const path = /const EVAL_MODULE_PATH = '([^']+)'/.exec(source)?.[1]
  expect(path).toBe(EVAL_MODULE)
  const app = fileURLToPath(new URL('..', import.meta.url))
  expect(existsSync(join(app, path))).toBe(true)
  expect(readFileSync(join(app, 'vite.config.ts'), 'utf8')).toContain(`'./${path}'`)
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

// Part 7: the test shop override (server/egress/test-shop.ts, `@test-shop`). Ways it can fail, written down first: the
// deployable Worker carries its module, its canary or the hub option's name (the product could then send an override);
// once the server imports `@test-shop`, the test or the eval build lacks the canary or the module, so the scan proves
// nothing; the script's canary or module path drifts from the module's and vite.config.ts's alias.
const SHOP = 'inhouse-test-shop-canary-9c4e17b2'
const SHOP_MODULE = 'server/egress/test-shop.ts'
const SHOP_IMPORT = { 'egress/index.ts': "import { withTestShop } from '@test-shop'" }
const shopIn = (opts) => ({ ...opts, workerJs: `${opts.workerJs ?? ''}; const t = '${SHOP}'; o.testShopHost = h`, serverModules: [...(opts.serverModules ?? ['server/index.ts']), SHOP_MODULE] })
const SHOP_OK = { server: { ...ISSUER_OK.server, ...SHOP_IMPORT }, productTest: shopIn(ISSUER_OK.productTest), productEval: shopIn(EVAL_OK) }

test('the test shop canary and module are the module\'s, the script\'s and the alias\'s (part 7)', () => {
  expect(TEST_SHOP_CANARY).toBe(SHOP)
  const source = readFileSync(script, 'utf8')
  expect(source).toContain(`const TEST_SHOP_CANARY = '${SHOP}'`)
  expect(source).toContain("const TEST_SHOP_OPTION = 'testShopHost'")
  const app = fileURLToPath(new URL('..', import.meta.url))
  expect(existsSync(join(app, SHOP_MODULE))).toBe(true)
  expect(readFileSync(join(app, 'vite.config.ts'), 'utf8')).toContain(`'./${SHOP_MODULE}'`)
  expect(readFileSync(join(app, 'hub/index/contract.ts'), 'utf8')).toContain('export type CallToolOptions = { testShopHost?: string }')
})
test('the test and eval builds carry the override and the deployable Worker doesn\'t: the check passes (part 7)', () => {
  const r = run(SHOP_OK)
  expect(r.stdout).toContain('ok    test shop: not in the deployable Worker')
  expect(r.stdout).toContain('ok    test shop: caught the test build.')
  expect(r.stdout).toContain('ok    test shop: caught the eval build.')
  expect(r.status).toBe(0)
})
test.each([
  ['its canary', { workerJs: `const t = '${SHOP}'` }],
  ['the option\'s name', { workerJs: 'o.testShopHost = h' }],
  ['its module', { serverModules: ['server/index.ts', SHOP_MODULE] }],
])('the deployable Worker carrying %s fails the check (part 7)', (_label, product) => {
  const r = run({ ...SHOP_OK, product })
  expect(r.stderr).toContain('FAIL  test shop: the deployable Worker')
  expect(r.status).toBe(1)
})
test('the off stand-in in the deployable Worker\'s graph passes (part 7)', () => {
  const r = run({ ...SHOP_OK, product: { serverModules: ['server/index.ts', 'server/egress/test-shop-off.ts'] } })
  expect(r.stdout).toContain('ok    test shop: not in the deployable Worker')
  expect(r.status).toBe(0)
})
test.each([
  ['the test build', 'no "inhouse-test-shop-canary-9c4e17b2"', { productTest: { ...ISSUER_OK.productTest, serverModules: ['server/index.ts', SHOP_MODULE] } }],
  ['the test build', 'no server/egress/test-shop.ts module', { productTest: { workerJs: `const c = '${CANARY}'; const t = '${SHOP}'` } }],
  ['the eval build', 'no "inhouse-test-shop-canary-9c4e17b2"', { productEval: { ...EVAL_OK, serverModules: [...EVAL_OK.serverModules, SHOP_MODULE] } }],
  ['the eval build', 'no server/egress/test-shop.ts module', { productEval: { ...EVAL_OK, workerJs: `${EVAL_OK.workerJs}; const t = '${SHOP}'` } }],
])('the server imports @test-shop and %s has %s: the scan proves nothing (part 7)', (label, missing, opts) => {
  const r = run({ ...SHOP_OK, ...opts })
  expect(r.stderr).toContain(`FAIL  test shop: the server imports @test-shop but ${label}`)
  expect(r.stderr).toContain(missing)
  expect(r.status).toBe(1)
})
test('nothing imports @test-shop: a note, and builds without it pass (part 7)', () => {
  const r = run(ISSUER_OK)
  expect(r.stdout).toContain('note  test shop: no server source imports @test-shop')
  expect(r.status).toBe(0)
})

// Part 8: the test issuer's header (eval behind Access). Ways it can fail, written down first: the deployable Worker names
// it, in any case (its authenticate.ts would read a second token source); the test or the eval build lacks it, so the
// scan proves nothing and the eval build can't sign its people in behind Access; the script's name drifts from the module's.
test('the header is the module\'s and the script\'s (part 8)', () => {
  expect(TEST_ASSERTION_HEADER).toBe(HEADER)
  expect(readFileSync(script, 'utf8')).toContain(`const TEST_ASSERTION = '${HEADER}'`)
})
test('the test and eval builds name the header and the deployable Worker doesn\'t: the check passes (part 8)', () => {
  const r = run(ISSUER_OK)
  expect(r.stdout).toContain('ok    test issuer\'s header: not in the deployable Worker')
  expect(r.stdout).toContain('ok    test issuer\'s header: caught the test build.')
  expect(r.stdout).toContain('ok    test issuer\'s header: caught the eval build.')
  expect(r.status).toBe(0)
})
test.each([HEADER, HEADER.toLowerCase()])('the deployable Worker naming %s fails the check (part 8)', (name) => {
  const r = run({ ...ISSUER_OK, product: { workerJs: `h.get('${name}')` } })
  expect(r.stderr).toContain('FAIL  test issuer\'s header: the deployable Worker')
  expect(r.status).toBe(1)
})
test.each([
  ['the test build', { productTest: { workerJs: `const c = '${CANARY}'` } }],
  ['the eval build', { productEval: { ...EVAL_OK, workerJs: `const f = 'eval (${EVAL})'` } }],
])('%s without the header fails: the scan proves nothing (part 8)', (label, opts) => {
  const r = run({ ...ISSUER_OK, ...opts })
  expect(r.stderr).toContain(`FAIL  test issuer's header: no "${HEADER}" in ${label}`)
  expect(r.status).toBe(1)
})
