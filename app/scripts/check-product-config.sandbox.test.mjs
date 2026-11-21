// check-product-config.mjs --sandbox, the sandbox prefix lock. Ways it could fail, written down first:
//  1. a per-PR config binds something outside its own PR: a live product's D1, R2, container, script or service, the
//     shared candidate's data, another PR's resources, a D1 by an id that points anywhere, or another Worker's Durable
//     Objects through a migration;
//  2. it attaches a host outside its own hosts on SBX_ZONE (a suffix attack, another zone, the bare zone, a wildcard);
//  3. it deploys to another account, turns on the AI binding (spend), runs more than 2 containers, builds an image or
//     runs a build command in the job that holds the token, ships logs elsewhere, or opens workers.dev or preview URLs;
//  4. a per-PR config ships without the test flag, or the candidate ships with it (or skips a product rule);
//  5. a sandbox config passes as a product one, or a product config as a sandbox one; a per-PR config passes as the
//     candidate or another PR's, or the candidate as a PR's (the caller states the mode);
//  6. a binding kind the lock doesn't know about passes;
//  7. a value hides where JSON.parse and wrangler's parser disagree (`__proto__`), at any depth;
//  8. a path points outside the build folder (wrangler would upload or build what it finds there);
//  9. it runs with the sandbox's account, zone or mode unset or malformed instead of stopping (exit 2);
// 10. its reader and wrangler's disagree on where a comment ends (a bare \r), so config hides from the check.
// 11. a migration step's values carry what its keys don't (a `from_script` inside `renamed_classes`).
// 12. (eval build, p3-eval-observability rev 2 rec 2) the AI binding or a gateway var passes beside the test issuer in any
//     mode but `--eval`; the eval deployment binds another deployment's names or hosts, or ships without the real
//     model, the test issuer's switch or the eval brand marker; the marker (INHOUSE_EVAL_BRAND) passes in a per-PR,
//     candidate or product config, so a brand could be graded or traced as an eval brand.
// 13. (P4) a sandbox product Worker binds a hub that isn't its own (the house's `inhouse-hub`, another PR's, a live
//     Worker; for the eval deployment, any hub but `inhouse-sbx-eval-hub`), another entrypoint (the hub's server
//     surface) or a second service; or a hub config (--hub, --eval --hub) gets a route,
//     storage, a service binding, an unbundled build, a `secrets` list wrangler would fail on, or (candidate) a store
//     credential or the test switch.
// Oracles: the literal pass fixtures in check-product-config-fixtures/sandbox/ and one literal change per rule below,
// each with the failure text it must print. Every case runs the script as CI and the ops repo do.
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'
import { stripJsonc } from './check-product-config.mjs'

const script = fileURLToPath(new URL('./check-product-config.mjs', import.meta.url))
const fixtures = fileURLToPath(new URL('./check-product-config-fixtures/', import.meta.url))
const ACCOUNT = '0123456789abcdef0123456789abcdef'
const ZONE = 'zone.example.test'
const ENV = { CF_SANDBOX_ACCOUNT_ID: ACCOUNT, SBX_ZONE: ZONE }
const PR12 = ['--sandbox', '--per-pr', '12']
const CANDIDATE = ['--sandbox', '--candidate']
const EVAL = ['--sandbox', '--eval']
const EVAL_BRAND_REFUSED = 'vars.INHOUSE_EVAL_BRAND is set: only the sandbox\'s eval deployment is an eval brand'
const run = (args, env = ENV) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', env: { PATH: process.env.PATH, ...env } })
const load = name => JSON.parse(readFileSync(`${fixtures}sandbox/${name}`, 'utf8'))
const tmp = mkdtempSync(join(tmpdir(), 'sandbox-config-'))
let n = 0
/** Writes the config (or, given `text`, the config's compact JSON passed through it) to a fresh folder. */
const write = (config, text = t => t) => {
  const dir = join(tmp, `c${++n}`)
  mkdirSync(dir)
  const file = join(dir, 'wrangler.json')
  writeFileSync(file, text(JSON.stringify(config)))
  return file
}
const failureLines = r => r.stderr.split('\n').filter(l => l.startsWith('  - '))
const access = (brand, team) => JSON.stringify({
  teamDomain: 'https://test-issuer.invalid',
  apps: [{ name: 'brand', origin: brand, aud: 'b'.repeat(64) }, { name: 'inhouse', origin: team, aud: 'c'.repeat(64) }],
  serviceTokens: {},
})
/** A text change that puts `inner` right after `anchor` in the compact JSON (how a `__proto__` key gets in as text). */
const after = (anchor, inner) => t => {
  if (!t.includes(anchor)) throw new Error(`anchor ${anchor} not in the config`)
  return t.replace(anchor, `${anchor},${inner}`)
}

/** [case, change to PR 12's passing config, the failure text, optional text change]. Each breaks exactly one rule. */
const PER_PR_CASES = [
  // 1: names and bindings.
  ['d1 of another PR', c => { c.d1_databases[0].database_name = 'inhouse-sbx-pr13-db' }, 'd1_databases[0].database_name: "inhouse-sbx-pr13-db" is not PR 12\'s d1 name (inhouse-sbx-pr12-db)'],
  ['d1 of the candidate', c => { c.d1_databases[0].database_name = 'inhouse-sbx-db' }, '"inhouse-sbx-db" is not PR 12\'s d1 name'],
  ['d1 of a live product', c => { c.d1_databases[0].database_name = 'live-product-db' }, '"live-product-db" is not PR 12\'s d1 name'],
  ['d1 named like another kind of this PR', c => { c.d1_databases[0].database_name = 'inhouse-sbx-pr12-files' }, '"inhouse-sbx-pr12-files" is not PR 12\'s d1 name'],
  ['d1 without a name', c => { delete c.d1_databases[0].database_name }, 'd1_databases[0].database_name: undefined is not PR 12\'s d1 name'],
  ['d1 bound by id', c => { c.d1_databases[0].database_id = '00000000-0000-4000-8000-000000000001' }, 'd1_databases[0].database_id is set'],
  ['d1 preview id', c => { c.d1_databases[0].preview_database_id = '00000000-0000-4000-8000-000000000002' }, 'd1_databases[0].preview_database_id is set'],
  ['d1 migrations pattern', c => { c.d1_databases[0].migrations_pattern = '../../**/*.sql' }, 'd1_databases[0].migrations_pattern is set'],
  ['two d1 bindings', c => { c.d1_databases.push({ ...c.d1_databases[0], binding: 'DB2' }) }, 'd1_databases has more than one database'],
  ['r2 of the candidate', c => { c.r2_buckets[0].bucket_name = 'inhouse-sbx-files' }, 'r2_buckets[0].bucket_name: "inhouse-sbx-files" is not PR 12\'s r2 name'],
  ['r2 of a live product', c => { c.r2_buckets[0].bucket_name = 'live-product-files' }, 'r2_buckets[0].bucket_name: "live-product-files"'],
  ['r2 preview bucket', c => { c.r2_buckets[0].preview_bucket_name = 'inhouse-sbx-pr12-files' }, 'r2_buckets[0].preview_bucket_name is set'],
  ['two r2 bindings', c => { c.r2_buckets.push({ ...c.r2_buckets[0], binding: 'FILES2' }) }, 'r2_buckets has more than one bucket'],
  ['container of a live product', c => { c.containers[0].name = 'inhouse-app' }, 'containers[0].name: "inhouse-app" is not PR 12\'s container name'],
  ['container without a name', c => { delete c.containers[0].name }, 'containers[0] has no name'],
  ['container image of a live product', c => { c.containers[0].image = `registry.cloudflare.com/${ACCOUNT}/live-product:v1` }, 'containers[0].image: "live-product" is not PR 12\'s image name'],
  ['durable object of another Worker', c => { c.durable_objects.bindings[0].script_name = 'live-product' }, 'durable_objects.bindings[0].script_name is set'],
  ['durable object of another environment', c => { c.durable_objects.bindings[0].environment = 'production' }, 'durable_objects.bindings[0].environment is set'],
  ['a migration that takes another Worker\'s objects', c => { c.migrations.push({ tag: 'v2', transferred_classes: [{ from: 'Live', from_script: 'live-product', to: 'Runner' }] }) }, 'migrations[1].transferred_classes is set'],
  ['service binding', c => { c.services = [{ binding: 'LIVE', service: 'live-product' }] }, 'services is set: a sandbox config may not use it'],
  ['kv binding', c => { c.kv_namespaces = [{ binding: 'KV', id: '0123' }] }, 'kv_namespaces is set'],
  ['queue producer', c => { c.queues = { producers: [{ binding: 'Q', queue: 'live-queue' }], consumers: [] } }, 'queues is set'],
  ['tail consumer', c => { c.tail_consumers = [{ service: 'live-product' }] }, 'tail_consumers is set'],
  ['dispatch namespace', c => { c.dispatch_namespaces = [{ binding: 'D', namespace: 'live' }] }, 'dispatch_namespaces is set'],
  ['log destinations', c => { c.observability = { enabled: true, logs: { enabled: true, destinations: ['elsewhere'] } } }, 'observability.logs.destinations is set'],
  ['an unknown observability key', c => { c.observability.sink = 'elsewhere' }, 'observability.sink is set'],
  // 6: a key the lock doesn't know, even a scalar.
  ['an unknown key', c => { c.first_party_worker = true }, 'first_party_worker is set'],
  // 7: where JSON.parse and wrangler's parser disagree, at every depth.
  ['__proto__ at the top', c => c, 'config.__proto__ is a forbidden key', after('"name":"inhouse-sbx-pr12"', '"__proto__":{"account_id":"fedcba9876543210fedcba9876543210"}')],
  ['__proto__ in a d1 binding', c => c, 'config.d1_databases[0].__proto__ is a forbidden key', after('"database_name":"inhouse-sbx-pr12-db"', '"__proto__":{"database_id":"00000000-0000-4000-8000-000000000001"}')],
  ['__proto__ in build', c => { c.build = { watch_dir: './src' } }, 'config.build.__proto__ is a forbidden key', after('"watch_dir":"./src"', '"__proto__":{"command":"npm run build"}')],
  ['__proto__ in a durable object binding', c => c, 'config.durable_objects.bindings[0].__proto__ is a forbidden key', after('"name":"RUNNER","class_name":"Runner"', '"__proto__":{"script_name":"live-product"}')],
  ['__proto__ in a container', c => c, 'config.containers[0].__proto__ is a forbidden key', after('"max_instances":2', '"__proto__":{"max_instances":20}')],
  ['__proto__ in assets', c => c, 'config.assets.__proto__ is a forbidden key', after('"directory":"../client"', '"__proto__":{"directory":"/"}')],
  ['a constructor key', c => { c.vars.constructor = 'x' }, 'config.vars.constructor is a forbidden key'],
  ['a prototype key', c => { c.migrations[0].prototype = {} }, 'config.migrations[0].prototype is a forbidden key'],
  // 11: migration step values.
  ['a rename from another Worker', c => { c.migrations.push({ tag: 'v2', renamed_classes: [{ from: 'Live', from_script: 'live-product', to: 'Runner' }] }) }, 'migrations[1].renamed_classes items must be exactly { from, to }'],
  ['a rename without a target', c => { c.migrations.push({ tag: 'v2', renamed_classes: [{ from: 'Old' }] }) }, 'migrations[1].renamed_classes items must be exactly { from, to }'],
  ['a class list of objects', c => { c.migrations[0].new_sqlite_classes = [{ name: 'Runner', script: 'live-product' }] }, 'migrations[0].new_sqlite_classes must be a list of class names'],
  ['a class list that is a string', c => { c.migrations.push({ tag: 'v2', deleted_classes: 'Live' }) }, 'migrations[1].deleted_classes must be a list of class names'],
  // 8: paths.
  ['main outside the build', c => { c.main = '../../../../proc/self/environ' }, 'main must be a relative path inside the build folder'],
  ['main absolute', c => { c.main = '/proc/self/environ' }, 'main must be a relative path inside the build folder'],
  ['assets elsewhere', c => { c.assets.directory = '../../..' }, 'assets.directory must be ../client'],
  ['assets absolute', c => { c.assets.directory = '/' }, 'assets.directory must be ../client'],
  ['migrations outside the build', c => { c.d1_databases[0].migrations_dir = '../../server/migrations' }, 'd1_databases[0].migrations_dir must be a relative path inside the build folder'],
  ['migrations absolute', c => { c.d1_databases[0].migrations_dir = '/etc' }, 'd1_databases[0].migrations_dir must be a relative path inside the build folder'],
  ['module rules', c => { c.rules = [{ type: 'Text', globs: ['../../**'] }] }, 'rules may only be the vite plugin\'s ESModule rule'],
  ['additional modules', c => { c.find_additional_modules = true }, 'find_additional_modules is set'],
  ['a base dir', c => { c.base_dir = '/' }, 'base_dir is set'],
  ['an alias', c => { c.alias = { x: '/etc/passwd' } }, 'alias is set'],
  ['a tsconfig', c => { c.tsconfig = '../../tsconfig.json' }, 'tsconfig is set'],
  ['python modules', c => { c.python_modules = { exclude: [] } }, 'python_modules may only be wrangler\'s default'],
  ['the vite plugin\'s config path', c => { c.userConfigPath = '/tmp/elsewhere.json' }, 'userConfigPath is set'],
  // 2: hosts.
  ['route on another zone', c => { c.routes[0].pattern = 'inhouse-sbx-pr12-brand.evil.test' }, 'routes[0].pattern: host "inhouse-sbx-pr12-brand.evil.test" is not PR 12\'s brand or team host'],
  ['route suffix attack', c => { c.routes[0].pattern = `inhouse-sbx-pr12-brand.${ZONE}.evil.test` }, 'is not PR 12\'s brand or team host'],
  ['route on the bare zone', c => { c.routes[0].pattern = ZONE }, `routes[0].pattern: host "${ZONE}" is not PR 12's`],
  ['route one level deeper', c => { c.routes[0].pattern = `www.inhouse-sbx-pr12-brand.${ZONE}` }, 'routes[0].pattern: host "www.inhouse-sbx-pr12-brand'],
  ['route in upper case', c => { c.routes[0].pattern = `INHOUSE-SBX-PR12-BRAND.${ZONE}` }, 'routes[0].pattern: host "INHOUSE'],
  ['route of another PR', c => { c.routes[1].pattern = `inhouse-sbx-pr13-team.${ZONE}` }, 'routes[1].pattern: host "inhouse-sbx-pr13-team.zone.example.test" is not PR 12\'s'],
  ['route on another name of this PR', c => { c.routes[1].pattern = `inhouse-sbx-pr12-db.${ZONE}` }, 'routes[1].pattern: host "inhouse-sbx-pr12-db.zone.example.test" is not PR 12\'s'],
  ['route with a wildcard', c => { c.routes[0] = { pattern: `*.${ZONE}/*`, zone_name: ZONE } }, 'routes[0].pattern: host "*.zone.example.test"'],
  ['route by zone id', c => { c.routes[0] = { pattern: `inhouse-sbx-pr12-brand.${ZONE}/*`, zone_id: 'abc' } }, 'routes[0].zone_id is set'],
  ['route on another zone name', c => { c.routes[0] = { pattern: `inhouse-sbx-pr12-brand.${ZONE}/*`, zone_name: 'evil.test' } }, 'routes[0].zone_name is not the sandbox zone'],
  ['the single route key', c => { c.route = 'shop.example.test/*' }, 'route.pattern: host "shop.example.test"'],
  ['a route with a scheme', c => { c.routes[0] = `https://inhouse-sbx-pr12-brand.${ZONE}/*` }, 'routes[0].pattern: host "https:"'],
  ['access origin off the zone', c => { c.vars.INHOUSE_ACCESS = access('https://brand.example.test', `https://inhouse-sbx-pr12-team.${ZONE}`) }, 'INHOUSE_ACCESS.apps[0].origin: host "brand.example.test" is not PR 12\'s'],
  ['access origin over http', c => { c.vars.INHOUSE_ACCESS = access(`http://inhouse-sbx-pr12-brand.${ZONE}`, `https://inhouse-sbx-pr12-team.${ZONE}`) }, 'INHOUSE_ACCESS.apps[0].origin must be a bare https:// origin'],
  // 3: account, spend, size, builds, public URLs.
  ['no account id', c => { delete c.account_id }, 'account_id is missing or is not the sandbox account'],
  ['another account', c => { c.account_id = 'fedcba9876543210fedcba9876543210' }, 'account_id is missing or is not the sandbox account'],
  ['an AI binding', c => { c.ai = { binding: 'AI' } }, 'ai is set: the sandbox runs the scripted model only', undefined, ['a test-build config has an AI binding or a gateway var or secret']],
  ['3 containers at most', c => { c.containers[0].max_instances = 3 }, 'containers[0].max_instances must be 1 or 2'],
  ['no container limit', c => { delete c.containers[0].max_instances }, 'containers[0].max_instances must be 1 or 2 (left out'],
  ['a container limit of 0', c => { c.containers[0].max_instances = 0 }, 'containers[0].max_instances must be 1 or 2'],
  ['a fractional container limit', c => { c.containers[0].max_instances = 1.5 }, 'containers[0].max_instances must be 1 or 2'],
  // P3's pool rules hold in the sandbox, the container cap of 2 standing in for 3 x RUNNER_POOL (the pass fixture has
  // RUNNER_POOL 2 with max_instances 2, which product mode would refuse).
  ['no RUNNER_POOL beside the Runner container', c => { delete c.vars.RUNNER_POOL }, 'vars.RUNNER_POOL must be a whole number of 2 or more'],
  ['a RUNNER_POOL of 1', c => { c.vars.RUNNER_POOL = '1' }, 'vars.RUNNER_POOL must be a whole number of 2 or more'],
  ['the container not for the Runner class', c => { c.containers[0].class_name = 'Other'; c.durable_objects.bindings[0].class_name = 'Other'; c.migrations[0].new_sqlite_classes = ['Other'] }, 'containers must be exactly one, for the Runner class'],
  ['two containers', c => { c.containers.push({ ...c.containers[0], class_name: 'Other', max_instances: 1 }) }, 'containers has more than one container', undefined, ['containers must be exactly one, for the Runner class']],
  ['a container built from a Dockerfile', c => { c.containers[0].image = './runner/Dockerfile' }, 'containers[0].image must be registry.cloudflare.com/<CF_SANDBOX_ACCOUNT_ID>/'],
  ['a container image in another account', c => { c.containers[0].image = 'registry.cloudflare.com/fedcba9876543210fedcba9876543210/inhouse-sbx-pr12:v1' }, 'containers[0].image must be registry.cloudflare.com/'],
  ['a container image on Docker Hub', c => { c.containers[0].image = 'docker.io/library/inhouse-sbx-pr12:v1' }, 'containers[0].image must be registry.cloudflare.com/'],
  ['a container image without a tag', c => { c.containers[0].image = `registry.cloudflare.com/${ACCOUNT}/inhouse-sbx-pr12` }, 'containers[0].image must be registry.cloudflare.com/'],
  ['a container image with a path', c => { c.containers[0].image = `registry.cloudflare.com/${ACCOUNT}/x/inhouse-sbx-pr12:v1` }, 'containers[0].image: "x/inhouse-sbx-pr12" is not PR 12\'s image name'],
  ['a container build context', c => { c.containers[0].image_build_context = '.' }, 'containers[0].image_build_context is set'],
  ['a container images map', c => { c.containers[0].images = { runner: { dockerfile: './Dockerfile' } } }, 'containers[0].images is set'],
  ['a build command', c => { c.build = { command: 'npm run build' } }, 'build.command is set'],
  ['workers.dev on', c => { c.workers_dev = true }, 'workers_dev must be false'],
  ['workers.dev left out', c => { delete c.workers_dev }, 'workers_dev must be false'],
  ['preview URLs on', c => { c.preview_urls = true }, 'preview_urls must be false'],
  ['an env block', c => { c.env = { other: { name: 'live-product' } } }, 'env is set'],
  // 4: the test flag.
  ['no test flag', c => { delete c.vars.INHOUSE_TEST_BUILD }, 'vars.INHOUSE_TEST_BUILD must be "1" in a per-PR test deployment'],
  ['test flag off', c => { c.vars.INHOUSE_TEST_BUILD = '0' }, 'vars.INHOUSE_TEST_BUILD must be "1"'],
  ['no INHOUSE_ACCESS', c => { delete c.vars.INHOUSE_ACCESS }, 'vars.INHOUSE_ACCESS must list the per-PR hosts'],
  // 12: the eval brand marker.
  ['the eval brand marker', c => { c.vars.INHOUSE_EVAL_BRAND = '1' }, EVAL_BRAND_REFUSED],
]

describe('check-product-config --sandbox --per-pr: PR 12', () => {
  test('passes pass-per-pr.json with exit 0', () => {
    const r = run([...PR12, `${fixtures}sandbox/pass-per-pr.json`])
    expect(r.stderr).toBe('')
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('may deploy to the sandbox (PR 12)')
  })
  test('passes pass-per-pr-generated.json (config.mjs\'s rewrite of the vite output) as PR 7', () => {
    const r = run(['--sandbox', '--per-pr', '7', `${fixtures}sandbox/pass-per-pr-generated.json`])
    expect(r.stderr).toBe('')
    expect(r.status).toBe(0)
  })
  test('refuses the raw vite output on exactly what config.mjs must rewrite', () => {
    const r = run(['--sandbox', '--per-pr', '7', `${fixtures}sandbox/raw-vite-output.json`])
    expect(r.status).toBe(1)
    expect(failureLines(r)).toEqual([
      '  - configPath is set: a sandbox config may not use it (it could reach resources or files outside the sandbox)',
      '  - userConfigPath is set: a sandbox config may not use it (it could reach resources or files outside the sandbox)',
      '  - topLevelName is set: a sandbox config may not use it (it could reach resources or files outside the sandbox)',
      '  - d1_databases[0].migrations_dir must be a relative path inside the build folder (no .., not absolute)',
    ])
  })
  for (const [name, change, text, textChange, also = []] of PER_PR_CASES) {
    test(`refuses ${name} with exit 1 and names it`, () => {
      const config = load('pass-per-pr.json')
      change(config)
      const r = run([...PR12, write(config, textChange)])
      expect(r.status).toBe(1)
      // `also`: P3's pool and gateway rules (checkPool) name the same break in their own words.
      expect(failureLines(r)).toEqual([text, ...also].map(t => expect.stringContaining(t)))
    })
  }
  test('refuses a container image that exists as a file beside the config (wrangler would build it)', () => {
    const config = load('pass-per-pr.json')
    const file = write(config)
    const dir = join(file, '..', 'registry.cloudflare.com', ACCOUNT)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'inhouse-sbx-pr12:sha-0a1b2c3'), 'FROM scratch\n')
    const r = run([...PR12, file])
    expect(r.status).toBe(1)
    expect(failureLines(r)).toEqual([expect.stringContaining('containers[0].image exists as a file beside the config')])
  })
})

describe('the caller states the mode (failure 5)', () => {
  test('PR 12\'s config fails as PR 13\'s, on every name and host', () => {
    const r = run(['--sandbox', '--per-pr', '13', `${fixtures}sandbox/pass-per-pr.json`])
    expect(r.status).toBe(1)
    const lines = failureLines(r)
    for (const where of ['name', 'd1_databases[0].database_name', 'r2_buckets[0].bucket_name', 'containers[0].name', 'containers[0].image', 'routes[0].pattern', 'routes[1].pattern', 'INHOUSE_ACCESS.apps[0].origin', 'INHOUSE_ACCESS.apps[1].origin']) {
      expect(lines.some(l => l.startsWith(`  - ${where}: `) && l.includes('PR 13')), where).toBe(true)
    }
  })
  test('a per-PR config fails as the candidate, on its per-PR names and the product rules', () => {
    const r = run([...CANDIDATE, `${fixtures}sandbox/pass-per-pr.json`])
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('name: "inhouse-sbx-pr12" is a per-PR name, not the candidate\'s')
    expect(r.stderr).toContain('d1_databases[0].database_name: "inhouse-sbx-pr12-db" is a per-PR name')
    expect(r.stderr).toContain('vars.INHOUSE_TEST_BUILD is set')
  })
  test('the candidate fails as a PR\'s', () => {
    const r = run([...PR12, `${fixtures}sandbox/pass-candidate.json`])
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('name: "inhouse-sbx-product" is not PR 12\'s worker name (inhouse-sbx-pr12)')
    expect(r.stderr).toContain('vars.INHOUSE_TEST_BUILD must be "1"')
  })
})

describe('check-product-config --sandbox --candidate', () => {
  test('passes pass-candidate.json with exit 0', () => {
    const r = run([...CANDIDATE, `${fixtures}sandbox/pass-candidate.json`])
    expect(r.stderr).toBe('')
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('may deploy to the sandbox (candidate)')
  })
  const CANDIDATE_CASES = [
    ['the test flag', c => { c.vars.INHOUSE_TEST_BUILD = '1' }, 'vars.INHOUSE_TEST_BUILD is set: the test issuer must never be on'],
    ['a live D1', c => { c.d1_databases[0].database_name = 'live-product-db' }, 'd1_databases[0].database_name: "live-product-db" is not a sandbox name'],
    ['a PR\'s D1', c => { c.d1_databases[0].database_name = 'inhouse-sbx-pr12-db' }, 'd1_databases[0].database_name: "inhouse-sbx-pr12-db" is a per-PR name, not the candidate\'s'],
    ['a live host', c => { c.routes[0].pattern = `inhouse-app.${ZONE}` }, 'routes[0].pattern: host "inhouse-app.zone.example.test": "inhouse-app" is not a sandbox name'],
    ['a PR\'s host', c => { c.routes[0].pattern = `inhouse-sbx-pr12-brand.${ZONE}` }, 'routes[0].pattern: host "inhouse-sbx-pr12-brand.zone.example.test": "inhouse-sbx-pr12-brand" is a per-PR name'],
    ['another account', c => { c.account_id = 'fedcba9876543210fedcba9876543210' }, 'account_id is missing or is not the sandbox account'],
    ['a product rule (version metadata)', c => { delete c.version_metadata }, 'version_metadata needs a binding name'],
    ['a D1 id', c => { c.d1_databases[0].database_id = '11111111-0000-4000-8000-000000000000' }, 'd1_databases[0].database_id is set'],
  ]
  for (const [name, change, text] of CANDIDATE_CASES) {
    test(`refuses ${name}`, () => {
      const config = load('pass-candidate.json')
      change(config)
      const r = run([...CANDIDATE, write(config)])
      expect(r.status).toBe(1)
      expect(failureLines(r)).toEqual([expect.stringContaining(text)])
    })
  }
})

describe('neither mode passes the other\'s config (failure 5)', () => {
  for (const pass of ['pass-per-pr.json', 'pass-per-pr-generated.json', 'pass-candidate.json']) {
    test(`product mode refuses sandbox/${pass} on its sandbox strings`, () => {
      const r = run([`${fixtures}sandbox/${pass}`])
      expect(r.status).toBe(1)
      expect(r.stderr).toContain('config.name carries inhouse-sbx-')
    })
  }
  test('product mode refuses inhouse-sbx- anywhere, in any case, and a __proto__ key', () => {
    const product = JSON.parse(stripJsonc(readFileSync(`${fixtures}pass.jsonc`, 'utf8')))
    const r1 = run([write({ ...product, vars: { ...product.vars, NOTE: 'see Inhouse-SBX-db' } })])
    expect(r1.status).toBe(1)
    expect(failureLines(r1)).toEqual(['  - config.vars.NOTE carries inhouse-sbx- (a sandbox name or host): a product config never does'])
    const r2 = run([write(product, after('"name":"inhouse-product"', '"__proto__":{"workers_dev":true}'))])
    expect(r2.status).toBe(1)
    expect(failureLines(r2)).toEqual([expect.stringContaining('config.__proto__ is a forbidden key')])
  })
  test('sandbox mode refuses the product pass fixture and the test build config', () => {
    for (const file of [`${fixtures}pass.jsonc`, fileURLToPath(new URL('../wrangler.test.jsonc', import.meta.url)), fileURLToPath(new URL('../wrangler.product.jsonc', import.meta.url))]) {
      for (const mode of [PR12, CANDIDATE]) {
        // As written (JSONC, with comments): not even read.
        expect(run([...mode, file]).status, file).toBe(2)
        // As plain JSON: refused on its names and account.
        const r = run([...mode, write(JSON.parse(stripJsonc(readFileSync(file, 'utf8'))))])
        expect(r.status, file).toBe(1)
        expect(r.stderr).toContain('name: "inhouse-product"')
        expect(r.stderr).toContain('account_id is missing')
      }
    }
  })
})

describe('comments (failure 10)', () => {
  const text = readFileSync(`${fixtures}sandbox/pass-per-pr.json`, 'utf8')
  const fileOf = t => {
    const dir = join(tmp, `t${++n}`)
    mkdirSync(dir)
    writeFileSync(join(dir, 'wrangler.json'), t)
    return join(dir, 'wrangler.json')
  }
  const hidden = '"build":{"command":"echo pwned"},"services":[{"binding":"LIVE","service":"live-product"}],'
  test('sandbox mode reads plain JSON only: a comment, or a bare-\\r comment that hides config from a JSONC reader, exits 2', () => {
    // Text put right after the file's opening brace (built by slicing, so nothing else in the file can match).
    expect(text.startsWith('{')).toBe(true)
    const afterBrace = inner => `{${inner}${text.slice(1)}`
    for (const t of [`// a comment\n${text}`, afterBrace(` // x\r${hidden}`), afterBrace(' /* x */')]) {
      const r = run([...PR12, fileOf(t)])
      expect(r.status).toBe(2)
      expect(r.stderr).toContain("isn't plain JSON (sandbox configs have no comments)")
      expect(r.stdout).toBe('')
    }
  })
  test('product mode ends a // comment at a bare \\r, as wrangler does, so the config after it is checked', () => {
    expect(JSON.parse(stripJsonc('{"a": 1, // c\r"b": 2}'))).toEqual({ a: 1, b: 2 })
    expect(JSON.parse(stripJsonc('{"a": 1 // c\r, "b": 2}'))).toEqual({ a: 1, b: 2 })
    expect(JSON.parse(stripJsonc('{"a": [1, // c\r]}'))).toEqual({ a: [1] })
    const product = readFileSync(`${fixtures}pass.jsonc`, 'utf8')
    const r = run([fileOf(product.replace('"main"', '// note\r"env": { "x": {} },\n\t"main"'))])
    expect(r.status).toBe(1)
    expect(failureLines(r)).toEqual([expect.stringContaining('env is set')])
  })
})

const evalHost = kind => `inhouse-sbx-eval-${kind}.${ZONE}`
/** [case, change to the eval deployment's passing config, the failure text, optional text change, other lines]. */
const EVAL_CASES = [
  ['a PR\'s worker name', c => { c.name = 'inhouse-sbx-pr12' }, 'name: "inhouse-sbx-pr12" is not the eval deployment\'s worker name (inhouse-sbx-eval)'],
  ['the candidate\'s d1', c => { c.d1_databases[0].database_name = 'inhouse-sbx-db' }, 'd1_databases[0].database_name: "inhouse-sbx-db" is not the eval deployment\'s d1 name (inhouse-sbx-eval-db)'],
  ['a live product\'s r2', c => { c.r2_buckets[0].bucket_name = 'live-product-files' }, 'r2_buckets[0].bucket_name: "live-product-files" is not the eval deployment\'s r2 name'],
  ['a PR\'s container', c => { c.containers[0].name = 'inhouse-sbx-pr12' }, 'containers[0].name: "inhouse-sbx-pr12" is not the eval deployment\'s container name'],
  ['a PR\'s image', c => { c.containers[0].image = `registry.cloudflare.com/${ACCOUNT}/inhouse-sbx-pr12:v1` }, 'containers[0].image: "inhouse-sbx-pr12" is not the eval deployment\'s image name'],
  ['the candidate\'s host', c => { c.routes[0].pattern = `inhouse-sbx-brand.${ZONE}` }, `routes[0].pattern: host "inhouse-sbx-brand.${ZONE}" is not the eval deployment's brand or team host on the sandbox zone`],
  ['an access origin of a PR', c => { c.vars.INHOUSE_ACCESS = access(`https://inhouse-sbx-pr12-brand.${ZONE}`, `https://${evalHost('team')}`) }, 'INHOUSE_ACCESS.apps[0].origin: host "inhouse-sbx-pr12-brand.zone.example.test" is not the eval deployment\'s'],
  ['no AI binding', c => { delete c.ai }, 'ai.binding must name the AI binding: the eval deployment runs the real model through the gateway'],
  ['an AI binding with another key', c => { c.ai.remote = true }, 'ai.remote is set: a sandbox config may not use it'],
  ['no gateway id', c => { c.vars.AI_GATEWAY_ID = '' }, 'vars.AI_GATEWAY_ID must name the AI Gateway'],
  ['no eval brand marker', c => { delete c.vars.INHOUSE_EVAL_BRAND }, 'vars.INHOUSE_EVAL_BRAND must be "1" in the eval deployment'],
  ['the marker off', c => { c.vars.INHOUSE_EVAL_BRAND = 'true' }, 'vars.INHOUSE_EVAL_BRAND must be "1" in the eval deployment'],
  ['no test flag', c => { delete c.vars.INHOUSE_TEST_BUILD }, 'vars.INHOUSE_TEST_BUILD must be "1" in the eval deployment'],
  ['no INHOUSE_ACCESS', c => { delete c.vars.INHOUSE_ACCESS }, 'vars.INHOUSE_ACCESS must list the eval hosts as its app origins'],
  // #236 review O2: the eval build reads green without version metadata (as the test build may), so its deployment must
  // carry the binding.
  ['no version metadata', c => { delete c.version_metadata }, 'version_metadata needs a binding name in the eval deployment'],
  // #240 review M1: eval holds the real gateway token, so no secret may sit in its plain vars.
  ['the gateway token as a var', c => { c.vars.AI_GATEWAY_TOKEN = 'real-token' }, 'vars.AI_GATEWAY_TOKEN looks like a secret: set secrets with wrangler secret put'],
  ['a provider key as a var', c => { c.vars.ANTHROPIC_API_KEY = 'sk-ant-real' }, 'vars.ANTHROPIC_API_KEY looks like a secret: set secrets with wrangler secret put'],
  ['another gateway var', c => { c.vars.AI_GATEWAY_URL = 'https://gateway.example.test/' }, 'vars.AI_GATEWAY_URL is set: of the gateway\'s settings only AI_GATEWAY_ID is a var'],
  ['the audit hash key as a var', c => { c.vars.AUDIT_HASH_KEY = 'test-only-audit-hash-key-not-a-secret' }, 'vars.AUDIT_HASH_KEY looks like a secret: set secrets with wrangler secret put'],
  ['a secret-like var', c => { c.vars.SESSION_SECRET = 'x' }, 'vars.SESSION_SECRET looks like a secret: set secrets with wrangler secret put'],
  // #240 review O-L2: the plan's required test-issuer key, its public half only.
  ['no test issuer key', c => { delete c.vars.TEST_ISSUER_JWKS }, 'vars.TEST_ISSUER_JWKS must be a JWKS of one public key'],
  ['a private test issuer key', c => { const j = JSON.parse(c.vars.TEST_ISSUER_JWKS); j.keys[0].d = 'CCCC'; c.vars.TEST_ISSUER_JWKS = JSON.stringify(j) }, 'vars.TEST_ISSUER_JWKS must be a JWKS of one public key'],
  ['two test issuer keys', c => { const j = JSON.parse(c.vars.TEST_ISSUER_JWKS); j.keys.push(j.keys[0]); c.vars.TEST_ISSUER_JWKS = JSON.stringify(j) }, 'vars.TEST_ISSUER_JWKS must be a JWKS of one public key'],
  ['a test issuer key that is not JSON', c => { c.vars.TEST_ISSUER_JWKS = '{keys' }, 'vars.TEST_ISSUER_JWKS must be a JWKS of one public key'],
  ['version metadata without a binding', c => { c.version_metadata = {} }, 'version_metadata needs a binding name in the eval deployment'],
  // The sandbox's own rules hold in eval mode too.
  ['another account', c => { c.account_id = 'fedcba9876543210fedcba9876543210' }, 'account_id is missing or is not the sandbox account'],
  ['3 containers', c => { c.containers[0].max_instances = 3 }, 'containers[0].max_instances must be 1 or 2'],
  // (eval hub) still refused; the eval deployment's own refusal names the one binding it may hold.
  ['a service binding', c => { c.services = [{ binding: 'LIVE', service: 'live-product' }] }, 'services is set: the eval deployment may bind exactly { HUB -> ReadGateway } to its own hub'],
  ['__proto__ in the AI binding', c => c, 'config.ai.__proto__ is a forbidden key', after('"ai":{"binding":"AI"', '"__proto__":{"remote":true}')],
]

describe('check-product-config --sandbox --eval (failure 12)', () => {
  test('passes pass-eval.json with exit 0: the AI binding and gateway beside the test issuer', () => {
    const r = run([...EVAL, `${fixtures}sandbox/pass-eval.json`])
    expect(r.stderr).toBe('')
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('may deploy to the sandbox (eval)')
  })
  for (const [name, change, text, textChange, also = []] of EVAL_CASES) {
    test(`refuses ${name} with exit 1 and names it`, () => {
      const config = load('pass-eval.json')
      change(config)
      const r = run([...EVAL, write(config, textChange)])
      expect(r.status).toBe(1)
      expect(failureLines(r)).toEqual([text, ...also].map(t => expect.stringContaining(t)))
    })
  }
  test('no other mode passes the eval deployment\'s config, and eval mode passes no other\'s', () => {
    const asPr = run([...PR12, `${fixtures}sandbox/pass-eval.json`])
    expect(asPr.status).toBe(1)
    expect(asPr.stderr).toContain('name: "inhouse-sbx-eval" is not PR 12\'s worker name')
    expect(asPr.stderr).toContain('ai is set: the sandbox runs the scripted model only')
    expect(asPr.stderr).toContain(EVAL_BRAND_REFUSED)
    const asCandidate = run([...CANDIDATE, `${fixtures}sandbox/pass-eval.json`])
    expect(asCandidate.status).toBe(1)
    expect(asCandidate.stderr).toContain('name: "inhouse-sbx-eval" is the eval deployment\'s name, not the candidate\'s')
    expect(asCandidate.stderr).toContain(EVAL_BRAND_REFUSED)
    expect(asCandidate.stderr).toContain('ai is set: the sandbox runs the scripted model only')
    const asProduct = run([`${fixtures}sandbox/pass-eval.json`])
    expect(asProduct.status).toBe(1)
    expect(asProduct.stderr).toContain(EVAL_BRAND_REFUSED)
    for (const other of ['pass-per-pr.json', 'pass-candidate.json']) {
      const r = run([...EVAL, `${fixtures}sandbox/${other}`])
      expect(r.status, other).toBe(1)
      expect(r.stderr, other).toContain('is not the eval deployment\'s worker name (inhouse-sbx-eval)')
      expect(r.stderr, other).toContain('vars.INHOUSE_EVAL_BRAND must be "1" in the eval deployment')
    }
  })
  test('the candidate refuses the eval brand marker', () => {
    const config = load('pass-candidate.json')
    config.vars.INHOUSE_EVAL_BRAND = '1'
    const r = run([...CANDIDATE, write(config)])
    expect(r.status).toBe(1)
    expect(failureLines(r)).toEqual([expect.stringContaining(EVAL_BRAND_REFUSED)])
  })
})

describe('usage (failure 9)', () => {
  const file = `${fixtures}sandbox/pass-per-pr.json`
  test('exits 2 without, or with a malformed, account id or zone', () => {
    for (const env of [{}, { SBX_ZONE: ZONE }, { CF_SANDBOX_ACCOUNT_ID: ACCOUNT }, { ...ENV, CF_SANDBOX_ACCOUNT_ID: ACCOUNT.toUpperCase() },
      { ...ENV, CF_SANDBOX_ACCOUNT_ID: `${ACCOUNT}0` }, { ...ENV, SBX_ZONE: 'Zone.example.test' }, { ...ENV, SBX_ZONE: 'example' }, { ...ENV, SBX_ZONE: `${ZONE}.` }]) {
      const r = run([...PR12, file], env)
      expect(r.status, JSON.stringify(env)).toBe(2)
      expect(r.stdout).toBe('')
    }
  })
  test('exits 2 without a mode, on a malformed PR number, or on two modes', () => {
    for (const args of [['--sandbox', file], ['--sandbox', '--per-pr', file], ['--sandbox', '--per-pr', '0', file], ['--sandbox', '--per-pr', '012', file],
      ['--sandbox', '--per-pr', '1234567', file], ['--sandbox', '--per-pr', '12x', file], ['--sandbox', '--candidate', '--per-pr', '12', file],
      ['--sandbox', '--per-pr', '12', '--candidate', file], ['--sandbox', '--eval', '--per-pr', '12', file], ['--sandbox', '--per-pr', '12', '--eval', file],
      ['--sandbox', '--eval', '--candidate', file], ['--eval', file]]) {
      const r = run(args)
      expect(r.status, args.join(' ')).toBe(2)
      expect(r.stdout).toBe('')
    }
  })
  test('exits 2 on a missing path, two paths, an unknown flag or a config that is not an object', () => {
    expect(run(PR12).status).toBe(2)
    expect(run([...PR12, file, file]).status).toBe(2)
    expect(run([...PR12, '--other']).status).toBe(2)
    expect(run([file, '--sandbox']).status).toBe(2)
    expect(run([...PR12, write([])]).status).toBe(2)
  })
})

const HUB = { binding: 'HUB', service: 'inhouse-sbx-pr12-hub', entrypoint: 'ReadGateway' }
const PR12_HUB = [...PR12, '--hub']
const CANDIDATE_HUB = [...CANDIDATE, '--hub']

describe('(P4) the product\'s one service binding, to its own sandbox hub (failure 12)', () => {
  test('PR 12 may bind inhouse-sbx-pr12-hub\'s ReadGateway, and the candidate a shared sandbox hub', () => {
    const pr = load('pass-per-pr.json')
    pr.services = [HUB]
    const r1 = run([...PR12, write(pr)])
    expect(r1.stderr).toBe('')
    expect(r1.status).toBe(0)
    const candidate = load('pass-candidate.json')
    candidate.services = [{ ...HUB, service: 'inhouse-sbx-hub' }]
    const r2 = run([...CANDIDATE, write(candidate)])
    expect(r2.stderr).toBe('')
    expect(r2.status).toBe(0)
  })
  // (P5) The message names both allowed sets now (the refusals are unchanged).
  const SHAPE = 'services is set: a sandbox config may not use it, but for exactly { HUB -> ReadGateway } or { HUB -> ReadGateway, HUB_CONNECT -> ConnectGateway, HUB_DELIVERY -> DeliveryGateway }'
  const PRODUCT_CASES = [
    ['the house hub', [PR12, 'pass-per-pr.json'], { ...HUB, service: 'inhouse-hub' }, 'services[0].service: "inhouse-hub" is not PR 12\'s hub name (inhouse-sbx-pr12-hub)'],
    ['another PR\'s hub', [PR12, 'pass-per-pr.json'], { ...HUB, service: 'inhouse-sbx-pr13-hub' }, 'services[0].service: "inhouse-sbx-pr13-hub" is not PR 12\'s hub name'],
    ['the candidate\'s hub from a PR', [PR12, 'pass-per-pr.json'], { ...HUB, service: 'inhouse-sbx-hub' }, 'services[0].service: "inhouse-sbx-hub" is not PR 12\'s hub name'],
    ['the PR\'s own product Worker', [PR12, 'pass-per-pr.json'], { ...HUB, service: 'inhouse-sbx-pr12' }, 'services[0].service: "inhouse-sbx-pr12" is not PR 12\'s hub name'],
    ['the house hub from the candidate', [CANDIDATE, 'pass-candidate.json'], { ...HUB, service: 'inhouse-hub' }, 'services[0].service: "inhouse-hub" is not a sandbox name'],
    ['a PR\'s hub from the candidate', [CANDIDATE, 'pass-candidate.json'], HUB, 'services[0].service: "inhouse-sbx-pr12-hub" is a per-PR name, not the candidate\'s'],
    ['the candidate product binding its own name', [CANDIDATE, 'pass-candidate.json'], { ...HUB, service: 'inhouse-sbx-product' }, 'services[0].service: "inhouse-sbx-product" is not the candidate hub\'s name (inhouse-sbx-hub)'],
    ['a PR-style hub name from the candidate', [CANDIDATE, 'pass-candidate.json'], { ...HUB, service: 'inhouse-sbx-pr012-hub' }, 'services[0].service: "inhouse-sbx-pr012-hub" is not the candidate hub\'s name (inhouse-sbx-hub)'],
    ['the server entrypoint', [PR12, 'pass-per-pr.json'], { ...HUB, entrypoint: 'ServerGateway' }, SHAPE],
    ['the default export', [PR12, 'pass-per-pr.json'], { binding: 'HUB', service: HUB.service }, SHAPE],
    ['another binding name', [PR12, 'pass-per-pr.json'], { ...HUB, binding: 'LIVE' }, SHAPE],
    ['an environment', [PR12, 'pass-per-pr.json'], { ...HUB, environment: 'production' }, SHAPE],
    ['a second entry', [PR12, 'pass-per-pr.json'], [HUB, { ...HUB, binding: 'HUB2' }], SHAPE],
    ['the hub binding twice', [PR12, 'pass-per-pr.json'], [HUB, HUB], SHAPE],
    ['a live product', [CANDIDATE, 'pass-candidate.json'], { binding: 'LIVE', service: 'live-product' }, SHAPE],
  ]
  for (const [name, [mode, fixture], entry, text] of PRODUCT_CASES) {
    test(`refuses ${name}`, () => {
      const config = load(fixture)
      config.services = Array.isArray(entry) ? entry : [entry]
      const r = run([...mode, write(config)])
      expect(r.status).toBe(1)
      expect(failureLines(r)).toEqual([expect.stringContaining(text)])
    })
  }
  test('refuses the candidate product named like the candidate hub, with or without the binding', () => {
    const config = load('pass-candidate.json')
    config.name = 'inhouse-sbx-hub'
    const r1 = run([...CANDIDATE, write(config)])
    expect(r1.status).toBe(1)
    expect(failureLines(r1)).toEqual([expect.stringContaining('name: the candidate product may not take the hub\'s name (inhouse-sbx-hub)')])
    config.services = [{ ...HUB, service: 'inhouse-sbx-hub' }]
    const r2 = run([...CANDIDATE, write(config)])
    expect(r2.status).toBe(1)
    expect(r2.stderr).toContain('the hub may not be the product\'s own name ("inhouse-sbx-hub")')
  })
  test('refuses services that is not a list', () => {
    const config = load('pass-per-pr.json')
    config.services = HUB
    const r = run([...PR12, write(config)])
    expect(r.status).toBe(1)
    expect(failureLines(r)).toEqual([expect.stringContaining('services must be a list')])
  })
})

describe('(P4) --hub: the connector hub\'s sandbox config (failure 12)', () => {
  test('passes pass-per-pr-hub.json as PR 12\'s hub and pass-candidate-hub.json as the candidate\'s', () => {
    const r1 = run([...PR12_HUB, `${fixtures}sandbox/pass-per-pr-hub.json`])
    expect(r1.stderr).toBe('')
    expect(r1.status).toBe(0)
    expect(r1.stdout).toContain('may deploy to the sandbox (PR 12 hub)')
    const r2 = run([...CANDIDATE_HUB, `${fixtures}sandbox/pass-candidate-hub.json`])
    expect(r2.stderr).toBe('')
    expect(r2.status).toBe(0)
    expect(r2.stdout).toContain('may deploy to the sandbox (candidate hub)')
  })
  const HUB_CASES = [
    // [case, mode, fixture, change, failure text]
    ['the house hub\'s name', PR12_HUB, 'pass-per-pr-hub.json', c => { c.name = 'inhouse-hub' }, 'name: "inhouse-hub" is not PR 12\'s hub name (inhouse-sbx-pr12-hub)'],
    ['the PR\'s product Worker name', PR12_HUB, 'pass-per-pr-hub.json', c => { c.name = 'inhouse-sbx-pr12' }, 'name: "inhouse-sbx-pr12" is not PR 12\'s hub name'],
    ['another PR\'s hub name', PR12_HUB, 'pass-per-pr-hub.json', c => { c.name = 'inhouse-sbx-pr13-hub' }, 'name: "inhouse-sbx-pr13-hub" is not PR 12\'s hub name'],
    ['a PR\'s hub name as the candidate', CANDIDATE_HUB, 'pass-candidate-hub.json', c => { c.name = 'inhouse-sbx-pr12-hub' }, 'name: "inhouse-sbx-pr12-hub" is a per-PR name'],
    ['a PR-style hub name as the candidate', CANDIDATE_HUB, 'pass-candidate-hub.json', c => { c.name = 'inhouse-sbx-pr012-hub' }, 'name: "inhouse-sbx-pr012-hub" is not the candidate hub\'s name (inhouse-sbx-hub)'],
    ['the candidate product\'s name as the candidate hub', CANDIDATE_HUB, 'pass-candidate-hub.json', c => { c.name = 'inhouse-sbx-product' }, 'name: "inhouse-sbx-product" is not the candidate hub\'s name (inhouse-sbx-hub)'],
    ['vars as a list', CANDIDATE_HUB, 'pass-candidate-hub.json', c => { c.vars = [] }, 'vars must be a plain object in the candidate hub config'],
    ['vars as a string', CANDIDATE_HUB, 'pass-candidate-hub.json', c => { c.vars = 'SHOPIFY_SHOP=' }, 'vars must be a plain object in the candidate hub config'],
    ['vars as null', CANDIDATE_HUB, 'pass-candidate-hub.json', c => { c.vars = null }, 'vars must be a plain object in the candidate hub config'],
    ['keep_vars true', PR12_HUB, 'pass-per-pr-hub.json', c => { c.keep_vars = true }, 'keep_vars is set: a sandbox hub config may not use it'],
    ['preview_urls true', PR12_HUB, 'pass-per-pr-hub.json', c => { c.preview_urls = true }, 'preview_urls must be false'],
    ['an ai binding', CANDIDATE_HUB, 'pass-candidate-hub.json', c => { c.ai = { binding: 'AI' } }, 'ai is set'],
    ['an env block', PR12_HUB, 'pass-per-pr-hub.json', c => { c.env = { production: {} } }, 'env is set'],
    ['the house hub as the candidate', CANDIDATE_HUB, 'pass-candidate-hub.json', c => { c.name = 'inhouse-hub' }, 'name: "inhouse-hub" is not a sandbox name'],
    ['a service binding', PR12_HUB, 'pass-per-pr-hub.json', c => { c.services = [{ binding: 'LIVE', service: 'live-product' }] }, 'services is set: a sandbox hub config binds no other Worker'],
    ['a route', PR12_HUB, 'pass-per-pr-hub.json', c => { c.routes = [{ pattern: `inhouse-sbx-pr12-brand.${ZONE}`, custom_domain: true }] }, 'routes is set: a sandbox hub config may not use it'],
    ['assets', PR12_HUB, 'pass-per-pr-hub.json', c => { c.assets = { directory: '../client' } }, 'assets is set: a sandbox hub config may not use it'],
    ['a D1 binding', PR12_HUB, 'pass-per-pr-hub.json', c => { c.d1_databases = [{ binding: 'DB', database_name: 'inhouse-sbx-pr12-db' }] }, 'd1_databases is set: a sandbox hub config may not use it'],
    ['an R2 binding', CANDIDATE_HUB, 'pass-candidate-hub.json', c => { c.r2_buckets = [{ binding: 'FILES', bucket_name: 'inhouse-sbx-files' }] }, 'r2_buckets is set: a sandbox hub config may not use it'],
    ['a cron trigger', PR12_HUB, 'pass-per-pr-hub.json', c => { c.triggers = { crons: ['* * * * *'] } }, 'triggers is set: a sandbox hub config may not use it'],
    ['required secrets (wrangler would fail the deploy)', CANDIDATE_HUB, 'pass-candidate-hub.json', c => { c.secrets = { required: ['HUB_TOKEN_KEYS'] } }, 'secrets is set: a sandbox config may not use it'],
    ['a define', PR12_HUB, 'pass-per-pr-hub.json', c => { c.define = { __INHOUSE_HUB_TEST__: 'true' } }, 'define is set: a sandbox config may not use it'],
    ['no main', PR12_HUB, 'pass-per-pr-hub.json', c => { delete c.main }, 'main must be set in a sandbox hub config'],
    ['main outside the build', PR12_HUB, 'pass-per-pr-hub.json', c => { c.main = '../hub/index/index.ts' }, 'main must be a relative path inside the build folder'],
    ['a rebundle', PR12_HUB, 'pass-per-pr-hub.json', c => { delete c.no_bundle }, 'no_bundle must be true in a sandbox hub config'],
    ['another Worker\'s Durable Object', PR12_HUB, 'pass-per-pr-hub.json', c => { c.durable_objects.bindings[0].script_name = 'live-product' }, 'durable_objects.bindings[0].script_name is set'],
    ['workers.dev on', CANDIDATE_HUB, 'pass-candidate-hub.json', c => { c.workers_dev = true }, 'workers_dev must be false'],
    ['another account', CANDIDATE_HUB, 'pass-candidate-hub.json', c => { c.account_id = 'fedcba9876543210fedcba9876543210' }, 'account_id is missing or is not the sandbox account'],
    ['no test switch in a PR\'s hub', PR12_HUB, 'pass-per-pr-hub.json', c => { delete c.vars.INHOUSE_TEST_BUILD }, 'vars.INHOUSE_TEST_BUILD must be "1"'],
    ['a store in the candidate', CANDIDATE_HUB, 'pass-candidate-hub.json', c => { c.vars.SHOPIFY_SHOP = 'real-store' }, 'vars.SHOPIFY_SHOP must be empty: no store credential in the sandbox account'],
    ['a client id in the candidate', CANDIDATE_HUB, 'pass-candidate-hub.json', c => { c.vars.SHOPIFY_CLIENT_ID = 'abc' }, 'vars.SHOPIFY_CLIENT_ID must be empty'],
    ['a secret in the candidate\'s vars', CANDIDATE_HUB, 'pass-candidate-hub.json', c => { c.vars.SHOPIFY_CLIENT_SECRET = 'x' }, 'vars.SHOPIFY_CLIENT_SECRET is set: the candidate hub\'s vars are SHOPIFY_SHOP and SHOPIFY_CLIENT_ID only'],
    ['the test switch in the candidate', CANDIDATE_HUB, 'pass-candidate-hub.json', c => { c.vars.INHOUSE_TEST_BUILD = '1' }, 'vars.INHOUSE_TEST_BUILD is set: the candidate hub\'s vars'],
  ]
  for (const [name, mode, fixture, change, text] of HUB_CASES) {
    test(`refuses ${name}`, () => {
      const config = load(fixture)
      change(config)
      const r = run([...mode, write(config)])
      expect(r.status).toBe(1)
      expect(failureLines(r)).toEqual([expect.stringContaining(text)])
    })
  }
  test('refuses a containers entry (the product rules add their own container failures)', () => {
    const config = load('pass-candidate-hub.json')
    config.containers = [{ class_name: 'Runner', image: './Dockerfile' }]
    const r = run([...CANDIDATE_HUB, write(config)])
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('containers is set: a sandbox hub config may not use it')
  })
  test('a hub config fails as the product, and the product as the hub', () => {
    const r1 = run([...PR12, `${fixtures}sandbox/pass-per-pr-hub.json`])
    expect(r1.status).toBe(1)
    expect(r1.stderr).toContain('name: "inhouse-sbx-pr12-hub" is not PR 12\'s worker name')
    const r2 = run([...PR12_HUB, `${fixtures}sandbox/pass-per-pr.json`])
    expect(r2.status).toBe(1)
    expect(r2.stderr).toContain('name: "inhouse-sbx-pr12" is not PR 12\'s hub name')
    expect(r2.stderr).toContain('d1_databases is set: a sandbox hub config may not use it')
    const r3 = run([...CANDIDATE_HUB, `${fixtures}sandbox/pass-candidate.json`])
    expect(r3.status).toBe(1)
    expect(r3.stderr).toContain('routes is set: a sandbox hub config may not use it')
  })
  test('the hub\'s own config files never pass as a sandbox hub, as written or as plain JSON', () => {
    for (const name of ['wrangler.hub.jsonc', 'wrangler.hub.test.jsonc']) {
      const file = fileURLToPath(new URL(`../${name}`, import.meta.url))
      let text
      try { text = readFileSync(file, 'utf8') } catch { continue } // the hub's configs arrive with P4; nothing to read before
      for (const mode of [PR12_HUB, CANDIDATE_HUB, [...EVAL, '--hub']]) {
        expect(run([...mode, file]).status, name).toBe(2)
        const r = run([...mode, write(JSON.parse(stripJsonc(text)))])
        expect(r.status, name).toBe(1)
        expect(r.stderr).toContain('account_id is missing')
      }
    }
  })
  test('usage: --hub only right after the mode, once', () => {
    const file = `${fixtures}sandbox/pass-per-pr-hub.json`
    for (const args of [['--sandbox', '--hub', '--per-pr', '12', file], ['--sandbox', '--per-pr', '12', '--hub', '--hub', file], ['--sandbox', '--per-pr', '12', file, '--hub'], ['--hub', file]]) {
      const r = run(args)
      expect(r.status, args.join(' ')).toBe(2)
      expect(r.stdout).toBe('')
    }
  })
})

describe('(P4) the eval deployment\'s own hub (failures 12 and 13)', () => {
  const EVAL_HUB_NAME = 'inhouse-sbx-eval-hub'
  const EVAL_HUB = [...EVAL, '--hub']
  const evalEntry = { binding: 'HUB', service: EVAL_HUB_NAME, entrypoint: 'ReadGateway' }
  test('the eval product may bind inhouse-sbx-eval-hub\'s ReadGateway, or no hub (a build before P4)', () => {
    const config = load('pass-eval.json')
    expect(config.services ?? []).toEqual([])
    config.services = [evalEntry]
    const r = run([...EVAL, write(config)])
    expect(r.stderr).toBe('')
    expect(r.status).toBe(0)
  })
  const SHAPE = 'services is set: the eval deployment may bind exactly { HUB -> ReadGateway } to its own hub'
  const p5 = [evalEntry, { binding: 'HUB_CONNECT', service: EVAL_HUB_NAME, entrypoint: 'ConnectGateway' }, { binding: 'HUB_DELIVERY', service: EVAL_HUB_NAME, entrypoint: 'DeliveryGateway' }]
  const EVAL_PRODUCT_CASES = [
    // #266's P5 set passes for a PR and the candidate; the eval deployment takes the read binding alone.
    ['P5\'s three bindings', p5, SHAPE],
    ['P5\'s connect binding alone', [p5[1]], SHAPE],
    ['the read and the delivery bindings', [evalEntry, p5[2]], SHAPE],
    ['the candidate\'s hub', { ...evalEntry, service: 'inhouse-sbx-hub' }, 'services[0].service: "inhouse-sbx-hub" is not the eval deployment\'s hub name (inhouse-sbx-eval-hub)'],
    ['a PR\'s hub', { ...evalEntry, service: 'inhouse-sbx-pr12-hub' }, 'services[0].service: "inhouse-sbx-pr12-hub" is not the eval deployment\'s hub name'],
    ['the house hub', { ...evalEntry, service: 'inhouse-hub' }, 'services[0].service: "inhouse-hub" is not the eval deployment\'s hub name'],
    ['its own product Worker', { ...evalEntry, service: 'inhouse-sbx-eval' }, 'services[0].service: "inhouse-sbx-eval" is not the eval deployment\'s hub name'],
    ['another eval name', { ...evalEntry, service: 'inhouse-sbx-eval-db' }, 'services[0].service: "inhouse-sbx-eval-db" is not the eval deployment\'s hub name'],
    ['the server entrypoint', { ...evalEntry, entrypoint: 'ServerGateway' }, SHAPE],
    ['the default export', { binding: 'HUB', service: EVAL_HUB_NAME }, SHAPE],
    ['another binding name', { ...evalEntry, binding: 'LIVE' }, SHAPE],
    ['an environment', { ...evalEntry, environment: 'production' }, SHAPE],
    ['a second entry', [evalEntry, { ...evalEntry, binding: 'HUB2' }], SHAPE],
    ['the hub binding twice', [evalEntry, evalEntry], SHAPE],
    ['a live product', { binding: 'LIVE', service: 'live-product' }, SHAPE],
  ]
  for (const [name, entry, text] of EVAL_PRODUCT_CASES) {
    test(`the eval product refuses ${name}`, () => {
      const config = load('pass-eval.json')
      config.services = Array.isArray(entry) ? entry : [entry]
      const r = run([...EVAL, write(config)])
      expect(r.status).toBe(1)
      expect(failureLines(r)).toEqual([expect.stringContaining(text)])
    })
  }
  test('passes pass-eval-hub.json as the eval hub', () => {
    const r = run([...EVAL_HUB, `${fixtures}sandbox/pass-eval-hub.json`])
    expect(r.stderr).toBe('')
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('may deploy to the sandbox (eval hub)')
  })
  const EVAL_HUB_CASES = [
    ['the candidate hub\'s name', c => { c.name = 'inhouse-sbx-hub' }, 'name: "inhouse-sbx-hub" is not the eval deployment\'s hub name (inhouse-sbx-eval-hub)'],
    ['a PR\'s hub name', c => { c.name = 'inhouse-sbx-pr12-hub' }, 'name: "inhouse-sbx-pr12-hub" is not the eval deployment\'s hub name'],
    ['the house hub\'s name', c => { c.name = 'inhouse-hub' }, 'name: "inhouse-hub" is not the eval deployment\'s hub name'],
    ['the eval product\'s name', c => { c.name = 'inhouse-sbx-eval' }, 'name: "inhouse-sbx-eval" is not the eval deployment\'s hub name'],
    ['a store', c => { c.vars.SHOPIFY_SHOP = 'real-store' }, 'vars.SHOPIFY_SHOP must be empty: no store credential in the sandbox account'],
    ['a client id', c => { c.vars.SHOPIFY_CLIENT_ID = 'abc' }, 'vars.SHOPIFY_CLIENT_ID must be empty'],
    ['a secret in its vars', c => { c.vars.SHOPIFY_CLIENT_SECRET = 'x' }, 'vars.SHOPIFY_CLIENT_SECRET is set: the eval hub\'s vars are SHOPIFY_SHOP and SHOPIFY_CLIENT_ID only'],
    ['the test switch', c => { c.vars.INHOUSE_TEST_BUILD = '1' }, 'vars.INHOUSE_TEST_BUILD is set: the eval hub\'s vars'],
    ['the eval brand marker', c => { c.vars.INHOUSE_EVAL_BRAND = '1' }, 'vars.INHOUSE_EVAL_BRAND is set: the eval hub\'s vars'],
    ['the gateway id', c => { c.vars.AI_GATEWAY_ID = 'inhouse-eval' }, 'vars.AI_GATEWAY_ID is set: the eval hub\'s vars'],
    ['vars as a list', c => { c.vars = [] }, 'vars must be a plain object in the eval hub config'],
    ['an AI binding (the hub runs no model)', c => { c.ai = { binding: 'AI' } }, 'ai is set'],
    ['required secrets (wrangler would fail the deploy)', c => { c.secrets = { required: ['HUB_TOKEN_KEYS'] } }, 'secrets is set: a sandbox config may not use it'],
    ['a define', c => { c.define = { __INHOUSE_HUB_TEST__: 'true' } }, 'define is set: a sandbox config may not use it'],
    ['a service binding', c => { c.services = [evalEntry] }, 'services is set: a sandbox hub config binds no other Worker'],
    ['a route', c => { c.routes = [{ pattern: `inhouse-sbx-eval-brand.${ZONE}`, custom_domain: true }] }, 'routes is set: a sandbox hub config may not use it'],
    ['the eval D1', c => { c.d1_databases = [{ binding: 'DB', database_name: 'inhouse-sbx-eval-db' }] }, 'd1_databases is set: a sandbox hub config may not use it'],
    ['version metadata', c => { c.version_metadata = { binding: 'CF_VERSION_METADATA' } }, 'version_metadata is set: a sandbox hub config may not use it'],
    ['a rebundle', c => { delete c.no_bundle }, 'no_bundle must be true in a sandbox hub config'],
    ['workers.dev on', c => { c.workers_dev = true }, 'workers_dev must be false'],
    ['another account', c => { c.account_id = 'fedcba9876543210fedcba9876543210' }, 'account_id is missing or is not the sandbox account'],
  ]
  for (const [name, change, text] of EVAL_HUB_CASES) {
    test(`the eval hub refuses ${name}`, () => {
      const config = load('pass-eval-hub.json')
      change(config)
      const r = run([...EVAL_HUB, write(config)])
      expect(r.status).toBe(1)
      expect(failureLines(r)).toEqual([expect.stringContaining(text)])
    })
  }
  test('the eval hub passes as no other hub, no other hub as the eval\'s, and the eval product fails as its hub', () => {
    const asCandidate = run([...CANDIDATE_HUB, `${fixtures}sandbox/pass-eval-hub.json`])
    expect(asCandidate.status).toBe(1)
    expect(asCandidate.stderr).toContain('name: "inhouse-sbx-eval-hub" is the eval deployment\'s name, not the candidate\'s')
    const asPr = run([...PR12_HUB, `${fixtures}sandbox/pass-eval-hub.json`])
    expect(asPr.status).toBe(1)
    expect(asPr.stderr).toContain('name: "inhouse-sbx-eval-hub" is not PR 12\'s hub name')
    for (const other of ['pass-candidate-hub.json', 'pass-per-pr-hub.json']) {
      const r = run([...EVAL_HUB, `${fixtures}sandbox/${other}`])
      expect(r.status, other).toBe(1)
      expect(r.stderr, other).toContain('is not the eval deployment\'s hub name (inhouse-sbx-eval-hub)')
    }
    const productAsHub = run([...EVAL_HUB, `${fixtures}sandbox/pass-eval.json`])
    expect(productAsHub.status).toBe(1)
    expect(productAsHub.stderr).toContain('name: "inhouse-sbx-eval" is not the eval deployment\'s hub name')
    expect(productAsHub.stderr).toContain('d1_databases is set: a sandbox hub config may not use it')
    const hubAsProduct = run([...EVAL, `${fixtures}sandbox/pass-eval-hub.json`])
    expect(hubAsProduct.status).toBe(1)
    expect(hubAsProduct.stderr).toContain('name: "inhouse-sbx-eval-hub" is not the eval deployment\'s worker name')
  })
  test('the candidate and a PR bind no eval hub', () => {
    const candidate = load('pass-candidate.json')
    candidate.services = [evalEntry]
    const c = run([...CANDIDATE, write(candidate)])
    expect(c.status).toBe(1)
    expect(c.stderr).toContain('services[0].service: "inhouse-sbx-eval-hub" is the eval deployment\'s name, not the candidate\'s')
    const pr = load('pass-per-pr.json')
    pr.services = [evalEntry]
    const p = run([...PR12, write(pr)])
    expect(p.status).toBe(1)
    expect(p.stderr).toContain('services[0].service: "inhouse-sbx-eval-hub" is not PR 12\'s hub name')
  })
  test('usage: --hub only right after --eval, once', () => {
    const file = `${fixtures}sandbox/pass-eval-hub.json`
    for (const args of [['--sandbox', '--hub', '--eval', file], ['--sandbox', '--eval', '--hub', '--hub', file], ['--sandbox', '--eval', file, '--hub']]) {
      const r = run(args)
      expect(r.status, args.join(' ')).toBe(2)
      expect(r.stdout).toBe('')
    }
  })
})

describe('(P5) the product\'s three hub bindings: exact sets, not any subset (failure 13)', () => {
  const three = hub => [
    { binding: 'HUB', service: hub, entrypoint: 'ReadGateway' },
    { binding: 'HUB_CONNECT', service: hub, entrypoint: 'ConnectGateway' },
    { binding: 'HUB_DELIVERY', service: hub, entrypoint: 'DeliveryGateway' },
  ]
  const SHAPE = 'services is set: a sandbox config may not use it, but for exactly { HUB -> ReadGateway } or { HUB -> ReadGateway, HUB_CONNECT -> ConnectGateway, HUB_DELIVERY -> DeliveryGateway }'
  test('PR 12 and the candidate may bind all three to their own hub, in any order; none and HUB alone still pass', () => {
    for (const services of [three('inhouse-sbx-pr12-hub'), three('inhouse-sbx-pr12-hub').reverse(), [three('inhouse-sbx-pr12-hub')[0]], []]) {
      const config = load('pass-per-pr.json')
      config.services = services
      const r = run([...PR12, write(config)])
      expect(r.stderr, JSON.stringify(services)).toBe('')
      expect(r.status).toBe(0)
    }
    const candidate = load('pass-candidate.json')
    candidate.services = three('inhouse-sbx-hub')
    const r = run([...CANDIDATE, write(candidate)])
    expect(r.stderr).toBe('')
    expect(r.status).toBe(0)
  })
  const H = 'inhouse-sbx-pr12-hub'
  const CASES = [
    // Missing: a subset that isn't an allowed set.
    ['HUB_CONNECT and HUB_DELIVERY without HUB', three(H).slice(1), SHAPE],
    ['HUB and HUB_CONNECT without HUB_DELIVERY', three(H).slice(0, 2), SHAPE],
    ['HUB_CONNECT alone', [three(H)[1]], SHAPE],
    ['HUB_DELIVERY alone', [three(H)[2]], SHAPE],
    // Extra.
    ['a fourth entry to a live Worker', [...three(H), { binding: 'LIVE', service: 'live-product', entrypoint: 'ReadGateway' }], SHAPE],
    ['a binding twice in place of another', [three(H)[0], three(H)[1], three(H)[1]], SHAPE],
    ['the three and HUB again', [...three(H), three(H)[0]], SHAPE],
    // Wrong entrypoint.
    ['HUB_CONNECT on ReadGateway', [three(H)[0], { ...three(H)[1], entrypoint: 'ReadGateway' }, three(H)[2]], SHAPE],
    ['HUB_DELIVERY on ConnectGateway', [three(H)[0], three(H)[1], { ...three(H)[2], entrypoint: 'ConnectGateway' }], SHAPE],
    ['HUB on the server surface', [{ ...three(H)[0], entrypoint: 'ServerGateway' }, three(H)[1], three(H)[2]], SHAPE],
    ['HUB_CONNECT with no entrypoint (the default export)', [three(H)[0], { binding: 'HUB_CONNECT', service: H }, three(H)[2]], SHAPE],
    ['an extra key on one entry', [three(H)[0], three(H)[1], { ...three(H)[2], environment: 'production' }], SHAPE],
    // Wrong hub.
    ['HUB_CONNECT to the house hub', [three(H)[0], { ...three(H)[1], service: 'inhouse-hub' }, three(H)[2]], 'services[1].service: "inhouse-hub" is not PR 12\'s hub name (inhouse-sbx-pr12-hub)'],
    ['HUB_DELIVERY to another PR\'s hub', [three(H)[0], three(H)[1], { ...three(H)[2], service: 'inhouse-sbx-pr13-hub' }], 'services[2].service: "inhouse-sbx-pr13-hub" is not PR 12\'s hub name'],
    ['HUB_CONNECT to the candidate\'s hub', [three(H)[0], { ...three(H)[1], service: 'inhouse-sbx-hub' }, three(H)[2]], 'services[1].service: "inhouse-sbx-hub" is not PR 12\'s hub name'],
  ]
  for (const [name, services, text] of CASES) {
    test(`refuses ${name}`, () => {
      const config = load('pass-per-pr.json')
      config.services = services
      const r = run([...PR12, write(config)])
      expect(r.status).toBe(1)
      expect(failureLines(r)).toEqual([expect.stringContaining(text)])
    })
  }
  test('the candidate: every entry names exactly its hub, never a PR\'s, the house\'s or its own product', () => {
    for (const [i, service, text] of [[1, 'inhouse-sbx-pr12-hub', 'is a per-PR name'], [2, 'inhouse-hub', 'is not a sandbox name'], [1, 'inhouse-sbx-other-hub', 'is not the candidate hub\'s name'], [2, 'inhouse-sbx-product', 'is not the candidate hub\'s name']]) {
      const config = load('pass-candidate.json')
      config.services = three('inhouse-sbx-hub')
      config.services[i] = { ...config.services[i], service }
      const r = run([...CANDIDATE, write(config)])
      expect(r.status, service).toBe(1)
      expect(failureLines(r)).toEqual([expect.stringContaining(`services[${i}].service: `)])
      expect(r.stderr).toContain(text)
    }
  })
  // (eval hub) the eval deployment binds its own hub's read surface only, never P5's three.
  test('the eval deployment binds none of P5\'s set', () => {
    const config = load('pass-eval.json')
    config.services = three('inhouse-sbx-eval-hub')
    const r = run([...EVAL, write(config)])
    expect(r.status).toBe(1)
    expect(failureLines(r)).toEqual([expect.stringContaining('services is set: the eval deployment may bind exactly { HUB -> ReadGateway } to its own hub')])
  })
})
