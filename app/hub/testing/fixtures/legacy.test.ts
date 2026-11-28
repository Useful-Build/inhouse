// The legacy fixture (app/test/upstreams/mcp/legacy.ts, MCP 2025-11-25): raw requests answer as the 2025-11-25 pages
// say, and a 2026-07-28 client's first request is refused in a way that makes it fall back (streamable-http 2026-07-28
// "Backward Compatibility").
import { beforeEach, describe, expect, it } from 'vitest'
import type { McpFixtures } from '../../../test/upstreams/mcp/index'
import { legacyInitialize, legacyRequest } from '../../../test/upstreams/mcp/legacy'
import { fixtures, LEGACY, modern, rpcOf, signIn } from './kit'

let fx: McpFixtures
beforeEach(() => {
  fx = fixtures()
})

async function session(url = `${LEGACY}/mcp`): Promise<string> {
  const res = await fx.fetch(legacyInitialize(url))
  expect(res.status).toBe(200)
  return res.headers.get('Mcp-Session-Id')!
}

describe('2025-11-25 lifecycle and sessions (basic/lifecycle, basic/transports)', () => {
  it('initialize answers the version asked, a session id, and the initialized notification is 202', async () => {
    const res = await fx.fetch(legacyInitialize(`${LEGACY}/mcp`, 1))
    const sid = res.headers.get('Mcp-Session-Id')
    expect(sid).toMatch(/^[\x21-\x7e]+$/)
    expect((await rpcOf(res)).result).toMatchObject({ protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'fixture-legacy' } })
    const note = await fx.fetch(legacyRequest(`${LEGACY}/mcp`, sid, { method: 'notifications/initialized' }))
    expect(note.status).toBe(202)
    // "Version Negotiation": an unknown version gets the server's own latest.
    expect((await rpcOf(await fx.fetch(legacyInitialize(`${LEGACY}/mcp`, 2, '2099-01-01')))).result!.protocolVersion).toBe('2025-11-25')
  })

  it('later requests need the session (400 without, 404 unknown), and a supported MCP-Protocol-Version (400 otherwise)', async () => {
    const sid = await session()
    const list = await rpcOf(await fx.fetch(legacyRequest(`${LEGACY}/mcp`, sid, { id: 2, method: 'tools/list' })))
    expect((list.result!.tools as { name: string }[]).map(t => t.name)).toEqual(['notes_search', 'notes_read'])
    expect(list.result!.nextCursor).toBe('page-2')
    const none = await fx.fetch(legacyRequest(`${LEGACY}/mcp`, null, { id: 3, method: 'tools/list' }))
    expect(none.status).toBe(400)
    const unknown = await fx.fetch(legacyRequest(`${LEGACY}/mcp`, 'no-such', { id: 4, method: 'tools/list' }))
    expect(unknown.status).toBe(404)
    const badVersion = await fx.fetch(legacyRequest(`${LEGACY}/mcp`, sid, { id: 5, method: 'tools/list' }, '2099-01-01'))
    expect(badVersion.status).toBe(400)
  })

  it('a tool call answers in band; DELETE ends the session (then 404); GET is 405 (no standalone stream)', async () => {
    const sid = await session()
    const r = await rpcOf(await fx.fetch(legacyRequest(`${LEGACY}/mcp`, sid, { id: 2, method: 'tools/call', params: { name: 'notes_read', arguments: { id: 'n1' } } })))
    expect(r.result).toMatchObject({ isError: false, content: [{ type: 'text' }] })
    expect(r.result!.resultType).toBeUndefined()
    expect(fx.legacy.calls).toEqual([{ endpoint: '/mcp', tool: 'notes_read', args: { id: 'n1' }, session: sid }])
    expect((await fx.fetch(new Request(`${LEGACY}/mcp`, { headers: { Accept: 'text/event-stream', 'Mcp-Session-Id': sid } }))).status).toBe(405)
    expect((await fx.fetch(new Request(`${LEGACY}/mcp`, { method: 'DELETE', headers: { 'Mcp-Session-Id': sid } }))).status).toBe(200)
    expect((await fx.fetch(legacyRequest(`${LEGACY}/mcp`, sid, { id: 3, method: 'tools/list' }))).status).toBe(404)
  })

  it('/sse/mcp answers on an SSE stream with event ids (2025-11-25 "Sending Messages" 6) and ends it', async () => {
    const res = await fx.fetch(legacyInitialize(`${LEGACY}/sse/mcp`, 9))
    expect(res.headers.get('Content-Type')).toBe('text/event-stream')
    const text = await res.text()
    expect(text.startsWith('id: ev-0\ndata: \n\n')).toBe(true)
    expect(JSON.parse(text.split('\n').find(l => l.startsWith('data: {'))!.slice(6))).toMatchObject({ id: 9, result: { protocolVersion: '2025-11-25' } })
  })
})

describe('a 2026-07-28 client meets it (streamable-http 2026-07-28 "Backward Compatibility")', () => {
  it('the modern first request gets 400 with no recognised modern error, so the client falls back to initialize, which works', async () => {
    const probe = await modern(fx, `${LEGACY}/mcp`, 'server/discover')
    expect(probe.status).toBe(400)
    const code = (await rpcOf(probe)).error!.code
    expect([-32020, -32021, -32022]).not.toContain(code)
    expect(await session()).toBeTruthy()
  })

  it('a signed-in endpoint checks the tool scope: a notes:read token gets 403 insufficient_scope on notes_write, and the write never runs (#631)', async () => {
    const url = `${LEGACY}/as/std/mcp`
    const s = await signIn(fx, 'std', { resource: url, scope: 'notes:read', client: 'app' })
    const init = await fx.fetch(new Request(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${s.access}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 't', version: '1' } } }) }))
    const sid = init.headers.get('Mcp-Session-Id')!
    const callAs = (name: string, args: Record<string, unknown>) => {
      const r = legacyRequest(url, sid, { id: 2, method: 'tools/call', params: { name, arguments: args } })
      r.headers.set('Authorization', `Bearer ${s.access}`)
      return fx.fetch(r)
    }
    const write = await callAs('notes_write', { folder: 'ops', text: 'x' })
    expect(write.status).toBe(403)
    expect(write.headers.get('WWW-Authenticate')).toBe(`Bearer error="insufficient_scope", scope="notes:write", resource_metadata="${LEGACY}/.well-known/oauth-protected-resource/as/std/mcp"`)
    expect(fx.legacy.writes).toEqual([])
    // Control: a read the token's scope covers runs.
    expect((await callAs('notes_read', { id: 'n1' })).status).toBe(200)
    expect(fx.legacy.calls.map(c => c.tool)).toEqual(['notes_read'])
  })

  it('a signed-in endpoint answers 401 with the same Bearer challenge shape', async () => {
    const res = await fx.fetch(legacyInitialize(`${LEGACY}/as/std/mcp`))
    expect(res.status).toBe(401)
    expect(res.headers.get('WWW-Authenticate')).toContain(`resource_metadata="${LEGACY}/.well-known/oauth-protected-resource/as/std/mcp"`)
  })
})
