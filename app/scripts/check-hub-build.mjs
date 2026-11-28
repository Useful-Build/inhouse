// The hub bundle scan (P4, hub PR0). Run in app/ after `npm run bundle` and `npm run bundle:test` in app/hub/:
//   node scripts/check-hub-build.mjs                          checks dist-hub/ (must pass) and dist-hub-test/ (must fail)
//   node scripts/check-hub-build.mjs --deploy DIR --test DIR  other bundle folders
// The deployable hub carries no test seam: app/hub/testing/ (and the recorded upstreams it bundles from
// app/test/upstreams/) is reached only inside `if (__INHOUSE_HUB_TEST__ && ...)`, which wrangler.hub.jsonc defines as
// "false" so esbuild drops it. Two parts, each run on both bundles:
//   1. The canaries: HUB_TEST_CANARY's value (read from app/hub/testing/index.ts), the recorded Shopify upstream's
//      SHOPIFY_UPSTREAM_CANARY (read from app/test/upstreams/shopify/server.ts), each in any output file but the
//      metafile, and the recorded MCP upstream's MCP_UPSTREAM_CANARY (P5, read from app/test/upstreams/mcp/server.ts).
//      Stage 1 M4-F (N52): MCP_FIXTURES_CANARY (read from app/test/upstreams/mcp/index.ts), M4's fixture servers, login
//      server and REST API, which only the test bundle's seam registers. Its runtime code names it (the unknown-host
//      answer), so the test bundle must hold it in a script, not only in a source map.
//      Each is read from its source, so the scan and the code can't drift.
//      Stage 1 M3-R (N30): the name EvalWriteGateway (EVAL_WRITE_GATEWAY, read from app/hub/testing/eval-write.ts's class),
//      the eval deployment's credential-free write log, which only the test bundle's main module exports.
//      Stage 1 M3 (N31): EVAL_SLACK_CANARY (read from app/hub/testing/eval-slack.ts), the eval deployment's fake Slack
//      workspace, which only the test bundle's seam reads from the eval D1. The module names it in runtime code, so the
//      test bundle must hold it in a script (.js), not only in a source map (#588): otherwise a leak of the module into
//      a bundle would show only in its map.
//      The test-fakes hook (W5): HUB_FAKES_CANARY (read from app/hub/testing/fakes.ts), and the hook's three in-isolate
//      globals (`__inhouseHubTestVars`, `__inhouseHubTestLogs`, `__inhouseHubTestConnectBodies`), which must sit only
//      inside `if (false)` blocks of the deployable script (the define's dead branches: wrangler doesn't minify, so their
//      text stays). So the deployable hub's ConnectGateway.testFakes and SignIn.testFireAlarm can only refuse.
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

class Fatal extends Error {}
const fail = msg => { throw new Fatal(msg) }

const args = process.argv.slice(2)
const flag = (name, fallback) => {
  const i = args.indexOf(name)
  if (i === -1) return fallback
  if (!args[i + 1] || args[i + 1].startsWith('--')) fail(`${name} needs a folder.`)
  return resolve(args[i + 1])
}
const read = path => {
  try {
    return readFileSync(path, 'utf8')
  } catch (e) {
    fail(`can't read ${path}: ${e.message}`)
  }
}

// ---------- the canaries, from their sources ----------
// The test-fakes hook (W5, hub/testing/fakes.ts): its canary, and the names it shares with code outside hub/testing/ (the
// singleton `__test-fakes__` SignIn DO in signin/signin.ts and oauth/entry.ts, the log queue in index/log.ts). Each needle
// is a quoted string or a call site (`.name(`), never a bare method name: the deployable SignIn class still defines the
// refusing `testFakesOp` / `testGetVars` / `testRecordConnectBody` / `testAppendLogs` methods, but every string and call
// to them sits in a branch the deployable define drops. The deployable bundle must hold none of these outside an
// `if (false)` block; the test bundle must hold every one (a needle it lacks means the name changed and the guard went
// stale). The names are fixed here: the code under hub/ is what must match them.
const FAKES_GLOBALS = [
  '__inhouseHubTestLogs',
  '"__test-fakes__"',
  '"test-fakes:vars"',
  '"X-Inhouse-Test-Throw"',
  '.testFakesOp(',
  '.testGetVars(',
  '.testRecordConnectBody(',
  '.testAppendLogs(',
]

function readCanaries() {
  const seam = join(hubDir, 'testing/index.ts')
  if (!existsSync(seam)) fail(`${relative(root, seam)} is missing: there's no canary to look for.`)
  const canaryMatch = read(seam).match(/export const HUB_TEST_CANARY = '([^']+)'/)
  if (!canaryMatch) fail(`no \`export const HUB_TEST_CANARY = '...'\` in ${relative(root, seam)}; the seam's shape changed.`)
  const shopifyUpstream = join(root, 'test/upstreams/shopify/server.ts')
  if (!existsSync(shopifyUpstream)) fail(`${relative(root, shopifyUpstream)} is missing: there's no Shopify upstream canary to look for.`)
  const shopifyMatch = read(shopifyUpstream).match(/export const SHOPIFY_UPSTREAM_CANARY = '([^']+)'/)
  if (!shopifyMatch) fail(`no \`export const SHOPIFY_UPSTREAM_CANARY = '...'\` in ${relative(root, shopifyUpstream)}; the upstream's shape changed.`)
  const shopifyWriteUpstream = join(root, 'test/upstreams/shopify/write/server.ts')
  if (!existsSync(shopifyWriteUpstream)) fail(`${relative(root, shopifyWriteUpstream)} is missing: there's no Shopify write upstream canary to look for.`)
  const shopifyWriteMatch = read(shopifyWriteUpstream).match(/export const SHOPIFY_WRITE_UPSTREAM_CANARY = '([^']+)'/)
  if (!shopifyWriteMatch) fail(`no \`export const SHOPIFY_WRITE_UPSTREAM_CANARY = '...'\` in ${relative(root, shopifyWriteUpstream)}; the write upstream's shape changed.`)
  const mcpUpstream = join(root, 'test/upstreams/mcp/server.ts')
  if (!existsSync(mcpUpstream)) fail(`${relative(root, mcpUpstream)} is missing: there's no MCP upstream canary to look for.`)
  const mcpMatch = read(mcpUpstream).match(/export const MCP_UPSTREAM_CANARY = '([^']+)'/)
  if (!mcpMatch) fail(`no \`export const MCP_UPSTREAM_CANARY = '...'\` in ${relative(root, mcpUpstream)}; the upstream's shape changed.`)
  const mcpFixtures = join(root, 'test/upstreams/mcp/index.ts')
  if (!existsSync(mcpFixtures)) fail(`${relative(root, mcpFixtures)} is missing: there's no MCP fixtures canary to look for.`)
  const mcpFixturesMatch = read(mcpFixtures).match(/export const MCP_FIXTURES_CANARY = '([^']+)'/)
  if (!mcpFixturesMatch) fail(`no \`export const MCP_FIXTURES_CANARY = '...'\` in ${relative(root, mcpFixtures)}; the fixtures' shape changed.`)
  const fakesHook = join(hubDir, 'testing/fakes.ts')
  if (!existsSync(fakesHook)) fail(`${relative(root, fakesHook)} is missing: there's no test-fakes canary to look for.`)
  const fakesMatch = read(fakesHook).match(/export const HUB_FAKES_CANARY = '([^']+)'/)
  if (!fakesMatch) fail(`no \`export const HUB_FAKES_CANARY = '...'\` in ${relative(root, fakesHook)}; the hook's shape changed.`)
  const evalWrite = join(hubDir, 'testing/eval-write.ts')
  if (!existsSync(evalWrite)) fail(`${relative(root, evalWrite)} is missing: there's no eval write gateway name to look for.`)
  const evalWriteMatch = read(evalWrite).match(/export class (EvalWriteGateway) extends WorkerEntrypoint/)
  if (!evalWriteMatch) fail(`no \`export class EvalWriteGateway extends WorkerEntrypoint\` in ${relative(root, evalWrite)}; the gateway's shape changed.`)
  const evalSlack = join(hubDir, 'testing/eval-slack.ts')
  if (!existsSync(evalSlack)) fail(`${relative(root, evalSlack)} is missing: there's no eval Slack canary to look for.`)
  const evalSlackMatch = read(evalSlack).match(/export const EVAL_SLACK_CANARY = '([^']+)'/)
  if (!evalSlackMatch) fail(`no \`export const EVAL_SLACK_CANARY = '...'\` in ${relative(root, evalSlack)}; the module's shape changed.`)
  return {
    EVAL_WRITE_GATEWAY: evalWriteMatch[1],
    EVAL_SLACK_CANARY: evalSlackMatch[1],
    CANARY: canaryMatch[1],
    SHOPIFY_CANARY: shopifyMatch[1],
    SHOPIFY_WRITE_CANARY: shopifyWriteMatch[1],
    MCP_CANARY: mcpMatch[1],
    MCP_FIXTURES_CANARY: mcpFixturesMatch[1],
    FAKES_CANARY: fakesMatch[1],
  }
}

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
/**
 * The [start, end) spans of every `if (false) { ... }` block in a script, or `unclosed` when one never closes, or
 * `ambiguous` when a line inside one is no deeper than its opener. wrangler
 * doesn't minify, so esbuild keeps a branch the define turned into `if (false)` as text (it only skips bundling the
 * imports inside it). esbuild prints the opener alone on its line and the block's `}` at the opener's indentation, so
 * the span is found by lines, never by reading the code: a quote in a regex or a string can't stretch it. A block with
 * no closing line at its indentation fails the part (it would otherwise count the rest of the file as dead).
 */
function deadSpans(text) {
  const spans = []
  const lines = text.split('\n')
  const starts = []
  let at = 0
  for (const line of lines) {
    starts.push(at)
    at += line.length + 1
  }
  for (let i = 0; i < lines.length; i++) {
    const open = /^(\s*)(?:\} else )?if \(false\) \{$/.exec(lines[i])
    if (!open) continue
    const close = new RegExp(`^${open[1]}\\}`)
    let j = i + 1
    while (j < lines.length && !close.test(lines[j])) {
      // Every line inside a real block sits deeper than its opener. One that doesn't (an opener-looking line inside a
      // template literal, say) makes the span ambiguous: fail rather than count it dead.
      if (lines[j].trim() !== '' && !lines[j].startsWith(`${open[1]} `)) return { ambiguous: i + 1 }
      j++
    }
    if (j === lines.length) return { unclosed: i + 1 }
    spans.push([starts[i], starts[j] + lines[j].length])
  }
  return { spans }
}
/**
 * The test-fakes hook's globals in a script outside every `if (false)` block (reachable code), and any block that never
 * closes. Scripts only: a source map carries the sources' own text, dead branches included.
 */
const fakesGlobals = ({ files }) =>
  files.filter(f => /\.[cm]?js$/.test(f)).flatMap(f => {
    const text = textOf(f)
    const dead = deadSpans(text)
    if (dead.ambiguous) return [`an \`if (false)\` block at line ${dead.ambiguous} of ${relative(root, f)} has a line no deeper than its opener, so its extent is ambiguous`]
    if (dead.unclosed) return [`an \`if (false)\` block at line ${dead.unclosed} of ${relative(root, f)} never closes at its indentation, so nothing after it can be judged`]
    const hits = []
    for (const n of FAKES_GLOBALS) {
      for (let i = text.indexOf(n); i !== -1; i = text.indexOf(n, i + n.length)) {
        if (!dead.spans.some(([a, b]) => i >= a && i < b)) {
          hits.push(`"${n}" in ${relative(root, f)} outside an \`if (false)\` block`)
          break
        }
      }
    }
    return hits
  })

function moduleGraph({ inputs }) {
  return inputs.filter(id => candidates(id).some(forbidden)).map(id => `module ${id}`)
}

function main() {
  const deployDir = flag('--deploy', join(root, 'dist-hub'))
  const testDir = flag('--test', join(root, 'dist-hub-test'))
  const { CANARY, SHOPIFY_CANARY, SHOPIFY_WRITE_CANARY, MCP_CANARY, MCP_FIXTURES_CANARY, FAKES_CANARY, EVAL_WRITE_GATEWAY, EVAL_SLACK_CANARY } = readCanaries()

  const PARTS = [
    ['canary string', canary(CANARY)],
    ['shopify upstream canary', canary(SHOPIFY_CANARY)],
    ['shopify write upstream canary', canary(SHOPIFY_WRITE_CANARY)],
    ['mcp upstream canary', canary(MCP_CANARY)],
    ['mcp fixtures canary', canary(MCP_FIXTURES_CANARY)],
    ['test-fakes canary', canary(FAKES_CANARY)],
    ['test-fakes globals', fakesGlobals],
    ['eval write gateway', canary(EVAL_WRITE_GATEWAY)],
    ['eval slack canary', canary(EVAL_SLACK_CANARY)],
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

  // Every test-fakes needle must be in the test bundle's script, or the guard has gone stale for it.
  const testScripts = testBundle.files.filter(f => /\.[cm]?js$/.test(f))
  const missing = FAKES_GLOBALS.filter(n => !testScripts.some(f => textOf(f).includes(n)))
  if (missing.length) {
    bad = true
    console.error(`FAIL  test-fakes names: the test bundle (${relative(root, testDir)}) lacks ${missing.map(n => `"${n}"`).join(', ')}, so the guard no longer looks for what the code uses.`)
  } else console.log('ok    test-fakes names: every name is in the test bundle.')

  // (#588) The eval Slack canary must be in the test bundle's script itself: a canary only in the map means the module's
  // runtime code stopped naming it, and a leak would then show nowhere but the map.
  if (!testScripts.some(f => textOf(f).includes(EVAL_SLACK_CANARY))) {
    bad = true
    console.error(`FAIL  eval slack canary in the script: the test bundle (${relative(root, testDir)}) holds "${EVAL_SLACK_CANARY}" in no script, so hub/testing/eval-slack.ts's runtime code no longer names it.`)
  } else console.log('ok    eval slack canary in the script: the test bundle\'s script holds it.')

  // (M4-F) The MCP fixtures canary must be in the test bundle's script too: the seam's runtime code names it.
  if (!testScripts.some(f => textOf(f).includes(MCP_FIXTURES_CANARY))) {
    bad = true
    console.error(`FAIL  mcp fixtures canary in the script: the test bundle (${relative(root, testDir)}) holds "${MCP_FIXTURES_CANARY}" in no script, so the fixtures' runtime code no longer names it.`)
  } else console.log('ok    mcp fixtures canary in the script: the test bundle\'s script holds it.')

  return bad ? 1 : 0
}

// Set process.exitCode and let Node exit naturally instead of calling process.exit(): in Node 26, process.exit() from
// top-level ESM tears down the V8 platform (joining background compiler threads) before disposing the Isolate, which
// deadlocks when a concurrent Maglev job is waiting on the main thread for GC.
try {
  process.exitCode = main()
} catch (e) {
  if (e instanceof Fatal) {
    console.error(`check-hub-build: ${e.message}`)
    process.exitCode = 2
  } else {
    throw e
  }
}
