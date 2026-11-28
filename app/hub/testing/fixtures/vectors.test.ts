// The raw request vectors (app/test/upstreams/mcp/vectors.ts) against our fixtures: each answers as its rule says.
// M4-C1's differential test sends the same vectors to the official @modelcontextprotocol/server 2.4.0.
import { describe, expect, it } from 'vitest'
import { LEGACY_VECTORS, MODERN_VECTORS, normalise, vectorRequest } from '../../../test/upstreams/mcp/vectors'
import { legacyInitialize } from '../../../test/upstreams/mcp/legacy'
import { fixtures, LEGACY, MODERN } from './kit'

describe('modern vectors (2026-07-28)', () => {
  it.each(MODERN_VECTORS.map(v => [v.id, v] as const))('%s', async (_id, v) => {
    expect(v.rule.length).toBeGreaterThan(10)
    const fx = fixtures()
    expect(await normalise(await fx.fetch(vectorRequest(v, MODERN)))).toMatchObject(v.expect)
  })
})

describe('legacy vectors (2025-11-25)', () => {
  it.each(LEGACY_VECTORS.map(v => [v.id, v] as const))('%s', async (_id, v) => {
    expect(v.rule.length).toBeGreaterThan(10)
    const fx = fixtures()
    const session = JSON.stringify(v.request.headers).includes('{session}') ? (await fx.fetch(legacyInitialize(`${LEGACY}/mcp`, 99))).headers.get('Mcp-Session-Id')! : undefined
    expect(await normalise(await fx.fetch(vectorRequest(v, LEGACY, session)))).toMatchObject(v.expect)
  })

  it('ids are unique within each set', () => {
    for (const set of [MODERN_VECTORS, LEGACY_VECTORS]) expect(new Set(set.map(v => v.id)).size).toBe(set.length)
  })
})
