// P5 W1 brief "Tests" 6 (allowlist), 7 (pause by account), 13 (one row per account) and the registry rules for
// oauth_mcp modules. Expected name lists are literals written here, never read from the allowlist module.
import { fc, test } from '@fast-check/vitest'
import { globSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { connectors } from '../index'
import { buildRegistry, callReadyTool, listReadyTools, type ConnectorModule, type McpConnectorModule } from '../../registry/registry'
import { codeOf, connect, connectDeps, MEMBER, readyDeps, RUN, SERVER, SLACK, world } from '../../oauth/testing/kit'
import * as G from '../../oauth/gateway'
import { slackConnector } from './slack/route'
import { notesConnector } from './testing/notes-connector'

beforeEach(() => void vi.spyOn(console, 'log').mockImplementation(() => {}))
afterEach(() => vi.restoreAllMocks())

const SLACK_TOOLS_OFF = ['slack_list_channel_members', 'slack_list_user_channels', 'slack_read_channel', 'slack_read_thread', 'slack_read_user_profile', 'slack_search_channels', 'slack_search_public']
const SLACK_TOOLS_ON = [...SLACK_TOOLS_OFF, 'slack_search_public_and_private'].sort()

/** A test module standing in for W2's code-mode module on `shopify:store`. */
const shopifyA: ConnectorModule = {
  id: 'shopify',
  accountId: 'shopify:store',
  apiVersion: '2026-10',
  scopes: { read: ['read_orders', 'read_returns'], required: ['read_returns'] },
  tools: [{ name: 'orders_list', description: 'Lists orders.', mode: 'read', input: z.strictObject({}), run: async () => ({ ok: true, value: 1 }) }],
}
const shopifyB: ConnectorModule = { ...shopifyA, tools: [{ ...shopifyA.tools[0]!, name: 'shopify_script_run' }] }

describe('test 6: the allowlist', () => {
  it('listTools returns exactly the literal list per policy, with our descriptions', async () => {
    const w = world()
    await connect(w)
    const names = (await listReadyTools(readyDeps(w))).filter(t => t.connector === 'slack').map(t => t.name).sort()
    expect(names).toEqual(SLACK_TOOLS_OFF)
    const w2 = world()
    w2.env.SLACK_PRIVATE_SEARCH = 'on'
    await connect(w2)
    expect((await listReadyTools(readyDeps(w2))).filter(t => t.connector === 'slack').map(t => t.name).sort()).toEqual(SLACK_TOOLS_ON)
    const infos = await listReadyTools(readyDeps(w2))
    for (const t of infos) {
      expect(t.description).not.toMatch(/UPSTREAM|Ignore previous/)
      // Deferred: never always-loaded, no _meta marker.
      expect(JSON.stringify(t)).not.toMatch(/alwaysLoad|_meta/)
    }
    expect(w2.slack.requests.some(r => r.rpc === 'tools/list')).toBe(false)
  })

  test.prop([fc.constantFrom('slack_send_message', 'slack_create_canvas', 'slack_add_reaction', 'slack_get_file_upload_url'), fc.dictionary(fc.string(), fc.jsonValue())])(
    'a known write answers write_refused with no upstream request',
    async (name, args) => {
      const w = world()
      await connect(w)
      const before = w.slack.requests.length
      expect(codeOf(await callReadyTool(readyDeps(w), RUN, name, args))).toBe('write_refused')
      expect(codeOf(await w.core(SLACK).mcpCall({ accountId: SLACK, upstream: name, args: {} }))).toBe('write_refused')
      expect(w.slack.requests.length).toBe(before)
    },
  )

  test.prop([fc.stringMatching(/^[a-z]{2,8}_[a-z]{2,8}$/).filter(n => !SLACK_TOOLS_ON.includes(n) && !n.startsWith('notes_')), fc.boolean()])(
    'any other unlisted name answers unknown_tool and never reaches the upstream',
    async (name, readOnlyHint) => {
      const w = world()
      await connect(w)
      void readOnlyHint
      const before = w.slack.requests.length
      expect(codeOf(await callReadyTool(readyDeps(w), RUN, name, {}))).toBe(name === 'slack_send_message' ? 'write_refused' : 'unknown_tool')
      expect(w.slack.requests.length).toBe(before)
    },
  )

  it('notes_export appearing mid-run upstream stays hidden and uncallable', async () => {
    const w = world()
    await connect(w, 'notes:test')
    w.notes.exportAfterLists = 0
    const names = (await listReadyTools(readyDeps(w))).filter(t => t.connector === 'notes').map(t => t.name).sort()
    expect(names).toEqual(['notes_read', 'notes_search'])
    expect(codeOf(await callReadyTool(readyDeps(w), RUN, 'notes_export', {}))).toBe('unknown_tool')
    expect(codeOf(await callReadyTool(readyDeps(w), RUN, 'notes_delete', { id: 'n1' }))).toBe('write_refused')
    expect(w.notes.toolCalls.map(c => c.name)).toEqual([])
  })

  test.prop([fc.integer({ min: 1, max: 20 }), fc.constantFrom('detailed', 'concise', 'x')])('fixed arguments always override the model', async (limit, format) => {
    const w = world()
    await connect(w)
    const r = await callReadyTool(readyDeps(w), RUN, 'slack_search_public', { keywords: ['late'], limit })
    expect(codeOf(r)).toBe('ok')
    expect(w.slack.toolCalls.at(-1)).toEqual({ name: 'slack_search_public', args: { keywords: ['late'], limit, response_format: 'concise' } })
    // The model can't even name a fixed argument: the strict input refuses it before any request.
    expect(codeOf(await callReadyTool(readyDeps(w), RUN, 'slack_search_public', { keywords: ['late'], response_format: format }))).toBe('invalid_args')
    expect(codeOf(await callReadyTool(readyDeps(w), RUN, 'slack_read_channel', { channel_id: 'C0TEST0001', limit: 500 }))).toBe('invalid_args')
  })

  it('the upstream result carries no upstream description, and an isError answer carries no upstream text', async () => {
    const w = world()
    await connect(w)
    const r = await callReadyTool(readyDeps(w), RUN, 'slack_read_channel', { channel_id: 'G0TEST0001' })
    expect(r).toEqual({ ok: false, error: { code: 'upstream_rejected', message: 'upstream rejected the request: slack_read_channel' } })
  })

  it('a missing scope upstream: hidden answers upstream_rejected, listed-and-failing answers scope_mismatch', async () => {
    for (const [mode, code] of [['hide', 'upstream_rejected'], ['fail', 'scope_mismatch']] as const) {
      const w = world()
      await connect(w)
      w.slack.missingScope = mode
      // Simulate a narrower token than the hub thinks: the fake drops users:read from the issued token.
      for (const t of w.slack.tokens.values()) t.scopes = t.scopes.filter(s => s !== 'users:read')
      expect(codeOf(await callReadyTool(readyDeps(w), RUN, 'slack_read_user_profile', {}))).toBe(code)
    }
  })

  it('the private-channel read fails at Slack with the policy off (no groups:history on the token)', async () => {
    const w = world()
    await connect(w)
    expect(codeOf(await callReadyTool(readyDeps(w), RUN, 'slack_read_channel', { channel_id: 'G0TEST0001' }))).toBe('upstream_rejected')
    expect(codeOf(await callReadyTool(readyDeps(w), RUN, 'slack_search_public_and_private', { keywords: ['budget'] }))).toBe('unknown_tool')
  })

  it("S4's miss reproduces: a two-word search finds nothing, one distinctive word finds the planted message", async () => {
    const w = world()
    await connect(w)
    const two = await callReadyTool(readyDeps(w), RUN, 'slack_search_public', { keywords: ['supplier', 'delay'] })
    expect(JSON.stringify(two)).not.toContain('Kestrel')
    const one = await callReadyTool(readyDeps(w), RUN, 'slack_search_public', { keywords: ['late'] })
    expect(JSON.stringify(one)).toContain('Kestrel Mills')
  })
})

describe('test 7: pause, by account', () => {
  it("a paused account's tools leave listTools and answer paused with no upstream call; unpausing restores them", async () => {
    const w = world()
    await connect(w)
    expect(await G.setPaused(connectDeps(w), SERVER, SLACK, true)).toEqual({ ok: true, value: { paused: true } })
    expect((await listReadyTools(readyDeps(w))).filter(t => t.connector === 'slack')).toEqual([])
    const before = w.slack.requests.length
    expect(codeOf(await callReadyTool(readyDeps(w), RUN, 'slack_search_public', { keywords: ['late'] }))).toBe('paused')
    expect(w.slack.requests.length).toBe(before)
    await G.setPaused(connectDeps(w), SERVER, SLACK, false)
    expect((await listReadyTools(readyDeps(w))).filter(t => t.connector === 'slack')).toHaveLength(7)
  })

  it('Shopify too, and a second module on shopify:store follows the same pause', async () => {
    const w = world({ modules: [slackConnector, shopifyA, shopifyB] })
    const calls: string[] = []
    expect((await listReadyTools(readyDeps(w, calls))).map(t => t.name).sort()).toEqual(['orders_list', 'shopify_script_run'])
    await w.core('shopify:store').setPaused('shopify:store', true)
    expect(await listReadyTools(readyDeps(w, calls))).toEqual([])
    expect(codeOf(await callReadyTool(readyDeps(w, calls), RUN, 'shopify_script_run', {}))).toBe('paused')
    expect(codeOf(await callReadyTool(readyDeps(w, calls), RUN, 'orders_list', {}))).toBe('paused')
    await w.core('shopify:store').setPaused('shopify:store', false)
    expect(codeOf(await callReadyTool(readyDeps(w, calls), RUN, 'orders_list', {}))).toBe('ok')
  })

  it('Shopify can be paused but not disconnected from the gateway', async () => {
    const w = world({ modules: [slackConnector, shopifyA] })
    expect(codeOf(await G.disconnect(connectDeps(w), SERVER, 'shopify:store'))).toBe('invalid_args')
  })
})

describe('test 13: listAccounts and the gateway rules', () => {
  it('one Shopify row with two modules on shopify:store', async () => {
    const w = world({ modules: [slackConnector, shopifyA, shopifyB] })
    const rows = await G.listAccounts(connectDeps(w), SERVER)
    expect(rows.ok && rows.value.map(r => [r.accountId, r.connector, r.status.kind])).toEqual([
      ['slack:workspace', 'slack', 'oauth_mcp'],
      ['shopify:store', 'shopify', 'client_credentials'],
    ])
  })

  it('a run scope is refused on every ConnectGateway method', async () => {
    const d = connectDeps(world())
    const results = [
      await G.startConnect(d, RUN, { accountId: SLACK, memberId: MEMBER }),
      await G.completeConnect(d, RUN, { state: 'x.y', code: 'c', memberId: MEMBER }),
      await G.failConnect(d, RUN, { state: 'x.y', memberId: MEMBER, error: 'access_denied' }),
      await G.disconnect(d, RUN, SLACK),
      await G.setPaused(d, RUN, SLACK, true),
      await G.listAccounts(d, RUN),
    ]
    for (const r of results) expect(r).toEqual({ ok: false, error: { code: 'invalid_args', message: 'invalid arguments: scope' } })
  })

  it('start names a configured oauth_mcp connector, else unknown_tool or not_configured', async () => {
    const w = world({ modules: [slackConnector, shopifyA] })
    expect(codeOf(await G.startConnect(connectDeps(w), SERVER, { accountId: 'shopify:store', memberId: MEMBER }))).toBe('unknown_tool')
    expect(codeOf(await G.startConnect(connectDeps(w), SERVER, { accountId: 'nothing:here', memberId: MEMBER }))).toBe('unknown_tool')
    w.env.SLACK_CLIENT_SECRET = ''
    expect(codeOf(await G.startConnect(connectDeps(w), SERVER, { accountId: SLACK, memberId: MEMBER }))).toBe('not_configured')
    expect(await listReadyTools(readyDeps(w))).toEqual([{ name: 'orders_list', connector: 'shopify', description: 'Lists orders.', inputSchema: expect.any(Object) }])
  })

  it('an unreadable state prefix is state_invalid on completeConnect and accountId null on failConnect', async () => {
    const d = connectDeps(world())
    expect(codeOf(await G.completeConnect(d, SERVER, { state: 'not-a-state', code: 'c', memberId: MEMBER }))).toBe('state_invalid')
    expect(await G.failConnect(d, SERVER, { state: 'not-a-state', memberId: MEMBER, error: 'access_denied' })).toEqual({ ok: true, value: { accountId: null } })
  })
})

describe('registry rules for oauth_mcp modules', () => {
  const bad = (over: Partial<McpConnectorModule>) => ({ ...slackConnector, ...over }) as McpConnectorModule
  const cases: [string, McpConnectorModule, string][] = [
    ['an entry whose upstream is a known write', bad({ tools: [{ ...slackConnector.tools[2]!, name: 'slack_read_channel', upstream: 'slack_send_message' }] }), 'tool "slack_read_channel" names a known write'],
    ['an entry whose name is a known write', bad({ tools: [{ ...slackConnector.tools[0]!, name: 'slack_send_message' }] }), 'tool "slack_send_message" names a known write'],
    ['a scope that isn’t a handle', bad({ scopes: { base: ['search:read.public', 'Channels'], policy: {} } }), 'scope "Channels" in connector "slack" isn\'t an exact scope handle'],
    ['base and policy overlap', bad({ scopes: { base: ['search:read.public'], policy: { privateSearch: ['search:read.public'] } } }), 'scope "search:read.public" in connector "slack" policy privateSearch isn\'t disjoint from the other lists'],
    ['an endpoint off the allowed hosts', bad({ endpoints: { ...slackConnector.endpoints!, token: 'https://evil.example/token' } }), 'connector "slack" token endpoint isn\'t https on an allowed host'],
    ['a resource with a trailing slash', bad({ mcp: { ...slackConnector.mcp, resource: 'https://mcp.slack.com/' } }), 'connector "slack" mcp.resource must be https without a trailing slash'],
    ['an unknown policy on a tool', bad({ tools: [{ ...slackConnector.tools[0]!, policy: 'dms' }] }), 'tool "slack_search_public" names an unknown policy'],
    ['a result cap over 32 KiB', bad({ tools: [{ ...slackConnector.tools[0]!, maxResultBytes: 32 * 1024 + 1 }] }), 'tool "slack_search_public" maxResultBytes must be 1 to 32768'],
    ['a dynamic module pinning endpoints', bad({ client: 'dynamic' }), 'connector "slack" is dynamic and pins endpoints'],
  ]
  for (const [name, m, message] of cases) {
    it(`throws on ${name}`, () => expect(() => buildRegistry([m])).toThrow(new Error(`hub registry: ${message}`)))
  }

  it('accepts Slack and the notes test connector beside Shopify', () => {
    // connectors/index.ts lists Slack now (orchestrator line 3); the test connector is added on top.
    expect(connectors).toContain(slackConnector)
    expect(() => buildRegistry([...(connectors as readonly ConnectorModule[]), notesConnector])).not.toThrow()
  })

  it('every connectors/mcp/*/route.ts exports a module (the connector list line is the orchestrator\'s)', async () => {
    const hub = fileURLToPath(new URL('../..', import.meta.url).href)
    const routes = globSync('connectors/mcp/*/route.ts', { cwd: hub })
    expect(routes).toEqual(['connectors/mcp/slack/route.ts'])
    for (const path of routes) {
      const exports = (await import(/* @vite-ignore */ join(hub, path))) as Record<string, unknown>
      expect(Object.values(exports).some(v => typeof v === 'object' && v !== null && (v as { kind?: unknown }).kind === 'oauth_mcp')).toBe(true)
    }
    expect(globSync('connectors/slack/route.ts', { cwd: hub })).toEqual([])
  })
})
