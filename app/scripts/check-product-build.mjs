// The product build check (P1, C8; part 4 P2; part 5 the hub, P4; part 6 the eval build). Run in app/ after `npm run build`,
// `npm run build:product`, `npm run build:product-test` and `npm run build:product-eval`:
//   node scripts/check-product-build.mjs                      checks dist-product/ (must pass) and dist/ (must fail)
//   node scripts/check-product-build.mjs --product DIR --demo DIR --product-test DIR --product-eval DIR   other folders
//   ... --server DIR   the server source part 4 looks in for the test issuer (default server/; its tests use fixtures)
// The product build ships no sample data, mock code, demo controls or demo clock. Three client-output parts (1 to 3), each run on both builds:
//   1. Canary strings in the client output: the sample brand's and people's names, the brand's email domain and the user's
//      email (read from src/agent/sample-data/) and a
//      marker constant each from mock.ts, demo-controls.ts and demo-clock.ts. Unique strings only, never common words or
//      method names a library also uses.
//   2. The module graph: the build writes every module id it bundled to <build>/client-modules.json (vite.config.ts,
//      writeModuleList). Fails when a module under src/agent/sample-data/, or mock, demo-controls, demo-clock or client.demo,
//      is in it. A string scan alone can't prove a tree-shaken or renamed import is gone.
//   3. Copied files: no file of public-demo/ (the demo-only public files; its top-level entries make the pattern) in the client output.
// The same three parts run on the demo build and must each FAIL there: a check that passes on the demo scanned the wrong
// folder or looks for the wrong thing, so it can't go green by accident. Exit code 0 only when the product build is clean
// and every part caught the demo.
//   4. The server bundle scan (P2): the deployable Worker output (the product build's Worker folder, the one with a
//      wrangler.json beside client/, which `wrangler deploy -c <it>/wrangler.json` uploads as built) holds no test-issuer
//      canary (INHOUSE_TEST_ISSUER_CANARY_7f3c) and no `test-issuer` module in its graph (<build>/server-modules.json).
//      Its proof is the test build (dist-product-test/), where the canary MUST always be found: with no canary there
//      the scan proves nothing, and the check fails.
//      P3 PR0: the same for the scripted model (app/test/scripted-model/, `@scripted-model` in vite.config.ts): its canary
//      (SCRIPTED_MODEL_CANARY) and its modules never in the deployable Worker. Its proof in the test build is required
//      as soon as any server source imports `@scripted-model` (W3 wires it into the egress); until then it's a note.
//      P4 wave 4: the same for the test-build controls (server/ops/test-controls.ts, `@test-controls`, route 67): their
//      canary (TEST_CONTROLS_CANARY) and module never in the deployable Worker; their proof in the test build is required
//      as soon as any server source imports `@test-controls`.
//   5. The hub (P4, p4-h1.md OC 4): the connector hub is its own Worker, reached only through the HUB service binding. No
//      module under hub/ in either Worker's graph, and a server source may name a hub file only as `import type` of
//      hub/index/contract.ts (plain types, erased at build). The hub's own bundles keep their scan (check-hub-build.mjs).
//   6. The eval trace (p3-eval-observability rev 2, rec 1): `@eval-trace` resolves to server/eval-trace/on.ts in the eval
//      build only (vite.config.ts). Its canary (EVAL_CANARY) and that module are in neither the deployable Worker nor the
//      test build's (built from PR code on every PR); the eval build must carry both, or the scan proves nothing; and the
//      eval build carries no scripted model (it runs the real model).
//   8. The test-fakes hook (P5 W5, route 76): `@test-fakes` resolves to server/ops/test-fakes.ts in the test build only
//      (vite.config.ts), not in the eval build, which is deployed. That module (which calls notification_send as a named
//      member and the hub's ReadGateway with a run scope), its canary (TEST_FAKES_CANARY) and that run scope's
//      synthetic principal (`m_test_fakes`) are in neither the deployable Worker nor the eval build, source maps
//      included; the test build must carry all three as soon as any server source imports
//      `@test-fakes`, or the scan proves nothing. (Part 8, not 7: fleet/watch's #291 holds part 7, the test shop.)
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))

const args = process.argv.slice(2)
const flag = (name, fallback) => {
  const i = args.indexOf(name)
  if (i === -1) return fallback
  if (!args[i + 1] || args[i + 1].startsWith('--')) { console.error(`check-product-build: ${name} needs a folder.`); process.exit(2) }
  return resolve(args[i + 1])
}
const productDir = flag('--product', join(root, 'dist-product'))
const demoDir = flag('--demo', join(root, 'dist'))
const productTestDir = flag('--product-test', join(root, 'dist-product-test'))
const productEvalDir = flag('--product-eval', join(root, 'dist-product-eval'))
const serverDir = flag('--server', join(root, 'server'))

const fail = msg => { console.error(`check-product-build: ${msg}`); process.exit(2) }
const readJson = rel => JSON.parse(readFileSync(join(root, 'src/agent/sample-data', rel), 'utf8'))

// ---------- the canaries ----------
const MARKERS = ['inhouse-canary:mock', 'inhouse-canary:demo-controls', 'inhouse-canary:demo-clock']
// Full names and the brand's name from the sample data itself, so the list follows the data. A name is only a canary at
// two words or more: a one-word name could be anything a library says.
const sampleNames = () => {
  const meta = readJson('meta.json')
  const people = readJson('people-and-rules.json')
  const names = [meta.brand?.name, meta.currentUser?.name, ...(people.members ?? []).map(m => m.name)]
  const full = [...new Set(names.filter(n => typeof n === 'string' && /\s/.test(n.trim())).map(n => n.trim()))]
  if (!full.some(n => n === meta.brand?.name)) fail('src/agent/sample-data/meta.json has no brand name to use as a canary.')
  if (full.length < 3) fail(`only ${full.length} sample names found in src/agent/sample-data/ to use as canaries; the data's shape changed.`)
  return full
}
// The sample brand's email domain and the signed-in person's address: unique strings the product has no reason to carry.
const sampleEmails = () => {
  const meta = readJson('meta.json')
  const found = [meta.brand?.emailDomain, meta.currentUser?.email].filter(e => typeof e === 'string' && e.trim())
  if (found.length < 2) fail('src/agent/sample-data/meta.json has no brand.emailDomain or currentUser.email to use as canaries.')
  return found.map(e => e.trim())
}
const CANARIES = [...sampleNames(), ...sampleEmails(), ...MARKERS]

// ---------- a build's files ----------
const walk = dir => readdirSync(dir, { withFileTypes: true }).flatMap(d => (d.isDirectory() ? walk(join(dir, d.name)) : [join(dir, d.name)]))
const TEXT = /\.(js|mjs|css|html|json|svg|txt|map)$/

/** A build folder as the Cloudflare Vite plugin writes it: <dir>/client (served files) and <dir>/client-modules.json beside it. */
function open(dir, label) {
  if (!existsSync(dir)) fail(`${label} build folder ${dir} doesn't exist. Run its build first.`)
  const clientDir = [join(dir, 'client'), dir].find(d => existsSync(join(d, 'index.html')))
  if (!clientDir) fail(`${label}: no client/index.html or index.html in ${dir}. The build output changed shape, or it didn't run.`)
  const list = join(clientDir, '..', 'client-modules.json')
  if (!existsSync(list)) fail(`${label}: ${relative(root, list)} is missing. vite.config.ts's writeModuleList writes it at build time.`)
  const modules = JSON.parse(readFileSync(list, 'utf8'))
  if (!Array.isArray(modules) || modules.length === 0) fail(`${label}: ${relative(root, list)} is empty.`)
  return { clientDir, modules, files: walk(clientDir) }
}

// ---------- the three parts: each returns what it found ----------
/** 1. Canaries in the client output. */
function canaries({ files }) {
  const found = []
  for (const f of files.filter(f => TEXT.test(f))) {
    const text = readFileSync(f, 'utf8')
    for (const c of CANARIES) if (text.includes(c)) found.push(`"${c}" in ${relative(root, f)}`)
  }
  return found
}

/** 2. Modules that must not be in the graph. Ids are relative to app/ with forward slashes, maybe with a ?query. */
const FORBIDDEN = /(^|\/)src\/agent\/(sample-data\/|(mock|demo-controls|demo-clock|client\.demo)\.[cm]?[jt]sx?($|\?))/
function moduleGraph({ modules }) {
  return modules.filter(id => FORBIDDEN.test(id)).map(id => `module ${id}`)
}

/**
 * 3. The demo-only public files (everything under public-demo/) copied into the output. The pattern comes from public-demo/'s
 * own top-level entries, so a new folder there is covered; and any output file at the same path as a public-demo/ file fails.
 */
const PUBLIC_DEMO = join(root, 'public-demo')
if (!existsSync(PUBLIC_DEMO)) fail('public-demo/ is missing: the copied-files check has nothing to compare against.')
// Dotfiles (a Finder .DS_Store) are never demo content and are gitignored, so they're left out on both sides.
const publicDemoTop = readdirSync(PUBLIC_DEMO).filter(n => !n.startsWith('.'))
if (publicDemoTop.length === 0) fail('public-demo/ is empty: the copied-files check has nothing to compare against.')
const publicDemoFiles = new Set(walk(PUBLIC_DEMO).map(f => relative(PUBLIC_DEMO, f).split(sep).join('/')).filter(f => !f.split('/').some(p => p.startsWith('.'))))
const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const DEMO_ONLY_TOP = new RegExp(`^(${publicDemoTop.map(escapeRe).join('|')})(/|$)`)
function copiedFiles({ clientDir, files }) {
  return files.map(f => relative(clientDir, f).split(sep).join('/')).filter(p => DEMO_ONLY_TOP.test(p) || publicDemoFiles.has(p)).map(p => `file ${p}`)
}

const PARTS = [
  ['canary strings', canaries],
  ['module graph', moduleGraph],
  ['copied files', copiedFiles],
]

const product = open(productDir, 'product')
const demo = open(demoDir, 'demo')
let bad = false
const show = list => list.slice(0, 5).map(x => `    ${x}`).join('\n') + (list.length > 5 ? `\n    ... and ${list.length - 5} more` : '')

for (const [name, run] of PARTS) {
  const inProduct = run(product)
  if (inProduct.length) {
    bad = true
    console.error(`FAIL  ${name}: the product build (${relative(root, productDir)}) has what it must not:\n${show(inProduct)}`)
  } else console.log(`ok    ${name}: clean in the product build.`)
  const inDemo = run(demo)
  if (!inDemo.length) {
    bad = true
    console.error(`FAIL  ${name}: found nothing in the demo build (${relative(root, demoDir)}), so it proves nothing: it scanned the wrong folder or looks for the wrong thing.`)
  } else console.log(`ok    ${name}: caught the demo build (${inDemo.length} hit${inDemo.length === 1 ? '' : 's'}).`)
}

// ---------- 4. the server bundle scan ----------
const SERVER_CANARY = 'INHOUSE_TEST_ISSUER_CANARY_7f3c'
const TEST_ISSUER_MODULE = /test-issuer/
/** app/test/scripted-model/index.ts's SCRIPTED_MODEL_CANARY (check-product-build.test.mjs keeps the two equal). */
const SCRIPTED_CANARY = 'inhouse-scripted-model-canary-7f3c9b21'
const SCRIPTED_MODULE = /(^|\/)test\/scripted-model\//
/** app/server/ops/test-controls.ts's TEST_CONTROLS_CANARY (check-product-build.test.mjs keeps the two equal). */
const CONTROLS_CANARY = 'inhouse-test-controls-canary-5d81e0a7'
/** The real controls module only: the off stand-in (test-controls-off.ts) is what the deployable Worker bundles. */
const CONTROLS_MODULE = /(^|\/)server\/ops\/test-controls\.ts($|\?)/
/** The server's own sources (tests aside). */
const serverSources = () => (existsSync(serverDir) ? walk(serverDir).filter(f => /\.(ts|mts|js|mjs)$/.test(f) && !/\.test\.[a-z]+$/.test(f)) : [])
/** Whether any server source imports this alias. */
const serverImports = alias => serverSources().some(f => new RegExp(`(from\\s+|import\\s*\\(\\s*)['"]${alias}['"]`).test(readFileSync(f, 'utf8')))
/** Whether any server source (tests aside) imports the scripted model through its alias. */
const serverImportsScripted = () => serverImports('@scripted-model')
/** The Worker folder of a product build: the one subfolder (not client/) holding a wrangler.json. */
function workerDir(dir, label) {
  if (!existsSync(dir)) fail(`${label} build folder ${dir} doesn't exist. Run its build first.`)
  const found = readdirSync(dir, { withFileTypes: true })
    .filter(d => d.isDirectory() && d.name !== 'client' && existsSync(join(dir, d.name, 'wrangler.json')))
    .map(d => join(dir, d.name))
  if (found.length !== 1) fail(`${label}: expected one Worker folder with a wrangler.json in ${relative(root, dir)}, found ${found.length}.`)
  return found[0]
}
/** Canary hits in the Worker's files, and test-issuer modules in its graph (<build>/server-modules.json, vite.config.ts). */
function serverScan(dir) {
  const hits = []
  for (const f of walk(dir).filter(f => TEXT.test(f))) {
    const text = readFileSync(f, 'utf8')
    if (text.includes(SERVER_CANARY)) hits.push(`"${SERVER_CANARY}" in ${relative(root, f)}`)
    if (text.includes(SCRIPTED_CANARY)) hits.push(`"${SCRIPTED_CANARY}" in ${relative(root, f)}`)
    if (text.includes(CONTROLS_CANARY)) hits.push(`"${CONTROLS_CANARY}" in ${relative(root, f)}`)
  }
  const list = join(dir, '..', 'server-modules.json')
  if (!existsSync(list)) fail(`${relative(root, list)} is missing. vite.config.ts's writeServerModuleList writes it in product builds.`)
  const modules = JSON.parse(readFileSync(list, 'utf8'))
  if (!Array.isArray(modules) || !modules.some(id => /(^|\/)server\/index\.ts$/.test(id))) fail(`${relative(root, list)} doesn't list server/index.ts: it's not the product Worker's graph.`)
  for (const id of modules) if (TEST_ISSUER_MODULE.test(id) || SCRIPTED_MODULE.test(id) || CONTROLS_MODULE.test(id)) hits.push(`module ${id}`)
  return hits
}
/** Hub modules in a Worker's graph (ids are relative to app/, so the hub's files start with hub/). */
const HUB_MODULE = /^hub\//
const hubModules = dir => JSON.parse(readFileSync(join(dir, '..', 'server-modules.json'), 'utf8')).filter(id => HUB_MODULE.test(id)).map(id => `module ${id}`)
/** The only hub file a server source may name, and only as `import type`. */
const HUB_CONTRACT = /(^|\/)hub\/index\/contract(\.ts)?$/
/** Every import or re-export of a hub file in the server's sources but `import type` of hub/index/contract.ts. */
function hubImports() {
  const found = []
  const statement = /\b(import|export)\s+(type\s+)?(?:[^'";]*?\s+from\s*)?['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]/g
  for (const f of serverSources()) {
    for (const m of readFileSync(f, 'utf8').matchAll(statement)) {
      const spec = m[3] ?? m[4]
      if (!/(^|\/)hub\//.test(spec)) continue
      if (m[1] === 'import' && m[2] && HUB_CONTRACT.test(spec)) continue
      found.push(`${relative(root, f)}: ${m[0].replace(/\s+/g, ' ')}`)
    }
  }
  return found
}
const productWorker = workerDir(productDir, 'product')
// serverScan first: it exits with "server-modules.json is missing" before the hub check reads that file.
const inServer = serverScan(productWorker)
const hubIn = [...hubImports(), ...hubModules(productWorker)]
if (hubIn.length) {
  bad = true
  console.error(`FAIL  hub: the product Worker reaches hub code other than \`import type\` of hub/index/contract.ts:\n${show(hubIn)}`)
} else console.log('ok    hub: no hub module in the deployable Worker, and the server names hub/index/contract.ts as types only.')
if (inServer.length) {
  bad = true
  console.error(`FAIL  server bundle: the deployable Worker (${relative(root, productWorker)}) has the test issuer, the scripted model or the test controls:\n${show(inServer)}`)
} else console.log(`ok    server bundle: no test issuer, no scripted model and no test controls in the deployable Worker (${relative(root, productWorker)}).`)
const testWorker = workerDir(productTestDir, 'product-test')
const inTest = serverScan(testWorker)
const hubInTest = hubModules(testWorker)
if (hubInTest.length) {
  bad = true
  console.error(`FAIL  hub: the test build's product Worker bundles hub modules (the hub runs as its own Worker):\n${show(hubInTest)}`)
}
// The proof is always required: the test build must carry the canary, or the scan proves nothing.
if (!inTest.some(h => h.includes(SERVER_CANARY))) {
  bad = true
  console.error(`FAIL  server bundle: no "${SERVER_CANARY}" in the test build (${relative(root, testWorker)}), so the scan proves nothing.`)
} else console.log(`ok    server bundle: caught the test build (${inTest.length} hit${inTest.length === 1 ? '' : 's'}).`)
if (serverImportsScripted()) {
  if (!inTest.some(h => h.includes(SCRIPTED_CANARY))) {
    bad = true
    console.error(`FAIL  server bundle: the server imports @scripted-model but the test build (${relative(root, testWorker)}) has no "${SCRIPTED_CANARY}", so the scan proves nothing.`)
  } else console.log('ok    server bundle: caught the scripted model in the test build.')
} else console.log('note  scripted model: no server source imports @scripted-model yet, so the test build need not carry its canary.')
if (serverImports('@test-controls')) {
  if (!inTest.some(h => h.includes(CONTROLS_CANARY))) {
    bad = true
    console.error(`FAIL  server bundle: the server imports @test-controls but the test build (${relative(root, testWorker)}) has no "${CONTROLS_CANARY}", so the scan proves nothing.`)
  } else console.log('ok    server bundle: caught the test controls in the test build.')
} else console.log('note  test controls: no server source imports @test-controls, so the test build need not carry their canary.')

// ---------- 5. the eval trace ----------
/** app/server/eval-trace/on.ts's EVAL_TRACE_CANARY (check-product-build.test.mjs keeps the two equal). */
const EVAL_CANARY = 'inhouse-eval-trace-canary-5d1e8a40'
/** vite.config.ts's `@eval-trace` target in the eval build (check-product-build.test.mjs pins it to the real file and the alias). */
const EVAL_MODULE_PATH = 'server/eval-trace/on.ts'
const EVAL_MODULE = new RegExp('(^|/)' + escapeRe(EVAL_MODULE_PATH) + '($|\\?)')
/** Eval-trace canary hits in a Worker's files, eval-trace modules in its graph, and the same for the scripted model. */
function evalScan(dir) {
  const trace = []
  const scripted = []
  for (const f of walk(dir).filter(f => TEXT.test(f))) {
    const text = readFileSync(f, 'utf8')
    if (text.includes(EVAL_CANARY)) trace.push(`"${EVAL_CANARY}" in ${relative(root, f)}`)
    if (text.includes(SCRIPTED_CANARY)) scripted.push(`"${SCRIPTED_CANARY}" in ${relative(root, f)}`)
  }
  const list = join(dir, '..', 'server-modules.json')
  if (!existsSync(list)) fail(`${relative(root, list)} is missing. vite.config.ts's writeServerModuleList writes it in product builds.`)
  const modules = JSON.parse(readFileSync(list, 'utf8'))
  if (!Array.isArray(modules) || !modules.some(id => /(^|\/)server\/index\.ts$/.test(id))) fail(`${relative(root, list)} doesn't list server/index.ts: it's not the product Worker's graph.`)
  for (const id of modules) {
    if (EVAL_MODULE.test(id)) trace.push(`module ${id}`)
    if (SCRIPTED_MODULE.test(id)) scripted.push(`module ${id}`)
  }
  return { trace, scripted }
}
for (const [label, dir] of [['the deployable Worker', productWorker], ['the test build', testWorker]]) {
  const { trace } = evalScan(dir)
  if (trace.length) {
    bad = true
    console.error(`FAIL  eval trace: ${label} (${relative(root, dir)}) has the eval trace:\n${show(trace)}`)
  } else console.log(`ok    eval trace: not in ${label} (${relative(root, dir)}).`)
}
const evalWorker = workerDir(productEvalDir, 'product-eval')
const inEval = evalScan(evalWorker)
const missing = [
  ...(inEval.trace.some(h => h.includes(EVAL_CANARY)) ? [] : [`no "${EVAL_CANARY}"`]),
  ...(inEval.trace.some(h => h.startsWith('module ')) ? [] : ['no server/eval-trace/on.ts module']),
]
if (missing.length) {
  bad = true
  console.error(`FAIL  eval trace: the eval build (${relative(root, evalWorker)}) has ${missing.join(' and ')}, so the scan proves nothing.`)
} else console.log(`ok    eval trace: caught the eval build (${inEval.trace.length} hits).`)
if (inEval.scripted.length) {
  bad = true
  console.error(`FAIL  eval trace: the eval build carries the scripted model (${relative(root, evalWorker)}):\n${show(inEval.scripted)}`)
} else console.log('ok    eval trace: no scripted model in the eval build.')

// ---------- 8. the test-fakes hook ----------
/** app/server/ops/test-fakes.ts's TEST_FAKES_CANARY (check-product-build.test.mjs keeps the two equal). */
const TEST_FAKES_CANARY = 'inhouse-test-fakes-canary-6b2f90d4'
/** The synthetic principal the hook's `hub` op calls the ReadGateway as (test-fakes.ts): a run scope only it builds. */
const TEST_FAKES_PRINCIPAL = 'm_test_fakes'
/** The real module only: the off stand-in (test-fakes-off.ts) is what every other build bundles. */
const TEST_FAKES_MODULE = /(^|\/)server\/ops\/test-fakes\.ts($|\?)/
/** The hook's canary and synthetic principal in a Worker's files (its source maps included), and its module in the graph. */
function testFakesScan(dir) {
  const hits = []
  for (const f of walk(dir).filter(f => TEXT.test(f))) {
    const text = readFileSync(f, 'utf8')
    for (const needle of [TEST_FAKES_CANARY, TEST_FAKES_PRINCIPAL]) if (text.includes(needle)) hits.push(`"${needle}" in ${relative(root, f)}`)
  }
  for (const id of JSON.parse(readFileSync(join(dir, '..', 'server-modules.json'), 'utf8'))) if (TEST_FAKES_MODULE.test(id)) hits.push(`module ${id}`)
  return hits
}
for (const [label, dir] of [['the deployable Worker', productWorker], ['the eval build', evalWorker]]) {
  const hits = testFakesScan(dir)
  if (hits.length) {
    bad = true
    console.error(`FAIL  test fakes: ${label} (${relative(root, dir)}) has the test-fakes hook:\n${show(hits)}`)
  } else console.log(`ok    test fakes: not in ${label} (${relative(root, dir)}).`)
}
if (serverImports('@test-fakes')) {
  const hits = testFakesScan(testWorker)
  const missing = [
    ...(hits.some(h => h.includes(TEST_FAKES_CANARY)) ? [] : [`no "${TEST_FAKES_CANARY}"`]),
    ...(hits.some(h => h.includes(`"${TEST_FAKES_PRINCIPAL}"`)) ? [] : [`no "${TEST_FAKES_PRINCIPAL}"`]),
    ...(hits.some(h => h.startsWith('module ')) ? [] : ['no server/ops/test-fakes.ts module']),
  ]
  if (missing.length) {
    bad = true
    console.error(`FAIL  test fakes: the server imports @test-fakes but the test build (${relative(root, testWorker)}) has ${missing.join(' and ')}, so the scan proves nothing.`)
  } else console.log('ok    test fakes: caught the test build.')
} else console.log('note  test fakes: no server source imports @test-fakes, so the test build need not carry it.')

process.exit(bad ? 1 : 0)
