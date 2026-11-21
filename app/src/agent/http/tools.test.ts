// The client's Tools calls. Ways they can fail: the wrong path or method (an account id built on the client, a key not
// escaped), a body that isn't `{ paused }`, an answer the shared schema refuses passed on, a failure swallowed.
import { describe, expect, test } from 'vitest'
import { AgentError } from '../types'
import { Transport } from './transport'
import { postToolConnect, postToolDisconnect, putToolPaused, readTools } from './tools'

const instant = { iso: '2026-11-20T10:00:00.000Z', ms: Date.parse('2026-11-20T10:00:00.000Z') }
const TOOLS = {
  connected: ['slack'], channels: [], beingConnected: [], lastRead: { default: instant }, catalog: [],
  details: { slack: { name: 'Slack', desc: 'd', ex: [], read: 'r', draft: 'd', run: 'r', conn: 'c', site: 'slack.com', paused: false, canDisconnect: true } },
  connection: {}, setup: {}, readDone: 1,
}

function server(status: number, body: unknown) {
  const calls: { method: string; path: string; body: unknown }[] = []
  const fetch: typeof globalThis.fetch = async (input, init) => {
    calls.push({ method: init?.method ?? 'GET', path: String(input), body: init?.body ? JSON.parse(String(init.body)) : undefined })
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
  }
  const transport = new Transport({ fetch })
  return { transport, calls }
}

describe('tools calls', () => {
  test('route C reads the list through the shared schema', async () => {
    const s = server(200, TOOLS)
    expect(await readTools(s.transport)).toEqual(TOOLS)
    expect(s.calls).toEqual([{ method: 'GET', path: '/api/tools', body: undefined }])
  })
  test('an answer the schema refuses is an unknown error, not passed on', async () => {
    const s = server(200, { ...TOOLS, readDone: -1 })
    await expect(readTools(s.transport)).rejects.toMatchObject({ code: 'unknown' })
  })
  test('route D sends the key and a body of exactly { paused }', async () => {
    const s = server(200, { paused: true })
    expect(await putToolPaused(s.transport, await s.transport.contract(), 'slack', true)).toEqual({ paused: true })
    expect(s.calls).toEqual([{ method: 'PUT', path: '/api/tools/slack/paused', body: { paused: true } }])
  })
  test('route E posts to the key and answers revoked as the server said', async () => {
    const s = server(200, { revoked: false })
    expect(await postToolDisconnect(s.transport, 'slack')).toEqual({ revoked: false })
    expect(s.calls).toEqual([{ method: 'POST', path: '/api/tools/slack/disconnect', body: {} }])
  })
  test('connect answers only the authorize URL, whatever else the server adds', async () => {
    const s = server(200, { authorizeUrl: 'https://slack.com/oauth/v2/authorize?x=1', expiresAt: instant })
    expect(await postToolConnect(s.transport, 'slack')).toEqual({ authorizeUrl: 'https://slack.com/oauth/v2/authorize?x=1' })
    expect(s.calls[0]).toEqual({ method: 'POST', path: '/api/connect/slack/start', body: {} })
  })
  test('a key is escaped into the path', async () => {
    const s = server(200, { revoked: true })
    await postToolDisconnect(s.transport, 'a/b')
    expect(s.calls[0]?.path).toBe('/api/tools/a%2Fb/disconnect')
  })
  test('a refusal rejects with the error code', async () => {
    const s = server(409, { error: { code: 'conflict', reason: 'not_disconnectable' } })
    const e = await postToolDisconnect(s.transport, 'shopify').catch((x: unknown) => x)
    expect(e).toBeInstanceOf(AgentError)
    expect(e).toMatchObject({ code: 'conflict', reason: 'not_disconnectable' })
  })
})
