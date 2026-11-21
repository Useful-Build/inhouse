// Today's contract (p4-w3.md sections 2 and 7). Ways it can fail, written down first:
//  1. the wire schema keeps a keyword the API's constrained decoding refuses (maxLength, minItems, pattern, format, ...),
//     so the first real run is rejected; or drops a limit instead of moving it into the field's description;
//  2. the wire schema is over the SDK's cap (16 KiB, 64 levels) and is refused at parse;
//  3. the largest valid result is over R3's 64 KiB `structuredOutput` cap (the test holds it under 60 KiB).
import { describe, expect, it } from 'vitest'
import { OutputFormat } from '../protocol/index.ts'
import { MorningCheckResultSchema, SEVERITIES, AREAS, morningCheckWireSchema, reduceSchema } from './today.ts'

const REFUSED = ['maxLength', 'minLength', 'maxItems', 'minItems', 'pattern', 'format', 'minimum', 'maximum', '$schema', 'additionalItems']
const keysOf = (v: unknown, out = new Set<string>()): Set<string> => {
  if (Array.isArray(v)) for (const x of v) keysOf(x, out)
  else if (v !== null && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) {
      // `properties` names fields: only its values are schemas.
      if (k === 'properties') for (const s of Object.values(x as object)) keysOf(s, out)
      else {
        out.add(k)
        keysOf(x, out)
      }
    }
  }
  return out
}

describe('the wire schema', () => {
  const wire = morningCheckWireSchema()
  it('holds none of the refused keywords, and every object is closed', () => {
    const keys = keysOf(wire)
    for (const k of REFUSED) expect(keys.has(k), k).toBe(false)
    const closed = (n: unknown): boolean => {
      if (Array.isArray(n)) return n.every(closed)
      if (n === null || typeof n !== 'object') return true
      const o = n as Record<string, unknown>
      const types = Array.isArray(o.type) ? o.type : [o.type]
      return (!types.includes('object') || o.additionalProperties === false) && Object.values(o).every(closed)
    }
    expect(closed(wire)).toBe(true)
  })

  it('closes every object node, the `cost` money object included, and writes each nullable as anyOf with a null type', () => {
    const objects: { path: string; closed: boolean }[] = []
    const walk = (n: unknown, path: string): void => {
      if (Array.isArray(n)) return n.forEach((x, i) => walk(x, `${path}[${i}]`))
      if (n === null || typeof n !== 'object') return
      const o = n as Record<string, unknown>
      const types = Array.isArray(o.type) ? o.type : [o.type]
      if (types.includes('object')) objects.push({ path, closed: o.additionalProperties === false })
      for (const [k, v] of Object.entries(o)) {
        if (k === 'properties') for (const [p, sch] of Object.entries(v as object)) walk(sch, `${path}.${p}`)
        else walk(v, `${path}.${k}`)
      }
    }
    walk(wire, 'wire')
    expect(objects.length).toBe(4) // the result, an item, its cost (inside the anyOf) and a source
    expect(objects.filter(o => !o.closed)).toEqual([])
    expect(objects.some(o => o.path.includes('cost'))).toBe(true)
    const item = (wire.properties as { items: { items: { properties: Record<string, unknown> } } }).items.items.properties
    expect(item.cost).toMatchObject({ anyOf: [{ type: 'object', additionalProperties: false }, { type: 'null' }] })
    expect(item.since).toMatchObject({ anyOf: [{ type: 'string' }, { type: 'null' }] })
    expect(JSON.stringify(wire)).not.toMatch(/"type":\[/)
  })

  it("moves each maximum into the field's description", () => {
    const item = (wire.properties as { items: { items: { properties: Record<string, { description?: string }> } } }).items
    expect(item.items.properties.title.description).toBe('at most 120 characters; at least 1 character')
    expect(item.items.properties.found.description).toBe('at most 6 items')
    expect((wire.properties as { items: { description?: string } }).items.description).toBe('at most 10 items')
    expect(item.items.properties.since).toMatchObject({ description: 'at most 40 characters' })
  })

  it('passes the SDK caps (16 KiB, 64 levels) as P3 checks them', () => {
    expect(OutputFormat.safeParse({ type: 'json_schema', schema: wire }).success).toBe(true)
    expect(JSON.stringify(wire).length).toBeLessThan(16 * 1024)
  })

  it('refuses a union that is not a nullable', () => {
    expect(() => reduceSchema({ anyOf: [{ type: 'string' }, { type: 'number' }] })).toThrow()
  })
})

describe('the largest valid result', () => {
  const s = (n: number) => 'a'.repeat(n)
  const item = (i: number) => ({
    key: `k${i}-aaaa-bbbb-cccc-dddd-eeee`.slice(0, 48), sev: SEVERITIES[0], area: AREAS[0], title: s(120), sub: s(200), cost: { minor: Number.MAX_SAFE_INTEGER, currency: 'USD' },
    costNote: s(100), next: s(140), found: Array.from({ length: 6 }, () => [s(160), s(160)]), sources: Array.from({ length: 10 }, () => ({ n: s(40), text: s(160) })), since: s(40),
  })
  it('is valid and under 60 KiB as JSON (ASCII text: a character outside it takes more bytes, and R3 caps bytes)', () => {
    const big = { coverage: 'complete', gaps: ['orders', 'products', 'inventory', 'refunds', 'returns'], items: Array.from({ length: 10 }, (_, i) => item(i)) }
    expect(MorningCheckResultSchema.safeParse(big).success).toBe(true)
    expect(new TextEncoder().encode(JSON.stringify(big)).length).toBeLessThan(60 * 1024)
  })
})
