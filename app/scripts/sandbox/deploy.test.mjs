// scripts/sandbox/deploy.mjs (moved from the ops repo's deploy.mjs, per-PR mode). Ways it could fail, written down first:
//  1. it calls Cloudflare or wrangler for a config the lock refuses, or one that is another PR's;
//  2. it tears down anything but PR N's own names (another PR's, the candidate's, a live product's);
//  3. it deploys before migrating and seeding, seeds the wrong database, or passes wrangler anything that changes the
//     checked config (--name, --route, --var, --env);
//  4. it deploys onto an old database (no teardown first).
// Oracles: config.mjs's own output for a literal artifact (config.test.mjs pins it), a literal listing, and fakes that
// record every call in order.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'vitest'
import { main as writeConfig } from './deploy-config.mjs'
import { checkHub, deploy, mainParts } from './deploy.mjs'
import { ACCOUNT, APP_DIR, ZONE, app } from './test-support.mjs'

const ENV = { CF_SANDBOX_ACCOUNT_ID: ACCOUNT, SBX_ZONE: ZONE }

/** PR 12's deploy folder, written by config.mjs from a minimal literal artifact. */
async function deployDir(pr = 12) {
  const root = mkdtempSync(join(tmpdir(), 'deploy-test-'))
  const art = join(root, 'artifact')
  const files = {
    'dist/inhouse_product/wrangler.json': JSON.stringify({
      name: 'inhouse-product', main: 'index.js', compatibility_date: '2026-11-13',
      assets: { binding: 'ASSETS', directory: '../client' },
      d1_databases: [{ binding: 'DB', database_name: 'inhouse-test', database_id: '00000000-0000-4000-8000-000000000001', migrations_dir: '../../server/migrations' }],
      r2_buckets: [{ binding: 'FILES', bucket_name: 'inhouse-test-files' }],
      vars: { INHOUSE_TEST_BUILD: '1', AUDIT_HASH_KEY: 'test-only', INHOUSE_ACCESS: JSON.stringify({ teamDomain: 'https://test-issuer.invalid', apps: [{ name: 'brand', origin: 'http://brand.localhost:8787', aud: 'b'.repeat(64) }, { name: 'inhouse', origin: 'http://inhouse.localhost:8787', aud: 'c'.repeat(64) }], serviceTokens: {} }) },
      workers_dev: false, preview_urls: false,
    }),
    'dist/inhouse_product/index.js': 'export default {}',
    'dist/client/index.html': '<!doctype html>',
    'migrations/0001_members.sql': 'CREATE TABLE t (id TEXT);',
  }
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(join(art, p, '..'), { recursive: true })
    writeFileSync(join(art, p), text)
  }
  const jwks = join(root, 'jwks.json')
  writeFileSync(jwks, JSON.stringify({ keys: [{ kty: 'RSA', n: 'abc', e: 'AQAB', kid: 'k1', alg: 'RS256' }] }))
  await writeConfig(['--app', APP_DIR, '--pr', String(pr), '--artifact', art, '--out', join(root, 'deploy'), '--jwks', jwks], ENV)
  return join(root, 'deploy')
}

const LISTING = {
  workers: ['live-product', 'inhouse-sbx-product', 'inhouse-sbx-pr12', 'inhouse-sbx-pr13'],
  domains: [
    { id: 'dom-12b', hostname: `inhouse-sbx-pr12-brand.${ZONE}`, service: 'inhouse-sbx-pr12' },
    { id: 'dom-13b', hostname: `inhouse-sbx-pr13-brand.${ZONE}`, service: 'inhouse-sbx-pr13' },
  ],
  d1: [{ name: 'inhouse-sbx-db', uuid: 'u-cand' }, { name: 'inhouse-sbx-pr12-db', uuid: 'u-12' }, { name: 'inhouse-sbx-pr13-db', uuid: 'u-13' }],
  r2: ['inhouse-sbx-files', 'inhouse-sbx-pr12-files', 'inhouse-sbx-pr13-files'],
  containers: [{ id: 'c-cand', name: 'inhouse-sbx-product' }, { id: 'c-12', name: 'inhouse-sbx-pr12' }, { id: 'c-13', name: 'inhouse-sbx-pr13' }],
}

/** Fakes for the outside world, recording every call in one ordered list. */
function world(listing = LISTING) {
  const calls = []
  const rec = name => async (...a) => { calls.push([name, ...a]) }
  const cf = {
    workers: async () => listing.workers, domains: async () => listing.domains, d1: async () => listing.d1, r2: async () => listing.r2,
    containerApps: async () => listing.containers, deleteContainerApp: rec('deleteContainerApp'),
    r2Keys: async b => { calls.push(['r2Keys', b]); return [] },
    detachDomain: rec('detachDomain'), deleteWorker: rec('deleteWorker'), deleteD1: rec('deleteD1'), deleteR2Object: rec('deleteR2Object'),
    deleteR2: rec('deleteR2'), createD1: rec('createD1'), createR2: rec('createR2'),
  }
  return { calls, cf, wrangler: a => calls.push(['wrangler', ...a]), seed: a => calls.push(['seed', ...a]), log: () => {} }
}

describe('deploy.mjs (failures 2 to 4)', () => {
  test('tears PR 12 down by exact name, then creates, migrates, seeds and deploys, in that order', async () => {
    const dir = await deployDir()
    const w = world()
    await deploy({ app, pr: 12, dir, accountId: ACCOUNT, zone: ZONE, ...w })
    const worker = join(dir, 'inhouse_product/wrangler.json')
    assert.deepEqual(w.calls, [
      ['detachDomain', 'dom-12b'], ['deleteWorker', 'inhouse-sbx-pr12'], ['deleteContainerApp', 'c-12'], ['deleteD1', 'u-12'], ['r2Keys', 'inhouse-sbx-pr12-files'], ['deleteR2', 'inhouse-sbx-pr12-files'],
      ['createD1', 'inhouse-sbx-pr12-db'], ['createR2', 'inhouse-sbx-pr12-files'],
      ['wrangler', 'd1', 'migrations', 'apply', 'inhouse-sbx-pr12-db', '--remote', '--config', join(dir, 'migrate/wrangler.json')],
      ['seed', '--per-pr', '12', '--config', worker, '--database', 'inhouse-sbx-pr12-db'],
      ['wrangler', 'deploy', '--config', worker, '--containers-rollout=immediate'],
    ])
  })
  test('a first deploy (nothing there yet) only creates', async () => {
    const dir = await deployDir()
    const w = world({ workers: [], domains: [], d1: [], r2: [], containers: [] })
    await deploy({ app, pr: 12, dir, accountId: ACCOUNT, zone: ZONE, ...w })
    assert.deepEqual(w.calls.map(c => c[0]), ['createD1', 'createR2', 'wrangler', 'seed', 'wrangler'])
  })
})

describe('deploy.mjs refuses before any call (failure 1)', () => {
  const edit = (dir, change) => {
    const f = join(dir, 'inhouse_product/wrangler.json')
    const c = JSON.parse(readFileSync(f, 'utf8'))
    change(c)
    writeFileSync(f, JSON.stringify(c))
  }
  const cases = [
    ['a config edited after config.mjs to bind a live D1', c => { c.d1_databases[0].database_name = 'live-product-db' }, /fails the lock/],
    ['a config edited to add a service binding', c => { c.services = [{ binding: 'X', service: 'live-product' }] }, /fails the lock/],
    ['a config edited to bind by id', c => { c.d1_databases[0].database_id = '00000000-0000-4000-8000-000000000009' }, /fails the lock/],
  ]
  for (const [name, change, message] of cases) {
    test(name, async () => {
      const dir = await deployDir()
      edit(dir, change)
      const w = world()
      await assert.rejects(deploy({ app, pr: 12, dir, accountId: ACCOUNT, zone: ZONE, ...w }), message)
      assert.deepEqual(w.calls, [])
    })
  }
  test('a comment in the config (plain JSON only)', async () => {
    const dir = await deployDir()
    const f = join(dir, 'inhouse_product/wrangler.json')
    writeFileSync(f, `// x\r${readFileSync(f, 'utf8')}`)
    const w = world()
    await assert.rejects(deploy({ app, pr: 12, dir, accountId: ACCOUNT, zone: ZONE, ...w }), /isn't plain JSON/)
    assert.deepEqual(w.calls, [])
  })
  test('PR 12\'s folder deployed as PR 13', async () => {
    const dir = await deployDir(12)
    const w = world()
    await assert.rejects(deploy({ app, pr: 13, dir, accountId: ACCOUNT, zone: ZONE, ...w }), /fails the lock/)
    assert.deepEqual(w.calls, [])
  })
})

// main()'s own wiring: main() only forwards mainParts(argv, env) to deploy(), so these are main's runners.
describe('mainParts (what main() runs with)', () => {
  const env = { PATH: '/bin', HOME: '/home/x', CLOUDFLARE_API_TOKEN: 'tok', CLOUDFLARE_ACCOUNT_ID: ACCOUNT, CF_SANDBOX_ACCOUNT_ID: ACCOUNT, SBX_ZONE: ZONE, AUDIT_HASH_KEY: 'the-key-0123456789', UNRELATED: 'x' }
  const record = () => {
    const runs = []
    return { runs, run: (dir, script, args, childEnv) => runs.push({ script: script.split('/').slice(-2).join('/'), env: childEnv }) }
  }
  test('neither child gets AUDIT_HASH_KEY or anything else from the job env', async () => {
    const r = record()
    const parts = await mainParts(['--app', APP_DIR, '--pr', '12', '--deploy-dir', '/tmp/x'], env, { run: r.run })
    assert.equal(parts.pr, 12)
    parts.wrangler(['deploy'])
    parts.seed(['--per-pr', '12'])
    assert.deepEqual(r.runs.map(x => [x.script, Object.hasOwn(x.env, 'AUDIT_HASH_KEY'), Object.hasOwn(x.env, 'UNRELATED')]), [['bin/wrangler.js', false, false], ['sandbox/seed-remote.mjs', false, false]])
  })
  test('refuses another account than the sandbox, or no token', async () => {
    await assert.rejects(mainParts(['--app', APP_DIR, '--pr', '12', '--deploy-dir', '/tmp/x'], { ...env, CLOUDFLARE_ACCOUNT_ID: 'f'.repeat(32) }), /CLOUDFLARE_ACCOUNT_ID equal to CF_SANDBOX_ACCOUNT_ID/)
    await assert.rejects(mainParts(['--app', APP_DIR, '--pr', '12', '--deploy-dir', '/tmp/x'], { ...env, CLOUDFLARE_API_TOKEN: '' }), /needs CLOUDFLARE_API_TOKEN/)
  })
})

// (P4) The hub. Ways it could fail, written down first:
//  5. the product deploys before its hub (its binding would point at nothing), or a hub deploys when the product binds
//     none, or the product binds another hub than the folder's;
//  6. the teardown deletes the hub before the product that binds it, or another PR's hub.
const HUB_TEST_SOURCE = JSON.stringify({
  name: 'inhouse-hub', main: 'hub/index/index.ts', compatibility_date: '2026-11-11', workers_dev: false, preview_urls: false,
  durable_objects: { bindings: [{ name: 'SIGNIN', class_name: 'SignIn' }] }, migrations: [{ tag: 'v1', new_sqlite_classes: ['SignIn'] }],
  define: { __INHOUSE_HUB_TEST__: 'true' }, vars: { INHOUSE_TEST_BUILD: '1', SHOPIFY_SHOP: 'example-fixture', SHOPIFY_CLIENT_ID: 'test-client' },
})
const HUB_ENTRY = { binding: 'HUB', service: 'inhouse-hub', entrypoint: 'ReadGateway' }

/** PR `pr`'s deploy folder with a hub (its test config in the artifact), written by deploy-config.mjs. */
async function hubDeployDir({ pr = 12 } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'hub-deploy-test-'))
  const art = join(root, 'artifact')
  const access = JSON.stringify({ teamDomain: 'https://test-issuer.invalid', apps: [{ name: 'brand', origin: 'http://brand.localhost:8787', aud: 'b'.repeat(64) }, { name: 'inhouse', origin: 'http://inhouse.localhost:8787', aud: 'c'.repeat(64) }], serviceTokens: {} })
  const product = {
    name: 'inhouse-product', main: 'index.js', compatibility_date: '2026-11-13',
    d1_databases: [{ binding: 'DB', database_name: 'inhouse' }], r2_buckets: [{ binding: 'FILES', bucket_name: 'inhouse-files' }],
    services: [HUB_ENTRY],
    vars: { INHOUSE_TEST_BUILD: '1', INHOUSE_ACCESS: access },
    workers_dev: false, preview_urls: false,
  }
  const files = {
    'dist/inhouse_product/wrangler.json': JSON.stringify(product),
    'dist/inhouse_product/index.js': 'export default {}',
    'hub/index.js': 'export default {}',
    'hub/wrangler.jsonc': HUB_TEST_SOURCE,
    'migrations/0001_members.sql': 'CREATE TABLE t (id TEXT);',
  }
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(join(art, p, '..'), { recursive: true })
    writeFileSync(join(art, p), text)
  }
  const jwks = join(root, 'jwks.json')
  writeFileSync(jwks, JSON.stringify({ keys: [{ kty: 'RSA', n: 'abc', e: 'AQAB', kid: 'k1', alg: 'RS256' }] }))
  await writeConfig(['--app', APP_DIR, '--pr', String(pr), '--artifact', art, '--out', join(root, 'deploy'), '--jwks', jwks], ENV)
  return join(root, 'deploy')
}

describe('(P4) deploy.mjs and the hub (failures 5 to 7)', () => {
  const HUB_LISTING = { ...LISTING, workers: [...LISTING.workers, 'inhouse-sbx-pr12-hub', 'inhouse-sbx-pr13-hub', 'inhouse-sbx-hub'] }
  test('per-PR: tears the product down before its hub, then deploys the hub before the product', async () => {
    const dir = await hubDeployDir()
    const w = world(HUB_LISTING)
    await deploy({ app, pr: 12, dir, accountId: ACCOUNT, zone: ZONE, ...w })
    const worker = join(dir, 'inhouse_product/wrangler.json')
    assert.deepEqual(w.calls, [
      ['detachDomain', 'dom-12b'], ['deleteWorker', 'inhouse-sbx-pr12'], ['deleteWorker', 'inhouse-sbx-pr12-hub'], ['deleteContainerApp', 'c-12'], ['deleteD1', 'u-12'], ['r2Keys', 'inhouse-sbx-pr12-files'], ['deleteR2', 'inhouse-sbx-pr12-files'],
      ['createD1', 'inhouse-sbx-pr12-db'], ['createR2', 'inhouse-sbx-pr12-files'],
      ['wrangler', 'd1', 'migrations', 'apply', 'inhouse-sbx-pr12-db', '--remote', '--config', join(dir, 'migrate/wrangler.json')],
      ['seed', '--per-pr', '12', '--config', worker, '--database', 'inhouse-sbx-pr12-db'],
      ['wrangler', 'deploy', '--config', join(dir, 'hub/wrangler.json')],
      ['wrangler', 'deploy', '--config', worker, '--containers-rollout=immediate'],
    ])
  })
  const edit = (file, change) => {
    const c = JSON.parse(readFileSync(file, 'utf8'))
    change(c)
    writeFileSync(file, JSON.stringify(c))
  }
  const refusals = [
    ['the product bound to another PR\'s hub', dir => edit(join(dir, 'inhouse_product/wrangler.json'), c => { c.services[0].service = 'inhouse-sbx-pr13-hub' }), /fails the lock/],
    ['the product bound to the house hub', dir => edit(join(dir, 'inhouse_product/wrangler.json'), c => { c.services[0].service = 'inhouse-hub' }), /fails the lock/],
    ['the product with no binding beside a hub', dir => edit(join(dir, 'inhouse_product/wrangler.json'), c => { c.services = [] }), /the product doesn't bind inhouse-sbx-pr12-hub/],
    ['a hub that is gone while the product binds it', dir => rmSync(join(dir, 'hub'), { recursive: true }), /the product binds a hub, but the deploy folder has none/],
    ['a hub config edited to add a route', dir => edit(join(dir, 'hub/wrangler.json'), c => { c.routes = [`inhouse-sbx-pr12-brand.${ZONE}`] }), /hub\/wrangler\.json fails the lock/],
    ['a hub config that keeps secrets.required', dir => edit(join(dir, 'hub/wrangler.json'), c => { c.secrets = { required: ['HUB_TOKEN_KEYS'] } }), /hub\/wrangler\.json fails the lock/],
  ]
  for (const [name, change, message] of refusals) {
    test(`per-PR: refuses ${name}, before any call`, async () => {
      const dir = await hubDeployDir()
      change(dir)
      const w = world(HUB_LISTING)
      await assert.rejects(deploy({ app, pr: 12, dir, accountId: ACCOUNT, zone: ZONE, ...w }), message)
      assert.deepEqual(w.calls, [])
    })
  }
})

describe('(P5) deploy.mjs: every hub entry names the folder\'s hub', () => {
  const HUB_LISTING = { ...LISTING, workers: [...LISTING.workers, 'inhouse-sbx-pr12-hub'] }
  const three = hub => [
    { binding: 'HUB', service: hub, entrypoint: 'ReadGateway' },
    { binding: 'HUB_CONNECT', service: hub, entrypoint: 'ConnectGateway' },
    { binding: 'HUB_DELIVERY', service: hub, entrypoint: 'DeliveryGateway' },
  ]
  const setServices = (dir, services) => {
    const f = join(dir, 'inhouse_product/wrangler.json')
    writeFileSync(f, JSON.stringify({ ...JSON.parse(readFileSync(f, 'utf8')), services }))
  }
  test('the three, all to PR 12\'s hub, deploy the hub then the product', async () => {
    const dir = await hubDeployDir()
    setServices(dir, three('inhouse-sbx-pr12-hub'))
    const w = world(HUB_LISTING)
    await deploy({ app, pr: 12, dir, accountId: ACCOUNT, zone: ZONE, ...w })
    assert.deepEqual(w.calls.filter(c => c[1] === 'deploy').map(c => c[3]), [join(dir, 'hub/wrangler.json'), join(dir, 'inhouse_product/wrangler.json')])
  })
  test('one entry to another PR\'s hub is refused before any call', async () => {
    const dir = await hubDeployDir()
    const services = three('inhouse-sbx-pr12-hub')
    services[2] = { ...services[2], service: 'inhouse-sbx-pr13-hub' }
    setServices(dir, services)
    const w = world(HUB_LISTING)
    await assert.rejects(deploy({ app, pr: 12, dir, accountId: ACCOUNT, zone: ZONE, ...w }), /fails the lock|doesn't bind inhouse-sbx-pr12-hub/)
    assert.deepEqual(w.calls, [])
  })
})

describe('(P5) checkHub, its own guard (the app lock stubbed to pass everything)', () => {
  // The app lock refuses a wrong hub first in a real run, so this proves deploy.mjs's own check: with a lock that passes
  // anything, an entry naming another PR's hub still stops the deploy. (Mutation-checked: with the old
  // `services[0]?.service !== hubName` guard, the entry 1 and entry 2 cases pass.)
  const three = hub => [
    { binding: 'HUB', service: hub, entrypoint: 'ReadGateway' },
    { binding: 'HUB_CONNECT', service: hub, entrypoint: 'ConnectGateway' },
    { binding: 'HUB_DELIVERY', service: hub, entrypoint: 'DeliveryGateway' },
  ]
  const passAll = { readSandboxConfig: app.readSandboxConfig, checkSandboxConfig: () => [] }
  const run = async services => checkHub({ app: passAll, dir: await hubDeployDir(), product: { services }, hubName: 'inhouse-sbx-pr12-hub', accountId: ACCOUNT, zone: ZONE, mode: { perPr: 12 } })
  test('all three naming the folder\'s hub pass', async () => {
    assert.match(await run(three('inhouse-sbx-pr12-hub')), /hub\/wrangler\.json$/)
  })
  // The eval hub's name is refused for a PR's deploy, alone or as all three.
  for (const services of [[three('inhouse-sbx-eval-hub')[0]], three('inhouse-sbx-eval-hub')]) {
    test(`a PR's deploy refuses the eval hub (${services.length} entries)`, async () => {
      await assert.rejects(run(services), /doesn't bind inhouse-sbx-pr12-hub/)
    })
  }
  for (const i of [0, 1, 2]) {
    test(`entry ${i} naming another PR's hub is refused`, async () => {
      const services = three('inhouse-sbx-pr12-hub')
      services[i] = { ...services[i], service: 'inhouse-sbx-pr13-hub' }
      await assert.rejects(run(services), /doesn't bind inhouse-sbx-pr12-hub/)
    })
  }
})
