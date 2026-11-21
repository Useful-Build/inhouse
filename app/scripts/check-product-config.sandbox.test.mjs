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
  ['version metadata without a binding', c => { c.version_metadata = {} }, 'version_metadata needs a binding name in the eval deployment'],
  // The sandbox's own rules hold in eval mode too.
  ['another account', c => { c.account_id = 'fedcba9876543210fedcba9876543210' }, 'account_id is missing or is not the sandbox account'],
  ['3 containers', c => { c.containers[0].max_instances = 3 }, 'containers[0].max_instances must be 1 or 2'],
  ['a service binding', c => { c.services = [{ binding: 'LIVE', service: 'live-product' }] }, 'services is set: a sandbox config may not use it'],
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
