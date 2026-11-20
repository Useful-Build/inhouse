import { fc, test } from '@fast-check/vitest'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { connectors } from '../connectors/index'
import type { CallerScope } from '../index/contract'
import { buildRegistry, callReadTool, listReadTools, MAX_RESULT_BYTES, type ConnectorModule, type GatewayDeps, type Registry, type ToolDef } from './registry'
import { fixtureConnector } from './testing/fixture-connector'

declare global {
  interface ImportMeta {
    glob(pattern: string, options: { eager: true }): Record<string, Record<string, unknown>>
  }
}

const scope: CallerScope = { kind: 'run', runId: 'run-1', principalId: 'p-1', requestId: 'req-1' }

const tool = (over: Partial<ToolDef<any>> = {}): ToolDef<any> => ({
  name: 'orders_list',
  description: 'Lists orders.',
  mode: 'read',
  input: z.strictObject({ limit: z.number().int().max(50) }),
  run: async (_ctx, input) => ({ ok: true, value: { echoed: input } }),
  ...over,
})
const mod = (over: Partial<ConnectorModule> = {}): ConnectorModule => ({
  id: 'shopify',
  accountId: 'shopify:store',
  apiVersion: '2026-10',
  scopes: { read: ['read_orders', 'read_returns'], required: ['read_returns'] },
  tools: [tool()],
  ...over,
})

describe('buildRegistry startup rules', () => {
  const bad: [string, ConnectorModule[]][] = [
    ['a name not resource_action', [mod({ tools: [tool({ name: 'orders' })] })]],
    ['a camelCase name', [mod({ tools: [tool({ name: 'ordersList' })] })]],
    ['a duplicate name across connectors', [mod(), mod({ id: 'other', accountId: 'other', scopes: { read: [], required: [] } })]],
    ['a write mode', [mod({ tools: [tool({ mode: 'write' as 'read' })] })]],
    ['a non-strict object', [mod({ tools: [tool({ input: z.object({ a: z.string() }) })] })]],
    ['a loose object', [mod({ tools: [tool({ input: z.looseObject({ a: z.string() }) })] })]],
    ['a non-object input', [mod({ tools: [tool({ input: z.string() })] })]],
    ['an input JSON Schema cannot express', [mod({ tools: [tool({ input: z.strictObject({ d: z.date() }) })] })]],
    ['a description over 1,024 characters', [mod({ tools: [tool({ description: 'x'.repeat(1025) })] })]],
    ['a bad connector id', [mod({ id: 'Shopify' })]],
    ['a bad account id', [mod({ accountId: 'shopify:Store!' })]],
    ['a scope outside read_*', [mod({ scopes: { read: ['read_orders', 'read_returns', 'write_orders'], required: ['read_returns'] } })]],
    ['required not within read', [mod({ scopes: { read: ['read_orders'], required: ['read_returns'] } })]],
    ['shopify without read_returns required', [mod({ scopes: { read: ['read_orders', 'read_returns'], required: [] } })]],
    [
      'two connectors disagreeing on one account’s scopes',
      [mod(), mod({ tools: [tool({ name: 'products_list' })], scopes: { read: ['read_products', 'read_returns'], required: ['read_returns'] } })],
    ],
  ]
  for (const [name, modules] of bad) {
    it(`throws on ${name}`, () => {
      expect(() => buildRegistry(modules)).toThrow(/^hub registry: /)
    })
  }

  it('accepts a good module and converts its input to JSON Schema', () => {
    const r = buildRegistry([mod()])
    expect(r.tools.get('orders_list')!.inputSchema).toMatchObject({ type: 'object', additionalProperties: false })
    expect(() => buildRegistry([fixtureConnector])).not.toThrow()
    expect(() => buildRegistry([mod({ tools: [tool({ description: 'x'.repeat(1024) })] })])).not.toThrow()
  })

  test.prop([fc.string({ maxLength: 30 })])('a tool name passes exactly when it is resource_action', name => {
    const accepted = (() => {
      try {
        buildRegistry([mod({ tools: [tool({ name })] })])
        return true
      } catch {
        return false
      }
    })()
    expect(accepted).toBe(/^[a-z]+(?:_[a-z]+)+$/.test(name))
  })
})

describe('registry completeness', () => {
  it('every connectors/*/route.ts on disk is in connectors/index.ts', () => {
    const routes = import.meta.glob('../connectors/*/route.ts', { eager: true })
    const listed = new Set<unknown>(connectors)
    for (const [path, exports] of Object.entries(routes)) {
      const modules = Object.values(exports).filter(v => typeof v === 'object' && v !== null && 'tools' in v && 'accountId' in v)
      expect(modules.length, `${path} exports no connector module`).toBeGreaterThan(0)
      for (const m of modules) expect(listed.has(m), `${path} isn't listed in connectors/index.ts`).toBe(true)
    }
  })

  it('the glob sees files (so an empty match above means no connectors, not a broken pattern)', () => {
    expect(Object.keys(import.meta.glob('./*.ts', { eager: true }))).toContain('./registry.ts')
  })

  it('the fixture connector is never in the list', () => {
    expect((connectors as readonly unknown[]).includes(fixtureConnector)).toBe(false)
  })
})

describe('the read gateway logic (property 9)', () => {
  const deps = (registry: Registry, configured = true, calls: string[] = []): GatewayDeps => ({
    registry,
    isConfigured: () => configured,
    shopifyFor: () => ({
      graphql: async document => {
        calls.push(document)
        return { ok: true, value: { data: null } }
      },
    }),
    nowMs: () => 0,
  })

  /** A registry that skipped buildRegistry's rules, as a P6 module with another mode could reach the gateway. */
  const withMode = (mode: string): Registry => {
    const base = buildRegistry([mod({ tools: [tool({ run: async ctx => ctx.shopify.graphql('{ a }') })] })])
    const t = base.tools.get('orders_list')!
    return { ...base, tools: new Map([['orders_write', { ...t, name: 'orders_write', mode }], ['orders_list', t]]) }
  }

  test.prop([fc.string({ minLength: 1, maxLength: 10 }).filter(m => m !== 'read')])(
    'listTools never shows and callTool never runs a tool that is not read',
    async mode => {
      const calls: string[] = []
      const registry = withMode(mode)
      expect(listReadTools(deps(registry, true, calls)).map(t => t.name)).toEqual(['orders_list'])
      const r = await callReadTool(deps(registry, true, calls), scope, 'orders_write', { limit: 1 })
      expect(r).toEqual({ ok: false, error: { code: 'write_refused', message: 'writes are refused: orders_write' } })
      expect(calls).toEqual([])
    },
  )

  it('unknown tool, bad args and an unconfigured connector', async () => {
    const registry = buildRegistry([mod()])
    const unknown = await callReadTool(deps(registry), scope, 'orders_lost', {})
    expect(!unknown.ok && unknown.error.code).toBe('unknown_tool')
    const badArgs = await callReadTool(deps(registry), scope, 'orders_list', { limit: 500 })
    expect(!badArgs.ok && badArgs.error.code).toBe('invalid_args')
    const extra = await callReadTool(deps(registry), scope, 'orders_list', { limit: 1, more: true })
    expect(!extra.ok && extra.error.code).toBe('invalid_args')
    expect(listReadTools(deps(registry, false))).toEqual([])
    const nc = await callReadTool(deps(registry, false), scope, 'orders_list', { limit: 1 })
    expect(!nc.ok && nc.error.code).toBe('not_configured')
  })

  test.prop([fc.integer({ min: 0, max: 2 * MAX_RESULT_BYTES })])('a result over 32 KiB is result_too_large, never truncated', async size => {
    const registry = buildRegistry([mod({ tools: [tool({ run: async () => ({ ok: true, value: 'é'.repeat(size) }) })] })])
    const r = await callReadTool(deps(registry), scope, 'orders_list', { limit: 1 })
    const bytes = new TextEncoder().encode(JSON.stringify('é'.repeat(size))).byteLength
    if (bytes > MAX_RESULT_BYTES) expect(!r.ok && r.error.code).toBe('result_too_large')
    else expect(r).toEqual({ ok: true, value: { data: 'é'.repeat(size) } })
  })

  it('lists the tool with its connector and JSON Schema', () => {
    const [info] = listReadTools(deps(buildRegistry([mod()])))
    expect(info).toMatchObject({ name: 'orders_list', connector: 'shopify', description: 'Lists orders.' })
    expect(info!.inputSchema).toMatchObject({ type: 'object' })
  })
})
