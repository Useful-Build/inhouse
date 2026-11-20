// The product build check (P1, C8; part 4 P2). Run in app/ after `npm run build`, `npm run build:product` and
// `npm run build:product-test`:
//   node scripts/check-product-build.mjs                      checks dist-product/ (must pass) and dist/ (must fail)
//   node scripts/check-product-build.mjs --product DIR --demo DIR --product-test DIR   other build folders
// The product build ships no sample data, mock code, demo controls or demo clock. Three parts, each run on both builds:
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
//      Its proof is the test build (dist-product-test/), where the canary MUST be found, once the test issuer exists
//      (server/auth/test-issuer.ts, W1). Until then the proof is reported as not yet possible, never as passed.
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
    if (readFileSync(f, 'utf8').includes(SERVER_CANARY)) hits.push(`"${SERVER_CANARY}" in ${relative(root, f)}`)
  }
  const list = join(dir, '..', 'server-modules.json')
  if (!existsSync(list)) fail(`${relative(root, list)} is missing. vite.config.ts's writeServerModuleList writes it in product builds.`)
  const modules = JSON.parse(readFileSync(list, 'utf8'))
  if (!Array.isArray(modules) || !modules.some(id => /(^|\/)server\/index\.ts$/.test(id))) fail(`${relative(root, list)} doesn't list server/index.ts: it's not the product Worker's graph.`)
  for (const id of modules) if (TEST_ISSUER_MODULE.test(id)) hits.push(`module ${id}`)
  return hits
}
const productWorker = workerDir(productDir, 'product')
const inServer = serverScan(productWorker)
if (inServer.length) {
  bad = true
  console.error(`FAIL  server bundle: the deployable Worker (${relative(root, productWorker)}) has the test issuer:\n${show(inServer)}`)
} else console.log(`ok    server bundle: no test issuer in the deployable Worker (${relative(root, productWorker)}).`)
const testWorker = workerDir(productTestDir, 'product-test')
const inTest = serverScan(testWorker)
if (existsSync(join(root, 'server/auth/test-issuer.ts'))) {
  if (!inTest.some(h => h.includes(SERVER_CANARY))) {
    bad = true
    console.error(`FAIL  server bundle: no "${SERVER_CANARY}" in the test build (${relative(root, testWorker)}), so the scan proves nothing.`)
  } else console.log(`ok    server bundle: caught the test build (${inTest.length} hit${inTest.length === 1 ? '' : 's'}).`)
} else {
  console.log(`note  server bundle: server/auth/test-issuer.ts doesn't exist yet (W1 adds it), so the scan can't be proven on the test build yet.`)
}

process.exit(bad ? 1 : 0)
