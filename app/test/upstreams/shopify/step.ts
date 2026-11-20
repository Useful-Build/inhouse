// The recorder's step engine (P4 W1, brief section 7). Node never holds a token or a secret: the engine writes each
// request body to a file, the orchestrator sends it with `curl -q` (the only shape the guard lets a secret card take),
// and the engine reads the saved response back. record.live.ts runs it through the `live` vitest project.
//
//   SHOPIFY_STEP=start|ingest|finish   SHOPIFY_STEP_DIR=<abs scratch dir>   SHOPIFY_STEP_MODE=record|check
//   SHOPIFY_STEP_RESPONSE=<abs file> (ingest)   SHOPIFY_STEP_OUT=<recordings dir> (finish, record mode)
//   SHOPIFY_SHOP=<handle> (finish, record mode: scrubbed and scanned for; never written out)
//
// Not bundled into the hub (only server.ts is); it runs under Node in vitest, so it may use node: modules.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { checkReadDocument } from '../../../hub/scope/graphql'
import { shopifyConnector } from '../../../hub/connectors/shopify/route'
import {
  currentDocumentHashes,
  RECORD_ORDERS,
  RECORD_PRODUCTS,
  RECORD_REFUNDS,
  RECORD_RETURNS,
  RECORD_SCOPES,
  RECORDER,
  SHOPIFY_API_VERSION,
  SHOPIFY_READ_SCOPES,
} from '../../../hub/connectors/shopify/documents'
import { buildQuery } from '../../../hub/connectors/shopify/search'
import { ok } from '../../../hub/index/errors'
import { CASES, type LiveCase } from '../../connectors/shopify/cases'
import { hubReadClient } from '../../connectors/shopify/client'
import { captureRequest, firstDifference, hasNext, normalise, pageInput, runCase, toolFor } from '../../connectors/shopify/run'
import { checkDataset, type Dataset } from './dataset'
import { createShopifyUpstream, TEST_CLIENT_ID, TEST_CLIENT_SECRET } from './server'

export type Pass = 'orders' | 'refunds' | 'returns' | 'products'
type Step = { kind: 'scopes' } | { kind: 'pass'; pass: Pass; after: string | null } | { kind: 'case'; name: string; page: number }
type State = {
  v: 1
  mode: 'record' | 'check'
  n: number
  current: Step | null
  queue: Step[]
  nodes: Record<Pass, unknown[]>
  currency: string | null
  cases: Record<string, unknown[]>
  costs: number[]
}

export type StepEnv = Record<string, string | undefined>

export class StepError extends Error {}
const stop = (why: string): never => {
  throw new StepError(why)
}

const PASS_DOC: Record<Pass, string> = { orders: RECORD_ORDERS, refunds: RECORD_REFUNDS, returns: RECORD_RETURNS, products: RECORD_PRODUCTS }
const PASS_QUERY: Partial<Record<Pass, string>> = {
  refunds: buildQuery([
    {
      kind: 'any',
      of: [
        { kind: 'eq', field: 'financial_status', value: 'refunded' },
        { kind: 'eq', field: 'financial_status', value: 'partially_refunded' },
      ],
    },
  ]),
  returns: buildQuery([{ kind: 'eq', field: 'return_status', value: 'no_return', negate: true }]),
}
const PASS_ROOT: Record<Pass, 'orders' | 'products'> = { orders: 'orders', refunds: 'orders', returns: 'orders', products: 'products' }

const caseByName = (cases: readonly LiveCase[], name: string) => cases.find(c => c.name === name) ?? stop(`unknown case ${name}`)

const statePath = (dir: string) => join(dir, 'state.json')
const readState = (dir: string): State => {
  if (!existsSync(statePath(dir))) stop('no state.json in SHOPIFY_STEP_DIR: run SHOPIFY_STEP=start first')
  return JSON.parse(readFileSync(statePath(dir), 'utf8')) as State
}
const writeState = (dir: string, s: State) => writeFileSync(statePath(dir), JSON.stringify(s))

function need(env: StepEnv, key: string): string {
  const v = env[key]
  if (!v) stop(`${key} must be set`)
  return v!
}

async function requestFor(s: State, step: Step, cases: readonly LiveCase[]): Promise<{ query: string; variables: Record<string, unknown>; label: string }> {
  if (step.kind === 'scopes') return { query: RECORD_SCOPES, variables: {}, label: 'RecordScopes' }
  if (step.kind === 'pass') {
    const variables: Record<string, unknown> = { first: RECORDER.pages[step.pass] }
    if (step.after) variables.after = step.after
    const q = PASS_QUERY[step.pass]
    if (q) variables.query = q
    return { query: PASS_DOC[step.pass], variables, label: `${step.pass} pass` }
  }
  const c = caseByName(cases, step.name)
  const previous = step.page > 0 ? (await mapLivePages(c, s.cases[c.name]!.slice(0, step.page))).at(-1) : undefined
  const r = await captureRequest(toolFor(c), pageInput(c, previous))
  return { ...r, label: `case "${c.name}" page ${step.page + 1}` }
}

function curlCommand(file: string): string {
  return (
    `curl -q -sSi -X POST "https://<shop>.myshopify.com/admin/api/${SHOPIFY_API_VERSION}/graphql.json" ` +
    `-H "X-Shopify-Access-Token: $(cat <TOKEN_CARD>)" -H "Content-Type: application/json" --data-binary @${file}`
  )
}

async function writeNext(dir: string, s: State, cases: readonly LiveCase[]): Promise<string> {
  const step = s.queue.shift()
  if (!step) {
    s.current = null
    writeState(dir, s)
    return `done: ${s.n} requests, highest cost ${Math.max(0, ...s.costs)}. Next: SHOPIFY_STEP=finish`
  }
  const req = await requestFor(s, step, cases)
  // Only read documents ever reach a request file.
  const check = checkReadDocument(req.query)
  if (!check.ok) stop(`refusing to write a request that isn't a single read query (${req.label})`)
  s.n++
  s.current = step
  const file = join(dir, `request-${String(s.n).padStart(3, '0')}.json`)
  writeFileSync(file, JSON.stringify({ query: req.query, variables: req.variables }))
  writeState(dir, s)
  return `next: ${req.label}\n${curlCommand(file)}`
}

/** Status, headers and JSON body from `curl -i` output, tolerating text around it. */
export function parseCurlOutput(text: string): { status: number; headers: Map<string, string>; body: unknown } {
  const starts = [...text.matchAll(/^HTTP\/[\d.]+ (\d{3})[^\n]*$/gm)]
  const last = starts.at(-1)
  if (!last) stop('no HTTP status line in the response file')
  const rest = text.slice(last!.index!)
  const split = /\r?\n\r?\n/.exec(rest)
  if (!split) stop('no header block end in the response file')
  const headers = new Map<string, string>()
  for (const line of rest.slice(0, split!.index).split(/\r?\n/).slice(1)) {
    const i = line.indexOf(':')
    if (i > 0) headers.set(line.slice(0, i).trim().toLowerCase(), line.slice(i + 1).trim())
  }
  const after = rest.slice(split!.index + split![0].length)
  const open = after.indexOf('{')
  const close = after.lastIndexOf('}')
  if (open < 0 || close < open) stop('no JSON body in the response file')
  let body: unknown
  try {
    body = JSON.parse(after.slice(open, close + 1))
  } catch {
    stop('the response body is not JSON')
  }
  return { status: Number(last![1]), headers, body }
}

/** Throws "raise the recorder limit" when any nested list in a recorded node may be incomplete. */
export function checkComplete(node: unknown, path: string, limits: Record<string, number>) {
  if (Array.isArray(node)) {
    node.forEach((x, i) => checkComplete(x, `${path}[${i}]`, limits))
    return
  }
  if (!node || typeof node !== 'object') return
  for (const [k, v] of Object.entries(node)) {
    if (k === 'pageInfo' && (v as { hasNextPage?: unknown }).hasNextPage === true) stop(`raise the recorder limit: ${path} has more than recorded`)
    if (Array.isArray(v) && k in limits && v.length >= limits[k]!) stop(`raise the recorder limit: ${path}.${k} is at its first (${limits[k]})`)
    checkComplete(v, `${path}.${k}`, limits)
  }
}
// Lists without pageInfo: a list at its `first` may have more.
const LIST_LIMITS = { refunds: RECORDER.refunds }

function ingestBody(s: State, step: Step, data: Record<string, any>): void {
  if (step.kind === 'scopes') {
    const handles = ((data.currentAppInstallation?.accessScopes ?? []) as { handle: unknown }[]).map(a => String(a.handle))
    const want = [...SHOPIFY_READ_SCOPES]
    const extra = handles.filter(h => !want.includes(h as never))
    const missing = want.filter(h => !handles.includes(h))
    if (extra.length || missing.length) {
      const safe = (l: string[]) => l.filter(h => /^[a-z_]{1,64}$/.test(h)).join(',') || 'none'
      stop(`the app's scopes don't match the connector: extra ${safe(extra)}; missing ${safe(missing)}`)
    }
    const currency = data.shop?.currencyCode
    if (typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency)) stop('no shop currency')
    s.currency = currency
    return
  }
  if (step.kind === 'pass') {
    const conn = data[PASS_ROOT[step.pass]]
    if (!conn || !Array.isArray(conn.nodes)) stop(`${step.pass} pass: no nodes`)
    checkComplete(conn.nodes, step.pass, LIST_LIMITS)
    s.nodes[step.pass].push(...conn.nodes)
    if (conn.pageInfo?.hasNextPage) {
      if (typeof conn.pageInfo.endCursor !== 'string') stop(`${step.pass} pass: next page without a cursor`)
      s.queue.unshift({ kind: 'pass', pass: step.pass, after: conn.pageInfo.endCursor })
    }
    return
  }
  ;(s.cases[step.name] ??= []).push(data)
}

/** Maps a case's recorded live pages through the tool, as the live script would see them. */
async function mapLivePages(c: LiveCase, datas: unknown[]): Promise<unknown[]> {
  const out: unknown[] = []
  for (const data of datas) {
    const tool = toolFor(c)
    const r = await tool.run(
      { shopify: { graphql: async () => ok({ data }) }, scope: { kind: 'server', job: 'record', requestId: 'record' }, nowMs: 0 },
      tool.input.parse(pageInput(c, out.at(-1))),
    )
    if (!r.ok) throw new StepError(`case "${c.name}": the live response doesn't map (${r.error.code})`)
    out.push(r.value)
  }
  return out
}

function stripPageInfo(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stripPageInfo)
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, x] of Object.entries(v)) if (k !== 'pageInfo') out[k] = stripPageInfo(x)
    return out
  }
  return v
}

const GID = /gid:\/\/shopify\/([A-Za-z]+)\/(\d+)/g

/** Builds the dataset from the recorded passes, with gids renumbered and location names replaced. */
export function buildDataset(s: State, recordedOn: string): { dataset: Dataset; ids: Map<string, string>; locations: Map<string, string>; originals: string[] } {
  const refunds = new Map((s.nodes.refunds as { id: string; refunds: unknown }[]).map(n => [n.id, n.refunds]))
  const returns = new Map((s.nodes.returns as { id: string; returns: unknown }[]).map(n => [n.id, n.returns]))
  const orderIds = new Set((s.nodes.orders as { id: string }[]).map(o => o.id))
  for (const id of [...refunds.keys(), ...returns.keys()]) if (!orderIds.has(id)) stop('a refunded or returned order is missing from the orders pass')
  const orders = (s.nodes.orders as Record<string, unknown>[]).map(o => ({
    ...o,
    refunds: refunds.get(o.id as string) ?? [],
    returns: returns.get(o.id as string) ?? { nodes: [] },
  }))
  let text = JSON.stringify(stripPageInfo({ orders, products: s.nodes.products }))

  const byType = new Map<string, Set<string>>()
  for (const m of text.matchAll(GID)) {
    const set = byType.get(m[1]!) ?? new Set<string>()
    set.add(m[2]!)
    byType.set(m[1]!, set)
  }
  const ids = new Map<string, string>()
  const originals: string[] = []
  for (const [type, nums] of byType) {
    const sorted = [...nums].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0))
    sorted.forEach((n, i) => {
      ids.set(`gid://shopify/${type}/${n}`, `gid://shopify/${type}/${i + 1}`)
      originals.push(n)
    })
  }
  text = text.replace(GID, g => ids.get(g)!)
  const body = JSON.parse(text) as { orders: unknown[]; products: unknown[] }

  const names = new Set<string>()
  const visit = (v: unknown, f: (o: { location: { name: string } }) => void) => {
    if (Array.isArray(v)) v.forEach(x => visit(x, f))
    else if (v && typeof v === 'object') {
      if ('location' in v && typeof (v as { location: { name?: unknown } }).location?.name === 'string') f(v as { location: { name: string } })
      Object.values(v).forEach(x => visit(x, f))
    }
  }
  visit(body.products, o => names.add(o.location.name))
  const locations = new Map([...names].sort().map((n, i) => [n, `Location ${i + 1}`]))
  visit(body.products, o => (o.location.name = locations.get(o.location.name)!))

  const dataset = checkDataset({
    v: 1,
    apiVersion: SHOPIFY_API_VERSION,
    recordedOn,
    documentHashes: currentDocumentHashes(),
    currency: s.currency ?? stop('no shop currency recorded'),
    orders: body.orders,
    products: body.products,
  })
  return { dataset, ids, locations, originals }
}

/** Fails when the text carries the shop handle, a myshopify host, an email, a phone number or an original gid number. */
export function scrubScan(text: string, shop: string, originals: readonly string[]): void {
  const lower = text.toLowerCase()
  if (shop && lower.includes(shop.toLowerCase())) stop('scrub: the shop handle is in the output')
  if (lower.includes('myshopify.com')) stop('scrub: a myshopify.com host is in the output')
  if (/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.test(text)) stop('scrub: an email-shaped string is in the output')
  if (/\+\d[\d ]{6,16}\d|\(\d{3}\)\s?\d{3}-\d{4}|\b\d{3}[-. ]\d{3}[-. ]\d{4}\b/.test(text)) stop('scrub: a phone-shaped string is in the output')
  for (const n of originals) if (n.length >= 6 && text.includes(n)) stop('scrub: an original gid number is in the output')
}

/** Runs every case through the tool on the live responses and on a fake over `dataset`; one line per case. */
async function differential(
  s: State,
  dataset: Dataset,
  cases: readonly LiveCase[],
  maps?: { ids: ReadonlyMap<string, string>; locations: ReadonlyMap<string, string> },
): Promise<{ lines: string[]; equal: boolean }> {
  const client = hubReadClient(createShopifyUpstream(dataset), { shop: 'example-fixture', clientId: TEST_CLIENT_ID, clientSecret: TEST_CLIENT_SECRET }, shopifyConnector.scopes, SHOPIFY_API_VERSION)
  const lines: string[] = []
  let equal = true
  for (const c of cases) {
    const live = await mapLivePages(c, s.cases[c.name] ?? stop(`case "${c.name}" has no live response`))
    const fake = await runCase({ ...c, pages: live.length }, client)
    if (!fake.ok) {
      equal = false
      lines.push(`${c.name}: fake failed (${fake.error.code})`)
      continue
    }
    // Record mode maps the live ids onto the new recording's; check mode compares ids by type only.
    const d = firstDifference(normalise(live, maps), normalise(fake.value, maps && SAME))
    if (d) equal = false
    lines.push(`${c.name}: ${d ?? 'equal'}`)
  }
  return { lines, equal }
}

const SAME = { ids: new Map<string, string>(), locations: new Map<string, string>() }

async function loadCommitted(): Promise<unknown> {
  const url = new URL('./recordings/fixture/dataset.ts', import.meta.url).href
  return ((await import(/* @vite-ignore */ url)) as { dataset: unknown }).dataset
}

/** Runs one step and returns the message to print. Throws StepError with a plain message on any failed check. */
export async function runStep(env: StepEnv, opts: { cases?: readonly LiveCase[]; committed?: unknown; today?: string } = {}): Promise<string> {
  const cases = opts.cases ?? CASES
  const step = need(env, 'SHOPIFY_STEP')
  const dir = need(env, 'SHOPIFY_STEP_DIR')
  if (step === 'start') {
    const mode = need(env, 'SHOPIFY_STEP_MODE')
    if (mode !== 'record' && mode !== 'check') throw new StepError('SHOPIFY_STEP_MODE must be record or check')
    mkdirSync(dir, { recursive: true })
    const queue: Step[] = [{ kind: 'scopes' }]
    if (mode === 'record') for (const pass of ['orders', 'refunds', 'returns', 'products'] as const) queue.push({ kind: 'pass', pass, after: null })
    for (const c of cases) queue.push({ kind: 'case', name: c.name, page: 0 })
    const s: State = { v: 1, mode, n: 0, current: null, queue, nodes: { orders: [], refunds: [], returns: [], products: [] }, currency: null, cases: {}, costs: [] }
    return writeNext(dir, s, cases)
  }
  const s = readState(dir)
  if (step === 'ingest') {
    const current = s.current ?? stop('nothing to ingest: the run is done')
    const res = parseCurlOutput(readFileSync(need(env, 'SHOPIFY_STEP_RESPONSE'), 'utf8'))
    if (res.status !== 200) stop(`status ${res.status}, expected 200`)
    const version = res.headers.get('x-shopify-api-version')
    if (version !== SHOPIFY_API_VERSION) stop(`X-Shopify-API-Version is ${version && /^[\d-]{1,10}$/.test(version) ? version : 'missing'}, expected ${SHOPIFY_API_VERSION}`)
    const body = res.body as { data?: Record<string, any>; errors?: unknown; extensions?: { cost?: { requestedQueryCost?: unknown } } }
    if (body.errors !== undefined) stop('the response has errors')
    const cost = body.extensions?.cost?.requestedQueryCost
    if (typeof cost !== 'number') stop('the response has no requestedQueryCost')
    if ((cost as number) > RECORDER.maxCost) stop(`requestedQueryCost ${cost} is over ${RECORDER.maxCost}: lower the page size or limits for this request`)
    if (!body.data || typeof body.data !== 'object') stop('the response has no data')
    s.costs.push(cost as number)
    ingestBody(s, current, body.data!)
    if (current.kind === 'case') {
      const c = caseByName(cases, current.name)
      const mapped = await mapLivePages(c, s.cases[c.name]!)
      if (current.page + 1 < (c.pages ?? 1) && hasNext(mapped.at(-1))) s.queue.unshift({ kind: 'case', name: c.name, page: current.page + 1 })
    }
    return writeNext(dir, s, cases)
  }
  if (step === 'finish') {
    if (s.current !== null || s.queue.length > 0) stop('the run is not done: ingest every request first')
    if (s.mode === 'record') {
      const out = need(env, 'SHOPIFY_STEP_OUT')
      const shop = need(env, 'SHOPIFY_SHOP')
      const built = buildDataset(s, opts.today ?? new Date().toISOString().slice(0, 10))
      const text = JSON.stringify(built.dataset, null, 1)
      scrubScan(text, shop, built.originals)
      const diff = await differential(s, built.dataset, cases, built)
      writeFileSync(join(dir, 'differential.txt'), diff.lines.join('\n') + '\n')
      mkdirSync(out, { recursive: true })
      writeFileSync(
        join(out, 'dataset.ts'),
        '// Recorded from the read fixture store by the step engine (record.live.ts); scrubbed. Never edit by hand: fix the\n' +
          '// fake instead, or re-record.\n' +
          `export const dataset: unknown = ${text}\n`,
      )
      return `recorded ${built.dataset.orders.length} orders and ${built.dataset.products.length} products; differential ${diff.equal ? 'all equal' : 'has differences'} (differential.txt)`
    }
    const committed = opts.committed ?? (await loadCommitted())
    const diff = await differential(s, checkDataset(committed), cases)
    writeFileSync(join(dir, 'differential.txt'), diff.lines.join('\n') + '\n')
    return `check: differential ${diff.equal ? 'all equal' : 'has differences'} (differential.txt)`
  }
  return stop('SHOPIFY_STEP must be start, ingest or finish')
}
