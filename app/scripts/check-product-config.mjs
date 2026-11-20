// The deployable config check (P2 W1, p2-design section 2). Run in app/:
//   node scripts/check-product-config.mjs <wrangler config path (JSONC)>
// Exit 0: the config may deploy. Exit 1: it may not, with every failure listed. Exit 2: usage, an unreadable file or a
// crash. CI requires exactly 1 on wrangler.test.jsonc (AGENTS.md). It refuses a config when:
//   - it has an `env` block at all (each `env.<name>` can override vars, workers_dev and preview_urls, so none may
//     deploy unchecked: the product config is one environment);
//   - the test issuer is switched on: `INHOUSE_TEST_BUILD` or `TEST_ISSUER_JWKS` in `vars`;
//   - a var is a Worker secret (`AUDIT_HASH_KEY`, the only one the server reads) or has a secret-like name (ends in
//     SECRET, TOKEN, PASSWORD, PRIVATE or _KEY, any case): secrets are set with `wrangler secret put`, never in the config;
//   - `version_metadata` has no `binding` name (the Worker reads its release from that binding);
//   - INHOUSE_ACCESS is missing or not JSON, or its `teamDomain` isn't `https://<name>.cloudflareaccess.com`;
//   - INHOUSE_ACCESS.apps isn't exactly one `brand` app and one `inhouse` app;
//   - an app lacks `origin` or `aud`, an origin isn't a bare `https://` origin, two apps share a hostname (an origin,
//     or a port-only difference: Access's cookie is per hostname) or an `aud`,
//     or an `aud` isn't 64 hex;
//   - a service token maps to anything but `monitor` or `smoke`;
//   - a brand origin is on `workers.dev` (preview URLs live there too: `<version>-<worker>.<subdomain>.workers.dev`);
//   - `workers_dev` or `preview_urls` isn't explicitly false (wrangler turns both on when they're left out);
//   - any Worker, D1, R2, container, Durable Object script, service or image name, route or Access host carries
//     `inhouse-sbx-` (a sandbox config never passes as a product one).
//
// Sandbox mode (P3 PR0 item 12), the prefix lock for the sandbox, which shares its Cloudflare account with live products:
//   CF_SANDBOX_ACCOUNT_ID=<id> SBX_ZONE=<zone> node scripts/check-product-config.mjs --sandbox <config path>
// Both variables are required (exit 2 without them). A config whose Worker `name` passes the per-PR rule
// (scripts/sandbox/names.mjs) is a per-PR test deployment; any other is the candidate. It refuses a config when:
//   - the Worker `name` isn't a sandbox name, or any D1, R2, container or image name isn't one; in a per-PR config,
//     every one of them must be a per-PR name of the Worker's own PR (a PR's code never binds the candidate's data);
//   - a D1 binding has a `database_id` or `preview_database_id`, or an R2 binding a `preview_bucket_name`: wrangler then
//     binds by the checked name alone (deploy finds or makes the database by `database_name`; wrangler 4.162.0's D1
//     provisioning), so an id can't point the Worker at a live product's database;
//   - a route or custom domain isn't exactly `<sandbox name>.<SBX_ZONE>` (with the `/path` a route may add), names a
//     `zone_id` or another `zone_name`; or an INHOUSE_ACCESS origin isn't `https://<sandbox name>.<SBX_ZONE>`;
//   - `account_id` is missing or isn't CF_SANDBOX_ACCOUNT_ID;
//   - an `ai` binding is present (the sandbox runs the scripted model only, no spend);
//   - a container has no `max_instances` (wrangler's default is 20) or more than 2, no explicit `name`, an
//     `image_build_context`, or an `image` that isn't `registry.cloudflare.com/<CF_SANDBOX_ACCOUNT_ID>/<sandbox name>:<tag>`
//     (a pushed image: the deploy never builds from a Dockerfile);
//   - a Durable Object binding names another Worker's script, or `build` has a `command` (wrangler would run it);
//   - any other top-level key holds anything but empty values (services, KV, queues, tail consumers and every other
//     binding kind could reach a live product's resources; this list fails closed on keys added later);
//   - `env` is set, or `workers_dev` or `preview_urls` isn't explicitly false;
//   - per-PR: vars.INHOUSE_TEST_BUILD isn't "1" (Q2's one exception: the test issuer in a deployed build, sandbox only);
//   - candidate: any product rule above but the `inhouse-sbx-` one fails (it is the product build, rehearsed).
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { SandboxNameError, assertPerPrName, assertSandboxHost, assertSandboxName, assertZone, prNumberOf } from './sandbox/names.mjs'

const USAGE = 'usage: node scripts/check-product-config.mjs [--sandbox] <wrangler config path>\n' +
  '       (--sandbox reads CF_SANDBOX_ACCOUNT_ID and SBX_ZONE from the environment)'
const usage = msg => {
  console.error(`check-product-config: ${msg}\n${USAGE}`)
  process.exit(2)
}

/** JSONC to JSON: drops comments and trailing commas outside strings. */
export function stripJsonc(text) {
  let out = ''
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (c === '"') {
      let j = i + 1
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1
      out += text.slice(i, j + 1)
      i = j
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++
      out += '\n'
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2)
      if (end === -1) throw new Error('unterminated /* comment')
      i = end + 1
    } else if (c === ',') {
      // A trailing comma: only whitespace and comments between it and the closing bracket.
      let j = i + 1
      for (;;) {
        while (j < text.length && /\s/.test(text[j])) j++
        if (text.startsWith('//', j)) { while (j < text.length && text[j] !== '\n') j++ }
        else if (text.startsWith('/*', j)) {
          const end = text.indexOf('*/', j + 2)
          if (end === -1) throw new Error('unterminated /* comment')
          j = end + 2
        } else break
      }
      if (text[j] !== '}' && text[j] !== ']') out += c
    } else out += c
  }
  return out
}

const TEAM_DOMAIN = /^https:\/\/[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.cloudflareaccess\.com$/
const AUD = /^[0-9a-f]{64}$/i
/** The Worker's secrets (server/db/stores.ts's StoresEnv), and the names that look like one. */
const SECRET_VARS = new Set(['AUDIT_HASH_KEY'])
const SECRET_LIKE = /(SECRET|TOKEN|PASSWORD|PRIVATE|_KEY)$/i

/** Every reason this config may not deploy as a product (empty: it may). */
export function checkConfig(config) {
  return [...productRules(config), ...sandboxNamesIn(config)]
}

/** The product rules but the `inhouse-sbx-` one (the candidate in the sandbox is checked against these too). */
function productRules(config) {
  const failures = []
  if (Object.hasOwn(config, 'env')) failures.push('env is set: a deployable config has no env blocks (each could override what this checks)')
  const vars = config.vars ?? {}
  for (const name of ['INHOUSE_TEST_BUILD', 'TEST_ISSUER_JWKS']) {
    if (Object.hasOwn(vars, name)) failures.push(`vars.${name} is set: the test issuer must never be on in a deployable config`)
  }
  for (const name of Object.keys(vars)) {
    if (SECRET_VARS.has(name) || SECRET_LIKE.test(name)) failures.push(`vars.${name} looks like a secret: set secrets with wrangler secret put, never in the config`)
  }
  if (config.workers_dev !== false) failures.push('workers_dev must be false (left out, wrangler turns it on)')
  if (config.preview_urls !== false) failures.push('preview_urls must be false (left out, wrangler turns it on)')

  const vm = config.version_metadata
  if (typeof vm?.binding !== 'string' || !vm.binding) failures.push('version_metadata needs a binding name (the Worker reads its release from it)')

  const raw = config.vars?.INHOUSE_ACCESS
  let access
  try {
    access = JSON.parse(typeof raw === 'string' ? raw : '')
  } catch {
    failures.push('vars.INHOUSE_ACCESS is missing or not JSON')
    return failures
  }
  if (typeof access?.teamDomain !== 'string' || !TEAM_DOMAIN.test(access.teamDomain)) {
    failures.push('INHOUSE_ACCESS.teamDomain must be https://<name>.cloudflareaccess.com')
  }
  const apps = Array.isArray(access?.apps) ? access.apps : []
  const named = name => apps.filter(a => a?.name === name).length
  if (apps.length !== 2 || named('brand') !== 1 || named('inhouse') !== 1) {
    failures.push('INHOUSE_ACCESS.apps must be exactly one "brand" app and one "inhouse" app')
  }
  const origins = new Map()
  const auds = new Map()
  apps.forEach((app, i) => {
    const label = `INHOUSE_ACCESS.apps[${i}]${typeof app?.name === 'string' ? ` (${app.name})` : ''}`
    if (typeof app?.origin !== 'string' || !app.origin) failures.push(`${label} has no origin`)
    else {
      let url
      try { url = new URL(app.origin) } catch { url = null }
      if (!url || url.protocol !== 'https:' || url.origin !== app.origin) failures.push(`${label}.origin must be a bare https:// origin`)
      // Hostname, not origin: Access's CF_Authorization cookie is per hostname, so a port-only difference shares it.
      const key = url ? url.hostname : app.origin
      if (origins.has(key)) failures.push(`${label} shares its hostname with apps[${origins.get(key)}]`)
      origins.set(key, i)
      if (app.name === 'brand' && url && /(^|\.)workers\.dev$/i.test(url.hostname)) {
        failures.push(`${label}.origin is a workers.dev or preview hostname`)
      }
    }
    if (typeof app?.aud !== 'string' || !app.aud) failures.push(`${label} has no aud`)
    else {
      if (!AUD.test(app.aud)) failures.push(`${label}.aud must be 64 hex`)
      if (auds.has(app.aud)) failures.push(`${label} shares its aud with apps[${auds.get(app.aud)}]`)
      auds.set(app.aud, i)
    }
  })
  const tokens = access?.serviceTokens && typeof access.serviceTokens === 'object' ? access.serviceTokens : {}
  for (const service of Object.values(tokens)) {
    if (service !== 'monitor' && service !== 'smoke') failures.push(`INHOUSE_ACCESS.serviceTokens maps a token to "${String(service)}" (only monitor or smoke)`)
  }
  return failures
}

/** Every Cloudflare name and host a config acts on, as [where, value]. Values are whatever the config holds. */
function namesIn(config) {
  const out = []
  const list = v => (Array.isArray(v) ? v : [])
  out.push(['name', config.name])
  list(config.d1_databases).forEach((d, i) => out.push([`d1_databases[${i}].database_name`, d?.database_name]))
  list(config.r2_buckets).forEach((b, i) => {
    out.push([`r2_buckets[${i}].bucket_name`, b?.bucket_name])
    if (b?.preview_bucket_name !== undefined) out.push([`r2_buckets[${i}].preview_bucket_name`, b.preview_bucket_name])
  })
  list(config.containers).forEach((c, i) => {
    out.push([`containers[${i}].name`, c?.name])
    out.push([`containers[${i}].image`, c?.image])
  })
  list(config.durable_objects?.bindings).forEach((d, i) => {
    if (d?.script_name !== undefined) out.push([`durable_objects.bindings[${i}].script_name`, d.script_name])
  })
  list(config.services).forEach((s, i) => out.push([`services[${i}].service`, s?.service]))
  routesOf(config).forEach(([where, r]) => out.push([where, typeof r === 'string' ? r : r?.pattern]))
  accessOrigins(config).forEach(([where, origin]) => out.push([where, origin]))
  return out
}

/** The product's reverse lock: no sandbox name or host. */
function sandboxNamesIn(config) {
  return namesIn(config)
    .filter(([, v]) => typeof v === 'string' && /inhouse-sbx-/i.test(v))
    .map(([where, v]) => `${where} is a sandbox name or host (${JSON.stringify(v)}): a product config never carries inhouse-sbx-`)
}

/** [where, route] for `routes` and `route`. */
function routesOf(config) {
  const out = []
  if (config.route !== undefined) out.push(['route', config.route])
  if (Array.isArray(config.routes)) config.routes.forEach((r, i) => out.push([`routes[${i}]`, r]))
  else if (config.routes !== undefined) out.push(['routes', config.routes])
  return out
}

/** [where, origin] for INHOUSE_ACCESS's apps, when it parses. */
function accessOrigins(config) {
  let access
  try { access = JSON.parse(config.vars?.INHOUSE_ACCESS ?? '') } catch { return [] }
  const apps = Array.isArray(access?.apps) ? access.apps : []
  return apps.map((a, i) => [`INHOUSE_ACCESS.apps[${i}].origin`, a?.origin])
}

/**
 * Top-level keys a sandbox config may fill. Each one wrangler or the vite plugin's generated config uses, and either
 * checked below or unable to reach another Worker's resources. Every other key must be empty.
 */
const SANDBOX_KEYS = new Set([
  // Checked below.
  'name', 'account_id', 'workers_dev', 'preview_urls', 'vars', 'd1_databases', 'r2_buckets', 'containers', 'durable_objects',
  'routes', 'route', 'build',
  // The Worker's own code, assets and settings.
  '$schema', 'main', 'compatibility_date', 'compatibility_flags', 'assets', 'version_metadata', 'migrations', 'observability',
  'upload_source_maps', 'limits', 'triggers', 'logpush', 'keep_vars', 'rules', 'no_bundle', 'minify', 'keep_names',
  'find_additional_modules', 'base_dir', 'preserve_file_names', 'tsconfig', 'jsx_factory', 'jsx_fragment', 'define', 'alias',
  'python_modules', 'send_metrics', 'dev',
  // The vite plugin's bookkeeping in its generated wrangler.json.
  'configPath', 'userConfigPath', 'topLevelName', 'definedEnvironments', 'targetEnvironment', 'legacy_env',
])
const isEmpty = v => v === undefined || v === null ||
  (Array.isArray(v) ? v.length === 0 : typeof v === 'object' && Object.values(v).every(isEmpty))
const IMAGE_TAG = /^(?::[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}|@sha256:[0-9a-f]{64})$/
const ACCOUNT_ID = /^[0-9a-f]{32}$/

/**
 * Every reason this config may not deploy to the sandbox (empty: it may). `accountId` and `zone` are the sandbox's own
 * (CF_SANDBOX_ACCOUNT_ID, SBX_ZONE); a bad one throws, since no config could pass against it.
 */
export function checkSandboxConfig(config, { accountId, zone }) {
  if (typeof accountId !== 'string' || !ACCOUNT_ID.test(accountId)) throw new SandboxNameError('CF_SANDBOX_ACCOUNT_ID must be 32 lowercase hex')
  assertZone(zone)
  const failures = []
  const pr = prNumberOf(config.name)
  const perPr = pr !== null
  /** The rule every name meets: the Worker's own PR's per-PR names, or (candidate) any sandbox name. */
  const nameOk = (where, v) => {
    try {
      if (perPr) assertPerPrName(v, pr)
      else assertSandboxName(v)
    } catch (err) {
      if (!(err instanceof SandboxNameError)) throw err
      failures.push(`${where}: ${err.message}`)
    }
  }
  const hostOk = (where, host) => {
    try {
      assertSandboxHost(host, zone, perPr ? 'per-pr' : 'sandbox', perPr ? pr : undefined)
    } catch (err) {
      if (!(err instanceof SandboxNameError)) throw err
      failures.push(`${where}: ${err.message}`)
    }
  }
  const list = (key) => {
    const v = config[key]
    if (v === undefined) return []
    if (Array.isArray(v)) return v
    failures.push(`${key} must be a list`)
    return []
  }

  for (const [key, value] of Object.entries(config)) {
    if (key === 'env' || key === 'ai') continue // each has its own rule below
    if (!SANDBOX_KEYS.has(key) && !isEmpty(value)) failures.push(`${key} is set: a sandbox config may not use it (it could reach resources outside the sandbox)`)
  }
  if (Object.hasOwn(config, 'env')) failures.push('env is set: a deployable config has no env blocks (each could override what this checks)')
  nameOk('name', config.name)
  if (config.account_id !== accountId) failures.push('account_id is missing or is not the sandbox account (CF_SANDBOX_ACCOUNT_ID)')
  if (config.ai !== undefined && config.ai !== null) failures.push('ai is set: the sandbox runs the scripted model only (no AI binding, no spend)')
  if (config.workers_dev !== false) failures.push('workers_dev must be false (left out, wrangler turns it on)')
  if (config.preview_urls !== false) failures.push('preview_urls must be false (left out, wrangler turns it on)')
  if (config.build?.command !== undefined) failures.push('build.command is set: wrangler would run it in the job that holds the token')

  list('d1_databases').forEach((d, i) => {
    nameOk(`d1_databases[${i}].database_name`, d?.database_name)
    for (const k of ['database_id', 'preview_database_id']) {
      if (d?.[k] !== undefined) failures.push(`d1_databases[${i}].${k} is set: a sandbox D1 binds by its checked database_name only`)
    }
  })
  list('r2_buckets').forEach((b, i) => {
    nameOk(`r2_buckets[${i}].bucket_name`, b?.bucket_name)
    if (b?.preview_bucket_name !== undefined) failures.push(`r2_buckets[${i}].preview_bucket_name is set: a sandbox config has no preview bucket`)
  })
  const registry = `registry.cloudflare.com/${accountId}/`
  list('containers').forEach((c, i) => {
    const where = `containers[${i}]`
    if (c?.name === undefined) failures.push(`${where} has no name (wrangler would make one from the Worker and class names)`)
    else nameOk(`${where}.name`, c.name)
    if (!Number.isInteger(c?.max_instances) || c.max_instances < 1 || c.max_instances > 2) {
      failures.push(`${where}.max_instances must be 1 or 2 (left out, wrangler's default is 20)`)
    }
    if (c?.image_build_context !== undefined) failures.push(`${where}.image_build_context is set: the sandbox deploys a pushed image, never a build`)
    const image = typeof c?.image === 'string' ? c.image : ''
    const repo = image.startsWith(registry) ? /^[^:@]*/.exec(image.slice(registry.length))[0] : null
    if (repo === null || !IMAGE_TAG.test(image.slice(registry.length + repo.length))) {
      failures.push(`${where}.image must be registry.cloudflare.com/<CF_SANDBOX_ACCOUNT_ID>/<sandbox name>:<tag> (a pushed image, not a Dockerfile)`)
    } else nameOk(`${where}.image`, repo)
  })
  const dos = config.durable_objects?.bindings
  ;(Array.isArray(dos) ? dos : []).forEach((d, i) => {
    if (d?.script_name !== undefined && d.script_name !== config.name) failures.push(`durable_objects.bindings[${i}].script_name names another Worker`)
  })
  for (const [where, r] of routesOf(config)) {
    const route = typeof r === 'string' ? { pattern: r } : r
    if (typeof route?.pattern !== 'string') {
      failures.push(`${where} has no pattern`)
      continue
    }
    if (route.zone_id !== undefined) failures.push(`${where}.zone_id is set: name the sandbox zone with zone_name`)
    if (route.zone_name !== undefined && route.zone_name !== zone) failures.push(`${where}.zone_name is not the sandbox zone`)
    // A Custom Domain's pattern is the bare host; a route's may add a path.
    const slash = route.pattern.indexOf('/')
    const host = route.custom_domain === true || slash === -1 ? route.pattern : route.pattern.slice(0, slash)
    hostOk(`${where}.pattern`, host)
  }
  for (const [where, origin] of accessOrigins(config)) {
    let url
    try { url = new URL(origin) } catch { url = null }
    if (!url || url.protocol !== 'https:' || url.origin !== origin) failures.push(`${where} must be a bare https:// origin`)
    else hostOk(where, url.hostname)
  }

  if (perPr) {
    if (config.vars?.INHOUSE_TEST_BUILD !== '1') failures.push('vars.INHOUSE_TEST_BUILD must be "1" in a per-PR test deployment')
    if (accessOrigins(config).length === 0) failures.push('vars.INHOUSE_ACCESS must list the per-PR hosts as its app origins')
  } else {
    for (const f of productRules(config)) if (!failures.includes(f)) failures.push(f)
  }
  return failures
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = process.argv.slice(2)
    const sandbox = args[0] === '--sandbox'
    if (sandbox) args.shift()
    if (args.length !== 1 || args[0].startsWith('--')) usage('give exactly one config path')
    let sandboxEnv
    if (sandbox) {
      sandboxEnv = { accountId: process.env.CF_SANDBOX_ACCOUNT_ID, zone: process.env.SBX_ZONE }
      if (!sandboxEnv.accountId || !ACCOUNT_ID.test(sandboxEnv.accountId)) usage('--sandbox needs CF_SANDBOX_ACCOUNT_ID (32 lowercase hex)')
      try { assertZone(sandboxEnv.zone) } catch { usage('--sandbox needs SBX_ZONE (a lowercase domain name)') }
    }
    let text
    try { text = readFileSync(args[0], 'utf8') } catch { usage(`can't read ${args[0]}`) }
    let config
    try { config = JSON.parse(stripJsonc(text)) } catch (err) { usage(`${args[0]} isn't valid JSONC: ${err.message}`) }
    if (!config || typeof config !== 'object' || Array.isArray(config)) usage(`${args[0]} isn't a config object`)
    const failures = sandbox ? checkSandboxConfig(config, sandboxEnv) : checkConfig(config)
    const where = sandbox ? ' to the sandbox' : ''
    if (failures.length) {
      console.error(`check-product-config: ${args[0]} may not deploy${where}:\n${failures.map(f => `  - ${f}`).join('\n')}`)
      process.exit(1)
    }
    console.log(`check-product-config: ${args[0]} may deploy${where}.`)
  } catch (err) {
    console.error(`check-product-config: crashed: ${err?.stack ?? err}`)
    process.exit(2)
  }
}
