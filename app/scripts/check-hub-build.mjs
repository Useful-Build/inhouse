// The hub bundle scan (P4, hub PR0). Run in app/ after `npm run bundle` and `npm run bundle:test` in app/hub/:
//   node scripts/check-hub-build.mjs                          checks dist-hub/ (must pass) and dist-hub-test/ (must fail)
//   node scripts/check-hub-build.mjs --deploy DIR --test DIR  other bundle folders
// The deployable hub carries no test seam: app/hub/testing/ (and the recorded upstreams it bundles from
// app/test/upstreams/) is reached only inside `if (__INHOUSE_HUB_TEST__ && ...)`, which wrangler.hub.jsonc defines as
// "false" so esbuild drops it. Two parts, each run on both bundles:
//   1. The canaries: HUB_TEST_CANARY's value (read from app/hub/testing/index.ts), the recorded Shopify upstream's
//      SHOPIFY_UPSTREAM_CANARY (read from app/test/upstreams/shopify/server.ts), each in any output file but the
//      metafile, and the recorded MCP upstream's MCP_UPSTREAM_CANARY (P5, read from app/test/upstreams/mcp/server.ts).
//      Each is read from its source, so the scan and the code can't drift.
//   2. The module graph: the esbuild metafile `wrangler deploy --dry-run --metafile` writes (<dir>/bundle-meta.json).
//      Fails when any input sits in a `testing/` folder anywhere under app/hub/ (app/hub/testing/, and later ones such
//      as app/hub/registry/testing/), under app/test/upstreams/, or is a test module (`*.test.ts`). A string scan alone
//      can't prove a renamed or tree-shaken import is gone.
// The metafile's `outputs`, resolved from app/ only, must all be files in the scanned folder: wrangler 4.158.0 resolves `deploy --outdir`
// against the config's folder (esbuild's absWorkingDir) but writes the README and the metafile against the shell's,
// so a relative --outdir once put the script one level away from the folder scanned. hub/package.json passes absolute
// paths; this rule catches the split if it comes back.
// Both parts must FAIL on the test bundle (wrangler.hub.test.jsonc, define "true"): a check that passes there scanned
// the wrong folder or looks for the wrong thing. Exit 0 only when the deployable bundle is clean and every part caught
// the test bundle. Exit 1 for a refusal, 2 when it can't run (usage, a missing or unreadable file, a malformed
// metafile, outputs outside the folder). Modelled on check-product-build.mjs. No dependencies: the hub's CI job doesn't
// install app/. scripts/check-hub-build.test.mjs runs it on fixture bundles (scripts/check-hub-build-fixtures/).
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const hubDir = join(root, 'hub')

const args = process.argv.slice(2)
const flag = (name, fallback) => {
  const i = args.indexOf(name)
  if (i === -1) return fallback
  if (!args[i + 1] || args[i + 1].startsWith('--')) { console.error(`check-hub-build: ${name} needs a folder.`); process.exit(2) }
  return resolve(args[i + 1])
}
const deployDir = flag('--deploy', join(root, 'dist-hub'))
const testDir = flag('--test', join(root, 'dist-hub-test'))

const fail = msg => { console.error(`check-hub-build: ${msg}`); process.exit(2) }
const read = path => {
  try {
    return readFileSync(path, 'utf8')
  } catch (e) {
    fail(`can't read ${path}: ${e.message}`)
  }
}

// ---------- the canary, from its source ----------
const seam = join(hubDir, 'testing/index.ts')
if (!existsSync(seam)) fail(`${relative(root, seam)} is missing: there's no canary to look for.`)
const canaryMatch = read(seam).match(/export const HUB_TEST_CANARY = '([^']+)'/)
if (!canaryMatch) fail(`no \`export const HUB_TEST_CANARY = '...'\` in ${relative(root, seam)}; the seam's shape changed.`)
const CANARY = canaryMatch[1]
const shopifyUpstream = join(root, 'test/upstreams/shopify/server.ts')
if (!existsSync(shopifyUpstream)) fail(`${relative(root, shopifyUpstream)} is missing: there's no Shopify upstream canary to look for.`)
const shopifyMatch = read(shopifyUpstream).match(/export const SHOPIFY_UPSTREAM_CANARY = '([^']+)'/)
if (!shopifyMatch) fail(`no \`export const SHOPIFY_UPSTREAM_CANARY = '...'\` in ${relative(root, shopifyUpstream)}; the upstream's shape changed.`)
const SHOPIFY_CANARY = shopifyMatch[1]
const mcpUpstream = join(root, 'test/upstreams/mcp/server.ts')
if (!existsSync(mcpUpstream)) fail(`${relative(root, mcpUpstream)} is missing: there's no MCP upstream canary to look for.`)
const mcpMatch = read(mcpUpstream).match(/export const MCP_UPSTREAM_CANARY = '([^']+)'/)
if (!mcpMatch) fail(`no \`export const MCP_UPSTREAM_CANARY = '...'\` in ${relative(root, mcpUpstream)}; the upstream's shape changed.`)
const MCP_CANARY = mcpMatch[1]

// ---------- a bundle's files ----------
const METAFILE = 'bundle-meta.json'
const walkUnsafe = dir => readdirSync(dir, { withFileTypes: true }).flatMap(d => (d.isDirectory() ? walkUnsafe(join(dir, d.name)) : [join(dir, d.name)]))
const walk = dir => {
  try {
    return walkUnsafe(dir)
  } catch (e) {
    fail(`can't list ${dir}: ${e.message}`)
  }
}
const under = (p, dir) => p === dir || p.startsWith(dir + sep)
const bare = id => id.replace(/^[a-z-]+:/, '').split('?')[0]
/** esbuild writes metafile input paths relative to its working directory, which may be app/ or app/hub/. */
const candidates = id => {
  const path = bare(id)
  return isAbsolute(path) ? [path] : [resolve(root, path), resolve(hubDir, path)]
}
/** An output path, from app/ (the config's folder, esbuild's absWorkingDir) only. */
const outputPath = id => resolve(root, bare(id))

function open(dir, label) {
  if (!existsSync(dir)) fail(`${label} bundle folder ${dir} doesn't exist. Run its bundle script in app/hub/ first.`)
  const meta = join(dir, METAFILE)
  if (!existsSync(meta)) fail(`${label}: ${relative(root, meta)} is missing. The bundle scripts pass --metafile; was it built another way?`)
  let parsed
  try {
    parsed = JSON.parse(read(meta))
  } catch (e) {
    fail(`${label}: ${relative(root, meta)} isn't JSON: ${e.message}`)
  }
  if (parsed === null || typeof parsed !== 'object') fail(`${label}: ${relative(root, meta)} isn't a metafile object.`)
  const inputs = Object.keys(parsed.inputs ?? {})
  if (inputs.length === 0) fail(`${label}: ${relative(root, meta)} lists no inputs.`)
  const outputs = Object.keys(parsed.outputs ?? {})
  if (outputs.length === 0) fail(`${label}: ${relative(root, meta)} lists no outputs.`)
  // Outputs resolve against app/ only (esbuild's working directory is the config's folder): a second base would let a
  // stale same-named file in the scanned folder stand in for an output that landed elsewhere.
  const away = outputs.filter(id => {
    const out = outputPath(id)
    return !(under(out, dir) && existsSync(out))
  })
  if (away.length) fail(`${label}: the metafile's outputs aren't in ${dir}, so this folder isn't what was built: ${away.join(', ')}`)
  const files = walk(dir).filter(f => f !== meta)
  if (!files.some(f => /\.[cm]?js$/.test(f))) fail(`${label}: no .js file in ${dir}; the bundle didn't run or changed shape.`)
  return { inputs, files }
}

// ---------- the two parts: each returns what it found ----------
/**
 * 1. A canary in any output file (the script, its source map, anything else wrangler wrote). Each file is read once and
 * kept for every canary: re-reading the multi-MB bundle and map once per canary made node 26.13.1 hang at exit (a
 * worker thread never joined, about 3 runs in 4), so the scan allocates each file's text one time.
 */
const texts = new Map()
const textOf = f => {
  if (!texts.has(f)) texts.set(f, read(f))
  return texts.get(f)
}
const canary = value => ({ files }) => files.filter(f => textOf(f).includes(value)).map(f => `"${value}" in ${relative(root, f)}`)

/**
 * 2. Forbidden modules in the metafile's inputs: an input counts when it resolves, from app/ or app/hub/, into a
 * `testing/` folder anywhere under app/hub/, under app/test/upstreams/, or to a test module (a node_modules/
 * path is a dependency's own business: a package's testing/ folder isn't ours).
 */
const UPSTREAMS = join(root, 'test/upstreams')
const TEST_MODULE = /\.test\.[cm]?[jt]sx?$/
const forbidden = p =>
  under(p, UPSTREAMS) ||
  (!p.split(sep).includes('node_modules') &&
    ((under(p, hubDir) && relative(hubDir, p).split(sep).includes('testing')) || TEST_MODULE.test(p)))
function moduleGraph({ inputs }) {
  return inputs.filter(id => candidates(id).some(forbidden)).map(id => `module ${id}`)
}

const PARTS = [
  ['canary string', canary(CANARY)],
  ['shopify upstream canary', canary(SHOPIFY_CANARY)],
  ['mcp upstream canary', canary(MCP_CANARY)],
  ['module graph', moduleGraph],
]

const deploy = open(deployDir, 'deployable')
const testBundle = open(testDir, 'test')
let bad = false
const show = list => list.slice(0, 5).map(x => `    ${x}`).join('\n') + (list.length > 5 ? `\n    ... and ${list.length - 5} more` : '')

for (const [name, run] of PARTS) {
  const inDeploy = run(deploy)
  if (inDeploy.length) {
    bad = true
    console.error(`FAIL  ${name}: the deployable hub bundle (${relative(root, deployDir)}) has what it must not:\n${show(inDeploy)}`)
  } else console.log(`ok    ${name}: clean in the deployable hub bundle.`)
  const inTest = run(testBundle)
  if (!inTest.length) {
    bad = true
    console.error(`FAIL  ${name}: found nothing in the test bundle (${relative(root, testDir)}), so it proves nothing: it scanned the wrong folder or looks for the wrong thing.`)
  } else console.log(`ok    ${name}: caught the test bundle (${inTest.length} hit${inTest.length === 1 ? '' : 's'}).`)
}

process.exit(bad ? 1 : 0)
