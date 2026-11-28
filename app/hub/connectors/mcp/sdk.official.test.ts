// Two independent witnesses for the SDK wrapper and M4-F's fakes (Stage 1 M4-C1, N36), in Node only: the official
// @modelcontextprotocol/server 2.4.0 (a hub dev dependency, never bundled) serving the fakes' own notes tools.
// 1. The cross-check: the wrapper lists and calls through the official server in both eras, and gets what the fakes give.
// 2. The differential test: M4-F's raw request vectors (app/test/upstreams/mcp/vectors.ts) go to the official server and
//    to our fake, and the normalised answers must be equal, field by field. So the fake can't share a misreading of the
//    spec with the wrapper. Where the two differ on purpose, the difference is listed below with its reason, and the test
//    fails if it stops being a difference (a stale exception).
// Server API read in the package's source map on 2026-11-28: createMcpHandler (src/server/createMcpHandler.ts, `legacy:
// 'reject'` for a modern-only endpoint, the default `'stateless'` for both eras), WebStandardStreamableHTTPServerTransport
// (src/server/streamableHttp.ts, sessionful with `sessionIdGenerator`), McpServer.registerTool with fromJsonSchema.
import { createMcpHandler, fromJsonSchema, McpServer, WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LEGACY_VECTORS, MODERN_VECTORS, normalise, vectorRequest, type Normalised, type RawVector } from '../../../test/upstreams/mcp/vectors'
import { notesTools } from '../../../test/upstreams/mcp/modern'
import { legacyInitialize } from '../../../test/upstreams/mcp/legacy'
import { fixtures, LEGACY, MODERN } from '../../testing/fixtures/kit'
import { EraCache, ERA_TTL_MS, sdkCallTool, sdkListTools, type SdkDeps } from './sdk'

const OFFICIAL = 'https://official.mcp-fixtures.example.com'

/** The fakes' notes tools on an official McpServer: same names, schemas and answers. */
function officialServer(): McpServer {
  // The fakes' instructions line, so discover and initialize answers carry the same fields.
  const server = new McpServer({ name: 'fixture-official', version: '1.0.0' }, { instructions: 'UPSTREAM TEXT: fixture server instructions.' })
  for (const tool of notesTools([])) {
    server.registerTool(
      tool.def.name,
      {
        ...(tool.def.title !== undefined ? { title: tool.def.title } : {}),
        description: tool.def.description,
        inputSchema: fromJsonSchema(tool.def.inputSchema as Parameters<typeof fromJsonSchema>[0]),
        ...(tool.def.annotations ? { annotations: tool.def.annotations } : {}),
      },
      async (args: unknown) => {
        const out = await tool.run(args as Record<string, unknown>, { endpoint: '/official', declaredCapabilities: {}, params: {} })
        if (out.kind !== 'result') throw new Error('the notes tools only answer results')
        return { content: [{ type: 'text' as const, text: JSON.stringify(out.value) }], isError: false }
      },
    )
  }
  return server
}

let errors: Error[]
beforeEach(() => {
  errors = []
  for (const m of ['log', 'info', 'warn', 'error', 'debug'] as const) vi.spyOn(console, m).mockImplementation(() => {})
})
afterEach(() => {
  vi.restoreAllMocks()
})

describe('cross-check: the wrapper through the official server', () => {
  it('modern: lists the same tools as the fake and calls with mirrored headers', async () => {
    const handler = createMcpHandler(() => officialServer(), { legacy: 'reject', responseMode: 'json', onerror: e => errors.push(e) })
    const fx = fixtures()
    const deps: SdkDeps = { upstream: req => (new URL(req.url).origin === OFFICIAL ? handler.fetch(req) : fx.fetch(req)), now: () => 0, eras: new EraCache(), timeoutMs: 2_000 }
    const official = await sdkListTools(deps, { endpoint: `${OFFICIAL}/mcp`, generation: 1, credential: null })
    const fake = await sdkListTools(deps, { endpoint: `${MODERN}/open/mcp`, generation: 1, credential: null })
    expect(official).toMatchObject({ kind: 'ok', era: 'modern' })
    const shape = (l: typeof official) => (l.kind === 'ok' ? l.tools.map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) : null)
    expect(shape(official)).toEqual(shape(fake))
    const call = { tool: { name: 'region_lookup', inputSchema: { type: 'object' as const, properties: { region: { type: 'string', 'x-mcp-header': 'Region' } } } }, args: { region: 'Zürich' }, mode: 'read' as const }
    const a = await sdkCallTool(deps, { endpoint: `${OFFICIAL}/mcp`, generation: 1, credential: null }, call)
    const b = await sdkCallTool(deps, { endpoint: `${MODERN}/open/mcp`, generation: 1, credential: null }, call)
    expect(a).toMatchObject({ kind: 'ok', era: 'modern' })
    expect(a.kind === 'ok' && a.result).toEqual(b.kind === 'ok' && b.result)
    // A call missing its x-mcp-header mirror is refused by the official server too (-32020), so the fake's rule is the spec's.
    const bare = await sdkCallTool(deps, { endpoint: `${OFFICIAL}/mcp`, generation: 1, credential: null }, { ...call, tool: { name: 'region_lookup', inputSchema: { type: 'object' } } })
    expect(bare).toMatchObject({ kind: 'error', reason: 'header_mismatch' })
    await handler.close()
  })

  it('legacy: a cached 2025 verdict runs the handshake on the official stateless leg and calls', async () => {
    const handler = createMcpHandler(() => officialServer(), { responseMode: 'json', onerror: e => errors.push(e) })
    const deps: SdkDeps = { upstream: req => handler.fetch(req), now: () => 0, eras: new EraCache(), timeoutMs: 2_000 }
    deps.eras.set(`${OFFICIAL}/mcp`, 1, { kind: 'legacy' }, ERA_TTL_MS)
    const out = await sdkCallTool(deps, { endpoint: `${OFFICIAL}/mcp`, generation: 1, credential: null }, { tool: { name: 'notes_search', inputSchema: { type: 'object' } }, args: { query: 'fern' }, mode: 'read' })
    expect(out).toMatchObject({ kind: 'ok', era: 'legacy' })
    expect(out.kind === 'ok' && JSON.parse(out.result.content[0]!.text)).toEqual([expect.objectContaining({ id: 'n1' })])
    // With no verdict, the same dual-era server probes modern.
    expect(await sdkListTools({ ...deps, eras: new EraCache() }, { endpoint: `${OFFICIAL}/mcp`, generation: 1, credential: null })).toMatchObject({ kind: 'ok', era: 'modern' })
    await handler.close()
  })
})

/**
 * Where the fake and the official server differ on purpose: vector id, the fields that differ, and why. Each must still
 * differ (else the exception is stale and goes).
 */
const MODERN_DIFFERENCES: Record<string, { fields: (keyof Normalised)[]; why: string }> = {
  list: { fields: ['resultKeys'], why: 'page size is the server\'s choice (server/tools "Pagination"): the fake pages at 2 tools so cursors get exercised, the official server sends all 4 at once, so only the fake has nextCursor' },
}
const LEGACY_DIFFERENCES: Record<string, { fields: (keyof Normalised)[]; why: string }> = {
  'list-on-session': {
    fields: ['resultKeys', 'session'],
    why: 'pages, as above; and the official transport repeats Mcp-Session-Id on every answer, where 2025-11-25 transports "Session Management" 1 asks for it only on the InitializeResult (both are allowed; the client keeps the first)',
  },
  get: {
    fields: ['body', 'code', 'session', 'status'],
    why: 'the fake offers no standing stream (405 with -32000, transports "Listening for Messages from the Server" 3); the official sessionful transport opens one (200, an event stream that stays open, with its session header). Both are allowed; the hub never sends a GET either way',
  },
}

/** Normalised, but a GET's open event stream is not read (it never ends): its status and type are enough. */
async function normaliseOpen(res: Response, v: RawVector): Promise<Normalised> {
  if (v.request.method === 'GET' && (res.headers.get('Content-Type') ?? '').includes('text/event-stream')) {
    await res.body?.cancel()
    return { status: res.status, body: 'sse', session: res.headers.get('Mcp-Session-Id') !== null }
  }
  return normalise(res)
}

function compare(v: RawVector, fake: Normalised, official: Normalised, known: Record<string, { fields: (keyof Normalised)[]; why: string }>) {
  const diff = (Object.keys({ ...fake, ...official }) as (keyof Normalised)[]).filter(k => JSON.stringify(fake[k]) !== JSON.stringify(official[k])).sort()
  expect(diff, `${v.id}: ${v.rule}`).toEqual([...(known[v.id]?.fields ?? [])].sort())
  if (known[v.id]) expect(known[v.id]!.why.length).toBeGreaterThan(20)
}

describe('differential: the raw vectors, the fake and the official server', () => {
  it.each(MODERN_VECTORS.map(v => [v.id, v] as const))('modern %s', async (_id, v) => {
    const handler = createMcpHandler(() => officialServer(), { legacy: 'reject', responseMode: 'json', onerror: e => errors.push(e) })
    const fake = await normalise(await fixtures().fetch(vectorRequest(v, MODERN)))
    const official = await normalise(await handler.fetch(vectorRequest(v, OFFICIAL)))
    expect(fake).toMatchObject(v.expect)
    compare(v, fake, official, MODERN_DIFFERENCES)
    await handler.close()
  })

  it.each(LEGACY_VECTORS.map(v => [v.id, v] as const))('legacy %s', async (_id, v) => {
    // A sessionful 2025 server: one official transport, initialised first when the vector names a session.
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: () => 'official-session-0001', enableJsonResponse: true })
    await officialServer().connect(transport)
    // Both servers are live (one session each) before the vector, so "unknown session" means unknown, not "not started".
    // (An initialize vector is itself the first request.)
    const fx = fixtures()
    const first = (v.request.body as { method?: string } | undefined)?.method !== 'initialize'
    const fakeSession = first ? (await fx.fetch(legacyInitialize(`${LEGACY}/mcp`, 99))).headers.get('Mcp-Session-Id')! : undefined
    const officialSession = first ? (await transport.handleRequest(legacyInitialize(`${OFFICIAL}/mcp`, 99))).headers.get('Mcp-Session-Id')! : undefined
    const fake = await normalise(await fx.fetch(vectorRequest(v, LEGACY, fakeSession)))
    const official = await normaliseOpen(await transport.handleRequest(vectorRequest(v, OFFICIAL, officialSession)), v)
    expect(fake).toMatchObject(v.expect)
    compare(v, fake, official, LEGACY_DIFFERENCES)
    await transport.close()
  })
})
