// check-product-config.mjs --sandbox, the sandbox prefix lock. Ways it could fail, written down first:
//  1. a per-PR config binds something outside its own PR: a live product's D1, R2, container, script or service, the
//     shared candidate's data, another PR's resources, or a D1 by an id that points anywhere;
//  2. it attaches a host outside `<sandbox name>.<SBX_ZONE>` (a suffix attack, another zone, the bare zone, a wildcard);
//  3. it deploys to another account, turns on the AI binding (spend), runs more than 2 containers, builds an image or
//     runs a build command in the job that holds the token, or opens workers.dev or preview URLs;
//  4. a per-PR config ships without the test flag, or the candidate ships with it (or skips a product rule);
//  5. a sandbox config passes as a product one, or a product config as a sandbox one;
//  6. a binding kind the lock doesn't know about passes;
//  7. it runs with the sandbox's account or zone unset or malformed instead of stopping (exit 2).
// Oracles: the literal pass fixtures in check-product-config-fixtures/sandbox/ and one literal change per rule below,
// each with the failure text it must print. Every case runs the script as CI and the ops repo do.
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
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
const run = (args, env = ENV) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', env: { PATH: process.env.PATH, ...env } })
const load = name => JSON.parse(stripJsonc(readFileSync(`${fixtures}sandbox/${name}`, 'utf8')))
const tmp = mkdtempSync(join(tmpdir(), 'sandbox-config-'))
let n = 0
const write = config => {
  const file = join(tmp, `c${++n}.json`)
  writeFileSync(file, JSON.stringify(config))
  return file
}
const failureLines = r => r.stderr.split('\n').filter(l => l.startsWith('  - '))
const access = (brand, team) => JSON.stringify({
  teamDomain: 'https://test-issuer.invalid',
  apps: [{ name: 'brand', origin: brand, aud: 'b'.repeat(64) }, { name: 'inhouse', origin: team, aud: 'c'.repeat(64) }],
  serviceTokens: {},
})

/** [case, change to PR 12's passing config, the failure text]. Each change breaks exactly one rule. */
const PER_PR_CASES = [
  // 1: names and bindings.
  ['d1 of another PR', c => { c.d1_databases[0].database_name = 'inhouse-sbx-pr13-db' }, 'd1_databases[0].database_name: "inhouse-sbx-pr13-db" belongs to PR 13, not PR 12'],
  ['d1 of the candidate', c => { c.d1_databases[0].database_name = 'inhouse-sbx-db' }, 'd1_databases[0].database_name: "inhouse-sbx-db" is not a per-PR sandbox name'],
  ['d1 of a live product', c => { c.d1_databases[0].database_name = 'live-product-db' }, '"live-product-db" is not a per-PR sandbox name'],
  ['d1 without a name', c => { delete c.d1_databases[0].database_name }, 'd1_databases[0].database_name: undefined is not a per-PR'],
  ['d1 bound by id', c => { c.d1_databases[0].database_id = '00000000-0000-4000-8000-000000000001' }, 'd1_databases[0].database_id is set'],
  ['d1 preview id', c => { c.d1_databases[0].preview_database_id = '00000000-0000-4000-8000-000000000002' }, 'd1_databases[0].preview_database_id is set'],
  ['r2 of the candidate', c => { c.r2_buckets[0].bucket_name = 'inhouse-sbx-files' }, 'r2_buckets[0].bucket_name: "inhouse-sbx-files" is not a per-PR'],
  ['r2 of a live product', c => { c.r2_buckets[0].bucket_name = 'live-product-files' }, 'r2_buckets[0].bucket_name: "live-product-files"'],
  ['r2 preview bucket', c => { c.r2_buckets[0].preview_bucket_name = 'inhouse-sbx-pr12-preview' }, 'r2_buckets[0].preview_bucket_name is set'],
  ['container of a live product', c => { c.containers[0].name = 'inhouse-app' }, 'containers[0].name: "inhouse-app" is not a per-PR'],
  ['container without a name', c => { delete c.containers[0].name }, 'containers[0] has no name'],
  ['container image of a live product', c => { c.containers[0].image = `registry.cloudflare.com/${ACCOUNT}/live-product:v1` }, 'containers[0].image: "live-product" is not a per-PR'],
  ['durable object of another Worker', c => { c.durable_objects.bindings[0].script_name = 'live-product' }, 'durable_objects.bindings[0].script_name names another Worker'],
  ['service binding', c => { c.services = [{ binding: 'LIVE', service: 'live-product' }] }, 'services is set: a sandbox config may not use it'],
  ['kv binding', c => { c.kv_namespaces = [{ binding: 'KV', id: '0123' }] }, 'kv_namespaces is set'],
  ['queue producer', c => { c.queues = { producers: [{ binding: 'Q', queue: 'live-queue' }], consumers: [] } }, 'queues is set'],
  ['tail consumer', c => { c.tail_consumers = [{ service: 'live-product' }] }, 'tail_consumers is set'],
  ['dispatch namespace', c => { c.dispatch_namespaces = [{ binding: 'D', namespace: 'live' }] }, 'dispatch_namespaces is set'],
  // 6: a key the lock doesn't know, even a scalar.
  ['an unknown key', c => { c.first_party_worker = true }, 'first_party_worker is set'],
  // 2: hosts.
  ['route on another zone', c => { c.routes[0].pattern = 'inhouse-sbx-pr12-brand.evil.test' }, 'routes[0].pattern: host "inhouse-sbx-pr12-brand.evil.test" is not on the sandbox zone'],
  ['route suffix attack', c => { c.routes[0].pattern = `inhouse-sbx-pr12-brand.${ZONE}.evil.test` }, 'is not on the sandbox zone'],
  ['route on the bare zone', c => { c.routes[0].pattern = ZONE }, `routes[0].pattern: host "${ZONE}" is not on the sandbox zone`],
  ['route one level deeper', c => { c.routes[0].pattern = `www.inhouse-sbx-pr12-brand.${ZONE}` }, 'routes[0].pattern: host "www.inhouse-sbx-pr12-brand'],
  ['route in upper case', c => { c.routes[0].pattern = `INHOUSE-SBX-PR12-BRAND.${ZONE}` }, 'routes[0].pattern: host "INHOUSE'],
  ['route of another PR', c => { c.routes[1].pattern = `inhouse-sbx-pr13-team.${ZONE}` }, 'routes[1].pattern: host "inhouse-sbx-pr13-team.zone.example.test": "inhouse-sbx-pr13-team" belongs to PR 13'],
  ['route with a wildcard', c => { c.routes[0] = { pattern: `*.${ZONE}/*`, zone_name: ZONE } }, 'routes[0].pattern: host "*.zone.example.test"'],
  ['route by zone id', c => { c.routes[0] = { pattern: `inhouse-sbx-pr12-brand.${ZONE}/*`, zone_id: 'abc' } }, 'routes[0].zone_id is set'],
  ['route on another zone name', c => { c.routes[0] = { pattern: `inhouse-sbx-pr12-brand.${ZONE}/*`, zone_name: 'evil.test' } }, 'routes[0].zone_name is not the sandbox zone'],
  ['the single route key', c => { c.route = 'shop.example.test/*' }, 'route.pattern: host "shop.example.test"'],
  ['a route with a scheme', c => { c.routes[0] = `https://inhouse-sbx-pr12-brand.${ZONE}/*` }, 'routes[0].pattern: host "https:"'],
  ['access origin off the zone', c => { c.vars.INHOUSE_ACCESS = access('https://brand.example.test', `https://inhouse-sbx-pr12-team.${ZONE}`) }, 'INHOUSE_ACCESS.apps[0].origin: host "brand.example.test" is not on the sandbox zone'],
  ['access origin over http', c => { c.vars.INHOUSE_ACCESS = access(`http://inhouse-sbx-pr12-brand.${ZONE}`, `https://inhouse-sbx-pr12-team.${ZONE}`) }, 'INHOUSE_ACCESS.apps[0].origin must be a bare https:// origin'],
  // 3: account, spend, size, builds, public URLs.
  ['no account id', c => { delete c.account_id }, 'account_id is missing or is not the sandbox account'],
  ['another account', c => { c.account_id = 'fedcba9876543210fedcba9876543210' }, 'account_id is missing or is not the sandbox account'],
  ['an AI binding', c => { c.ai = { binding: 'AI' } }, 'ai is set: the sandbox runs the scripted model only'],
  ['3 containers at most', c => { c.containers[0].max_instances = 3 }, 'containers[0].max_instances must be 1 or 2'],
  ['no container limit', c => { delete c.containers[0].max_instances }, 'containers[0].max_instances must be 1 or 2 (left out'],
  ['a container limit of 0', c => { c.containers[0].max_instances = 0 }, 'containers[0].max_instances must be 1 or 2'],
  ['a fractional container limit', c => { c.containers[0].max_instances = 1.5 }, 'containers[0].max_instances must be 1 or 2'],
  ['a container built from a Dockerfile', c => { c.containers[0].image = './runner/Dockerfile' }, 'containers[0].image must be registry.cloudflare.com/<CF_SANDBOX_ACCOUNT_ID>/'],
  ['a container image in another account', c => { c.containers[0].image = 'registry.cloudflare.com/fedcba9876543210fedcba9876543210/inhouse-sbx-pr12:v1' }, 'containers[0].image must be registry.cloudflare.com/'],
  ['a container image on Docker Hub', c => { c.containers[0].image = 'docker.io/library/inhouse-sbx-pr12:v1' }, 'containers[0].image must be registry.cloudflare.com/'],
  ['a container image without a tag', c => { c.containers[0].image = `registry.cloudflare.com/${ACCOUNT}/inhouse-sbx-pr12` }, 'containers[0].image must be registry.cloudflare.com/'],
  ['a container image with a path', c => { c.containers[0].image = `registry.cloudflare.com/${ACCOUNT}/x/inhouse-sbx-pr12:v1` }, 'containers[0].image: "x/inhouse-sbx-pr12" is not a per-PR'],
  ['a container build context', c => { c.containers[0].image_build_context = '.' }, 'containers[0].image_build_context is set'],
  ['a build command', c => { c.build = { command: 'npm run build' } }, 'build.command is set'],
  ['workers.dev on', c => { c.workers_dev = true }, 'workers_dev must be false'],
  ['workers.dev left out', c => { delete c.workers_dev }, 'workers_dev must be false'],
  ['preview URLs on', c => { c.preview_urls = true }, 'preview_urls must be false'],
  ['an env block', c => { c.env = { other: { name: 'live-product' } } }, 'env is set'],
  // 4: the test flag.
  ['no test flag', c => { delete c.vars.INHOUSE_TEST_BUILD }, 'vars.INHOUSE_TEST_BUILD must be "1" in a per-PR test deployment'],
  ['test flag off', c => { c.vars.INHOUSE_TEST_BUILD = '0' }, 'vars.INHOUSE_TEST_BUILD must be "1"'],
  ['no INHOUSE_ACCESS', c => { delete c.vars.INHOUSE_ACCESS }, 'vars.INHOUSE_ACCESS must list the per-PR hosts'],
]

describe('check-product-config --sandbox: per-PR configs', () => {
  for (const pass of ['pass-per-pr.jsonc', 'pass-per-pr-generated.jsonc']) {
    test(`passes ${pass} with exit 0`, () => {
      const r = run(['--sandbox', `${fixtures}sandbox/${pass}`])
      expect(r.stderr).toBe('')
      expect(r.status).toBe(0)
      expect(r.stdout).toContain('may deploy to the sandbox')
    })
  }
  for (const [name, change, text] of PER_PR_CASES) {
    test(`refuses ${name} with exit 1 and names it`, () => {
      const config = load('pass-per-pr.jsonc')
      change(config)
      const r = run(['--sandbox', write(config)])
      expect(r.status).toBe(1)
      expect(failureLines(r)).toEqual([expect.stringContaining(text)])
    })
  }
  test('a per-PR config is judged by its Worker name: a live name makes it a candidate that fails both rule sets', () => {
    const config = load('pass-per-pr.jsonc')
    config.name = 'live-product'
    const r = run(['--sandbox', write(config)])
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('name: "live-product" is not a sandbox name')
    // As a candidate, every per-PR name is still a sandbox name; the product rules refuse the test flag.
    expect(r.stderr).toContain('vars.INHOUSE_TEST_BUILD is set')
  })
})

describe('check-product-config --sandbox: the candidate', () => {
  test('passes pass-candidate.jsonc with exit 0', () => {
    const r = run(['--sandbox', `${fixtures}sandbox/pass-candidate.jsonc`])
    expect(r.stderr).toBe('')
    expect(r.status).toBe(0)
  })
  const CANDIDATE_CASES = [
    ['the test flag', c => { c.vars.INHOUSE_TEST_BUILD = '1' }, 'vars.INHOUSE_TEST_BUILD is set: the test issuer must never be on'],
    ['a live D1', c => { c.d1_databases[0].database_name = 'live-product-db' }, 'd1_databases[0].database_name: "live-product-db" is not a sandbox name'],
    ['a live host', c => { c.routes[0].pattern = `inhouse-app.${ZONE}` }, 'routes[0].pattern: host "inhouse-app.zone.example.test": "inhouse-app" is not a sandbox name'],
    ['another account', c => { c.account_id = 'fedcba9876543210fedcba9876543210' }, 'account_id is missing or is not the sandbox account'],
    ['a product rule (version metadata)', c => { delete c.version_metadata }, 'version_metadata needs a binding name'],
    ['a D1 id', c => { c.d1_databases[0].database_id = '11111111-0000-4000-8000-000000000000' }, 'd1_databases[0].database_id is set'],
  ]
  for (const [name, change, text] of CANDIDATE_CASES) {
    test(`refuses ${name}`, () => {
      const config = load('pass-candidate.jsonc')
      change(config)
      const r = run(['--sandbox', write(config)])
      expect(r.status).toBe(1)
      expect(failureLines(r)).toEqual([expect.stringContaining(text)])
    })
  }
})

describe('neither mode passes the other\'s config (failure 5)', () => {
  for (const pass of ['pass-per-pr.jsonc', 'pass-per-pr-generated.jsonc', 'pass-candidate.jsonc']) {
    test(`product mode refuses sandbox/${pass} on its sandbox names`, () => {
      const r = run([`${fixtures}sandbox/${pass}`])
      expect(r.status).toBe(1)
      expect(r.stderr).toContain('is a sandbox name or host')
    })
  }
  test('sandbox mode refuses the product pass fixture and the test build config', () => {
    for (const file of [`${fixtures}pass.jsonc`, fileURLToPath(new URL('../wrangler.test.jsonc', import.meta.url)), fileURLToPath(new URL('../wrangler.product.jsonc', import.meta.url))]) {
      const r = run(['--sandbox', file])
      expect(r.status, file).toBe(1)
      expect(r.stderr).toContain('is not a sandbox name')
      expect(r.stderr).toContain('account_id is missing')
    }
  })
})

describe('usage (failure 7)', () => {
  const file = `${fixtures}sandbox/pass-per-pr.jsonc`
  test('exits 2 without, or with a malformed, account id or zone', () => {
    for (const env of [{}, { SBX_ZONE: ZONE }, { CF_SANDBOX_ACCOUNT_ID: ACCOUNT }, { ...ENV, CF_SANDBOX_ACCOUNT_ID: ACCOUNT.toUpperCase() },
      { ...ENV, CF_SANDBOX_ACCOUNT_ID: `${ACCOUNT}0` }, { ...ENV, SBX_ZONE: 'Zone.example.test' }, { ...ENV, SBX_ZONE: 'example' }, { ...ENV, SBX_ZONE: `${ZONE}.` }]) {
      const r = run(['--sandbox', file], env)
      expect(r.status, JSON.stringify(env)).toBe(2)
      expect(r.stdout).toBe('')
    }
  })
  test('exits 2 on a missing path, two paths, an unknown flag or a config that is not an object', () => {
    expect(run(['--sandbox']).status).toBe(2)
    expect(run(['--sandbox', file, file]).status).toBe(2)
    expect(run(['--sandbox', '--other']).status).toBe(2)
    expect(run([file, '--sandbox']).status).toBe(2)
    expect(run(['--sandbox', write([])]).status).toBe(2)
  })
})
