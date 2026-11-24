// The hub config check (P4, hub PR0). Run in app/: node scripts/check-hub-config.mjs <config path>
// The connector hub answers service bindings only, holds its secrets as Worker secrets and never ships its test seam.
// Exit 1, listing every failure, when the config (JSONC):
//   - sets `routes`, `route` or a custom domain (a `routes` entry with `custom_domain`), or doesn't set `workers_dev`
//     and `preview_urls` explicitly to false (workers_dev defaults to true without a route; an omitted preview_urls
//     keeps whatever the deployed Worker had), or sets `triggers`;
//   - defines `__INHOUSE_HUB_TEST__` as anything but "false", or sets INHOUSE_TEST_BUILD (the test build's switch);
//   - serves another public surface: `assets` or `site` (static files on the Worker's URL);
//   - has an `env` key at all (routes, workers_dev and triggers inherit into env blocks, and an env block can
//     override every rule here, so the hub has one environment: this file);
//   - puts HUB_TOKEN_KEYS, SHOPIFY_CLIENT_SECRET or SLACK_CLIENT_SECRET under `vars`, or in any `define` key
//     (`process.env.HUB_TOKEN_KEYS` too: they're Worker secrets, set through secret cards), or doesn't list the first
//     two in `secrets.required` (SLACK_CLIENT_SECRET is optional: a dynamic-registration connector has none, OC-W1-9);
//   - sets a `vars` name outside the known list (the connector settings: Shopify's two, Slack's three and
//     CONNECT_REDIRECT_URI; P5 W1);
//   - sets `alias`, `no_bundle` or `build` (each swaps a module or skips the esbuild bundle the bundle scan reads);
//   - lacks the SIGNIN binding to the hub's own SignIn class, or the migration that creates SignIn on SQLite;
//   - has a `main` other than hub/index/index.ts;
//   - sets `worker_loaders` as anything but exactly one entry `{ "binding": "LOADER" }` (P5 W2's code mode; absent is
//     allowed: code mode then has no loader).
// Not checked: `compatibility_flags` (allowed; a flag changes runtime behaviour, not the route, secret or bundle rules).
// It passes on wrangler.hub.jsonc and must FAIL on wrangler.hub.test.jsonc (CI asserts both). No dependencies: the
// hub's CI job doesn't install app/. scripts/check-hub-config.test.mjs runs it on one fixture per rule
// (scripts/check-hub-config-fixtures/).
import { readFileSync, realpathSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const usage = () => {
  console.error('usage: node scripts/check-hub-config.mjs <wrangler config path>')
  process.exit(2)
}

/** JSONC to JSON: drops // and /* *\/ comments and trailing commas, leaving strings untouched. */
export function stripJsonc(text) {
  let out = ''
  let i = 0
  while (i < text.length) {
    const c = text[i]
    if (c === '"') {
      let j = i + 1
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1
      out += text.slice(i, j + 1)
      i = j + 1
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2)
      if (end === -1) throw new Error('unterminated block comment')
      i = end + 2
    } else {
      out += c
      i++
    }
  }
  // A comma followed only by whitespace before } or ] (comments are gone by now; strings can't hold a raw newline,
  // but can hold ",}" so this runs on a string-free view).
  return removeTrailingCommas(out)
}

function removeTrailingCommas(json) {
  let out = ''
  let i = 0
  while (i < json.length) {
    const c = json[i]
    if (c === '"') {
      let j = i + 1
      while (j < json.length && json[j] !== '"') j += json[j] === '\\' ? 2 : 1
      out += json.slice(i, j + 1)
      i = j + 1
    } else if (c === ',') {
      let j = i + 1
      while (j < json.length && /\s/.test(json[j])) j++
      if (json[j] !== '}' && json[j] !== ']') out += c
      i++
    } else {
      out += c
      i++
    }
  }
  return out
}

const has = (obj, key) => obj !== null && typeof obj === 'object' && Object.hasOwn(obj, key)
const SECRET_NAMES = ['HUB_TOKEN_KEYS', 'SHOPIFY_CLIENT_SECRET']
/** A Worker secret that may be absent: refused in `vars` and `define`, but not listed as required. */
const OPTIONAL_SECRET_NAMES = ['SLACK_CLIENT_SECRET']
/** The only `vars` a deployable config may set (the ops repo fills them per deployment). */
const KNOWN_VARS = ['SHOPIFY_SHOP', 'SHOPIFY_CLIENT_ID', 'SLACK_CLIENT_ID', 'SLACK_TEAM_ID', 'SLACK_PRIVATE_SEARCH', 'CONNECT_REDIRECT_URI',
  // P5 W4: the product origin Slack notices link to.
  'APP_ORIGIN']
const PUBLIC_SURFACES = ['assets', 'site']
const BUNDLER_SWAPS = ['alias', 'no_bundle', 'build']

/** Every rule the config breaks, as `<rule>: <why>` lines. Empty means it passes. */
export function checkHubConfig(config) {
  const failures = []
  const fail = (rule, why) => failures.push(`${rule}: ${why}`)

  if (has(config, 'routes')) fail('routes', '`routes` is set; the hub has no public route')
  if (has(config, 'route')) fail('route', '`route` is set; the hub has no public route')
  const routeEntries = [config.route, ...(Array.isArray(config.routes) ? config.routes : [])]
  if (routeEntries.some(r => has(r, 'custom_domain'))) fail('custom-domain', 'a custom domain is set; the hub has no public route')
  if (config.workers_dev !== false) fail('workers-dev', '`workers_dev` must be explicitly false (it defaults to true without a route)')
  if (config.preview_urls !== false) fail('preview-urls', '`preview_urls` must be explicitly false (omitted keeps an existing setting)')
  if (has(config, 'triggers')) fail('triggers', '`triggers` is set; the hub has no cron or other trigger')
  for (const key of PUBLIC_SURFACES) {
    if (has(config, key)) fail('public-surface', `\`${key}\` is set; the hub serves nothing on a URL`)
  }
  for (const key of BUNDLER_SWAPS) {
    if (has(config, key)) fail('bundler', `\`${key}\` is set; it swaps a module or skips the bundle the scan reads`)
  }
  if (has(config, 'env')) fail('env', '`env` is set; env blocks inherit routes and triggers and can override every rule here')

  const define = has(config, 'define') && config.define && typeof config.define === 'object' ? config.define : {}
  if (define?.__INHOUSE_HUB_TEST__ !== 'false') {
    fail('test-define', '`define.__INHOUSE_HUB_TEST__` must be "false" (the test seam is only in the test build)')
  }
  const vars = has(config, 'vars') && config.vars && typeof config.vars === 'object' ? config.vars : {}
  if (has(vars, 'INHOUSE_TEST_BUILD')) fail('test-build-var', '`vars.INHOUSE_TEST_BUILD` is set; it turns on the test build')
  for (const name of [...SECRET_NAMES, ...OPTIONAL_SECRET_NAMES]) {
    if (has(vars, name)) fail('secret-in-vars', `\`vars.${name}\` is set; it's a Worker secret, set through a secret card`)
  }
  const known = [...KNOWN_VARS, ...SECRET_NAMES, ...OPTIONAL_SECRET_NAMES, 'INHOUSE_TEST_BUILD']
  for (const name of Object.keys(vars).filter(k => !known.includes(k))) {
    fail('unknown-var', `\`vars.${name}\` isn't a known hub setting (add it to KNOWN_VARS in this script when a connector needs it)`)
  }
  for (const key of Object.keys(define).filter(k => [...SECRET_NAMES, ...OPTIONAL_SECRET_NAMES].some(name => k.includes(name)))) {
    fail('secret-in-define', `\`define["${key}"]\` is set; it names a Worker secret, set through a secret card`)
  }
  const required = Array.isArray(config.secrets?.required) ? config.secrets.required : []
  const missing = SECRET_NAMES.filter(name => !required.includes(name))
  if (missing.length) fail('secrets-required', `\`secrets.required\` doesn't list ${missing.join(' and ')}`)

  const bindings = Array.isArray(config.durable_objects?.bindings) ? config.durable_objects.bindings : []
  if (!bindings.some(b => b?.name === 'SIGNIN' && b?.class_name === 'SignIn' && !has(b, 'script_name'))) {
    fail('signin-binding', 'no `durable_objects.bindings` entry { name: "SIGNIN", class_name: "SignIn" } on this Worker')
  }
  const migrations = Array.isArray(config.migrations) ? config.migrations : []
  if (!migrations.some(m => Array.isArray(m?.new_sqlite_classes) && m.new_sqlite_classes.includes('SignIn'))) {
    fail('signin-migration', 'no migration with `new_sqlite_classes` containing "SignIn"')
  }
  if (config.main !== 'hub/index/index.ts') fail('main', '`main` must be "hub/index/index.ts"')
  if (has(config, 'worker_loaders')) {
    const loaders = config.worker_loaders
    const one = Array.isArray(loaders) && loaders.length === 1 ? loaders[0] : null
    const exact = one !== null && typeof one === 'object' && !Array.isArray(one) && Object.keys(one).length === 1 && one.binding === 'LOADER'
    if (!exact) fail('worker-loaders', '`worker_loaders` must be exactly [{ "binding": "LOADER" }] (code mode\'s one loader)')
  }
  return failures
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const path = process.argv[2]
  if (!path || process.argv.length > 3) usage()
  let config
  try {
    config = JSON.parse(stripJsonc(readFileSync(path, 'utf8')))
  } catch (e) {
    console.error(`check-hub-config: can't read ${path} as JSONC: ${e.message}`)
    process.exit(2)
  }
  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    console.error(`check-hub-config: ${path} isn't a JSON object`)
    process.exit(2)
  }
  const failures = checkHubConfig(config)
  if (failures.length) {
    console.error(`FAIL  ${path}: ${failures.length} problem${failures.length === 1 ? '' : 's'}`)
    for (const f of failures) console.error(`    ${f}`)
    process.exit(1)
  }
  console.log(`ok    ${path}: no route or other public surface, no env block, no test build, secrets required and not in the file, SignIn bound and migrated.`)
}
