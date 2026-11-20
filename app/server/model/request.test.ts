// The gate's look at a request (p3-design 8.2). Expected bodies and byte counts are literals. Ways it can fail, written
// down first:
//  1. a refused shape passes: mcp_servers, service_tier, container, a server tool other than web_search, a url or file
//     source (nested in a tool result too), an unpriced modifier or cache TTL;
//  2. max_tokens or max_uses not clamped, or max_uses left unbounded when absent;
//  3. the projection carries a field count_tokens doesn't take (max_tokens, stream, metadata) or a server tool;
//  4. the byte bound misses an image or PDF page allowance, or counts base64 bytes as text;
//  5. the highest input-side rate is wrong (1-hour write anywhere in the request must win).
import { describe, expect, it } from 'vitest'
import { CATALOG } from './catalog.ts'
import { inspectRequest, pdfPages } from './request.ts'
import type { Inspected } from './request.ts'

const SONNET = CATALOG.find(m => m.id === 'sonnet')!.price!
const user = (content: unknown) => ({ role: 'user', content })
const base = { model: 'claude-sonnet-5-5', max_tokens: 1000, messages: [user('hi')] }
const ok = (body: unknown): Inspected => {
  const r = inspectRequest(body, SONNET)
  if ('refused' in r) throw new Error(`refused: ${r.refused}`)
  return r
}
const refused = (body: unknown) => {
  const r = inspectRequest(body, SONNET)
  return 'refused' in r ? r.refused : null
}
const b64 = (s: string) => btoa(s)

describe('refusals (failure 1)', () => {
  it('refuses each shape the gate has no price for, with 400 text', () => {
    const cases: Record<string, unknown> = {
      mcp_servers: { ...base, mcp_servers: [{ type: 'url', url: 'https://mcp.example.test', name: 'x' }] },
      service_tier: { ...base, service_tier: 'auto' },
      container: { ...base, container: 'cntr_x' },
      code_execution: { ...base, tools: [{ type: 'code_execution_20250825', name: 'code_execution' }] },
      web_fetch: { ...base, tools: [{ type: 'web_fetch_20250910', name: 'web_fetch' }] },
      url_image: { ...base, messages: [user([{ type: 'image', source: { type: 'url', url: 'https://x.example.test/a.png' } }])] },
      file_document: { ...base, messages: [user([{ type: 'document', source: { type: 'file', file_id: 'file_1' } }])] },
      nested_url: { ...base, messages: [user([{ type: 'tool_result', tool_use_id: 't', content: [{ type: 'image', source: { type: 'url', url: 'https://x.example.test' } }] }])] },
      fast: { ...base, speed: 'fast' },
      geo_us: { ...base, inference_geo: 'us' },
      ttl: { ...base, system: [{ type: 'text', text: 's', cache_control: { type: 'ephemeral', ttl: '24h' } }] },
      max_tokens: { ...base, max_tokens: 0 },
      no_messages: { model: 'claude-sonnet-5-5', max_tokens: 10 },
    }
    for (const [name, body] of Object.entries(cases)) expect(refused(body), name).not.toBeNull()
  })
  it('passes standard speed, global geo and client tools', () => {
    expect(refused({ ...base, speed: 'standard', inference_geo: 'global', tools: [{ name: 'Bash', input_schema: { type: 'object' } }, { type: 'custom', name: 'X', input_schema: { type: 'object' } }] })).toBeNull()
  })
})

describe('clamps (failure 2)', () => {
  it('max_tokens to 32,000; web_search max_uses to 5, and 5 when absent', () => {
    const r = ok({ ...base, max_tokens: 64_000, tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 9 }] })
    expect(r.maxTokens).toBe(32_000)
    expect(r.body.max_tokens).toBe(32_000)
    expect(r.body.tools).toEqual([{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }])
    expect(r.searchUses).toBe(5)
    const absent = ok({ ...base, tools: [{ type: 'web_search_20260209', name: 'web_search' }] })
    expect(absent.body.tools).toEqual([{ type: 'web_search_20260209', name: 'web_search', max_uses: 5 }])
    expect(ok({ ...base, tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 2 }] }).searchUses).toBe(2)
  })
})

describe('the projection (failure 3)', () => {
  it("holds only count_tokens's fields, server tools removed", () => {
    const body = {
      model: 'claude-sonnet-5-5', max_tokens: 2000, stream: true, metadata: { user_id: 'u' }, stop_sequences: ['x'],
      system: 's', messages: [user('hi')], thinking: { type: 'enabled', budget_tokens: 1024 }, tool_choice: { type: 'auto' },
      output_config: { effort: 'high' },
      tools: [{ name: 'Bash', input_schema: { type: 'object' } }, { type: 'web_search_20250305', name: 'web_search' }],
    }
    expect(ok(body).projection).toEqual({
      model: 'claude-sonnet-5-5', system: 's', messages: [user('hi')], thinking: { type: 'enabled', budget_tokens: 1024 },
      tool_choice: { type: 'auto' }, output_config: { effort: 'high' }, tools: [{ name: 'Bash', input_schema: { type: 'object' } }],
    })
    expect(ok({ ...base, tools: [{ type: 'web_search_20250305', name: 'web_search' }] }).projection).toEqual({ model: 'claude-sonnet-5-5', messages: [user('hi')] })
  })
})

describe('the byte bound (failure 4)', () => {
  const len = (s: string) => new TextEncoder().encode(s).length
  it('is the JSON text of the request, base64 out, + 5,000 per image and per PDF page', () => {
    expect(ok(base).byteBound).toBe(len('{"messages":[{"role":"user","content":"hi"}]}'))
    const img = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: b64('x'.repeat(3000)) } }
    expect(ok({ ...base, messages: [user([img])] }).byteBound).toBe(
      len('{"messages":[{"role":"user","content":[{"type":"image","source":{"type":"base64","media_type":"image/png","data":""}}]}]}') + 5000)
    const pdf = '%PDF-1.4\n1 0 obj << /Type /Pages /Kids [2 0 R 3 0 R] >> endobj\n2 0 obj << /Type /Page >> endobj\n3 0 obj << /Type/Page >> endobj\n'
    const doc = { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64(pdf) } }
    const r = ok({ ...base, messages: [user([doc])] })
    expect(r.byteBound).toBe(len('{"messages":[{"role":"user","content":[{"type":"document","source":{"type":"base64","media_type":"application/pdf","data":""}}]}]}') + 2 * 5000)
    expect(r.mustCount).toBe(false)
  })
  it('a PDF whose pages are not visible is guessed at 3,000 bytes a page and always counted', () => {
    const packed = `%PDF-1.5\n${'x'.repeat(9001)}`
    expect(pdfPages(new TextEncoder().encode(packed))).toBeNull()
    const r = ok({ ...base, messages: [user([{ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64(packed) } }])] })
    expect(r.mustCount).toBe(true)
    expect(r.byteBound % 5000).toBe(len('{"messages":[{"role":"user","content":[{"type":"document","source":{"type":"base64","media_type":"application/pdf","data":""}}]}]}') % 5000)
    expect(Math.floor(r.byteBound / 5000)).toBe(4)
  })
})

describe('the input-side rate (failure 5)', () => {
  it('input with no cache_control; 5-minute with one; 1-hour when any asks for an hour', () => {
    expect(ok(base).rate).toBe('input')
    expect(ok({ ...base, cache_control: { type: 'ephemeral' } }).rate).toBe('cacheWrite5m')
    const sys5 = [{ type: 'text', text: 'a', cache_control: { type: 'ephemeral', ttl: '5m' } }]
    expect(ok({ ...base, system: sys5 }).rate).toBe('cacheWrite5m')
    const deep = [user([{ type: 'text', text: 'b', cache_control: { type: 'ephemeral', ttl: '1h' } }])]
    expect(ok({ ...base, system: sys5, messages: deep }).rate).toBe('cacheWrite1h')
    expect(ok({ ...base, cache_control: { type: 'ephemeral', ttl: '1h' } }).rate).toBe('cacheWrite1h')
  })
})
