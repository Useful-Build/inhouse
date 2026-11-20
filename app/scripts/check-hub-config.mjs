// The hub config check (P4, hub PR0). Run in app/: node scripts/check-hub-config.mjs <config path>
// The connector hub answers service bindings only, holds its secrets as Worker secrets and never ships its test seam.
// Exit 1, listing every failure, when the config (JSONC):
//   - sets `routes`, `route` or a custom domain (a `routes` entry with `custom_domain`), or doesn't set `workers_dev`
//     and `preview_urls` explicitly to false (workers_dev defaults to true without a route; an omitted preview_urls
//     keeps whatever the deployed Worker had), or sets `triggers`;
//   - defines `__INHOUSE_HUB_TEST__` as anything but "false", or sets INHOUSE_TEST_BUILD (the test build's switch);
//   - puts HUB_TOKEN_KEYS or SHOPIFY_CLIENT_SECRET under `vars` (they're Worker secrets, set through secret cards);
//   - lacks the SIGNIN binding to the hub's own SignIn class, or the migration that creates SignIn on SQLite;
//   - has a `main` other than hub/index/index.ts.
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

  const define = has(config, 'define') ? config.define : {}
  if (define?.__INHOUSE_HUB_TEST__ !== 'false') {
    fail('test-define', '`define.__INHOUSE_HUB_TEST__` must be "false" (the test seam is only in the test build)')
  }
  const vars = has(config, 'vars') && config.vars && typeof config.vars === 'object' ? config.vars : {}
  if (has(vars, 'INHOUSE_TEST_BUILD')) fail('test-build-var', '`vars.INHOUSE_TEST_BUILD` is set; it turns on the test build')
  for (const name of SECRET_NAMES) {
    if (has(vars, name)) fail('secret-in-vars', `\`vars.${name}\` is set; it's a Worker secret, set through a secret card`)
  }

  const bindings = Array.isArray(config.durable_objects?.bindings) ? config.durable_objects.bindings : []
  if (!bindings.some(b => b?.name === 'SIGNIN' && b?.class_name === 'SignIn' && !has(b, 'script_name'))) {
    fail('signin-binding', 'no `durable_objects.bindings` entry { name: "SIGNIN", class_name: "SignIn" } on this Worker')
  }
  const migrations = Array.isArray(config.migrations) ? config.migrations : []
  if (!migrations.some(m => Array.isArray(m?.new_sqlite_classes) && m.new_sqlite_classes.includes('SignIn'))) {
    fail('signin-migration', 'no migration with `new_sqlite_classes` containing "SignIn"')
  }
  if (config.main !== 'hub/index/index.ts') fail('main', '`main` must be "hub/index/index.ts"')
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
  console.log(`ok    ${path}: no route, no test build, secrets not in vars, SignIn bound and migrated.`)
}
