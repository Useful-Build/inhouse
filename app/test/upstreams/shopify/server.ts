// The recorded Shopify upstream (P4 W1, OC 8): a dataset fake, not request replay. It answers the six tool operations
// and the recorder's operations by applying each operation's filters, sort and paging to a recorded dataset and slicing
// nested lists to the document's own limits. Differential cases against the live fixture store keep its semantics
// honest (app/test/connectors/shopify/cases.ts).
//
// Bundled into the hub's TEST build through app/hub/testing/index.ts, so: no npm package, relative imports and runtime
// globals only; no clock and no randomness (every answer is a function of the dataset and the request).
import { documentHash, OPERATIONS, SHOPIFY_READ_SCOPES, type Clause } from '../../../hub/connectors/shopify/documents'
import { checkDataset, type Dataset, type OrderNode, type ProductNode } from './dataset'
import { parseQuery } from './query'

/** Found in the test bundle, never in the deployable one (the orchestrator's bundle scan looks for this exact value). */
export const SHOPIFY_UPSTREAM_CANARY = 'INHOUSE_SHOPIFY_UPSTREAM_CANARY_7c2d'

/** The test config's invented credentials (app/wrangler.hub.test.jsonc). No real app has them. */
export const TEST_CLIENT_ID = 'test-client'
export const TEST_CLIENT_SECRET = 'test-only-client-secret-0RW9rVbhXFbVnJw6t1jyOWrJ1E7bMlc6'

export const BUCKET = { maximumAvailable: 2000, restoreRate: 100 } as const
export const TOKEN_LIFETIME_S = 86399
const MAX_FIRST = 250
const MAX_BODY_BYTES = 4 * 1024 * 1024

export type Fault = 'throttled' | 'unauthorized-once' | 'server-error' | 'oversize-body'
export type ShopifyUpstreamOptions = {
  faults?: readonly Fault[]
  /** The scope list the grant answers with (default: the connector's five). Proves scope_mismatch end to end. */
  scope?: readonly string[]
  credentials?: { clientId: string; clientSecret: string }
}

/** P6 registers its write operations here, from write/. W1 has none: every mutation answers ACCESS_DENIED. */
export type WriteHandler = (dataset: Dataset, variables: Record<string, unknown>) => unknown
export const WRITE_OPERATIONS = new Map<string, WriteHandler>()

// ---------------------------------------------------------------------------------------------------------------
// A small parser for the selection sets of our own documents (no npm graphql here). Anything it can't read is an
// error, which the fake answers as a GraphQL error.

type Arg = { var: string } | { value: unknown }
export type Field = { name: string; args: Record<string, Arg>; selections: Field[] | null }

class GqlError extends Error {
  readonly code: string
  constructor(message: string, code: string) {
    super(message)
    this.code = code
  }
}

function tokenize(src: string): string[] {
  const out: string[] = []
  const re = /\s+|,|(\.\.\.)|([{}():[\]!$=])|("(?:[^"\\]|\\.)*")|(-?\d+)|([_A-Za-z][_0-9A-Za-z]*)/y
  let i = 0
  while (i < src.length) {
    re.lastIndex = i
    const m = re.exec(src)
    if (!m) throw new GqlError(`unreadable document at ${i}`, 'GRAPHQL_PARSE_FAILED')
    const t = m[1] ?? m[2] ?? m[3] ?? m[4] ?? m[5]
    if (t !== undefined) out.push(t)
    i = re.lastIndex
  }
  return out
}

class Parser {
  i = 0
  readonly t: string[]
  constructor(t: string[]) {
    this.t = t
  }
  next(): string {
    const v = this.t[this.i++]
    if (v === undefined) throw new GqlError('unexpected end of document', 'GRAPHQL_PARSE_FAILED')
    return v
  }
  expect(v: string) {
    const got = this.next()
    if (got !== v) throw new GqlError(`expected ${v}, got ${got}`, 'GRAPHQL_PARSE_FAILED')
  }
  peek() {
    return this.t[this.i]
  }
  value(): Arg {
    const v = this.next()
    if (v === '$') return { var: this.next() }
    if (v === '[') {
      const items: unknown[] = []
      while (this.peek() !== ']') {
        const a = this.value()
        if ('var' in a) throw new GqlError('variables in lists are not supported', 'GRAPHQL_PARSE_FAILED')
        items.push(a.value)
      }
      this.expect(']')
      return { value: items }
    }
    if (v.startsWith('"')) return { value: JSON.parse(v) as string }
    if (/^-?\d+$/.test(v)) return { value: Number(v) }
    if (v === 'true' || v === 'false') return { value: v === 'true' }
    return { value: v } // an enum value
  }
  selections(): Field[] {
    this.expect('{')
    const out: Field[] = []
    while (this.peek() !== '}') {
      if (this.peek() === '...') {
        this.next()
        this.expect('on')
        this.next()
        out.push(...this.selections())
        continue
      }
      const name = this.next()
      const args: Record<string, Arg> = {}
      if (this.peek() === '(') {
        this.next()
        while (this.peek() !== ')') {
          const k = this.next()
          this.expect(':')
          args[k] = this.value()
        }
        this.expect(')')
      }
      out.push({ name, args, selections: this.peek() === '{' ? this.selections() : null })
    }
    this.expect('}')
    return out
  }
  operation(): Field[] {
    this.expect('query')
    this.next()
    if (this.peek() === '(') {
      let depth = 0
      do {
        const v = this.next()
        if (v === '(') depth++
        if (v === ')') depth--
      } while (depth > 0)
    }
    const s = this.selections()
    if (this.i !== this.t.length) throw new GqlError('one operation per document', 'GRAPHQL_PARSE_FAILED')
    return s
  }
}

export const parseOperation = (document: string): Field[] => new Parser(tokenize(document)).operation()

function argValue(f: Field, name: string, variables: Record<string, unknown>): unknown {
  const a = f.args[name]
  if (a === undefined) return undefined
  return 'var' in a ? variables[a.var] : a.value
}

/** Shopify's cost model, as documented: objects 1, scalars 0, connections and first-sized lists 2 + first × node. */
export function queryCost(fields: Field[], variables: Record<string, unknown>): number {
  let total = 0
  for (const f of fields) {
    if (f.selections === null || f.name === 'pageInfo') continue
    const first = argValue(f, 'first', variables)
    const names = argValue(f, 'names', variables)
    if (typeof first === 'number') {
      const nodes = f.selections.find(s => s.name === 'nodes')
      const child = 1 + queryCost(nodes?.selections ?? f.selections, variables)
      total += 2 + first * child
    } else if (Array.isArray(names)) {
      total += names.length * (1 + queryCost(f.selections, variables))
    } else {
      total += 1 + queryCost(f.selections, variables)
    }
  }
  return total
}

// ---------------------------------------------------------------------------------------------------------------
// Filters, sorts and paging over the dataset.

const FULFILLMENT: Record<string, string[]> = {
  unfulfilled: ['UNFULFILLED'],
  unshipped: ['UNFULFILLED'],
  fulfilled: ['FULFILLED'],
  shipped: ['FULFILLED'],
  partial: ['PARTIALLY_FULFILLED'],
  scheduled: ['SCHEDULED'],
  on_hold: ['ON_HOLD'],
  request_declined: ['REQUEST_DECLINED'],
}

const lower = (s: string | null | undefined) => (s ?? '').toLowerCase()
const bareName = (s: string) => lower(s.startsWith('#') ? s.slice(1) : s)
const words = (s: string) => lower(s).split(/[^\p{L}\p{N}]+/u).filter(w => w.length > 0)

function orderMatches(o: OrderNode, c: Clause): boolean {
  switch (c.kind) {
    case 'any':
      return c.of.some(x => orderMatches(o, x))
    case 'range': {
      const at = Date.parse(c.field === 'processed_at' ? o.processedAt : o.updatedAt)
      const bound = Date.parse(c.at)
      return c.op === '>=' ? at >= bound : at < bound
    }
    case 'eq': {
      let hit: boolean
      switch (c.field) {
        case 'financial_status':
          hit = lower(o.displayFinancialStatus) === c.value
          break
        case 'fulfillment_status': {
          const set = FULFILLMENT[c.value]
          if (!set) throw new GqlError(`unknown fulfillment_status ${c.value}`, 'INVALID_SEARCH')
          hit = set.includes(o.displayFulfillmentStatus)
          break
        }
        case 'return_status':
          hit = lower(o.returnStatus) === c.value
          break
        case 'sku':
          hit = o.lineItems.nodes.some(l => l.sku !== null && lower(l.sku) === lower(c.value))
          break
        case 'name':
          hit = bareName(o.name) === bareName(c.value)
          break
        default:
          throw new GqlError(`orders can't filter on ${c.field}`, 'INVALID_SEARCH')
      }
      return c.negate ? !hit : hit
    }
    default:
      throw new GqlError(`orders can't filter on ${c.kind}`, 'INVALID_SEARCH')
  }
}

function productMatches(p: ProductNode, c: Clause): boolean {
  switch (c.kind) {
    case 'phrase': {
      if (p.variants.nodes.some(v => v.sku !== null && lower(v.sku) === lower(c.value))) return true
      const want = words(c.value)
      const have = words(p.title)
      if (want.length === 0) return false
      for (let i = 0; i + want.length <= have.length; i++) {
        if (want.every((w, j) => have[i + j]!.startsWith(w))) return true
      }
      return false
    }
    case 'eq':
      if (c.field !== 'status') throw new GqlError(`products can't filter on ${c.field}`, 'INVALID_SEARCH')
      return c.negate ? lower(p.status) !== c.value : lower(p.status) === c.value
    case 'below':
      return p.totalInventory < c.value
    default:
      throw new GqlError(`products can't filter on ${c.kind}`, 'INVALID_SEARCH')
  }
}

type VariantRow = ProductNode['variants']['nodes'][number] & { product: { title: string } }

function variantMatches(v: VariantRow, c: Clause): boolean {
  if (c.kind !== 'eq' || c.field !== 'sku' || c.negate) throw new GqlError('productVariants filter on sku only', 'INVALID_SEARCH')
  return v.sku !== null && lower(v.sku) === lower(c.value)
}

const idNumber = (gid: string) => BigInt(gid.slice(gid.lastIndexOf('/') + 1))
const cmpId = (a: { id: string }, b: { id: string }) => {
  const x = idNumber(a.id)
  const y = idNumber(b.id)
  return x < y ? -1 : x > y ? 1 : 0
}

type Row = { id: string } & Record<string, unknown>
const SORTS: Record<string, { default: string; keys: Record<string, (r: Row) => number | string> }> = {
  orders: {
    default: 'PROCESSED_AT',
    keys: { PROCESSED_AT: r => Date.parse(r.processedAt as string), UPDATED_AT: r => Date.parse(r.updatedAt as string), ID: () => 0 },
  },
  products: {
    default: 'ID',
    keys: { ID: () => 0, TITLE: r => lower(r.title as string), INVENTORY_TOTAL: r => r.totalInventory as number },
  },
  productVariants: { default: 'ID', keys: { ID: () => 0 } },
}

function b64url(s: string): string {
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
function unb64url(s: string): string {
  const pad = s.replace(/-/g, '+').replace(/_/g, '/')
  return atob(pad + '='.repeat((4 - (pad.length % 4)) % 4))
}

function resolveRoot(d: Dataset, f: Field, variables: Record<string, unknown>) {
  const first = argValue(f, 'first', variables)
  if (typeof first !== 'number' || !Number.isInteger(first) || first < 1 || first > MAX_FIRST) {
    throw new GqlError(`${f.name}: first must be 1 to ${MAX_FIRST}`, 'BAD_REQUEST')
  }
  const query = argValue(f, 'query', variables)
  if (query !== undefined && query !== null && typeof query !== 'string') throw new GqlError('query must be a string', 'BAD_REQUEST')
  const parsed = parseQuery(query as string | undefined | null)
  if (!parsed.ok) throw new GqlError(`search query outside the recorded grammar: ${parsed.error}`, 'INVALID_SEARCH')
  const sort = SORTS[f.name]!
  const sortKey = (argValue(f, 'sortKey', variables) as string | undefined) ?? sort.default
  const key = sort.keys[sortKey]
  if (!key) throw new GqlError(`${f.name}: sortKey ${sortKey} isn't recorded`, 'BAD_REQUEST')
  const reverse = argValue(f, 'reverse', variables) === true

  let rows: Row[]
  if (f.name === 'orders') rows = d.orders.filter(o => parsed.clauses.every(c => orderMatches(o, c))) as unknown as Row[]
  else if (f.name === 'products') rows = d.products.filter(p => parsed.clauses.every(c => productMatches(p, c))) as unknown as Row[]
  else {
    const all: VariantRow[] = d.products.flatMap(p => p.variants.nodes.map(v => ({ ...v, product: { title: p.title } })))
    rows = all.filter(v => parsed.clauses.every(c => variantMatches(v, c))) as unknown as Row[]
  }
  rows = [...rows].sort((a, b) => {
    const x = key(a)
    const y = key(b)
    return x < y ? -1 : x > y ? 1 : cmpId(a, b)
  })
  if (reverse) rows.reverse()

  const scanHash = documentHash(`${f.name}|${query ?? ''}|${sortKey}|${reverse}`)
  let offset = 0
  const after = argValue(f, 'after', variables)
  if (after !== undefined && after !== null) {
    let c: { o?: unknown; h?: unknown }
    try {
      c = JSON.parse(unb64url(String(after))) as { o?: unknown; h?: unknown }
    } catch {
      throw new GqlError('invalid cursor', 'BAD_REQUEST')
    }
    if (c.h !== scanHash || typeof c.o !== 'number' || !Number.isInteger(c.o) || c.o < 0) throw new GqlError('cursor from another query', 'BAD_REQUEST')
    offset = c.o
  }
  const nodes = rows.slice(offset, offset + first)
  const end = offset + nodes.length
  return {
    nodes,
    pageInfo: { hasNextPage: end < rows.length, endCursor: nodes.length > 0 ? b64url(JSON.stringify({ o: end, h: scanHash })) : null },
  }
}

/** Projects `value` onto the selection set, slicing nested lists to their `first`. A field the dataset lacks is an error. */
function project(value: unknown, fields: Field[], variables: Record<string, unknown>, path: string): unknown {
  if (value === null) return null
  if (Array.isArray(value)) return value.map((v, i) => project(v, fields, variables, `${path}[${i}]`))
  if (typeof value !== 'object') throw new GqlError(`${path} isn't an object in the recording`, 'RE_RECORD_NEEDED')
  const src = value as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const f of fields) {
    const v = src[f.name]
    if (v === undefined) throw new GqlError(`${path}.${f.name} isn't in the recording`, 'RE_RECORD_NEEDED')
    if (f.selections === null) {
      out[f.name] = v
      continue
    }
    const first = argValue(f, 'first', variables)
    const names = argValue(f, 'names', variables)
    if (typeof first === 'number' && Array.isArray(v)) {
      out[f.name] = project(v.slice(0, first), f.selections, variables, `${path}.${f.name}`)
    } else if (typeof first === 'number' && typeof v === 'object' && v !== null && Array.isArray((v as { nodes?: unknown }).nodes)) {
      const all = (v as { nodes: unknown[] }).nodes
      const conn = { nodes: all.slice(0, first), pageInfo: { hasNextPage: all.length > first, endCursor: null } }
      out[f.name] = project(conn, f.selections, variables, `${path}.${f.name}`)
    } else if (Array.isArray(names) && Array.isArray(v)) {
      const picked = names.map(n => (v as { name: string }[]).find(q => q.name === n)).filter(q => q !== undefined)
      out[f.name] = project(picked, f.selections, variables, `${path}.${f.name}`)
    } else {
      out[f.name] = project(v, f.selections, variables, `${path}.${f.name}`)
    }
  }
  return out
}

function execute(d: Dataset, granted: readonly string[], fields: Field[], variables: Record<string, unknown>): Record<string, unknown> {
  const data: Record<string, unknown> = {}
  for (const f of fields) {
    if (f.selections === null) throw new GqlError(`unknown root ${f.name}`, 'BAD_REQUEST')
    if (f.name === 'shop') data.shop = project({ currencyCode: d.currency }, f.selections, variables, 'shop')
    else if (f.name === 'currentAppInstallation') {
      data[f.name] = project({ accessScopes: granted.map(handle => ({ handle })) }, f.selections, variables, f.name)
    } else if (f.name === 'orders' || f.name === 'products' || f.name === 'productVariants') {
      data[f.name] = project(resolveRoot(d, f, variables), f.selections, variables, f.name)
    } else throw new GqlError(`root ${f.name} isn't recorded`, 'BAD_REQUEST')
  }
  return data
}

// ---------------------------------------------------------------------------------------------------------------
// HTTP.

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } })

const gqlError = (message: string, code: string, version: string) =>
  json({ errors: [{ message, extensions: { code } }] }, 200, { 'X-Shopify-API-Version': version })

export function createShopifyUpstream(datasetValue: unknown, options: ShopifyUpstreamOptions = {}): (req: Request) => Promise<Response> {
  const d = checkDataset(datasetValue)
  const faults = new Set(options.faults ?? [])
  const granted = [...(options.scope ?? SHOPIFY_READ_SCOPES)]
  const creds = options.credentials ?? { clientId: TEST_CLIENT_ID, clientSecret: TEST_CLIENT_SECRET }
  const tokens = new Set<string>()
  let issued = 0
  let unauthorizedSent = false

  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url)
    if (req.method !== 'POST') return new Response('method not allowed', { status: 405 })

    if (url.pathname === '/admin/oauth/access_token') {
      const form = new URLSearchParams(await req.text())
      if (form.get('grant_type') !== 'client_credentials' || form.get('client_id') !== creds.clientId || form.get('client_secret') !== creds.clientSecret) {
        return json({ error: 'invalid_client' }, 401)
      }
      const token = `shpat_test_${++issued}`
      tokens.add(token)
      return json({ access_token: token, scope: granted.join(','), expires_in: TOKEN_LIFETIME_S })
    }

    const m = /^\/admin\/api\/([^/]+)\/graphql\.json$/.exec(url.pathname)
    if (!m) return new Response('not found', { status: 404 })
    if (!tokens.has(req.headers.get('X-Shopify-Access-Token') ?? '')) return json({ errors: '[API] Invalid API key or access token' }, 401)
    if (faults.has('unauthorized-once') && !unauthorizedSent) {
      unauthorizedSent = true
      return json({ errors: '[API] Invalid API key or access token' }, 401)
    }
    if (faults.has('server-error')) return new Response('internal error', { status: 500 })
    // Shopify falls forward to a supported version and says so in this header; H0 maps it to upstream_version_mismatch.
    if (m[1] !== d.apiVersion) return json({ data: null }, 200, { 'X-Shopify-API-Version': d.apiVersion })
    if (faults.has('oversize-body')) {
      return new Response(`{"data":"${'x'.repeat(MAX_BODY_BYTES)}"}`, { status: 200, headers: { 'X-Shopify-API-Version': d.apiVersion } })
    }

    let body: { query?: unknown; variables?: unknown }
    try {
      body = (await req.json()) as typeof body
    } catch {
      return gqlError('body is not JSON', 'BAD_REQUEST', d.apiVersion)
    }
    const text = typeof body.query === 'string' ? body.query : ''
    const variables = (typeof body.variables === 'object' && body.variables !== null ? body.variables : {}) as Record<string, unknown>
    const head = /^\s*(query|mutation|subscription)\b\s*([_A-Za-z][_0-9A-Za-z]*)?/.exec(text)
    const kind = head?.[1]
    const op = head?.[2] ?? ''
    if (kind === 'mutation' && WRITE_OPERATIONS.has(op)) return json({ data: WRITE_OPERATIONS.get(op)!(d, variables) }, 200, { 'X-Shopify-API-Version': d.apiVersion })
    if (kind !== 'query' || !Object.hasOwn(OPERATIONS, op)) {
      return gqlError(`Access denied: operation not recorded (${SHOPIFY_UPSTREAM_CANARY})`, 'ACCESS_DENIED', d.apiVersion)
    }
    if (d.documentHashes[op] !== documentHash(text)) {
      return gqlError(`${op} changed since the recording: re-record the dataset`, 'RE_RECORD_NEEDED', d.apiVersion)
    }
    try {
      const fields = parseOperation(text)
      const cost = queryCost(fields, variables)
      if (faults.has('throttled')) {
        return json(
          {
            errors: [{ message: 'Throttled', extensions: { code: 'THROTTLED' } }],
            extensions: { cost: { requestedQueryCost: cost, throttleStatus: { ...BUCKET, currentlyAvailable: 0 } } },
          },
          200,
          { 'X-Shopify-API-Version': d.apiVersion },
        )
      }
      const data = execute(d, granted, fields, variables)
      return json(
        {
          data,
          extensions: {
            cost: {
              requestedQueryCost: cost,
              actualQueryCost: cost,
              throttleStatus: { ...BUCKET, currentlyAvailable: BUCKET.maximumAvailable - cost },
            },
          },
        },
        200,
        { 'X-Shopify-API-Version': d.apiVersion },
      )
    } catch (e) {
      if (e instanceof GqlError) return gqlError(e.message, e.code, d.apiVersion)
      throw e
    }
  }
}
