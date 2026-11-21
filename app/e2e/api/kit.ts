// What the API specs share: who can sign in (the seed's people, the two service tokens, fresh identities), a request
// helper that sets what Access and a browser would, the route and matrix rows read from the Worker's own source, and
// the answers the specs check. The specs run against the test build (`wrangler dev`, a local D1 seeded by W2's seed).
import { readFileSync } from 'node:fs'
import { expect } from '@playwright/test'
import type { APIRequestContext } from '@playwright/test'
import type { JWK } from 'jose'
import { mintPerson, mintService } from '../../server/auth/test-issuer-mint.ts'
import type { MintOptions } from '../../server/auth/test-issuer-mint.ts'
import { EXACT_ROWS } from '../../shared/contract/settings-table.ts'
import type { SettingRow } from '../../shared/contract/settings-table.ts'
import { SEED_INHOUSE, SEED_PEOPLE } from '../../server/seed/brand.ts'
import { appOrigin, testAccessConfig } from '../support/test-build/issuer.ts'
import type { AppName } from '../support/test-build/issuer.ts'

export type { AppName }
export { appOrigin }

/**
 * The principals of the design's matrix (Inhouse with and without a grant are one person, the grant differs), with P3's
 * `release` service token.
 */
export type Who = 'admin' | 'memberA' | 'memberB' | 'inhouse' | 'smoke' | 'monitor' | 'release'

/** Someone who can sign in: a person's `sub` and email on an app, or a service token's client id. */
export type Actor =
  | { app: AppName; sub: string; email: string }
  | { app: 'brand'; clientId: string }

const seeded: Record<'admin' | 'memberA' | 'memberB' | 'inhouse', Actor> = {
  admin: { app: 'brand', sub: SEED_PEOPLE.admin.subject, email: SEED_PEOPLE.admin.email },
  memberA: { app: 'brand', sub: SEED_PEOPLE.dana.subject, email: SEED_PEOPLE.dana.email },
  memberB: { app: 'brand', sub: SEED_PEOPLE.leo.subject, email: SEED_PEOPLE.leo.email },
  inhouse: { app: 'inhouse', sub: SEED_INHOUSE.subject, email: SEED_INHOUSE.email },
}

const serviceClient = (name: 'smoke' | 'monitor' | 'release'): string => {
  const found = Object.entries(testAccessConfig().serviceTokens).find(([, v]) => v === name)
  if (!found) throw new Error(`The test build's INHOUSE_ACCESS has no "${name}" service token.`)
  return found[0]
}

export const actor = (who: Who): Actor => (who === 'smoke' || who === 'monitor' || who === 'release' ? { app: 'brand', clientId: serviceClient(who) } : seeded[who])

/** A person who isn't seeded: fresh subject, email and name per call (the member rows they make stay in the database). */
export function newIdentity(label: string): { sub: string; email: string; name: string } {
  const id = crypto.randomUUID().slice(0, 8)
  return { sub: `e2e-subject-${label}-${id}`, email: `e2e-${label}-${id}@example.test`, name: `E2E ${label} ${id}` }
}
export const personActor = (i: { sub: string; email: string }, app: AppName = 'brand'): Actor => ({ app, sub: i.sub, email: i.email })

/** This run's private test-issuer key (playwright.config.ts made it, or `ship.yml` wrote it to a file). */
function privateJwk(): JWK {
  const file = process.env.TEST_ISSUER_PRIVATE_JWK_FILE
  const text = file ? readFileSync(file, 'utf8') : process.env.INHOUSE_TEST_ISSUER_PRIVATE_JWK
  if (!text) throw new Error('No test issuer key in this process: run with E2E_TEST_BUILD=1 (playwright.config.ts makes one).')
  return JSON.parse(text) as JWK
}

export const audOf = (app: AppName): string => {
  const found = testAccessConfig().apps.find(a => a.name === app)
  if (!found) throw new Error(`The test build's INHOUSE_ACCESS has no "${app}" app.`)
  return found.aud
}

/** A JWT for `who` as Access would issue it. `o` breaks or changes it (another `aud`, `key`, `nowMs`, ...). */
export function mint(who: Actor, o: Partial<MintOptions> & { aud?: string } = {}): Promise<string> {
  const base = { key: privateJwk(), aud: audOf(who.app), ...o }
  return 'clientId' in who ? mintService({ clientId: who.clientId, ...base }) : mintPerson({ sub: who.sub, email: who.email, ...base })
}

export interface Reply {
  status: number
  headers: Record<string, string>
  text: string
  /** The body as JSON, or null when it isn't. */
  json: any
  bytes: Buffer
}

export interface CallOptions {
  json?: unknown
  bytes?: Buffer
  contentType?: string
  headers?: Record<string, string>
  /** The `Origin` header: absent means the app's own origin on a write and none on a read; `null` sends none. */
  origin?: string | null
  /** A JWT to send in place of `who`'s own (a broken one); `null` sends none. */
  token?: string | null
  /** The origin to send the request to (default: `who`'s app). */
  to?: string
}

const isRead = (method: string) => method === 'GET' || method === 'HEAD'

export async function fetchRaw(request: APIRequestContext, method: string, url: string, headers: Record<string, string>, data?: Buffer | string): Promise<Reply> {
  const res = await request.fetch(url, { method, headers, data, failOnStatusCode: false, maxRedirects: 0 })
  const bytes = await res.body()
  const text = bytes.toString('utf8')
  let json: unknown = null
  try { json = JSON.parse(text) } catch { /* not JSON */ }
  return { status: res.status(), headers: res.headers(), text, json, bytes }
}

/** One API call as `who`: the JWT in `Cf-Access-Jwt-Assertion` and, on a write, the app's own `Origin`. */
export async function call(request: APIRequestContext, who: Actor, method: string, path: string, o: CallOptions = {}): Promise<Reply> {
  const headers: Record<string, string> = { ...o.headers }
  const token = o.token === undefined ? await mint(who) : o.token
  if (token !== null) headers['Cf-Access-Jwt-Assertion'] = token
  const origin = o.origin === undefined ? (isRead(method) ? null : appOrigin(who.app)) : o.origin
  if (origin !== null) headers.Origin = origin
  let data: Buffer | string | undefined
  if (o.bytes !== undefined) {
    data = o.bytes
    headers['Content-Type'] = o.contentType ?? 'application/octet-stream'
  } else if (o.json !== undefined) {
    data = JSON.stringify(o.json)
    headers['Content-Type'] = o.contentType ?? 'application/json'
  }
  return fetchRaw(request, method, `${o.to ?? appOrigin(who.app)}${path}`, headers, data)
}

/** An error answer: the status and the body `{ error: { code, reason? } }` and nothing else. */
export function expectError(r: Reply, status: number, code: string, reason?: string): void {
  expect(r.status, r.text).toBe(status)
  expect(r.json).toEqual({ error: { code, ...(reason === undefined ? {} : { reason }) } })
}

/** A 409 with the record as it is now. */
export function expectConflict(r: Reply): Record<string, any> {
  expect(r.status, r.text).toBe(409)
  expect(r.json.error.code).toBe('conflict')
  expect(r.json.error.current, 'a stale ifRev answers with the current record').toBeTruthy()
  return r.json.error.current
}

export async function me(request: APIRequestContext, who: Actor): Promise<Record<string, any>> {
  const r = await call(request, who, 'GET', '/api/me')
  expect(r.status, r.text).toBe(200)
  return r.json
}

/** Every page of a list route, following `nextCursor` until null. */
export async function allPages<T>(request: APIRequestContext, who: Actor, path: string, limit: number): Promise<{ items: T[]; pages: number }> {
  const items: T[] = []
  let cursor: string | null = null
  let pages = 0
  do {
    const q: string = `limit=${limit}${cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`}`
    const r = await call(request, who, 'GET', `${path}?${q}`)
    expect(r.status, r.text).toBe(200)
    items.push(...r.json.items)
    cursor = r.json.nextCursor
    pages++
    expect(pages, 'paging never ends').toBeLessThan(10_000)
  } while (cursor !== null)
  return { items, pages }
}

/** The Admin ends any live support grant, so a spec starts from "no grant" and leaves none behind. */
export async function endLiveGrants(request: APIRequestContext): Promise<void> {
  const admin = actor('admin')
  const list = await call(request, admin, 'GET', '/api/grants')
  expect(list.status, list.text).toBe(200)
  for (const g of list.json.items.filter((x: { live: boolean }) => x.live)) {
    const done = await call(request, admin, 'POST', `/api/grants/${g.id}/end`, { json: { ifRev: g.rev } })
    expect(done.status, done.text).toBe(200)
  }
}

// ---------- the rows, read from the Worker's own source (it imports Worker-only modules, so it can't be imported here) ----------

export interface Row {
  method: string
  pattern: string
  class: string
  allow: string[]
  services: string[]
  adminWrite: boolean
  ownerObject: boolean
}

const appFile = (rel: string) => readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8')
const list = (s: string | undefined) => (s ?? '').split(',').map(x => x.trim().replaceAll("'", '')).filter(Boolean)

/** `server/access-matrix.ts`'s rows. Fails loud when a line that looks like a row isn't read as one. */
export function matrixRows(): Row[] {
  const source = appFile('server/access-matrix.ts')
  const re = /\{ method: '(\w+)', pattern: '([^']+)', class: '(\w+)', allow: \[([^\]]*)\](?:, services: \[([^\]]*)\])?(, adminWrite: true)?(, ownerObject: true)? \}/g
  const rows = [...source.matchAll(re)].map(m => ({
    method: m[1], pattern: m[2], class: m[3], allow: list(m[4]), services: list(m[5]), adminWrite: m[6] !== undefined, ownerObject: m[7] !== undefined,
  }))
  // Every row line, numbered or not (the canRows map has `{ method:` too, but no `class:`).
  const lines = source.split('\n').filter(l => l.includes("{ method: '") && l.includes('class:')).length
  if (rows.length === 0 || rows.length !== lines) throw new Error(`access-matrix.ts: read ${rows.length} rows from ${lines} row lines; the row format changed, update kit.ts's matrixRows.`)
  return rows
}

/** `server/routes.ts`'s routes as [method, pattern]. */
export function routeList(): [string, string][] {
  const source = appFile('server/routes.ts')
  const routes = [...source.matchAll(/\/\* \d+ \*\/ \{ method: '(\w+)', pattern: '([^']+)', handler:/g)].map(m => [m[1], m[2]] as [string, string])
  const lines = source.split('\n').filter(l => l.includes("{ method: '") && l.includes('handler')).length
  if (routes.length === 0 || routes.length !== lines) throw new Error(`routes.ts: read ${routes.length} routes from ${lines} route lines; the format changed, update kit.ts's routeList.`)
  return routes
}

export const rowKey = (r: { method: string; pattern: string }) => `${r.method} ${r.pattern}`

/** The `/*` block of public/_headers: the security headers every Worker answer carries. */
export function securityHeaders(): [string, string][] {
  const out: [string, string][] = []
  let inAll = false
  for (const line of appFile('public/_headers').split('\n')) {
    if (!line.trim() || line.trim().startsWith('#')) continue
    if (!/^\s/.test(line)) { inAll = line.trim() === '/*'; continue }
    const i = line.indexOf(':')
    if (inAll && i > 0) out.push([line.slice(0, i).trim().toLowerCase(), line.slice(i + 1).trim()])
  }
  if (out.length === 0) throw new Error('public/_headers has no "/*" block.')
  return out
}

/** A CSV text as rows of cells (RFC 4180: quoted cells, `""` for a quote, CRLF rows). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++ } else if (c === '"') quoted = false
      else cell += c
    } else if (c === '"') quoted = true
    else if (c === ',') { row.push(cell); cell = '' } else if (c === '\r' && text[i + 1] === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; i++ } else cell += c
  }
  if (cell !== '' || row.length > 0 || quoted) throw new Error('The CSV does not end with a complete row.')
  return rows
}

/** A setting's rev as the scope's list shows it (0: never set). */
export async function settingRev(request: APIRequestContext, who: Actor, scope: 'personal' | 'brand' | 'technical', key: string): Promise<number> {
  const r = await call(request, who, 'GET', `/api/settings/${scope}`)
  expect(r.status, r.text).toBe(200)
  return (r.json.items.find((i: { key: string }) => i.key === key)?.rev as number | undefined) ?? 0
}

type Scope = 'personal' | 'brand' | 'technical'

/** The registry's exact keys of a scope that match `pick`, never `g:name` (a rename, not a plain setting). */
export function registryKeys(scope: Scope, pick: (row: SettingRow) => boolean = () => true): string[] {
  return Object.entries(EXACT_ROWS).filter(([key, row]) => row.scope === scope && key !== 'g:name' && pick(row)).map(([key]) => key)
}

/** A key of the scope for a spec that only needs "some key", with the kind of value it takes. */
export function someKey(scope: Scope, kind: 'bool' | 'enum' | 'redacted' | 'logged', skip: string[] = []): string {
  const pick = (row: SettingRow) =>
    kind === 'bool' ? row.rule.t === 'bool' : kind === 'enum' ? row.rule.t === 'enum' : kind === 'redacted' ? row.rule.t === 'text' && !row.auditSafe : row.auditSafe
  const found = registryKeys(scope, pick).find(k => !skip.includes(k))
  if (!found) throw new Error(`The settings registry has no ${kind} ${scope} key.`)
  return found
}

/** Two different values the key accepts (`n` 0 or 1), from its rule. */
export function sampleValue(key: string, n: 0 | 1): string | boolean {
  const rule = EXACT_ROWS[key]?.rule
  if (!rule) throw new Error(`${key} is not an exact registry key.`)
  switch (rule.t) {
    case 'bool': return n === 0
    case 'enum': return rule.values[n]
    case 'text': return n === 0 ? 'Sample text one' : 'Sample text two'
    case 'cap': return n === 0 ? '$10' : '$20'
    case 'member': throw new Error(`${key} takes a member id`)
    case 'hostlist': return n === 0 ? 'example.com' : 'docs.example.com'
  }
}

/** Writes a setting at the rev it has now. */
export async function putSetting(request: APIRequestContext, who: Actor, scope: 'personal' | 'brand' | 'technical', key: string, value: unknown): Promise<Reply> {
  return call(request, who, 'PUT', `/api/settings/${scope}/${encodeURIComponent(key)}`, { json: { value, ifRev: await settingRev(request, who, scope, key) } })
}

const SIGNATURES = {
  'image/png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  'image/jpeg': Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
  'image/webp': Buffer.concat([Buffer.from('RIFF'), Buffer.from([0x24, 0, 0, 0]), Buffer.from('WEBP')]),
} as const
export type ImageType = keyof typeof SIGNATURES

/** Bytes that start as `type` does (the Worker reads the type from the first bytes alone), `size` bytes in all. */
export function imageBytes(type: ImageType, size = 64): Buffer {
  const head = SIGNATURES[type]
  return Buffer.concat([head, Buffer.alloc(Math.max(0, size - head.length), 0x2a)])
}
