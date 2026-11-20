import { fc, test } from '@fast-check/vitest'
import { describe, expect, it } from 'vitest'
import { LIMITS } from './documents'
import { cap, currencyExponent, instant, MapError, money, RESULT_BUDGET_BYTES } from './shape'
import { bytes, call, dataClient, MAXIMAL, TOOLS } from './test-kit'

// Tests 1 and 3 of the brief's section 9: bounds by construction, money and instants.

/** Every array a result can hold, by key path, and its cap. */
const ARRAY_CAPS: Record<string, Record<string, number>> = {
  orders_search: { items: LIMITS.ordersSearch.maxFirst, 'items.lines': LIMITS.ordersSearch.lines },
  order_get: {
    'order.lines': LIMITS.orderGet.lines,
    'order.refunds': LIMITS.orderGet.refunds,
    'order.refunds.lines': LIMITS.orderGet.refundLines,
    'order.returns': LIMITS.orderGet.returns,
    'order.returns.lines': LIMITS.orderGet.returnLines,
  },
  refunds_search: { items: LIMITS.refundsSearch.maxItems, 'items.lines': LIMITS.refundsSearch.refundLines },
  returns_search: { items: LIMITS.returnsSearch.maxItems, 'items.lines': LIMITS.returnsSearch.returnLines },
  products_search: { items: LIMITS.productsSearch.maxFirst, 'items.variants': LIMITS.productsSearch.variants },
  inventory_levels_get: { matches: LIMITS.inventoryLevelsGet.first, 'matches.levels': LIMITS.inventoryLevelsGet.levels },
}

function arrays(v: unknown, path: string, out: { path: string; length: number }[]) {
  if (Array.isArray(v)) {
    out.push({ path, length: v.length })
    for (const x of v) arrays(x, path, out)
  } else if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) arrays(x, path ? `${path}.${k}` : k, out)
  }
}

/** Every array within its cap, and no array the table doesn't know. */
function expectBounded(name: string, value: unknown) {
  const found: { path: string; length: number }[] = []
  arrays(value, '', found)
  for (const a of found) {
    const max = ARRAY_CAPS[name]![a.path]
    expect(max, `${name}: unexpected array ${a.path}`).toBeDefined()
    expect(a.length, `${name}: ${a.path}`).toBeLessThanOrEqual(max!)
  }
  expect(bytes(value)).toBeLessThan(RESULT_BUDGET_BYTES)
}

/** A small deterministic PRNG, seeded by fast-check, to walk a nested value. */
function prng(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const ALPHABET = ['a', 'Z', '"', '\\', '\u0001', '\n', 'é', '折', '🏕', '\ud800', ' ']

/** Shortens arrays, rewrites strings (up to 10× a 400-byte cap, multibyte) and flips booleans, keeping the shape. */
function vary(v: unknown, rnd: () => number, key = ''): unknown {
  if (Array.isArray(v)) return v.slice(0, Math.floor(rnd() * (v.length + 1))).map(x => vary(x, rnd))
  if (typeof v === 'boolean') return rnd() < 0.5
  if (typeof v === 'string') {
    // Strings the parser checks by pattern keep their shape; free text gets random code points.
    if (/^(id|processedAt|cancelledAt|createdAt|amount|currencyCode|price|endCursor|display\w+|returnStatus|status|restockType|name)$/.test(key) && key !== 'name') return v
    const n = Math.floor(rnd() * 4000)
    let s = ''
    for (let i = 0; i < n; i++) s += ALPHABET[Math.floor(rnd() * ALPHABET.length)]
    return s
  }
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, x] of Object.entries(v)) out[k] = k === 'quantities' ? x : vary(x, rnd, k)
    return out
  }
  return v
}

describe('bounds by construction (worst case)', () => {
  for (const name of Object.keys(TOOLS)) {
    it(`${name}: the maximal result fits in 24 KiB with every array at its cap`, async () => {
      const { input, data } = MAXIMAL[name]!
      const r = await call(name, input, dataClient(data))
      if (!r.ok) throw new Error(`${name}: ${r.error.code}`)
      expectBounded(name, r.value)
      // Every array really is at its cap here, so the bound above is the worst case, not a lucky one.
      const found: { path: string; length: number }[] = []
      arrays(r.value, '', found)
      for (const [path, max] of Object.entries(ARRAY_CAPS[name]!)) {
        expect(Math.max(...found.filter(a => a.path === path).map(a => a.length)), `${name}: ${path}`).toBe(max)
      }
      console.log(`${name}: worst case ${bytes(r.value)} bytes`)
    })
  }
})

describe('bounds over arbitrary data at every cap', () => {
  for (const name of Object.keys(TOOLS)) {
    test.prop([fc.integer()], { numRuns: 60 })(`${name}: arrays within caps, JSON under 24 KiB`, async seed => {
      const { input, data } = MAXIMAL[name]!
      const varied = vary(data, prng(seed)) as any
      // Keep the key the tool matches on, so order_get and inventory_levels_get return data under the property.
      if (name === 'order_get' && varied.orders.nodes[0]) varied.orders.nodes[0].name = (input as { name: string }).name
      if (name === 'inventory_levels_get') for (const n of varied.productVariants.nodes) n.sku = (input as { sku: string }).sku
      const r = await call(name, input, dataClient(varied))
      if (!r.ok) throw new Error(`${name}: ${r.error.code}`)
      expectBounded(name, r.value)
      if (name === 'order_get') expect((r.value as { order: unknown }).order !== null).toBe(varied.orders.nodes.length > 0)
      if (name === 'inventory_levels_get') expect((r.value as { matches: unknown[] }).matches).toHaveLength(varied.productVariants.nodes.length)
    })
  }

  test.prop([fc.integer()], { numRuns: 60 })('more flags follow the upstream', async seed => {
    const rnd = prng(seed)
    const data = vary(MAXIMAL.orders_search!.data, rnd) as { orders: { nodes: { lineItems: { pageInfo: { hasNextPage: boolean } } }[] } }
    const r = await call('orders_search', { first: 20 }, dataClient(data))
    if (!r.ok) throw new Error(r.error.code)
    const items = (r.value as { items: { moreLines: boolean }[] }).items
    items.forEach((it, i) => expect(it.moreLines).toBe(data.orders.nodes[i]!.lineItems.pageInfo.hasNextPage))

    const og = vary(MAXIMAL.order_get!.data, rnd) as { orders: { nodes: { name: string; refunds: unknown[] }[] } }
    for (const n of og.orders.nodes) n.name = '#AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
    og.orders.nodes = og.orders.nodes.slice(0, 1)
    const g = await call('order_get', { name: '#AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' }, dataClient(og))
    if (!g.ok) throw new Error(g.error.code)
    const order = (g.value as { order: { moreRefunds: boolean } | null }).order
    if (og.orders.nodes[0]) expect(order!.moreRefunds).toBe(og.orders.nodes[0].refunds.length > LIMITS.orderGet.refunds)
  })
})

describe('money', () => {
  const formatter = (minor: bigint, exponent: number) => {
    const neg = minor < 0n
    const digits = (neg ? -minor : minor).toString().padStart(exponent + 1, '0')
    const whole = digits.slice(0, digits.length - exponent)
    const frac = digits.slice(digits.length - exponent)
    // Shopify's Decimal always prints a fraction digit: "1500.0" for JPY.
    return `${neg ? '-' : ''}${whole}.${exponent ? frac : '0'}`
  }

  test.prop([fc.constantFrom('USD', 'JPY', 'KWD', 'EUR'), fc.bigInt({ min: -(2n ** 53n) + 1n, max: 2n ** 53n - 1n })])(
    'decimal to minor is exact for any amount within the exponent, round trip through a formatter',
    (currency, minor) => {
      const exponent = currencyExponent(currency)
      const amount = formatter(minor, exponent)
      expect(money(amount, currency)).toEqual({ minor: Number(minor) || 0, currency })
      // Fewer fraction digits than the exponent is the same amount.
      if (exponent > 0 && amount.endsWith('0')) expect(money(amount.slice(0, -1), currency).minor).toBe(Number(minor) || 0)
    },
  )

  it.each([
    ['0.0', 'JPY', 0],
    ['1500.0', 'JPY', 1500],
    ['1500.00', 'JPY', 1500],
    ['-3.000', 'JPY', -3],
    ['11.5', 'USD', 1150],
    ['11.50', 'USD', 1150],
    ['11.500', 'USD', 1150],
    ['0.100', 'KWD', 100],
  ])('accepts Shopify\'s %s %s as %d minor', (amount, currency, minor) => {
    expect(money(amount, currency)).toEqual({ minor, currency })
  })

  it('knows the exponents', () => {
    expect([currencyExponent('USD'), currencyExponent('JPY'), currencyExponent('KWD')]).toEqual([2, 0, 3])
  })

  it.each([
    ['1.234', 'USD'],
    ['1.5', 'JPY'],
    ['1500.01', 'JPY'],
    ['11.501', 'USD'],
    ['abc', 'USD'],
    ['1e5', 'USD'],
    ['', 'USD'],
    ['1.00', 'usd'],
    ['90071992547409.92', 'USD'],
    [' 1.00', 'USD'],
  ])('refuses %s %s', (amount, currency) => {
    expect(() => money(amount, currency)).toThrow(MapError)
  })
})

describe('instants', () => {
  test.prop([fc.date({ min: new Date('1970-01-01T00:00:00Z'), max: new Date('9999-12-31T23:59:59.999Z'), noInvalidDate: true })])(
    '{ iso, ms } with iso === new Date(ms).toISOString()',
    d => {
      const i = instant(d.toISOString())
      expect(i.ms).toBe(d.getTime())
      expect(i.iso).toBe(new Date(i.ms).toISOString())
    },
  )

  it('normalises an offset', () => {
    expect(instant('2026-11-19T12:00:00+02:00')).toEqual({ iso: '2026-11-19T10:00:00.000Z', ms: Date.UTC(2026, 10, 19, 10) })
  })

  it.each(['2026-11-19', 'yesterday', '2026-13-01T00:00:00Z', '1763510400000', '2026-11-19T10:00:00'])('refuses %s', s => {
    expect(() => instant(s)).toThrow(MapError)
  })
})

describe('string caps', () => {
  // Units that include astral code points (surrogate pairs) and lone surrogates, so "cut at a code point" is exercised.
  const unit = fc.oneof(
    fc.string({ unit: 'grapheme', minLength: 1, maxLength: 1 }),
    fc.constantFrom('🏕', '\ud800', '\udfff', '"', '\\', '\u0001', '\n', 'é', '折'),
  )
  test.prop([fc.string({ unit, maxLength: 400 }), fc.integer({ min: 0, max: 200 })])(
    'never more than the cap in JSON bytes, cut at a code point, a prefix, marked when cut',
    (s, max) => {
      const cut = { truncated: false }
      const out = cap(cut, s, max)
      expect(bytes(out) - 2).toBeLessThanOrEqual(max)
      expect(s.startsWith(out)).toBe(true)
      expect(cut.truncated).toBe(out !== s)
      // Never ends in the high half of a surrogate pair that the input completed.
      if (out.length > 0 && out.length < s.length) {
        const last = out.charCodeAt(out.length - 1)
        const next = s.charCodeAt(out.length)
        expect(last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff).toBe(false)
      }
    },
  )
})
