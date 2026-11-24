import { fc, test } from '@fast-check/vitest'
import { globSync, readFileSync } from 'node:fs'
import { join, matchesGlob } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { connectors } from '../connectors/index'
import type { CallerScope } from '../index/contract'
import { err } from '../index/errors'
import {
  buildRegistry,
  callReadTool,
  listReadTools,
  MAX_RESULT_BYTES,
  MCP_SCOPE,
  toolNameForLog,
  type ConnectorModule,
  type GatewayDeps,
  type Registry,
  type ToolDef,
} from './registry'
import { FIXTURE_ACCOUNT, fixtureConnector } from './testing/fixture-connector'

describe('MCP scope handles', () => {
  it.each([
    ['channels:history', true],
    ['search:read.public', true],
    ['search.read', true],
    ['search:read:public', true],
    ['a..', true],
    ['a:.:b', true],
    ['history', false],
    ['Channels:history', false],
    ['channels:history2', false],
    ['channels:', false],
    ['channels::history', false],
    ['channels.:history', false],
    ['channels:history\n', false],
  ])('matches %j → %j', (scope, accepted) => {
    expect(MCP_SCOPE.test(scope)).toBe(accepted)
  })

  it('rejects a long malformed scope with repeated dots in under 500 ms', () => {
    const scope = 'a.' + '..'.repeat(20_000) + '!'
    const start = performance.now()
    const accepted = MCP_SCOPE.test(scope)
    expect(performance.now() - start).toBeLessThan(500)
    expect(accepted).toBe(false)
  })
})

const HUB = fileURLToPath(new URL('..', import.meta.url).href)
/** Where a connector's route lives, relative to app/hub. */
const ROUTE_GLOB = 'connectors/*/route.ts'

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
  // Each case differs from the valid mod() in one way only, and names the exact message its rule throws.
  const bad: [string, ConnectorModule[], string][] = [
    ['a name not resource_action', [mod({ tools: [tool({ name: 'orders' })] })], 'tool name "orders" isn\'t resource_action'],
    ['a camelCase name', [mod({ tools: [tool({ name: 'ordersList' })] })], 'tool name "ordersList" isn\'t resource_action'],
    ['a duplicate name across connectors', [mod(), mod()], 'duplicate tool name "orders_list"'],
    ['a write mode', [mod({ tools: [tool({ mode: 'write' as 'read' })] })], 'tool "orders_list" isn\'t mode read'],
    ['a non-strict object', [mod({ tools: [tool({ input: z.object({ limit: z.number() }) })] })], 'tool "orders_list" input isn\'t a strict z.object'],
    ['a loose object', [mod({ tools: [tool({ input: z.looseObject({ limit: z.number() }) })] })], 'tool "orders_list" input isn\'t a strict z.object'],
    ['a non-object input', [mod({ tools: [tool({ input: z.string() })] })], 'tool "orders_list" input isn\'t a strict z.object'],
    ['an input JSON Schema cannot express', [mod({ tools: [tool({ input: z.strictObject({ d: z.date() }) })] })], 'tool "orders_list" input can\'t convert to JSON Schema'],
    ['a description over 1,024 characters', [mod({ tools: [tool({ description: 'x'.repeat(1025) })] })], 'tool "orders_list" description must be 1 to 1024 characters'],
    ['an empty description', [mod({ tools: [tool({ description: '' })] })], 'tool "orders_list" description must be 1 to 1024 characters'],
    ['a bad connector id', [mod({ id: 'Shopify' })], 'bad connector id "Shopify"'],
    ['a bad account id', [mod({ accountId: 'shopify:Store!' })], 'bad account id in connector "shopify"'],
    ['a scope outside read_*', [mod({ scopes: { read: ['read_orders', 'read_returns', 'write_orders'], required: ['read_returns'] } })], 'scope "write_orders" in connector "shopify" isn\'t read_*'],
    ['required not within read', [mod({ scopes: { read: ['read_orders'], required: ['read_returns'] } })], 'required scope "read_returns" in connector "shopify" isn\'t in its read list'],
    ['shopify without read_returns required', [mod({ scopes: { read: ['read_orders', 'read_returns'], required: [] } })], 'the shopify connector must require read_returns'],
    [
      'two connectors disagreeing on one account’s scopes',
      [mod(), mod({ scopes: { read: ['read_products', 'read_returns'], required: ['read_returns'] } })],
      'connectors disagree on the scopes of account "shopify:store"',
    ],
  ]
  for (const [name, modules, message] of bad) {
    it(`throws on ${name}`, () => {
      expect(() => buildRegistry(modules)).toThrow(new Error(`hub registry: ${message}`))
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
  it('every connectors/*/route.ts on disk is in connectors/index.ts', async () => {
    const listed = new Set<unknown>(connectors)
    for (const path of globSync(ROUTE_GLOB, { cwd: HUB })) {
      const exports = (await import(/* @vite-ignore */ join(HUB, path))) as Record<string, unknown>
      const modules = Object.values(exports).filter(v => typeof v === 'object' && v !== null && 'tools' in v && 'accountId' in v)
      expect(modules.length, `${path} exports no connector module`).toBeGreaterThan(0)
      for (const m of modules) expect(listed.has(m), `${path} isn't listed in connectors/index.ts`).toBe(true)
    }
  })

  it('the route pattern matches a route one folder down and nothing else (so an empty scan above means no connectors)', () => {
    expect(matchesGlob('connectors/orders/route.ts', ROUTE_GLOB)).toBe(true)
    expect(matchesGlob('connectors/route.ts', ROUTE_GLOB)).toBe(false)
    expect(matchesGlob('connectors/orders/v2/route.ts', ROUTE_GLOB)).toBe(false)
    // The same pattern and scan, rooted at the canary folder, find the canary route.
    const canary = ROUTE_GLOB.replace(/^connectors\//, 'registry/testing/glob-canary/')
    expect(globSync(canary, { cwd: HUB })).toEqual(['registry/testing/glob-canary/example/route.ts'])
  })

  it('the connector list never takes in test code: no testing/ import and no fixture account', () => {
    const source = readFileSync(join(HUB, 'connectors/index.ts'), 'utf8')
    expect(source).not.toMatch(/from\s+['"][^'"]*\/testing\//)
    expect((connectors as readonly ConnectorModule[]).some(m => m.accountId === FIXTURE_ACCOUNT)).toBe(false)
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

  it("a tool's own error is rebuilt from its code: upstream text never passes, retryAfterMs does", async () => {
    const leak = 'raw upstream body: {"errors":"Invalid API key shpat_0123"}'
    const failing = (error: unknown) => buildRegistry([mod({ tools: [tool({ run: async () => ({ ok: false, error }) as never })] })])
    const r = await callReadTool(deps(failing({ code: 'rate_limited', message: leak, retryAfterMs: 1500 })), scope, 'orders_list', { limit: 1 })
    expect(r).toEqual(err('rate_limited', 'orders_list', 1500))
    const bogus = await callReadTool(deps(failing({ code: leak, message: leak, retryAfterMs: -1 })), scope, 'orders_list', { limit: 1 })
    expect(bogus).toEqual(err('internal', 'orders_list'))
    expect(JSON.stringify([r, bogus])).not.toContain('shpat_')
  })

  it('a log line names a registered tool, else a fixed unknown', () => {
    const registry = buildRegistry([mod()])
    expect(toolNameForLog(registry, 'orders_list')).toBe('orders_list')
    expect(toolNameForLog(registry, 'orders_lost')).toBe('unknown')
    expect(toolNameForLog(registry, 'secret_token_value')).toBe('unknown')
  })

  it('lists the tool with its connector and JSON Schema', () => {
    const [info] = listReadTools(deps(buildRegistry([mod()])))
    expect(info).toMatchObject({ name: 'orders_list', connector: 'shopify', description: 'Lists orders.' })
    expect(info!.inputSchema).toMatchObject({ type: 'object' })
  })
})
