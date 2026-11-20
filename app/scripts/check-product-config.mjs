// The deployable config check (P2 W1, p2-design section 2). Run in app/:
//   node scripts/check-product-config.mjs <wrangler config path (JSONC)>
// Exit 0: the config may deploy. Exit 1: it may not, with every failure listed. Exit 2: usage, an unreadable file or a
// crash. CI requires exactly 1 on wrangler.test.jsonc (AGENTS.md). It refuses a config when:
//   - it has an `env` block at all (each `env.<name>` can override vars, workers_dev and preview_urls, so none may
//     deploy unchecked: the product config is one environment);
//   - the test issuer is switched on: `INHOUSE_TEST_BUILD` or `TEST_ISSUER_JWKS` in `vars`;
//   - a var is a Worker secret (`AUDIT_HASH_KEY`, the only one the server reads) or has a secret-like name (ends in
//     SECRET, TOKEN, PASSWORD, PRIVATE or _KEY, any case): secrets are set with `wrangler secret put`, never in the config;
//   - INHOUSE_ACCESS is missing or not JSON, or its `teamDomain` isn't `https://<name>.cloudflareaccess.com`;
//   - INHOUSE_ACCESS.apps isn't exactly one `brand` app and one `inhouse` app;
//   - an app lacks `origin` or `aud`, an origin isn't a bare `https://` origin, two apps share a hostname (an origin,
//     or a port-only difference: Access's cookie is per hostname) or an `aud`,
//     or an `aud` isn't 64 hex;
//   - a service token maps to anything but `monitor` or `smoke`;
//   - a brand origin is on `workers.dev` (preview URLs live there too: `<version>-<worker>.<subdomain>.workers.dev`);
//   - `workers_dev` or `preview_urls` isn't explicitly false (wrangler turns both on when they're left out).
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const usage = msg => {
  console.error(`check-product-config: ${msg}\nusage: node scripts/check-product-config.mjs <wrangler config path>`)
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

/** Every reason this config may not deploy (empty: it may). */
export function checkConfig(config) {
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = process.argv.slice(2)
    if (args.length !== 1) usage('give exactly one config path')
    let text
    try { text = readFileSync(args[0], 'utf8') } catch { usage(`can't read ${args[0]}`) }
    let config
    try { config = JSON.parse(stripJsonc(text)) } catch (err) { usage(`${args[0]} isn't valid JSONC: ${err.message}`) }
    const failures = checkConfig(config)
    if (failures.length) {
      console.error(`check-product-config: ${args[0]} may not deploy:\n${failures.map(f => `  - ${f}`).join('\n')}`)
      process.exit(1)
    }
    console.log(`check-product-config: ${args[0]} may deploy.`)
  } catch (err) {
    console.error(`check-product-config: crashed: ${err?.stack ?? err}`)
    process.exit(2)
  }
}
