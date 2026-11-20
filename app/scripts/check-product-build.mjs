// The product build check (P1, C8). Run in app/ after `npm run build` and `npm run build:product`:
//   node scripts/check-product-build.mjs                      checks dist-product/ (must pass) and dist/ (must fail)
//   node scripts/check-product-build.mjs --product DIR --demo DIR   other build folders
// The product build ships no sample data, mock code, demo controls or demo clock. Three parts, each run on both builds:
//   1. Canary strings in the client output: the sample brand's and people's names (read from src/agent/sample-data/) and a
//      marker constant each from mock.ts, demo-controls.ts and demo-clock.ts. Unique strings only, never common words or
//      method names a library also uses.
//   2. The module graph: the build writes every module id it bundled to <build>/client-modules.json (vite.config.ts,
//      writeModuleList). Fails when a module under src/agent/sample-data/, or mock, demo-controls, demo-clock or client.demo,
//      is in it. A string scan alone can't prove a tree-shaken or renamed import is gone.
//   3. Copied files: no library/ or avatars/ file in the client output (the demo-only public files, public-demo/).
// The same three parts run on the demo build and must each FAIL there: a check that passes on the demo scanned the wrong
// folder or looks for the wrong thing, so it can't go green by accident. Exit code 0 only when the product build is clean
// and every part caught the demo.
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
const CANARIES = [...sampleNames(), ...MARKERS]

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

/** 3. The demo-only public files (public-demo/library, public-demo/avatars) copied into the output. */
function copiedFiles({ clientDir, files }) {
  return files.map(f => relative(clientDir, f).split(sep).join('/')).filter(p => /^(library|avatars)\//.test(p)).map(p => `file ${p}`)
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

process.exit(bad ? 1 : 0)
