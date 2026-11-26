// Writes PR N's deploy folder from the build's artifact (no token needed here), for sandbox-test-deploy.yml:
//   CF_SANDBOX_ACCOUNT_ID=<id> SBX_ZONE=<zone> node scripts/sandbox/deploy-config.mjs --app <app main checkout>/app \
//     --pr <N> --artifact <dir> --out <dir> --jwks <file> [--image-tag <tag>]
// Moved from the private ops repo's scripts/config.mjs (its per-PR mode only; the candidate and eval modes stay there).
// The artifact (made from the PR's code, so untrusted) holds `dist/` (the vite plugin's `vite build --mode product-test`
// output: `dist/inhouse_product/` with the Worker bundle and its generated wrangler.json, `dist/client/` with the assets)
// and `migrations/*.sql`. Only an exact set of plain files is copied out (no symlinks, no dotfiles but the client's
// .assetsignore, no local env files); anything else fails the run. <out> must not exist. It gets:
//   <out>/inhouse_product/   the bundle (.js, .mjs, .map) and wrangler.json, the config the lock checks and wrangler deploys;
//   <out>/client/            the assets (wrangler.json's assets.directory is ../client);
//   <out>/migrate/           wrangler.json (the D1 binding only, migrations_dir "migrations") and migrations/*.sql, kept
//                            out of the bundle's folder so wrangler never uploads them as modules.
// The config is the generated one with the vite plugin's config paths dropped, and every name, host and the account set
// for PR N (names.mjs perPrNames): D1 bound by name only, INHOUSE_ACCESS's origins on PR N's two hosts (its test `aud`s
// kept, so the specs' test-issuer tokens match), TEST_ISSUER_JWKS from <jwks> (one public key: the private half never
// leaves the job that made it), and containers (only with --image-tag) on the sandbox registry. Both configs must pass
// the lock (`--sandbox --per-pr N`, in process) before anything is written, and deploy.mjs runs the lock again on the files.
// The connector hub: when the product config binds the hub (HUB to its ReadGateway; or HUB, HUB_CONNECT to
// ConnectGateway and HUB_DELIVERY to DeliveryGateway; or those three plus HUB_WRITE to WriteGateway: isHubSet), the
// artifact must hold the hub's bundle under `hub/` (`*.js`, `*.mjs`) and the PR's `hub/wrangler.jsonc` (the hub's TEST
// config), and the other way round. The folder then also gets:
//   <out>/hub/               the hub's bundle and wrangler.json: name (PR N's `perPrNames(N).hub`), account, `main` the
//                            bundle's index.js, `no_bundle`, workers_dev and preview_urls false, and the source config's
//                            compatibility settings, observability, Durable Objects, their migrations, vars and its one
//                            Worker Loader, exactly `worker_loaders: [{ binding: "LOADER" }]` when declared. Nothing
//                            else: no `define` (applied at bundle time) and no `secrets`. A source key outside that set is
//                            refused.
// The product's hub entries are rewritten to name that hub, and the hub's config passes the lock in hub mode
// (`--sandbox --per-pr N --hub`) before anything is written.
// Exit 0 written, 1 refused, 2 usage.
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { loadApp } from './teardown.mjs'

export class Refused extends Error {}
class Usage extends Error {}

const WORKER_DIR = 'dist/inhouse_product'
const CLIENT_DIR = 'dist/client'
const HUB_DIR = 'hub'
// oxlint-disable-next-line no-control-regex -- a control character in an artifact file name is exactly what this refuses
const BAD_NAME = /[\x00-\x1f\x7f\\]/

/** Every plain file under `root`, as relative paths. Refuses symlinks, odd names and anything not a file or folder. */
export function walk(root, rel = '') {
  const out = []
  for (const name of readdirSync(join(root, rel)).sort()) {
    const p = rel ? `${rel}/${name}` : name
    if (BAD_NAME.test(name)) throw new Refused(`artifact: bad file name ${JSON.stringify(p)}`)
    const st = lstatSync(join(root, p))
    if (st.isDirectory()) out.push(...walk(root, p))
    else if (st.isFile()) out.push(p)
    else throw new Refused(`artifact: ${p} is not a plain file or folder`)
  }
  return out
}

/**
 * Sorts the artifact's files into the sets that may be copied, or refuses the artifact. `hub` is the hub's bundle (plain
 * `.js` and `.mjs` files directly under `hub/`), and `hub/wrangler.jsonc` must come with it.
 */
export function sortArtifact(files) {
  const worker = []
  const client = []
  const migrations = []
  const hub = []
  let hubConfig = false
  for (const p of files) {
    const base = p.split('/').at(-1)
    // No module folder anywhere: a node_modules beside the bundle or under the assets could feed a node run there.
    if (p.split('/').includes('node_modules')) throw new Refused(`artifact: ${p} is under a node_modules folder`)
    if (p.startsWith(`${WORKER_DIR}/`)) {
      const rel = p.slice(WORKER_DIR.length + 1)
      if (rel.split('/').some(s => s.startsWith('.'))) throw new Refused(`artifact: ${p} is a dotfile`)
      if (rel !== 'wrangler.json' && !/\.(m?js|map)$/.test(rel)) throw new Refused(`artifact: ${p} is not a bundle file (.js, .mjs, .map)`)
      if (rel !== 'wrangler.json') worker.push(rel)
    } else if (p.startsWith(`${CLIENT_DIR}/`)) {
      const rel = p.slice(CLIENT_DIR.length + 1)
      if (rel !== '.assetsignore' && rel.split('/').some(s => s.startsWith('.'))) throw new Refused(`artifact: ${p} is a dotfile`)
      client.push(rel)
    } else if (/^migrations\/[0-9]{4}_[a-z0-9_]+\.sql$/.test(p)) {
      migrations.push(base)
    } else if (p.startsWith(`${HUB_DIR}/`)) {
      const rel = p.slice(HUB_DIR.length + 1)
      if (rel === 'wrangler.jsonc') hubConfig = true
      else if (/^[A-Za-z0-9_][A-Za-z0-9_.-]*\.m?js$/.test(rel)) hub.push(rel)
      else throw new Refused(`artifact: ${p} is not a hub bundle file (.js, .mjs directly under hub/)`)
    } else throw new Refused(`artifact: unexpected file ${p}`)
  }
  if (hub.length === 0 && hubConfig) throw new Refused('artifact: hub/wrangler.jsonc without a hub bundle')
  if (hub.length > 0 && !hubConfig) throw new Refused('artifact: a hub bundle without hub/wrangler.jsonc')
  if (!files.includes(`${WORKER_DIR}/wrangler.json`)) throw new Refused(`artifact: no ${WORKER_DIR}/wrangler.json`)
  if (worker.length === 0) throw new Refused('artifact: no Worker bundle')
  if (migrations.length === 0) throw new Refused('artifact: no migrations')
  return { worker, client, migrations, hub, hubConfig }
}

/** Each hub binding a product config may hold, by name, and the hub entrypoint it must name. */
export const HUB_ENTRYPOINTS = Object.freeze({ HUB: 'ReadGateway', HUB_CONNECT: 'ConnectGateway', HUB_DELIVERY: 'DeliveryGateway', HUB_WRITE: 'WriteGateway' })
/** The allowed sets of those bindings, exactly (not any subset): the read binding alone, P5's three, or those plus the write binding. */
export const HUB_SETS = Object.freeze([['HUB'], ['HUB', 'HUB_CONNECT', 'HUB_DELIVERY'], ['HUB', 'HUB_CONNECT', 'HUB_DELIVERY', 'HUB_WRITE']])
const HUB_SETS_TEXT = '{ HUB -> ReadGateway }, { HUB -> ReadGateway, HUB_CONNECT -> ConnectGateway, HUB_DELIVERY -> DeliveryGateway } or the same three plus HUB_WRITE -> WriteGateway'

/**
 * Whether `services` is exactly one allowed set of hub entries, each exactly `{ binding, service, entrypoint }` with its
 * binding's entrypoint, all naming `hubName` (any one hub, when `hubName` is undefined). Order doesn't matter; a binding
 * given twice never stands in for another.
 */
export function isHubSet(services, hubName) {
  if (!Array.isArray(services) || services.length === 0) return false
  const entryOk = e => !!e && typeof e === 'object' && !Array.isArray(e) && Object.keys(e).length === 3 &&
    Object.hasOwn(HUB_ENTRYPOINTS, e.binding) && e.entrypoint === HUB_ENTRYPOINTS[e.binding] && typeof e.service === 'string' &&
    e.service === (hubName ?? services[0].service)
  const bindings = JSON.stringify(services.map(e => e?.binding).sort())
  return services.every(entryOk) && HUB_SETS.some(set => JSON.stringify([...set].sort()) === bindings)
}

/**
 * Rewrites the product config `c`'s hub entries to name `hubName`, or refuses: the config binds a hub exactly when the
 * artifact has one (`hasHub`), and then only as one allowed set of hub entries, all naming one hub.
 */
export function bindHub(c, hubName, hasHub) {
  const s = c.services ?? []
  if (!Array.isArray(s)) throw new Refused('the build\'s services is not a list')
  if (s.length === 0) {
    if (hasHub) throw new Refused('the artifact has a hub bundle, but the build binds no hub (no services)')
    return
  }
  if (!hasHub) throw new Refused('services is set: the build binds a hub, but the artifact has no hub bundle')
  if (!isHubSet(s)) throw new Refused(`services is set: the build's services must be exactly one of ${HUB_SETS_TEXT}, all naming one hub`)
  c.services = s.map(e => ({ binding: e.binding, service: hubName, entrypoint: e.entrypoint }))
}

/** The hub source config keys a deploy carries, or drops by design; any other key is refused. */
const HUB_SOURCE_KEYS = new Set([
  '$schema', 'name', 'main', 'compatibility_date', 'compatibility_flags', 'workers_dev', 'preview_urls', 'observability',
  'durable_objects', 'migrations', 'define', 'vars', 'secrets', 'worker_loaders',
])
/**
 * The one Worker Loader binding the hub may declare: code mode runs scripts in Dynamic Workers through env.LOADER
 * (wrangler.hub.jsonc and .test.jsonc; check-hub-config.mjs pins the same). Carried only when the source declares it,
 * and only exactly this.
 */
export const HUB_WORKER_LOADERS = Object.freeze([Object.freeze({ binding: 'LOADER' })])
/** True when `v` is exactly HUB_WORKER_LOADERS: one entry, the key `binding` alone, "LOADER". */
export const isHubWorkerLoaders = v => Array.isArray(v) && v.length === 1 && !!v[0] && typeof v[0] === 'object' && !Array.isArray(v[0]) &&
  Object.keys(v[0]).length === 1 && v[0].binding === HUB_WORKER_LOADERS[0].binding

/** The hub's deploy config from its source config (parsed) and its bundle's file list. Pure; the lock runs after. */
export function hubDeployConfig(source, { name, accountId, bundle }) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) throw new Refused('the hub config is not an object')
  for (const k of Object.keys(source)) if (!HUB_SOURCE_KEYS.has(k)) throw new Refused(`the hub config sets ${k}, which the hub deploy doesn't carry`)
  // wrangler names the bundle after the entry (hub/index/index.ts -> index.js).
  if (!bundle.includes('index.js')) throw new Refused('the hub bundle has no index.js')
  const c = {
    name,
    account_id: accountId,
    main: 'index.js',
    no_bundle: true,
    compatibility_date: source.compatibility_date,
    workers_dev: false,
    preview_urls: false,
  }
  for (const k of ['compatibility_flags', 'observability', 'durable_objects', 'migrations', 'vars']) {
    if (source[k] !== undefined) c[k] = structuredClone(source[k])
  }
  if (source.worker_loaders !== undefined) {
    if (!isHubWorkerLoaders(source.worker_loaders)) throw new Refused(`the hub config's worker_loaders must be exactly ${JSON.stringify(HUB_WORKER_LOADERS)} (code mode's one loader)`)
    c.worker_loaders = structuredClone(source.worker_loaders)
  }
  return c
}

/** The two configs for PR `pr`, from the vite plugin's generated config. Pure; the lock runs after. */
export function perPrConfigs(generated, { app, pr, accountId, zone, jwks, imageTag, hasHub = false }) {
  const names = app.perPrNames(pr)
  const c = structuredClone(generated)
  for (const k of ['configPath', 'userConfigPath', 'topLevelName', 'definedEnvironments', 'targetEnvironment', 'route']) delete c[k]
  // The bundle is uploaded as built: wrangler never bundles it again, and no source map from the artifact goes up.
  c.no_bundle = true
  delete c.upload_source_maps
  if (c.vars?.INHOUSE_TEST_BUILD !== '1') throw new Refused('the build is not a test build (vars.INHOUSE_TEST_BUILD isn\'t "1")')
  const d1 = c.d1_databases ?? []
  const r2 = c.r2_buckets ?? []
  if (d1.length !== 1 || r2.length !== 1) throw new Refused(`the build binds ${d1.length} D1 databases and ${r2.length} R2 buckets; the sandbox takes one of each`)
  let access
  try { access = JSON.parse(c.vars.INHOUSE_ACCESS) } catch { throw new Refused('the build\'s INHOUSE_ACCESS is not JSON') }
  const host = { brand: `${names.brand}.${zone}`, inhouse: `${names.team}.${zone}` }
  for (const a of access.apps ?? []) {
    if (!host[a.name]) throw new Refused(`INHOUSE_ACCESS has an app named ${JSON.stringify(a.name)}`)
    a.origin = `https://${host[a.name]}`
  }
  c.name = names.worker
  c.account_id = accountId
  c.workers_dev = false
  c.preview_urls = false
  c.d1_databases = [{ binding: d1[0].binding, database_name: names.d1 }]
  c.r2_buckets = [{ binding: r2[0].binding, bucket_name: names.r2 }]
  c.routes = [{ pattern: host.brand, custom_domain: true }, { pattern: host.inhouse, custom_domain: true }]
  c.vars = { ...c.vars, INHOUSE_ACCESS: JSON.stringify(access), TEST_ISSUER_JWKS: jwks }
  if ((c.containers ?? []).length > 0) {
    if (!imageTag) throw new Refused('the build has containers: dispatch with containers=true')
    if (c.containers.length !== 1) throw new Refused('the sandbox takes one container')
    const { class_name, instance_type } = c.containers[0]
    c.containers = [{
      class_name, name: names.container, image: `registry.cloudflare.com/${accountId}/${names.image}:${imageTag}`, max_instances: 2,
      ...(instance_type === undefined ? {} : { instance_type }),
    }]
  } else if (imageTag) throw new Refused('--image-tag given, but the build has no containers')
  const migrate = {
    name: names.worker,
    account_id: accountId,
    compatibility_date: c.compatibility_date,
    d1_databases: [{ binding: d1[0].binding, database_name: names.d1, migrations_dir: 'migrations' }],
    vars: { INHOUSE_TEST_BUILD: '1', INHOUSE_ACCESS: c.vars.INHOUSE_ACCESS },
    workers_dev: false,
    preview_urls: false,
  }
  bindHub(c, names.hub, hasHub)
  return { worker: c, migrate }
}

const IMAGE_TAG = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/

function parseArgs(argv) {
  const flags = {}
  for (let i = 0; i < argv.length; i += 2) {
    const name = /^--(app|pr|artifact|out|jwks|image-tag)$/.exec(argv[i])?.[1]
    if (!name || Object.hasOwn(flags, name) || i + 1 >= argv.length) throw new Usage(`unexpected argument ${JSON.stringify(argv[i])}`)
    flags[name] = argv[i + 1]
  }
  for (const k of ['app', 'pr', 'artifact', 'out', 'jwks']) if (!flags[k]) throw new Usage(`--${k} is required`)
  if (!/^[1-9][0-9]{0,5}$/.test(flags.pr)) throw new Usage('--pr must be a PR number')
  if (flags['image-tag'] !== undefined && !IMAGE_TAG.test(flags['image-tag'])) throw new Usage('--image-tag is not a valid tag')
  return flags
}

/** JWK members only a private or symmetric key carries (RFC 7518: EC/OKP `d`, RSA's primes and CRT values, oct `k`). */
const PRIVATE_JWK_MEMBERS = ['d', 'p', 'q', 'dp', 'dq', 'qi', 'oth', 'k']
/**
 * The JWKS file's one public key, as text; refuses anything else: a private member, a symmetric key, no key type (the
 * private half never leaves the job that made it; the lock's isPublicJwks).
 */
function publicJwks(file) {
  const jwks = readFileSync(file, 'utf8').trim()
  let parsed
  try { parsed = JSON.parse(jwks) } catch { throw new Refused('--jwks is not JSON') }
  const key = Array.isArray(parsed?.keys) && parsed.keys.length === 1 ? parsed.keys[0] : null
  if (!key || typeof key !== 'object' || !['RSA', 'EC', 'OKP'].includes(key.kty) || PRIVATE_JWK_MEMBERS.some(m => Object.hasOwn(key, m))) {
    throw new Refused('--jwks must hold one public key (RSA, EC or OKP, no private member)')
  }
  return jwks
}

export async function main(argv, env = process.env) {
  const f = parseArgs(argv)
  const { CF_SANDBOX_ACCOUNT_ID: accountId, SBX_ZONE: zone } = env
  if (!accountId || !zone) throw new Usage('needs CF_SANDBOX_ACCOUNT_ID and SBX_ZONE')
  const app = await loadApp(f.app)
  const artifact = resolve(f.artifact)
  const out = resolve(f.out)
  if (existsSync(out)) throw new Usage(`${out} already exists`)
  if (out.startsWith(`${artifact}/`) || out === artifact) throw new Usage('--out must be outside the artifact')
  const files = sortArtifact(walk(artifact))
  const hasHub = files.hub.length > 0
  const generated = JSON.parse(readFileSync(join(artifact, WORKER_DIR, 'wrangler.json'), 'utf8'))
  const mode = { perPr: Number(f.pr) }
  const { worker, migrate } = perPrConfigs(generated, { app, pr: mode.perPr, accountId, zone, jwks: publicJwks(f.jwks), imageTag: f['image-tag'], hasHub })
  let hub = null
  if (hasHub) {
    const sourcePath = join(artifact, HUB_DIR, 'wrangler.jsonc')
    let source
    try { source = JSON.parse(app.stripJsonc(readFileSync(sourcePath, 'utf8'))) } catch (err) { throw new Refused(`the hub config ${sourcePath} can't be read as JSONC: ${err.message}`) }
    hub = hubDeployConfig(source, { name: worker.services[0].service, accountId, bundle: files.hub })
  }
  const lock = (config, dir, m = mode) => app.checkSandboxConfig(config, { accountId, zone, mode: m, configDir: dir })
  const failures = [...lock(worker, join(out, 'inhouse_product')).map(x => `inhouse_product: ${x}`), ...lock(migrate, join(out, 'migrate')).map(x => `migrate: ${x}`)]
  if (hub) failures.push(...lock(hub, join(out, HUB_DIR), { ...mode, hub: true }).map(x => `hub: ${x}`))
  if (failures.length) throw new Refused(`the configs fail the lock:\n${failures.map(x => `  - ${x}`).join('\n')}`)
  const copy = (from, to) => { mkdirSync(dirname(to), { recursive: true }); copyFileSync(from, to) }
  for (const rel of files.worker) copy(join(artifact, WORKER_DIR, rel), join(out, 'inhouse_product', rel))
  for (const rel of files.client) copy(join(artifact, CLIENT_DIR, rel), join(out, 'client', rel))
  for (const name of files.migrations) copy(join(artifact, 'migrations', name), join(out, 'migrate', 'migrations', name))
  mkdirSync(join(out, 'client'), { recursive: true })
  writeFileSync(join(out, 'inhouse_product', 'wrangler.json'), `${JSON.stringify(worker, null, 2)}\n`)
  writeFileSync(join(out, 'migrate', 'wrangler.json'), `${JSON.stringify(migrate, null, 2)}\n`)
  if (hub) {
    for (const rel of files.hub) copy(join(artifact, HUB_DIR, rel), join(out, HUB_DIR, rel))
    writeFileSync(join(out, HUB_DIR, 'wrangler.json'), `${JSON.stringify(hub, null, 2)}\n`)
  }
  return { worker: files.worker.length, client: files.client.length, migrations: files.migrations.length, hub: files.hub.length }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(n => {
    console.log(`deploy-config: wrote the deploy folder (${n.worker} bundle files, ${n.client} assets, ${n.migrations} migrations, ${n.hub} hub bundle files)`)
  }, err => {
    console.error(`deploy-config: ${err instanceof Usage ? 'usage: ' : ''}${err.message}`)
    process.exitCode = err instanceof Usage ? 2 : 1
  })
}
