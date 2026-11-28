// The SDK wrapper's workerd smoke (Stage 1 M4-C1, N36): the official client 2.4.0 on the runtime the hub ships on (its
// workerd export conditions: `_shims` resolves to shimsWorkerd), against M4-F's fixtures in this isolate. One list and
// one call per era, the open-stream plant inside its deadline, and the 2025 handshake's standing-stream GET answered here.
import { describe, expect, it, vi } from 'vitest'
import { createMcpFixtures } from '../../../test/upstreams/mcp/index'
import { HOSTS } from '../../../test/upstreams/mcp/wire'
import { EraCache, sdkCallTool, sdkListTools, type SdkDeps } from './sdk'

const MODERN = `https://${HOSTS.modern}`
const LEGACY = `https://${HOSTS.legacy}`

function setup(): { fx: ReturnType<typeof createMcpFixtures>; deps: SdkDeps } {
  const fx = createMcpFixtures()
  return { fx, deps: { upstream: fx.fetch, now: () => Date.now(), eras: new EraCache(), timeoutMs: 5_000 } }
}

describe('the SDK wrapper on workerd', () => {
  it('modern and legacy each answer a list and a call, with no console output', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map(m => vi.spyOn(console, m))
    const { fx, deps } = setup()
    for (const [url, era] of [[`${MODERN}/open/mcp`, 'modern'], [`${LEGACY}/mcp`, 'legacy']] as const) {
      const t = { endpoint: url, generation: 1, credential: null }
      const list = await sdkListTools(deps, t)
      expect(list).toMatchObject({ kind: 'ok', era })
      expect(list.kind === 'ok' && list.tools.length).toBe(4)
      const out = await sdkCallTool(deps, t, { tool: { name: 'notes_read', inputSchema: { type: 'object' } }, args: { id: 'n2' }, mode: 'read' })
      expect(out).toMatchObject({ kind: 'ok', era })
      expect(out.kind === 'ok' && JSON.parse(out.result.content[0]!.text)).toMatchObject({ id: 'n2' })
    }
    // The 2025 handshake's standing-stream GET never reached the fixture.
    expect(fx.log.entries.filter(e => e.method !== 'POST')).toEqual([])
    for (const s of spies) expect(s).not.toHaveBeenCalled()
    vi.restoreAllMocks()
  })

  it('the open-stream plant answers inside the deadline', async () => {
    const { fx, deps } = setup()
    const started = Date.now()
    const t = { endpoint: `${MODERN}/stream-open/mcp`, generation: 1, credential: null }
    expect(await sdkListTools(deps, t)).toMatchObject({ kind: 'ok' })
    expect(await sdkCallTool(deps, t, { tool: { name: 'notes_read', inputSchema: { type: 'object' } }, args: { id: 'n1' }, mode: 'read' })).toMatchObject({ kind: 'ok' })
    expect(Date.now() - started).toBeLessThan(deps.timeoutMs!)
    expect(fx.modern.streamsCancelled).toBe(4)
  })

  it('a lost read is sent once more; a lost write is not', async () => {
    const { fx, deps } = setup()
    const t = { endpoint: `${MODERN}/lossy/mcp`, generation: 1, credential: null }
    await sdkListTools(deps, t)
    expect(await sdkCallTool(deps, t, { tool: { name: 'notes_read', inputSchema: { type: 'object' } }, args: { id: 'n1' }, mode: 'read' })).toMatchObject({ kind: 'ok' })
    expect(await sdkCallTool(deps, t, { tool: { name: 'notes_search', inputSchema: { type: 'object' } }, args: { query: 'x' }, mode: 'write' })).toMatchObject({ kind: 'error', reason: 'lost', sent: 'unknown' })
    expect(fx.modern.calls.map(c => c.tool)).toEqual(['notes_read', 'notes_read', 'notes_search'])
  })
})
