// scripts/sandbox/deploy-config.mjs (moved from the ops repo's config.mjs, per-PR mode). Ways it could fail, written down first:
//  1. it copies something from the (untrusted) artifact that wrangler would read or upload: a .env or .dev.vars, a
//     symlink, a file outside the bundle's known kinds, migrations into the bundle's folder;
//  2. a name, host, account or binding in the written config isn't PR N's (the D1 keeps its build-time id, an origin
//     stays on localhost, the vite plugin's config paths survive);
//  3. it writes a config the lock refuses, or writes anything when the lock refuses;
//  4. the test issuer's keys get mixed up (the private half in the config, or no JWKS);
//  5. containers deploy with the switch off, or without the registry image.
//  6. (P4) the hub: a product binds a hub the artifact doesn't carry (or the other way round), binds anything but its own
//     sandbox hub's ReadGateway, the hub's config carries a key the deploy doesn't (a route), keeps `secrets.required`
//     (wrangler would fail the deploy) or `define`, or the hub bundle brings a file that isn't a bundle file.
// Oracles: a literal artifact (the vite plugin's raw test-build output shape) and the literal config expected for PR 12.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, test } from 'vitest'
import { HUB_WORKER_LOADERS, bindHub, hubDeployConfig, isHubSet, main } from './deploy-config.mjs'
import { ACCOUNT, APP_DIR, ZONE, app } from './test-support.mjs'

const ENV = { CF_SANDBOX_ACCOUNT_ID: ACCOUNT, SBX_ZONE: ZONE }
const JWKS = { keys: [{ kty: 'RSA', n: 'abc', e: 'AQAB', kid: '0011223344556677', alg: 'RS256', use: 'sig' }] }
const TEST_ACCESS = '{"teamDomain":"https://test-issuer.invalid","apps":[{"name":"brand","origin":"http://brand.localhost:8787","aud":"b1a2c3d4e5f60718293a4b5c6d7e8f90b1a2c3d4e5f60718293a4b5c6d7e8f90"},{"name":"inhouse","origin":"http://inhouse.localhost:8787","aud":"0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0"}],"serviceTokens":{"monitor-test-client.access":"monitor","smoke-test-client.access":"smoke"}}'

/** The vite plugin's generated wrangler.json for the test build, as `vite build --mode product-test` writes it. */
const generated = () => ({
  configPath: '/home/runner/work/x/pr/app/wrangler.test.jsonc',
  userConfigPath: '/home/runner/work/x/pr/app/wrangler.test.jsonc',
  topLevelName: 'inhouse-product',
  definedEnvironments: [],
  legacy_env: true,
  compatibility_date: '2026-11-13',
  compatibility_flags: [],
  jsx_factory: 'React.createElement',
  jsx_fragment: 'React.Fragment',
  rules: [{ type: 'ESModule', globs: ['**/*.js', '**/*.mjs'] }],
  name: 'inhouse-product',
  main: 'index.js',
  triggers: {},
  assets: { binding: 'ASSETS', not_found_handling: 'single-page-application', run_worker_first: ['/api/*'], directory: '../client' },
  d1_databases: [{ binding: 'DB', database_name: 'inhouse-test', database_id: '00000000-0000-4000-8000-000000000001', migrations_dir: '../../server/migrations' }],
  r2_buckets: [{ binding: 'FILES', bucket_name: 'inhouse-test-files' }],
  version_metadata: { binding: 'CF_VERSION_METADATA' },
  vars: { INHOUSE_TEST_BUILD: '1', INHOUSE_ACCESS: TEST_ACCESS, AUDIT_HASH_KEY: 'test-only-audit-hash-key-not-a-secret' },
  kv_namespaces: [],
  services: [],
  queues: { producers: [], consumers: [] },
  durable_objects: { bindings: [] },
  migrations: [],
  workers_dev: false,
  preview_urls: false,
  observability: { enabled: true },
  python_modules: { exclude: ['**/*.pyc'] },
  no_bundle: true,
  build: { watch_dir: './src' },
  dev: { ip: 'localhost', local_protocol: 'http', upstream_protocol: 'http', enable_containers: true, generate_types: false },
})

/** A fresh artifact folder: the dist/ the build job uploads, with `config` as its generated wrangler.json. */
function artifact(config = generated(), extra = {}) {
  const root = mkdtempSync(join(tmpdir(), 'artifact-'))
  const files = {
    'dist/inhouse_product/wrangler.json': JSON.stringify(config),
    'dist/inhouse_product/index.js': 'export default {}\n',
    'dist/inhouse_product/assets/chunk-a1.js': 'export const a = 1\n',
    'dist/inhouse_product/index.js.map': '{}',
    'dist/client/index.html': '<!doctype html>',
    'dist/client/assets/app-b2.js': 'console.log(1)',
    'dist/client/.assetsignore': 'wrangler.json\n.dev.vars\n',
    // As in a real vite build's client folder: the headers file and nested static folders.
    'dist/client/_headers': '/*\n  X-Frame-Options: DENY\n',
    'dist/client/logos/a.svg': '<svg/>',
    'migrations/0001_members.sql': 'CREATE TABLE t (id TEXT);',
    'migrations/0002_settings.sql': 'CREATE TABLE u (id TEXT);',
    ...extra,
  }
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, p)), { recursive: true })
    writeFileSync(join(root, p), text)
  }
  return root
}
const jwksFile = (value = JWKS) => {
  const f = join(mkdtempSync(join(tmpdir(), 'jwks-')), 'jwks.json')
  writeFileSync(f, JSON.stringify(value))
  return f
}
const outDir = () => join(mkdtempSync(join(tmpdir(), 'deploy-')), 'deploy')
const args = (art, out, more = []) => ['--app', APP_DIR, '--pr', '12', '--artifact', art, '--out', out, '--jwks', jwksFile(), ...more]
const read = p => JSON.parse(readFileSync(p, 'utf8'))
const listAll = (root, rel = '') => readdirSync(join(root, rel), { withFileTypes: true }).flatMap(d =>
  d.isDirectory() ? listAll(root, rel ? `${rel}/${d.name}` : d.name) : [rel ? `${rel}/${d.name}` : d.name]).sort()

describe('config.mjs writes PR 12\'s deploy folder (failures 2, 4)', () => {
  test('the literal config, the bundle, the assets and the migrations in their own folder', async () => {
    const out = outDir()
    await main(args(artifact(), out), ENV)
    const worker = read(join(out, 'inhouse_product/wrangler.json'))
    assert.deepEqual(worker, {
      legacy_env: true,
      compatibility_date: '2026-11-13',
      compatibility_flags: [],
      jsx_factory: 'React.createElement',
      jsx_fragment: 'React.Fragment',
      rules: [{ type: 'ESModule', globs: ['**/*.js', '**/*.mjs'] }],
      name: 'inhouse-sbx-pr12',
      main: 'index.js',
      triggers: {},
      assets: { binding: 'ASSETS', not_found_handling: 'single-page-application', run_worker_first: ['/api/*'], directory: '../client' },
      d1_databases: [{ binding: 'DB', database_name: 'inhouse-sbx-pr12-db' }],
      r2_buckets: [{ binding: 'FILES', bucket_name: 'inhouse-sbx-pr12-files' }],
      version_metadata: { binding: 'CF_VERSION_METADATA' },
      vars: {
        INHOUSE_TEST_BUILD: '1',
        INHOUSE_ACCESS: '{"teamDomain":"https://test-issuer.invalid","apps":[{"name":"brand","origin":"https://inhouse-sbx-pr12-brand.zone.example.test","aud":"b1a2c3d4e5f60718293a4b5c6d7e8f90b1a2c3d4e5f60718293a4b5c6d7e8f90"},{"name":"inhouse","origin":"https://inhouse-sbx-pr12-team.zone.example.test","aud":"0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0"}],"serviceTokens":{"monitor-test-client.access":"monitor","smoke-test-client.access":"smoke"}}',
        AUDIT_HASH_KEY: 'test-only-audit-hash-key-not-a-secret',
        TEST_ISSUER_JWKS: JSON.stringify(JWKS),
      },
      kv_namespaces: [],
      services: [],
      queues: { producers: [], consumers: [] },
      durable_objects: { bindings: [] },
      migrations: [],
      workers_dev: false,
      preview_urls: false,
      observability: { enabled: true },
      python_modules: { exclude: ['**/*.pyc'] },
      no_bundle: true,
      build: { watch_dir: './src' },
      dev: { ip: 'localhost', local_protocol: 'http', upstream_protocol: 'http', enable_containers: true, generate_types: false },
      account_id: ACCOUNT,
      routes: [
        { pattern: 'inhouse-sbx-pr12-brand.zone.example.test', custom_domain: true },
        { pattern: 'inhouse-sbx-pr12-team.zone.example.test', custom_domain: true },
      ],
    })
    assert.deepEqual(read(join(out, 'migrate/wrangler.json')), {
      name: 'inhouse-sbx-pr12',
      account_id: ACCOUNT,
      compatibility_date: '2026-11-13',
      d1_databases: [{ binding: 'DB', database_name: 'inhouse-sbx-pr12-db', migrations_dir: 'migrations' }],
      vars: { INHOUSE_TEST_BUILD: '1', INHOUSE_ACCESS: worker.vars.INHOUSE_ACCESS },
      workers_dev: false,
      preview_urls: false,
    })
    assert.deepEqual(listAll(out), [
      'client/.assetsignore', 'client/_headers', 'client/assets/app-b2.js', 'client/index.html', 'client/logos/a.svg',
      'inhouse_product/assets/chunk-a1.js', 'inhouse_product/index.js', 'inhouse_product/index.js.map', 'inhouse_product/wrangler.json',
      'migrate/migrations/0001_members.sql', 'migrate/migrations/0002_settings.sql', 'migrate/wrangler.json',
    ])
  })
  test('the bundle is uploaded as built: no_bundle forced on, upload_source_maps dropped', async () => {
    const c = generated()
    c.no_bundle = false
    c.upload_source_maps = true
    const out = outDir()
    await main(args(artifact(c), out), ENV)
    const worker = read(join(out, 'inhouse_product/wrangler.json'))
    assert.equal(worker.no_bundle, true)
    assert.equal(Object.hasOwn(worker, 'upload_source_maps'), false)
  })
  test('refuses a JWKS with a private part, or more than one key', async () => {
    for (const bad of [{ keys: [{ ...JWKS.keys[0], d: 'secret' }] }, { keys: [JWKS.keys[0], JWKS.keys[0]] }, { keys: [] }]) {
      const out = outDir()
      await assert.rejects(main(['--app', APP_DIR, '--pr', '12', '--artifact', artifact(), '--out', out, '--jwks', jwksFile(bad)], ENV), /--jwks must hold one public key/)
    }
  })
})

describe('config.mjs copies only the exact file list (failure 1)', () => {
  const refused = [
    ['a .env beside the bundle', { 'dist/inhouse_product/.env': 'CLOUDFLARE_API_BASE_URL=https://evil.test' }, /\.env is a dotfile/],
    ['a .dev.vars beside the bundle', { 'dist/inhouse_product/.dev.vars': 'X=1' }, /\.dev\.vars is a dotfile/],
    ['a .env in the assets', { 'dist/client/.env': 'X=1' }, /dist\/client\/\.env is a dotfile/],
    ['a dot folder in the assets', { 'dist/client/.vite/manifest.json': '{}' }, /is a dotfile/],
    ['a text module beside the bundle', { 'dist/inhouse_product/notes.txt': 'x' }, /is not a bundle file/],
    ['a stray top-level file', { 'package.json': '{}' }, /unexpected file package\.json/],
    // What a vite build also writes next to the two folders; test-deploy's build job doesn't collect them.
    ['the client module list', { 'dist/client-modules.json': '{}' }, /unexpected file dist\/client-modules\.json/],
    // A per-PR build's module list is never read (only a release's main build is scanned by module: bundle-scan.mjs).
    ['the server module list', { 'dist/server-modules.json': '{}' }, /unexpected file dist\/server-modules\.json/],
    ['the sourcemaps folder', { 'dist/sourcemaps/assets/app-b2.js.map': '{}' }, /unexpected file dist\/sourcemaps/],
    ['a misnamed migration', { 'migrations/evil.sql': 'DROP TABLE t;' }, /unexpected file migrations\/evil\.sql/],
    ['a node_modules folder under the assets', { 'dist/client/node_modules/wrangler/bin/wrangler.js': 'evil()' }, /dist\/client\/node_modules\/wrangler\/bin\/wrangler\.js is under a node_modules folder/],
    ['a node_modules folder beside the bundle', { 'dist/inhouse_product/node_modules/x/index.js': 'evil()' }, /is under a node_modules folder/],
  ]
  for (const [name, extra, message] of refused) {
    test(`refuses ${name} and writes nothing`, async () => {
      const out = outDir()
      await assert.rejects(main(args(artifact(generated(), extra), out), ENV), message)
      assert.throws(() => readdirSync(out), /ENOENT/)
    })
  }
  test('refuses a symlink anywhere in the artifact', async () => {
    const art = artifact()
    symlinkSync('/etc/passwd', join(art, 'dist/client/passwd'))
    await assert.rejects(main(args(art, outDir()), ENV), /dist\/client\/passwd is not a plain file or folder/)
  })
  test('refuses an output folder that exists or sits inside the artifact', async () => {
    const art = artifact()
    await assert.rejects(main(args(art, art), ENV), /already exists/)
    await assert.rejects(main(args(art, join(art, 'out')), ENV), /must be outside the artifact/)
  })
})

describe('config.mjs and the lock (failures 3, 5)', () => {
  const cases = [
    ['a build that isn\'t the test build', c => { delete c.vars.INHOUSE_TEST_BUILD }, /not a test build/],
    ['a service binding the build added', c => { c.services = [{ binding: 'LIVE', service: 'live-product' }] }, /services is set/],
    ['an AI binding', c => { c.ai = { binding: 'AI' } }, /ai is set/],
    ['two D1 bindings', c => { c.d1_databases.push({ binding: 'DB2', database_name: 'x' }) }, /binds 2 D1 databases/],
    ['main outside the build', c => { c.main = '../../../etc/passwd' }, /main must be a relative path inside the build folder/],
    ['containers with the switch off', c => { c.containers = [{ class_name: 'Runner', image: './Dockerfile', max_instances: 5 }] }, /dispatch with containers=true/],
  ]
  for (const [name, change, message] of cases) {
    test(`refuses ${name} and writes nothing`, async () => {
      const c = generated()
      change(c)
      const out = outDir()
      await assert.rejects(main(args(artifact(c), out), ENV), message)
      assert.throws(() => readdirSync(out), /ENOENT/)
    })
  }
  test('with the switch on, a container gets PR 12\'s name, the registry image and the cap', async () => {
    const c = generated()
    // P3's pool rule (app main): exactly one container, for the Runner class, and RUNNER_POOL set.
    c.containers = [{ class_name: 'Runner', image: '/home/runner/work/x/pr/app/runner/Dockerfile', image_build_context: '/home/runner/work/x/pr/app', max_instances: 5, instance_type: 'standard' }]
    c.durable_objects = { bindings: [{ name: 'RUNNER', class_name: 'Runner' }] }
    c.vars.RUNNER_POOL = '2'
    const sha = '0123456789abcdef0123456789abcdef01234567'
    const out = outDir()
    await main(args(artifact(c), out, ['--image-tag', sha]), ENV)
    assert.deepEqual(read(join(out, 'inhouse_product/wrangler.json')).containers, [{
      class_name: 'Runner', name: 'inhouse-sbx-pr12', image: `registry.cloudflare.com/${ACCOUNT}/inhouse-sbx-pr12:${sha}`, max_instances: 2, instance_type: 'standard',
    }])
  })
  test('an image tag with no containers in the build is refused', async () => {
    await assert.rejects(main(args(artifact(), outDir(), ['--image-tag', 'abc']), ENV), /the build has no containers/)
  })
})

describe('usage', () => {
  test('refuses a bad PR number, a missing flag or a missing environment', async () => {
    await assert.rejects(main(['--app', APP_DIR, '--pr', '012', '--artifact', 'a', '--out', 'b', '--jwks', 'c'], ENV), /--pr must be a PR number/)
    await assert.rejects(main(['--app', APP_DIR, '--pr', '12', '--artifact', 'a', '--out', 'b'], ENV), /--jwks is required/)
    await assert.rejects(main(args(artifact(), outDir()), {}), /needs CF_SANDBOX_ACCOUNT_ID and SBX_ZONE/)
  })
})

// (P4) The connector hub. The hub's configs in the JSONC shape of app/wrangler.hub.jsonc and wrangler.hub.test.jsonc
// (comments included), with invented values.
const HUB_SOURCE = `/** The connector hub. */
{
	"$schema": "./hub/node_modules/wrangler/config-schema.json",
	"name": "inhouse-hub",
	"main": "hub/index/index.ts",
	// The newest date the pinned wrangler supports.
	"compatibility_date": "2026-11-11",
	"workers_dev": false,
	"preview_urls": false,
	"observability": { "enabled": true },
	"durable_objects": { "bindings": [{ "name": "SIGNIN", "class_name": "SignIn" }] },
	"migrations": [{ "tag": "v1", "new_sqlite_classes": ["SignIn"] }],
	"define": { "__INHOUSE_HUB_TEST__": "false" },
	"vars": { "SHOPIFY_SHOP": "", "SHOPIFY_CLIENT_ID": "" },
	"secrets": { "required": ["HUB_TOKEN_KEYS", "SHOPIFY_CLIENT_SECRET"] }
}
`
const HUB_TEST_SOURCE = HUB_SOURCE
  .replace('"__INHOUSE_HUB_TEST__": "false"', '"__INHOUSE_HUB_TEST__": "true"')
  .replace('"vars": { "SHOPIFY_SHOP": "", "SHOPIFY_CLIENT_ID": "" },', '"vars": { "INHOUSE_TEST_BUILD": "1", "SHOPIFY_SHOP": "example-fixture", "SHOPIFY_CLIENT_ID": "test-client" },')
  .replace(',\n\t"secrets": { "required": ["HUB_TOKEN_KEYS", "SHOPIFY_CLIENT_SECRET"] }', '')
const HUB = { binding: 'HUB', service: 'inhouse-hub', entrypoint: 'ReadGateway' }
const withHub = (c = generated()) => ({ ...c, services: [{ ...HUB }] })
const hubFiles = (config = HUB_TEST_SOURCE) => ({ 'hub/index.js': 'export default {}\n', ...(config === null ? {} : { 'hub/wrangler.jsonc': config }) })
/** The hub deploy config both modes write, but for name and vars. */
const hubConfig = (name, vars) => ({
  name,
  account_id: ACCOUNT,
  main: 'index.js',
  no_bundle: true,
  compatibility_date: '2026-11-11',
  workers_dev: false,
  preview_urls: false,
  observability: { enabled: true },
  durable_objects: { bindings: [{ name: 'SIGNIN', class_name: 'SignIn' }] },
  migrations: [{ tag: 'v1', new_sqlite_classes: ['SignIn'] }],
  vars,
})

describe('(P4) config.mjs and the hub, per-PR (failure 6)', () => {
  test('writes PR 12\'s hub from the PR\'s test config, and the product binds it', async () => {
    const out = outDir()
    await main(args(artifact(withHub(), hubFiles()), out), ENV)
    assert.deepEqual(read(join(out, 'inhouse_product/wrangler.json')).services, [{ binding: 'HUB', service: 'inhouse-sbx-pr12-hub', entrypoint: 'ReadGateway' }])
    assert.deepEqual(read(join(out, 'hub/wrangler.json')), hubConfig('inhouse-sbx-pr12-hub', { INHOUSE_TEST_BUILD: '1', SHOPIFY_SHOP: 'example-fixture', SHOPIFY_CLIENT_ID: 'test-client' }))
    assert.deepEqual(listAll(join(out, 'hub')), ['index.js', 'wrangler.json'])
  })
  test('a build without a hub writes no hub folder', async () => {
    const out = outDir()
    await main(args(artifact(), out), ENV)
    assert.throws(() => readdirSync(join(out, 'hub')), /ENOENT/)
  })
  const cases = [
    ['a hub binding with no hub bundle', withHub(), {}, /services is set: the build binds a hub, but the artifact has no hub bundle/],
    ['a hub bundle with no hub binding', generated(), hubFiles(), /the artifact has a hub bundle, but the build binds no hub/],
    ['a hub bundle with no config', withHub(), hubFiles(null), /a hub bundle without hub\/wrangler\.jsonc/],
    ['a hub config with no bundle', withHub(), { 'hub/wrangler.jsonc': HUB_TEST_SOURCE }, /hub\/wrangler\.jsonc without a hub bundle/],
    ['a dotfile in the hub folder', withHub(), { ...hubFiles(), 'hub/.hidden.js': '' }, /hub\/\.hidden\.js is not a hub bundle file/],
    ['a file in the hub folder that isn\'t a bundle file', withHub(), { ...hubFiles(), 'hub/README.md': '' }, /hub\/README\.md is not a hub bundle file/],
    ['a bundle in a hub subfolder', withHub(), { ...hubFiles(), 'hub/x/y.js': '' }, /hub\/x\/y\.js is not a hub bundle file/],
    ['no index.js in the hub bundle', withHub(), { 'hub/main.js': '', 'hub/wrangler.jsonc': HUB_TEST_SOURCE }, /the hub bundle has no index\.js/],
    ['the server entrypoint', { ...generated(), services: [{ ...HUB, entrypoint: 'ServerGateway' }] }, hubFiles(), /services must be exactly one/],
    ['a second service', { ...generated(), services: [{ ...HUB }, { binding: 'LIVE', service: 'live-product' }] }, hubFiles(), /services must be exactly one/],
    ['a route in the hub config', withHub(), hubFiles(HUB_TEST_SOURCE.replace('"workers_dev": false,', '"routes": ["x.example.test/*"], "workers_dev": false,')), /the hub config sets routes/],
    ['a hub config that isn\'t JSONC', withHub(), hubFiles('{ nope'), /can't be read as JSONC/],
    ['a PR hub without the test switch', withHub(), hubFiles(HUB_TEST_SOURCE.replace('"INHOUSE_TEST_BUILD": "1", ', '')), /hub: vars\.INHOUSE_TEST_BUILD must be "1"/],
  ]
  for (const [name, config, extra, message] of cases) {
    test(`refuses ${name} and writes nothing`, async () => {
      const out = outDir()
      await assert.rejects(main(args(artifact(config, extra), out), ENV), message)
      assert.throws(() => readdirSync(out), /ENOENT/)
    })
  }
})

describe('(P5) the three hub bindings: exact sets, not any subset (failure 6)', () => {
  const three = hub => [
    { binding: 'HUB', service: hub, entrypoint: 'ReadGateway' },
    { binding: 'HUB_CONNECT', service: hub, entrypoint: 'ConnectGateway' },
    { binding: 'HUB_DELIVERY', service: hub, entrypoint: 'DeliveryGateway' },
  ]
  test('per-PR: all three, in any order, are rewritten to PR 12\'s hub and pass the lock', async () => {
    for (const services of [three('inhouse-hub'), three('inhouse-hub').reverse()]) {
      const out = outDir()
      await main(args(artifact({ ...generated(), services }, hubFiles()), out), ENV)
      assert.deepEqual(read(join(out, 'inhouse_product/wrangler.json')).services, services.map(e => ({ ...e, service: 'inhouse-sbx-pr12-hub' })))
    }
  })
  test('bindHub: the candidate\'s three name CANDIDATE_HUB; HUB alone still binds', () => {
    const c = { services: three('inhouse-hub') }
    bindHub(c, 'inhouse-sbx-hub', true)
    assert.deepEqual(c.services, three('inhouse-sbx-hub'))
    const one = { services: [three('inhouse-hub')[0]] }
    bindHub(one, 'inhouse-sbx-hub', true)
    assert.deepEqual(one.services, [three('inhouse-sbx-hub')[0]])
  })
  const H = 'inhouse-hub'
  const cases = [
    ['two of the three', three(H).slice(0, 2)],
    ['HUB_CONNECT alone', [three(H)[1]]],
    ['HUB_DELIVERY alone', [three(H)[2]]],
    ['a fourth entry', [...three(H), { binding: 'LIVE', service: 'live-product', entrypoint: 'ReadGateway' }]],
    ['a binding twice in place of another', [three(H)[0], three(H)[1], three(H)[1]]],
    ['HUB_CONNECT on ReadGateway', [three(H)[0], { ...three(H)[1], entrypoint: 'ReadGateway' }, three(H)[2]]],
    ['HUB_DELIVERY with no entrypoint', [three(H)[0], three(H)[1], { binding: 'HUB_DELIVERY', service: H }]],
    ['an extra key', [three(H)[0], three(H)[1], { ...three(H)[2], environment: 'x' }]],
    ['entries naming two hubs', [three(H)[0], { ...three(H)[1], service: 'live-product' }, three(H)[2]]],
  ]
  for (const [name, services] of cases) {
    test(`refuses ${name} and writes nothing`, async () => {
      const out = outDir()
      await assert.rejects(main(args(artifact({ ...generated(), services }, hubFiles()), out), ENV), /services must be exactly one of \{ HUB -> ReadGateway \}, \{ HUB -> ReadGateway, HUB_CONNECT -> ConnectGateway, HUB_DELIVERY -> DeliveryGateway \} or the same three plus HUB_WRITE -> WriteGateway/)
      assert.throws(() => readdirSync(out), /ENOENT/)
    })
  }
  // A9 on ops#15: the eval hub's name is refused for every other environment; a build's hub name never survives bindHub.
  test('isHubSet refuses the eval hub for the per-PR, candidate and house hubs; bindHub writes the environment\'s own', () => {
    for (const env of ['inhouse-sbx-pr12-hub', 'inhouse-sbx-hub', 'inhouse-hub']) {
      for (const services of [[three('inhouse-sbx-eval-hub')[0]], three('inhouse-sbx-eval-hub')]) assert.equal(isHubSet(services, env), false, env)
      const c = { services: three('inhouse-sbx-eval-hub') }
      bindHub(c, env, true)
      assert.deepEqual(c.services.map(e => e.service), [env, env, env])
    }
  })
  test('isHubSet: exact sets only, one hub', () => {
    assert.equal(isHubSet(three('h')), true)
    assert.equal(isHubSet([three('h')[0]]), true)
    assert.equal(isHubSet([]), false)
    assert.equal(isHubSet(three('h'), 'other'), false)
    assert.equal(isHubSet([three('h')[0], three('h')[2]]), false)
  })
  // Stage 1 M2-C (app #432): the outbox dispatcher's write binding joins P5's three, never alone or with fewer.
  test('isHubSet: P5\'s three plus HUB_WRITE -> WriteGateway is a set; HUB_WRITE alone, or beside fewer is not', () => {
    const write = h => ({ binding: 'HUB_WRITE', service: h, entrypoint: 'WriteGateway' })
    assert.equal(isHubSet([...three('h'), write('h')]), true)
    assert.equal(isHubSet([write('h'), ...three('h')].reverse()), true)
    assert.equal(isHubSet([write('h')]), false)
    assert.equal(isHubSet([three('h')[0], write('h')]), false)
    assert.equal(isHubSet([...three('h'), { ...write('h'), entrypoint: 'ServerGateway' }]), false)
    assert.equal(isHubSet([...three('h'), write('other')]), false)
    const c = { services: [...three('built-hub'), write('built-hub')] }
    bindHub(c, 'inhouse-sbx-pr12-hub', true)
    assert.deepEqual(c.services.map(e => e.service), Array(4).fill('inhouse-sbx-pr12-hub'))
  })
})

// (P5) Code mode's Worker Loader on the hub (app wrangler.hub.jsonc and .test.jsonc on fleet/connectors:
// `"worker_loaders": [{ "binding": "LOADER" }]`). Ways it could fail, written down first:
//  12. a hub config that declares the loader is refused (P5's per-PR deploys stop at "Write PR N's config"), or the loader
//      is dropped on the way, so code mode deploys with no env.LOADER;
//  13. a loader other than exactly that one goes through: a second entry, another binding name, an extra key;
//  14. a hub config without it (app main today) is written any differently from before.
describe('(P5) the hub\'s Worker Loader (failures 12 to 14)', () => {
  const source = { name: 'inhouse-hub', main: 'hub/index/index.ts', compatibility_date: '2026-11-11', workers_dev: false, preview_urls: false, vars: { SHOPIFY_SHOP: '' } }
  const opts = { name: 'inhouse-sbx-pr12-hub', accountId: ACCOUNT, bundle: ['index.js'] }
  test('carried exactly when declared; a hub without it is written as before (failures 12, 14)', () => {
    assert.deepEqual(HUB_WORKER_LOADERS, [{ binding: 'LOADER' }])
    const before = hubDeployConfig(source, opts)
    assert.equal(Object.hasOwn(before, 'worker_loaders'), false)
    assert.deepEqual(hubDeployConfig({ ...source, worker_loaders: [{ binding: 'LOADER' }] }, opts), { ...before, worker_loaders: [{ binding: 'LOADER' }] })
  })
  for (const [what, loaders] of [
    ['two loaders', [{ binding: 'LOADER' }, { binding: 'LOADER2' }]],
    ['another binding name', [{ binding: 'OTHER' }]],
    ['an extra key', [{ binding: 'LOADER', id: 'x' }]],
    ['no entry', []],
    ['an object, not a list', { binding: 'LOADER' }],
    ['a bare string', ['LOADER']],
    ['null', null],
  ]) {
    test(`refuses ${what} (failure 13)`, () => {
      assert.throws(() => hubDeployConfig({ ...source, worker_loaders: loaders }, opts), /worker_loaders must be exactly \[\{"binding":"LOADER"\}\]/)
    })
  }
  // The app's own sandbox lock decides the rest, and the test asks it first (not a version guess): the lock is run on PR
  // 12's hub config as config.mjs writes it, without and with the loader. Without, it must pass (else this test can't
  // tell). With, it either passes (app #316 and later: the end-to-end write MUST succeed and carry the loader) or refuses
  // only by naming worker_loaders (before #316: the write MUST be refused by name, writing nothing).
  test('per-PR end to end: a lock that admits the loader must get it written; one that doesn\'t must refuse it by name, writing nothing', async () => {
    const withLoader = HUB_TEST_SOURCE.replace('"migrations": [', '"worker_loaders": [{ "binding": "LOADER" }],\n\t"migrations": [')
    assert.notEqual(withLoader, HUB_TEST_SOURCE)
    const probe = hubConfig('inhouse-sbx-pr12-hub', { INHOUSE_TEST_BUILD: '1', SHOPIFY_SHOP: 'example-fixture', SHOPIFY_CLIENT_ID: 'test-client' })
    const lock = c => app.checkSandboxConfig(c, { accountId: ACCOUNT, zone: ZONE, mode: { perPr: 12, hub: true }, configDir: tmpdir() })
    assert.deepEqual(lock(probe), [], 'the lock passes PR 12\'s hub without the loader')
    const withIt = lock({ ...probe, worker_loaders: [{ binding: 'LOADER' }] })
    const admits = withIt.length === 0
    if (!admits) assert.ok(withIt.every(f => /worker_loaders/.test(f)), `a lock that refuses the loader names it, and only it: ${withIt.join('; ')}`)
    const out = outDir()
    const run = main(args(artifact(withHub(), hubFiles(withLoader)), out), ENV)
    if (admits) {
      await run
      assert.deepEqual(read(join(out, 'hub/wrangler.json')), { ...probe, worker_loaders: [{ binding: 'LOADER' }] })
    } else {
      await assert.rejects(run, /hub: .*worker_loaders/)
      assert.throws(() => readdirSync(out), /ENOENT/)
    }
  })
})
