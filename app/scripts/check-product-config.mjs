// The deployable config check (P2 W1, p2-design section 2). Run in app/:
//   node scripts/check-product-config.mjs <wrangler config path (JSONC)>
// Exit 0: the config may deploy. Exit 1: it may not, with every failure listed. Exit 2: usage, an unreadable file or a
// crash. CI requires exactly 1 on wrangler.test.jsonc (AGENTS.md). It refuses a config when:
//   - it has an `env` block at all (each `env.<name>` can override vars, workers_dev and preview_urls, so none may
//     deploy unchecked: the product config is one environment);
//   - the test issuer is switched on: `INHOUSE_TEST_BUILD` or `TEST_ISSUER_JWKS` in `vars`;
//   - the eval brand marker `INHOUSE_EVAL_BRAND` is in `vars` (only the sandbox's eval deployment is an eval brand);
//   - a var is a Worker secret (`AUDIT_HASH_KEY` or `AI_GATEWAY_TOKEN`, the product config's required ones) or has a
//     secret-like name (ends in SECRET, TOKEN, PASSWORD, PRIVATE or _KEY, any case): secrets are set with
//     `wrangler secret put`, never in the config;
//   - `version_metadata` has no `binding` name (the Worker reads its release from that binding);
//   - INHOUSE_ACCESS is missing or not JSON, or its `teamDomain` isn't `https://<name>.cloudflareaccess.com`;
//   - INHOUSE_ACCESS.apps isn't exactly one `brand` app and one `inhouse` app;
//   - an app lacks `origin` or `aud`, an origin isn't a bare `https://` origin, two apps share a hostname (an origin,
//     or a port-only difference: Access's cookie is per hostname) or an `aud`,
//     or an `aud` isn't 64 hex;
//   - a service token maps to anything but `monitor`, `smoke` or `release` (P3);
//   - (P3) a config with the runner pool (a `Runner` Durable Object binding, a `containers` entry or `RUNNER_POOL`) whose
//     `RUNNER_POOL` isn't a whole number of 2 or more, or that hasn't exactly one `Runner` container with
//     `max_instances` = 3 x RUNNER_POOL (p3-design section 7);
//   - (P3) a test-build config (the test issuer on) with an AI binding or a gateway var or secret: tests never reach the
//     gateway (p3-design section 13). A test config is refused anyway; this names the gateway too, so it can't creep in;
//   - (P3) a config with the AI binding or an `AI_GATEWAY_ID` var whose `AI_GATEWAY_ID` is empty or not a gateway id
//     (the egress calls `env.AI.gateway(AI_GATEWAY_ID)`, p3-design 8.2); the template ships it empty, so only a filled
//     config (the release's) passes;
//   - a brand origin is on `workers.dev` (preview URLs live there too: `<version>-<worker>.<subdomain>.workers.dev`);
//   - `workers_dev` or `preview_urls` isn't explicitly false (wrangler turns both on when they're left out);
//   - any string anywhere in it (a name, a host, a var) carries `inhouse-sbx-` (a sandbox config never passes as a
//     product one);
//   - any key at any depth is `__proto__`, `constructor` or `prototype` (both modes; see below);
//   - (P4, p4-h1.md OC 4) `services` isn't exactly `[{ binding: "HUB", service: "inhouse-hub", entrypoint:
//     "ReadGateway" }]`: no other service, no second hub entry, no other binding name or key, no missing or other
//     entrypoint, and no `ServerGateway` entry: in P4 the product Worker reads through the hub and nothing more (P5's
//     PR0 widens this for its gateways).
//
// Sandbox mode (P3 PR0 item 12), the prefix lock for the sandbox, which shares its Cloudflare account with live products:
//   CF_SANDBOX_ACCOUNT_ID=<id> SBX_ZONE=<zone> node scripts/check-product-config.mjs --sandbox --per-pr <N> <config path>
//   CF_SANDBOX_ACCOUNT_ID=<id> SBX_ZONE=<zone> node scripts/check-product-config.mjs --sandbox --candidate <config path>
//   CF_SANDBOX_ACCOUNT_ID=<id> SBX_ZONE=<zone> node scripts/check-product-config.mjs --sandbox --eval <config path>
//   ... --sandbox --per-pr <N> --hub <config path>   or   ... --sandbox --candidate --hub <config path>
//   or   ... --sandbox --eval --hub <config path>
//     (P4) the connector hub's deploy config for that sandbox deployment (rules below).
// The caller states the mode (never inferred from the config, which a PR writes). Both variables are required (exit 2
// without them). The config must be plain JSON, read with JSON.parse alone: a comment or anything JSON.parse refuses
// exits 2. (Two JSONC readers can disagree on where a comment ends: wrangler's ends `//` at a bare \r too, so a
// comment-stripping read could hide config from this check that wrangler then applies.) Names come from
// scripts/sandbox/names.mjs. It refuses a config when:
//   - per-PR: the Worker, D1, R2, container and image names aren't exactly PR N's (`inhouse-sbx-pr<N>`, `-db`, `-files`)
//     and every host isn't `inhouse-sbx-pr<N>-brand` or `-team` on SBX_ZONE; candidate: any of them is a per-PR name or
//     not a sandbox name (a PR's code never binds the candidate's data, and the candidate never binds a PR's);
//   - any key at any depth is `__proto__`, `constructor` or `prototype`: JSON.parse keeps `__proto__` as an own key, but
//     wrangler's JSONC parser sets the object's prototype from it, so a value hidden there would pass this check and
//     still reach wrangler (reproduced on wrangler 4.162.0);
//   - a D1 binding has a key but `binding`, `database_name` and `migrations_dir` (so no `database_id`: wrangler then
//     binds by the checked name alone, finding or making the database by `database_name` in wrangler 4.162.0's D1
//     provisioning), or an R2 binding a key but `binding`, `bucket_name` and `jurisdiction`; or more than one of either;
//   - a route or custom domain isn't exactly a sandbox host (with the `/path` a route may add), names a `zone_id` or
//     another `zone_name`; or an INHOUSE_ACCESS origin isn't `https://<sandbox host>`;
//   - `account_id` is missing or isn't CF_SANDBOX_ACCOUNT_ID;
//   - an `ai` binding is present (the sandbox runs the scripted model only, no spend), except in eval mode;
//   - containers: more than one, a key but `class_name`, `name`, `image`, `max_instances` and `instance_type` (so no
//     `image_build_context` or `images`), `max_instances` missing (wrangler's default is 20) or not 1 or 2, or an `image`
//     that isn't `registry.cloudflare.com/<CF_SANDBOX_ACCOUNT_ID>/<name>:<tag>` or that exists as a file beside the
//     config (wrangler builds any image path that exists, relative to the config's folder);
//   - a path leaves the build folder: `main` and a D1 `migrations_dir` must be plain relative paths (no `..`, not
//     absolute) and `assets.directory` exactly `../client` (the vite plugin's client folder beside the Worker's);
//   - a Durable Object binding has a key but `name` and `class_name` (no other Worker's `script_name`); a migration step
//     a key but `tag`, `new_classes`, `new_sqlite_classes`, `renamed_classes` and `deleted_classes` (no
//     `transferred_classes`, which moves another Worker's objects), class lists that aren't lists of names, or a
//     `renamed_classes` item that isn't exactly `{ from, to }` (no `from_script`); `build` a key but `watch_dir` (no `command`);
//     `observability` a key but `enabled`, `head_sampling_rate`, `logs` and `traces` (those two only `enabled`,
//     `head_sampling_rate`, `invocation_logs` and `persist`: no `destinations`); `rules` anything but the vite
//     plugin's own ESModule rule; `python_modules` anything but wrangler's default;
//   - any other top-level key holds anything but empty values (KV, queues, tail consumers, aliases, a tsconfig, `define`,
//     `secrets`, the vite plugin's config paths and every other kind: this list fails closed on keys added later);
//   - (P4, P5) `services` isn't exactly one of the allowed sets of hub entries, each `{ binding, service: <its hub>,
//     entrypoint }` with no other key: none (a build before P4); `HUB` -> ReadGateway alone (P4, what main ships); or
//     `HUB` -> ReadGateway, `HUB_CONNECT` -> ConnectGateway and `HUB_DELIVERY` -> DeliveryGateway together (P5), in
//     any order. Exact sets, not any subset: a P5 build without one of its three, two entries, a binding twice, another
//     binding or another entrypoint for a binding are refused. Its hub is PR N's (`inhouse-sbx-pr<N>-hub`), for the
//     candidate exactly CANDIDATE_HUB (`inhouse-sbx-hub`, names.mjs), or for the eval deployment exactly its own
//     (`inhouse-sbx-eval-hub`, `HUB` alone: see eval mode below), the same in every entry, and never the product's own
//     name (the candidate product may not be named it either). A sandbox product Worker binds its own sandbox hub's
//     gateways and nothing else (never the house's `inhouse-hub`, a live product or another deployment's hub);
//   - `env` is set, or `workers_dev` or `preview_urls` isn't explicitly false;
//   - per-PR: vars.INHOUSE_TEST_BUILD isn't "1" (Q2's one exception: the test issuer in a deployed build, sandbox only);
//   - per-PR: vars.INHOUSE_EVAL_BRAND is set;
//   - candidate: any product rule above but the `inhouse-sbx-` one fails (it is the product build, rehearsed).
//   - (P3) P3's pool and gateway rules (checkPool) fail, with the sandbox's container cap of 2 in place of
//     3 x RUNNER_POOL (the sandbox runs RUNNER_POOL=2, max_instances=2).
// With --hub (P4) the config is the connector hub's (the ops repo writes it from the hub's bundle and config), and the
// rules above hold with these changes: the Worker name is the hub's (PR N's `inhouse-sbx-pr<N>-hub`, for the candidate
// exactly CANDIDATE_HUB, for the eval deployment exactly `inhouse-sbx-eval-hub`); `services` is empty (the hub binds no Worker); only the hub's keys may hold a value
// (name, account, `main`, `no_bundle`, compatibility, `workers_dev`, `preview_urls`, vars, Durable Objects, their
// migrations, observability, `rules`, `python_modules`, `limits`, `send_metrics`, `$schema`; not `keep_vars`): no route,
// custom domain, assets, D1, R2, container or version metadata; `main` is set and `no_bundle` is true (the bundle that
// was built deploys as it is); per-PR: vars.INHOUSE_TEST_BUILD is "1" (the hub's test build) and INHOUSE_ACCESS isn't
// needed; candidate and eval: `vars`, when set, is a plain object holding only SHOPIFY_SHOP and SHOPIFY_CLIENT_ID, both
// empty (no store credential in the sandbox account, p4 plan "Must not"), and the product rules don't apply (the hub
// isn't the product Worker); eval: the name is exactly the eval hub's (`evalNames().hub`, `inhouse-sbx-eval-hub`), and
// the eval product's rules (the AI binding, the gateway, the eval brand marker) don't apply: the hub runs no model.
// `secrets` (wrangler fails a deploy whose `secrets.required` aren't set) and `define` (applied at bundle time) must be
// empty, as every unlisted key: no generated sandbox or candidate hub config carries `secrets.required`. Any
// runtime secret the candidate hub needs is a per-run value the ops deploy sets at deploy time, not a store credential.
// Eval mode (p3-eval-observability rev 2, rec 2): the eval build's deployment (vite --mode product-eval), deployed from
// main only by the ops repo. The one mode that allows the AI binding and gateway vars beside the test issuer (the eval
// harness signs in through it and grades the real model; Q2's one named spend exception). Every sandbox rule above holds,
// and it refuses a config when:
//   - a name or host isn't exactly the eval deployment's (scripts/sandbox/names.mjs `evalNames()`: `inhouse-sbx-eval`,
//     `-db`, `-files`, its hub `-hub`, and hosts `-brand`, `-team` on SBX_ZONE), which no PR and not the candidate can
//     carry;
//   - `ai` isn't exactly `{ binding: <name> }`, or vars.AI_GATEWAY_ID isn't a gateway id;
//   - a var is a Worker secret or has a secret-like name (the product rule; eval holds the real gateway token, so it has
//     no test-value exception, AUDIT_HASH_KEY included: both go in with `wrangler secret put`), or is any other
//     `AI_GATEWAY_*` var than AI_GATEWAY_ID;
//   - vars.INHOUSE_TEST_BUILD or vars.INHOUSE_EVAL_BRAND isn't "1", or INHOUSE_ACCESS lists no app origins;
//   - vars.TEST_ISSUER_JWKS isn't a JWKS of exactly one public key (no private member: the private half stays in the ops
//     repo's secret);
//   - `version_metadata` has no `binding` name (the eval build's version signal, like the test build's, reads green
//     without one, so the deployment must carry it).
// The generic product, per-PR and candidate rules are unchanged by it; checkPool's "no gateway on a test build" rule is
// the one it lifts.
// Eval and the hub (P4, line A's eval hub): the eval deployment has its own hub, `evalNames().hub`
// (`inhouse-sbx-eval-hub`). An eval product config's `services` is nothing (a build before P4) or exactly
// `{ binding: "HUB", service: "inhouse-sbx-eval-hub", entrypoint: "ReadGateway" }`: never P5's HUB_CONNECT or
// HUB_DELIVERY (the eval brand connects no store and delivers nothing), and never the candidate's, a PR's or the house's
// hub; `--eval --hub` locks the eval hub's own config by the hub rules above.
import { existsSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  CANDIDATE_HUB, SandboxNameError, assertCandidateName, assertPrNumber, assertSandboxHost, assertZone, evalNames, perPrNames,
} from './sandbox/names.mjs'

const USAGE = 'usage: node scripts/check-product-config.mjs <wrangler config path>\n' +
  '       node scripts/check-product-config.mjs --sandbox (--per-pr <N> | --candidate | --eval) <wrangler config path>\n' +
  '       (--sandbox reads CF_SANDBOX_ACCOUNT_ID and SBX_ZONE from the environment)'
const usage = msg => {
  console.error(`check-product-config: ${msg}\n${USAGE}`)
  process.exit(2)
}

/** JSONC to JSON: drops comments and trailing commas outside strings. Product mode only (hand-written templates). */
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
      // A line comment ends at \n or \r, as wrangler's JSONC parser (jsonc-parser's isLineBreak) ends it.
      while (i < text.length && text[i] !== '\n' && text[i] !== '\r') i++
      out += text[i] ?? ''
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2)
      if (end === -1) throw new Error('unterminated /* comment')
      i = end + 1
    } else if (c === ',') {
      // A trailing comma: only whitespace and comments between it and the closing bracket.
      let j = i + 1
      for (;;) {
        while (j < text.length && /\s/.test(text[j])) j++
        if (text.startsWith('//', j)) { while (j < text.length && text[j] !== '\n' && text[j] !== '\r') j++ }
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
/** The Worker's secrets (wrangler.product.jsonc's required ones), and the names that look like one. */
const SECRET_VARS = new Set(['AUDIT_HASH_KEY', 'AI_GATEWAY_TOKEN'])
const SECRET_LIKE = /(SECRET|TOKEN|PASSWORD|PRIVATE|_KEY)$/i
const GATEWAY_ID = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/
const EVAL_BRAND_REFUSED = "vars.INHOUSE_EVAL_BRAND is set: only the sandbox's eval deployment is an eval brand"

/** Every reason this config may not deploy as a product (empty: it may). */
export function checkConfig(config) {
  return [...forbiddenKeys(config), ...productRules(config), ...sandboxStrings(config)]
}

/** The product rules but the `inhouse-sbx-` one (the candidate in the sandbox is checked against these too). */
function productRules(config) {
  const failures = []
  if (Object.hasOwn(config, 'env')) failures.push('env is set: a deployable config has no env blocks (each could override what this checks)')
  const vars = config.vars ?? {}
  for (const name of ['INHOUSE_TEST_BUILD', 'TEST_ISSUER_JWKS']) {
    if (Object.hasOwn(vars, name)) failures.push(`vars.${name} is set: the test issuer must never be on in a deployable config`)
  }
  if (Object.hasOwn(vars, 'INHOUSE_EVAL_BRAND')) failures.push(EVAL_BRAND_REFUSED)
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
  if (config.ai !== undefined || Object.hasOwn(vars, 'AI_GATEWAY_ID')) {
    if (typeof vars.AI_GATEWAY_ID !== 'string' || !GATEWAY_ID.test(vars.AI_GATEWAY_ID)) {
      failures.push('vars.AI_GATEWAY_ID must name the AI Gateway (lowercase letters, digits and dashes): the egress calls the model through it')
    }
  }
  const tokens = access?.serviceTokens && typeof access.serviceTokens === 'object' ? access.serviceTokens : {}
  for (const service of Object.values(tokens)) {
    if (!['monitor', 'smoke', 'release'].includes(service)) failures.push(`INHOUSE_ACCESS.serviceTokens maps a token to "${String(service)}" (only monitor, smoke or release)`)
  }
  return failures
}

/**
 * P3's runner pool and gateway rules (p3-design sections 7 and 13), apart from INHOUSE_ACCESS so they run on any config.
 * `sandbox`: the sandbox lock caps the container at 2 instances with RUNNER_POOL=2, so there the 3 x RUNNER_POOL rule
 * (placement headroom; nothing in the code reads max_instances) gives way to that cap; every other pool rule holds.
 * `evalMode`: the sandbox's eval deployment, the one config that runs the gateway beside the test issuer, so the
 * test-build gateway rule gives way there (with `sandbox` only: `checkSandboxConfig` in eval mode).
 */
export function checkPool(config, { sandbox = false, evalMode = false } = {}) {
  const failures = []
  const vars = config.vars ?? {}
  const runnerBound = (config.durable_objects?.bindings ?? []).some(b => b?.class_name === 'Runner')
  const containers = Array.isArray(config.containers) ? config.containers : []
  if (runnerBound || containers.length || Object.hasOwn(vars, 'RUNNER_POOL')) {
    const n = /^[1-9][0-9]*$/.test(String(vars.RUNNER_POOL ?? '')) ? Number(vars.RUNNER_POOL) : NaN
    if (!(n >= 2)) failures.push('vars.RUNNER_POOL must be a whole number of 2 or more (the runner pool size)')
    const runners = containers.filter(c => c?.class_name === 'Runner')
    if (runners.length !== 1 || containers.length !== 1) failures.push('containers must be exactly one, for the Runner class')
    else if (!sandbox && n >= 2 && runners[0].max_instances !== 3 * n) {
      failures.push(`the Runner container's max_instances (${String(runners[0].max_instances)}) must be 3 x RUNNER_POOL (${3 * n})`)
    }
  }
  const testBuild = Object.hasOwn(vars, 'INHOUSE_TEST_BUILD') || Object.hasOwn(vars, 'TEST_ISSUER_JWKS')
  const gateway = config.ai !== undefined || Object.keys(vars).some(k => k.startsWith('AI_GATEWAY')) || (config.secrets?.required ?? []).some(k => String(k).startsWith('AI_GATEWAY'))
  if (testBuild && gateway && !(sandbox === true && evalMode === true)) failures.push('a test-build config has an AI binding or a gateway var or secret: tests never reach the gateway')
  return failures
}

/** The connector hub's Worker name (app/wrangler.hub.jsonc), the one entrypoint the product Worker may bind in P4, and its binding name. */
const HUB_SERVICE = 'inhouse-hub'
const HUB_ENTRYPOINT = 'ReadGateway'
const HUB_BINDING = 'HUB'
const HUB_ENTRY_KEYS = new Set(['binding', 'service', 'entrypoint'])

/**
 * P4's service rule (p4-h1.md OC 4), on any product-mode config: `services` is exactly the hub's `ReadGateway` as
 * `HUB`, and nothing else. Every entrypoint of a Worker shares its env, so a binding left out is the only way to keep
 * the runner's route off the hub's server methods; any other service is a door this phase didn't plan.
 */
export function checkHub(config) {
  const failures = []
  if (config.services !== undefined && !Array.isArray(config.services)) return ['services must be a list']
  const services = config.services ?? []
  services.forEach((s, i) => {
    if (s?.entrypoint === 'ServerGateway') {
      failures.push(`services[${i}] binds ServerGateway: in P4 the product Worker binds the hub's ${HUB_ENTRYPOINT} only`)
      return
    }
    if (s?.service !== HUB_SERVICE) {
      failures.push(`services[${i}] binds ${JSON.stringify(s?.service)}: in P4 the product Worker binds the hub (${HUB_BINDING}) only`)
      return
    }
    if (s.binding !== HUB_BINDING) failures.push(`services[${i}] binds ${HUB_SERVICE} as ${JSON.stringify(s.binding)}: its binding is ${HUB_BINDING}`)
    const extra = Object.keys(s).filter(k => !HUB_ENTRY_KEYS.has(k))
    if (extra.length) failures.push(`services[${i}] has ${extra.join(', ')}: the hub entry is binding, service and entrypoint only`)
    if (s.entrypoint === undefined) failures.push(`services[${i}] binds ${HUB_SERVICE} with no entrypoint (its default export): bind ${HUB_ENTRYPOINT}`)
    else if (s.entrypoint !== HUB_ENTRYPOINT) failures.push(`services[${i}].entrypoint must be ${HUB_ENTRYPOINT}, not ${JSON.stringify(s.entrypoint)}`)
  })
  const named = services.filter(s => s?.service === HUB_SERVICE).length
  if (named !== 1) failures.push(`services must name ${HUB_SERVICE} exactly once (found ${named})`)
  return failures
}

const FORBIDDEN = new Set(['__proto__', 'constructor', 'prototype'])
/** Every key at any depth that wrangler's parser would read differently from JSON.parse, or that names a prototype. */
function forbiddenKeys(value, path = 'config') {
  if (!value || typeof value !== 'object') return []
  return Object.keys(value).flatMap(key => {
    const at = Array.isArray(value) ? `${path}[${key}]` : `${path}.${key}`
    if (FORBIDDEN.has(key)) return [`${at} is a forbidden key (wrangler's parser would set a prototype from it, or read it as one)`]
    return forbiddenKeys(value[key], at)
  })
}

/** The product's reverse lock: no string anywhere carries `inhouse-sbx-`. */
function sandboxStrings(value, path = 'config') {
  if (typeof value === 'string') return /inhouse-sbx-/i.test(value) ? [`${path} carries inhouse-sbx- (a sandbox name or host): a product config never does`] : []
  if (!value || typeof value !== 'object') return []
  return Object.keys(value).flatMap(key => sandboxStrings(value[key], Array.isArray(value) ? `${path}[${key}]` : `${path}.${key}`))
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
 * Top-level keys a sandbox config may fill: each is checked below, or is the Worker's own setting and can't reach
 * another Worker's resources or a file outside the build. Every other key must be empty.
 */
const SANDBOX_KEYS = new Set([
  // Checked below.
  'name', 'account_id', 'workers_dev', 'preview_urls', 'vars', 'd1_databases', 'r2_buckets', 'containers', 'durable_objects',
  'migrations', 'routes', 'route', 'build', 'main', 'assets', 'observability', 'rules', 'python_modules',
  // The Worker's own settings.
  '$schema', 'compatibility_date', 'compatibility_flags', 'version_metadata', 'upload_source_maps', 'limits', 'triggers',
  'logpush', 'keep_vars', 'no_bundle', 'minify', 'keep_names', 'preserve_file_names', 'jsx_factory', 'jsx_fragment',
  'send_metrics', 'legacy_env', 'dev',
])
const isEmpty = v => v === undefined || v === null || v === false || v === '' ||
  (Array.isArray(v) ? v.length === 0 : typeof v === 'object' && Object.values(v).every(isEmpty))
const IMAGE_TAG = /^(?::[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}|@sha256:[0-9a-f]{64})$/
const ACCOUNT_ID = /^[0-9a-f]{32}$/
/** The vite plugin's `rules` in its generated wrangler.json, and wrangler's default `python_modules`. */
const VITE_RULES = JSON.stringify([{ type: 'ESModule', globs: ['**/*.js', '**/*.mjs'] }])
const DEFAULT_PYTHON_MODULES = JSON.stringify({ exclude: ['**/*.pyc'] })
const D1_KEYS = new Set(['binding', 'database_name', 'migrations_dir'])
const R2_KEYS = new Set(['binding', 'bucket_name', 'jurisdiction'])
const CONTAINER_KEYS = new Set(['class_name', 'name', 'image', 'max_instances', 'instance_type'])
const DO_KEYS = new Set(['name', 'class_name'])
const MIGRATION_KEYS = new Set(['tag', 'new_classes', 'new_sqlite_classes', 'renamed_classes', 'deleted_classes'])
const OBSERVABILITY_KEYS = new Set(['enabled', 'head_sampling_rate', 'logs', 'traces'])
const OBSERVABILITY_PART_KEYS = new Set(['enabled', 'head_sampling_rate', 'invocation_logs', 'persist'])
/** (P4, P5) Each hub binding a sandbox product Worker may hold, by name, and the hub entrypoint it must name. */
const SANDBOX_HUB_ENTRYPOINTS = { HUB: 'ReadGateway', HUB_CONNECT: 'ConnectGateway', HUB_DELIVERY: 'DeliveryGateway' }
/** (P4, P5) The allowed sets of those bindings, exactly: P4's read binding alone, or P5's three. */
const SANDBOX_HUB_SETS = [['HUB'], ['HUB', 'HUB_CONNECT', 'HUB_DELIVERY']]
/** (eval hub) The eval deployment's one allowed set: its own hub's read binding alone, never P5's connect or delivery. */
const EVAL_HUB_SETS = [['HUB']]
const EVAL_SERVICES_SHAPE = 'services is set: the eval deployment may bind exactly { HUB -> ReadGateway } to its own hub, entry { binding, service, entrypoint } and nothing else (no P5 bindings)'
const SERVICES_SHAPE = 'services is set: a sandbox config may not use it, but for exactly { HUB -> ReadGateway } or { HUB -> ReadGateway, HUB_CONNECT -> ConnectGateway, HUB_DELIVERY -> DeliveryGateway }, each entry { binding, service: <its own hub>, entrypoint } and nothing else'
/** (P4) The keys a sandbox hub config may give a value (a subset of SANDBOX_KEYS). */
const HUB_KEYS = new Set([
  'name', 'account_id', 'workers_dev', 'preview_urls', 'vars', 'durable_objects', 'migrations', 'main', 'observability',
  'rules', 'python_modules', '$schema', 'compatibility_date', 'compatibility_flags', 'no_bundle', 'limits', 'send_metrics',
])
/** (P4) The candidate hub's vars: the store's shop and client id, both empty (no store in the sandbox account). */
const CANDIDATE_HUB_VARS = new Set(['SHOPIFY_SHOP', 'SHOPIFY_CLIENT_ID'])

/** A relative path that stays inside its folder: no `..` segment, not absolute, no backslash or NUL. */
const isInsidePath = p => typeof p === 'string' && p !== '' && !isAbsolute(p) && !/^[A-Za-z]:/.test(p) &&
  !/[\\\0]/.test(p) && !p.split('/').includes('..')

/**
 * Every reason this config may not deploy to the sandbox (empty: it may). `accountId` and `zone` are the sandbox's own
 * (CF_SANDBOX_ACCOUNT_ID, SBX_ZONE); `mode` is `{ perPr: N }`, `{ candidate: true }` or `{ eval: true }`, from the
 * caller, with `hub: true` for the connector hub's config (P4); `configDir` is
 * the folder the config file sits in (wrangler resolves an image path against it). A bad argument throws, since no
 * config could pass against it.
 */
export function checkSandboxConfig(config, { accountId, zone, mode, configDir }) {
  if (typeof accountId !== 'string' || !ACCOUNT_ID.test(accountId)) throw new SandboxNameError('CF_SANDBOX_ACCOUNT_ID must be 32 lowercase hex')
  assertZone(zone)
  const perPr = mode?.perPr !== undefined
  const evalMode = mode?.eval === true
  if ([perPr, mode?.candidate === true, evalMode].filter(Boolean).length !== 1) throw new SandboxNameError('give exactly one mode: { perPr: N }, { candidate: true } or { eval: true }')
  if (perPr) assertPrNumber(mode.perPr)
  if (mode.hub !== undefined && mode.hub !== true) throw new SandboxNameError('mode.hub must be true or left out')
  const hub = mode.hub === true
  if (typeof configDir !== 'string' || !isAbsolute(configDir)) throw new SandboxNameError('configDir must be an absolute folder')
  // Per-PR and eval bind exact names; the candidate any shared sandbox name.
  const names = perPr ? perPrNames(mode.perPr) : evalMode ? evalNames() : null
  const whose = perPr ? `PR ${mode.perPr}'s` : 'the eval deployment\'s'
  const failures = [...forbiddenKeys(config)]
  const fail = msg => failures.push(msg)
  /** A name this mode allows for `kind` (one of perPrNames' keys). */
  const nameOk = (where, v, kind) => {
    if (names) {
      if (v !== names[kind]) fail(`${where}: ${JSON.stringify(v)} is not ${whose} ${kind} name (${names[kind]})`)
      return
    }
    try { assertCandidateName(v) } catch (err) {
      if (!(err instanceof SandboxNameError)) throw err
      return fail(`${where}: ${err.message}`)
    }
    if (kind === 'hub' && v !== CANDIDATE_HUB) fail(`${where}: ${JSON.stringify(v)} is not the candidate hub's name (${CANDIDATE_HUB})`)
  }
  const hostOk = (where, host) => {
    if (names) {
      if (host !== `${names.brand}.${zone}` && host !== `${names.team}.${zone}`) fail(`${where}: host ${JSON.stringify(host)} is not ${whose} brand or team host on the sandbox zone`)
      return
    }
    try { assertSandboxHost(host, zone, 'candidate') } catch (err) {
      if (!(err instanceof SandboxNameError)) throw err
      fail(`${where}: ${err.message}`)
    }
  }
  const list = key => {
    const v = config[key]
    if (v === undefined) return []
    if (Array.isArray(v)) return v
    fail(`${key} must be a list`)
    return []
  }
  const onlyKeys = (where, value, allowed) => {
    if (value === undefined) return
    if (!value || typeof value !== 'object' || Array.isArray(value)) return fail(`${where} must be an object`)
    for (const k of Object.keys(value)) if (!allowed.has(k) && !FORBIDDEN.has(k)) fail(`${where}.${k} is set: a sandbox config may not use it`)
  }

  for (const [key, value] of Object.entries(config)) {
    if (key === 'env' || key === 'ai' || key === 'services' || FORBIDDEN.has(key)) continue // each has its own rule
    if (!SANDBOX_KEYS.has(key) && !isEmpty(value)) fail(`${key} is set: a sandbox config may not use it (it could reach resources or files outside the sandbox)`)
    else if (hub && !HUB_KEYS.has(key) && !isEmpty(value)) fail(`${key} is set: a sandbox hub config may not use it (the hub has no route, assets or storage but its own Durable Objects)`)
  }
  if (Object.hasOwn(config, 'env')) fail('env is set: a deployable config has no env blocks (each could override what this checks)')
  nameOk('name', config.name, hub ? 'hub' : 'worker')
  if (!perPr && !hub && config.name === CANDIDATE_HUB) fail(`name: the candidate product may not take the hub's name (${CANDIDATE_HUB})`)
  // (P4, P5) services: nothing for the hub; for the product, nothing, HUB -> ReadGateway alone, or HUB -> ReadGateway,
  // HUB_CONNECT -> ConnectGateway and HUB_DELIVERY -> DeliveryGateway together, each naming its own hub (the eval
  // deployment: nothing or HUB -> ReadGateway alone).
  const services = list('services')
  if (hub) {
    if (!isEmpty(services)) fail('services is set: a sandbox hub config binds no other Worker')
  } else if (!isEmpty(services)) {
    // Each entry exactly { binding, service, entrypoint } with its binding's entrypoint, and the bindings exactly one
    // allowed set (sorted, so order doesn't matter and a binding given twice can't stand in for another).
    const entryOk = s => !!s && typeof s === 'object' && !Array.isArray(s) && Object.keys(s).length === 3 &&
      Object.hasOwn(s, 'service') && Object.hasOwn(SANDBOX_HUB_ENTRYPOINTS, s.binding) && s.entrypoint === SANDBOX_HUB_ENTRYPOINTS[s.binding]
    const bindings = JSON.stringify(services.map(s => s?.binding).sort())
    const shaped = services.every(entryOk) && (evalMode ? EVAL_HUB_SETS : SANDBOX_HUB_SETS).some(set => JSON.stringify([...set].sort()) === bindings)
    if (!shaped) fail(evalMode ? EVAL_SERVICES_SHAPE : SERVICES_SHAPE)
    else {
      services.forEach((s, i) => {
        const before = failures.length
        nameOk(`services[${i}].service`, s.service, 'hub')
        if (failures.length === before && s.service === config.name) fail(`services[${i}].service: the hub may not be the product's own name (${JSON.stringify(s.service)})`)
      })
    }
  }
  if (hub) {
    if (config.main === undefined) fail('main must be set in a sandbox hub config (the bundle\'s entry, inside the build folder)')
    if (config.no_bundle !== true) fail('no_bundle must be true in a sandbox hub config (the bundle that was built deploys as it is)')
  }
  if (config.account_id !== accountId) fail('account_id is missing or is not the sandbox account (CF_SANDBOX_ACCOUNT_ID)')
  if (evalMode && !hub) {
    // The eval deployment runs the real model: exactly one AI binding, by name, and the gateway it calls.
    onlyKeys('ai', config.ai, new Set(['binding']))
    if (typeof config.ai?.binding !== 'string' || !config.ai.binding) fail('ai.binding must name the AI binding: the eval deployment runs the real model through the gateway')
    const gatewayId = config.vars?.AI_GATEWAY_ID
    if (typeof gatewayId !== 'string' || !GATEWAY_ID.test(gatewayId)) fail('vars.AI_GATEWAY_ID must name the AI Gateway (lowercase letters, digits and dashes): the egress calls the model through it')
  } else if (config.ai !== undefined && config.ai !== null) fail('ai is set: the sandbox runs the scripted model only (no AI binding, no spend)')
  if (config.workers_dev !== false) fail('workers_dev must be false (left out, wrangler turns it on)')
  if (config.preview_urls !== false) fail('preview_urls must be false (left out, wrangler turns it on)')
  if (config.main !== undefined && !isInsidePath(config.main)) fail('main must be a relative path inside the build folder (no .., not absolute)')
  onlyKeys('build', config.build, new Set(['watch_dir']))
  if (config.assets !== undefined) {
    onlyKeys('assets', config.assets, new Set(['binding', 'directory', 'not_found_handling', 'html_handling', 'run_worker_first']))
    if (config.assets?.directory !== undefined && config.assets.directory !== '../client') fail('assets.directory must be ../client (the vite plugin\'s client folder)')
  }
  if (config.rules !== undefined && !isEmpty(config.rules) && JSON.stringify(config.rules) !== VITE_RULES) fail('rules may only be the vite plugin\'s ESModule rule')
  if (config.python_modules !== undefined && JSON.stringify(config.python_modules) !== DEFAULT_PYTHON_MODULES) fail('python_modules may only be wrangler\'s default')
  if (config.observability !== undefined) {
    onlyKeys('observability', config.observability, OBSERVABILITY_KEYS)
    for (const part of ['logs', 'traces']) onlyKeys(`observability.${part}`, config.observability?.[part], OBSERVABILITY_PART_KEYS)
  }

  const d1 = list('d1_databases')
  if (d1.length > 1) fail('d1_databases has more than one database')
  d1.forEach((d, i) => {
    onlyKeys(`d1_databases[${i}]`, d, D1_KEYS)
    nameOk(`d1_databases[${i}].database_name`, d?.database_name, 'd1')
    if (d?.migrations_dir !== undefined && !isInsidePath(d.migrations_dir)) fail(`d1_databases[${i}].migrations_dir must be a relative path inside the build folder (no .., not absolute)`)
  })
  const r2 = list('r2_buckets')
  if (r2.length > 1) fail('r2_buckets has more than one bucket')
  r2.forEach((b, i) => {
    onlyKeys(`r2_buckets[${i}]`, b, R2_KEYS)
    nameOk(`r2_buckets[${i}].bucket_name`, b?.bucket_name, 'r2')
  })
  const registry = `registry.cloudflare.com/${accountId}/`
  const containers = list('containers')
  if (containers.length > 1) fail('containers has more than one container')
  containers.forEach((c, i) => {
    const where = `containers[${i}]`
    onlyKeys(where, c, CONTAINER_KEYS)
    if (c?.name === undefined) fail(`${where} has no name (wrangler would make one from the Worker and class names)`)
    else nameOk(`${where}.name`, c.name, 'container')
    if (!Number.isInteger(c?.max_instances) || c.max_instances < 1 || c.max_instances > 2) {
      fail(`${where}.max_instances must be 1 or 2 (left out, wrangler's default is 20)`)
    }
    const image = typeof c?.image === 'string' ? c.image : ''
    const repo = image.startsWith(registry) ? /^[^:@]*/.exec(image.slice(registry.length))[0] : null
    if (repo === null || !IMAGE_TAG.test(image.slice(registry.length + repo.length))) {
      fail(`${where}.image must be registry.cloudflare.com/<CF_SANDBOX_ACCOUNT_ID>/<name>:<tag> (a pushed image, not a Dockerfile)`)
    } else {
      nameOk(`${where}.image`, repo, 'image')
      // wrangler builds any `image` that exists as a path relative to the config's folder (isDockerfile, 4.162.0).
      if (existsSync(resolve(configDir, image))) fail(`${where}.image exists as a file beside the config: wrangler would build it`)
    }
  })
  const dos = config.durable_objects
  if (dos !== undefined) {
    onlyKeys('durable_objects', dos, new Set(['bindings']))
    const bindings = dos?.bindings
    if (bindings !== undefined && !Array.isArray(bindings)) fail('durable_objects.bindings must be a list')
    ;(Array.isArray(bindings) ? bindings : []).forEach((d, i) => onlyKeys(`durable_objects.bindings[${i}]`, d, DO_KEYS))
  }
  list('migrations').forEach((m, i) => {
    const where = `migrations[${i}]`
    onlyKeys(where, m, MIGRATION_KEYS)
    const isNames = v => Array.isArray(v) && v.every(x => typeof x === 'string')
    for (const k of ['new_classes', 'new_sqlite_classes', 'deleted_classes']) {
      if (m?.[k] !== undefined && !isNames(m[k])) fail(`${where}.${k} must be a list of class names`)
    }
    if (m?.renamed_classes !== undefined) {
      const ok = Array.isArray(m.renamed_classes) && m.renamed_classes.every(r => r && typeof r === 'object' && !Array.isArray(r) &&
        Object.keys(r).length === 2 && typeof r.from === 'string' && typeof r.to === 'string')
      if (!ok) fail(`${where}.renamed_classes items must be exactly { from, to } (class names in this Worker)`)
    }
  })
  for (const [where, r] of routesOf(config)) {
    const route = typeof r === 'string' ? { pattern: r } : r
    if (typeof route?.pattern !== 'string') {
      fail(`${where} has no pattern`)
      continue
    }
    onlyKeys(where, route, new Set(['pattern', 'custom_domain', 'zone_name', 'zone_id']))
    if (route.zone_id !== undefined) fail(`${where}.zone_id is set: name the sandbox zone with zone_name`)
    if (route.zone_name !== undefined && route.zone_name !== zone) fail(`${where}.zone_name is not the sandbox zone`)
    // A Custom Domain's pattern is the bare host; a route's may add a path.
    const slash = route.pattern.indexOf('/')
    const host = route.custom_domain === true || slash === -1 ? route.pattern : route.pattern.slice(0, slash)
    hostOk(`${where}.pattern`, host)
  }
  for (const [where, origin] of accessOrigins(config)) {
    let url
    try { url = new URL(origin) } catch { url = null }
    if (!url || url.protocol !== 'https:' || url.origin !== origin) fail(`${where} must be a bare https:// origin`)
    else hostOk(where, url.hostname)
  }

  if (perPr) {
    if (config.vars?.INHOUSE_TEST_BUILD !== '1') fail('vars.INHOUSE_TEST_BUILD must be "1" in a per-PR test deployment')
    if (!hub && accessOrigins(config).length === 0) fail('vars.INHOUSE_ACCESS must list the per-PR hosts as its app origins')
    if (Object.hasOwn(config.vars ?? {}, 'INHOUSE_EVAL_BRAND')) fail(EVAL_BRAND_REFUSED)
  } else if (hub) {
    // vars set but not a plain object (a list, a string, null) is refused, so nothing hides behind a shape this loop skips.
    const plain = config.vars !== null && typeof config.vars === 'object' && !Array.isArray(config.vars)
    // The candidate's and the eval deployment's hubs alike: main's hub config, the store vars empty.
    const which = evalMode ? 'eval' : 'candidate'
    if (config.vars !== undefined && !plain) fail(`vars must be a plain object in the ${which} hub config`)
    const vars = plain ? config.vars : {}
    for (const [k, v] of Object.entries(vars)) {
      if (!CANDIDATE_HUB_VARS.has(k)) fail(`vars.${k} is set: the ${which} hub's vars are SHOPIFY_SHOP and SHOPIFY_CLIENT_ID only (no test switch, no secret)`)
      else if (v !== '') fail(`vars.${k} must be empty: no store credential in the sandbox account`)
    }
  } else if (evalMode) {
    if (config.vars?.INHOUSE_TEST_BUILD !== '1') fail('vars.INHOUSE_TEST_BUILD must be "1" in the eval deployment (the harness signs in through the test issuer)')
    if (config.vars?.INHOUSE_EVAL_BRAND !== '1') fail('vars.INHOUSE_EVAL_BRAND must be "1" in the eval deployment (the eval brand marker)')
    // No secret in plain vars (#240 review M1): the product rule, with no exception (eval holds the real gateway token).
    for (const name of Object.keys(config.vars ?? {})) {
      if (SECRET_VARS.has(name) || SECRET_LIKE.test(name)) fail(`vars.${name} looks like a secret: set secrets with wrangler secret put, never in the config`)
      else if (name.startsWith('AI_GATEWAY') && name !== 'AI_GATEWAY_ID') fail(`vars.${name} is set: of the gateway's settings only AI_GATEWAY_ID is a var`)
    }
    if (!isPublicJwks(config.vars?.TEST_ISSUER_JWKS)) fail('vars.TEST_ISSUER_JWKS must be a JWKS of one public key (the test issuer\'s public half; the private half never leaves the ops repo)')
    if (accessOrigins(config).length === 0) fail('vars.INHOUSE_ACCESS must list the eval hosts as its app origins')
    // The eval build's version signal, like the test build's, reads green without version metadata (the test issuer is
    // compiled in), so its deployment must carry the binding to report which version answers.
    const vm = config.version_metadata
    if (typeof vm?.binding !== 'string' || !vm.binding) fail('version_metadata needs a binding name in the eval deployment (its version signal would read green without one)')
  } else {
    for (const f of productRules(config)) if (!failures.includes(f)) fail(f)
  }
  // P3's pool and gateway rules hold in the sandbox too, the container cap of 2 standing in for 3 x RUNNER_POOL (and in
  // eval mode, the gateway beside the test issuer allowed).
  for (const f of checkPool(config, { sandbox: true, evalMode: evalMode && !hub })) if (!failures.includes(f)) fail(f)
  return failures
}

/** JWK members that only a private key carries (RFC 7518: EC and OKP `d`, RSA's primes and CRT values, oct `k`). */
const PRIVATE_JWK_MEMBERS = ['d', 'p', 'q', 'dp', 'dq', 'qi', 'oth', 'k']
/** A JSON string holding `{ keys: [<one public JWK>] }`. */
function isPublicJwks(text) {
  if (typeof text !== 'string') return false
  let jwks
  try { jwks = JSON.parse(text) } catch { return false }
  const keys = jwks?.keys
  if (!Array.isArray(keys) || keys.length !== 1) return false
  const key = keys[0]
  return !!key && typeof key === 'object' && !Array.isArray(key) && typeof key.kty === 'string' && !PRIVATE_JWK_MEMBERS.some(m => Object.hasOwn(key, m))
}

/** A sandbox config: plain JSON only (no comments), a JSON object. Throws a message for a usage error otherwise. */
export function readSandboxConfig(path) {
  let text
  try { text = readFileSync(path, 'utf8') } catch { throw new Error(`can't read ${path}`) }
  let config
  try { config = JSON.parse(text) } catch (err) { throw new Error(`${path} isn't plain JSON (sandbox configs have no comments): ${err.message}`) }
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error(`${path} isn't a config object`)
  return config
}

/** The sandbox mode from the command line's flags (after --sandbox), or throws a usage message. */
export function parseSandboxMode(args) {
  let parsed
  if (args[0] === '--candidate') parsed = { mode: { candidate: true }, rest: args.slice(1) }
  else if (args[0] === '--eval') parsed = { mode: { eval: true }, rest: args.slice(1) }
  else if (args[0] === '--per-pr' && /^[1-9][0-9]{0,5}$/.test(args[1] ?? '')) parsed = { mode: { perPr: Number(args[1]) }, rest: args.slice(2) }
  else throw new Error('--sandbox needs --per-pr <N> (1 to 999999), --candidate or --eval, then --hub for the hub\'s config')
  // (P4) --hub right after the mode: the connector hub's config.
  if (parsed.rest[0] === '--hub') {
    return { mode: { ...parsed.mode, hub: true }, rest: parsed.rest.slice(1) }
  }
  return parsed
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    let args = process.argv.slice(2)
    const sandbox = args[0] === '--sandbox'
    let mode
    if (sandbox) {
      try { ({ mode, rest: args } = parseSandboxMode(args.slice(1))) } catch (err) { usage(err.message) }
    }
    if (args.length !== 1 || args[0].startsWith('--')) usage('give exactly one config path')
    let sandboxEnv
    if (sandbox) {
      sandboxEnv = { accountId: process.env.CF_SANDBOX_ACCOUNT_ID, zone: process.env.SBX_ZONE, mode, configDir: dirname(resolve(args[0])) }
      if (!sandboxEnv.accountId || !ACCOUNT_ID.test(sandboxEnv.accountId)) usage('--sandbox needs CF_SANDBOX_ACCOUNT_ID (32 lowercase hex)')
      try { assertZone(sandboxEnv.zone) } catch { usage('--sandbox needs SBX_ZONE (a lowercase domain name)') }
    }
    let config
    if (sandbox) {
      try { config = readSandboxConfig(args[0]) } catch (err) { usage(err.message) }
    } else {
      let text
      try { text = readFileSync(args[0], 'utf8') } catch { usage(`can't read ${args[0]}`) }
      try { config = JSON.parse(stripJsonc(text)) } catch (err) { usage(`${args[0]} isn't valid JSONC: ${err.message}`) }
      if (!config || typeof config !== 'object' || Array.isArray(config)) usage(`${args[0]} isn't a config object`)
    }
    // Product mode adds P3's pool and gateway rules and P4's hub binding rule; sandbox mode runs the pool rules inside
    // checkSandboxConfig (a sandbox config holds no service binding at all).
    const failures = sandbox ? checkSandboxConfig(config, sandboxEnv) : [...checkConfig(config), ...checkPool(config), ...checkHub(config)]
    const where = sandbox ? ` to the sandbox (${mode.candidate ? 'candidate' : mode.eval ? 'eval' : `PR ${mode.perPr}`}${mode.hub ? ' hub' : ''})` : ''
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
