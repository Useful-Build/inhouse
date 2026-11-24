// A tool with a history here (P5 W3): after a disconnect, or a first connect that failed or was declined, the tool's page stays
// open and says so, instead of throwing or bouncing. Ways it can fail:
//  1. `toolView` throws on a tool that is neither connected nor going live (it asked for a `since` or a `liveBy`);
//  2. a disconnected tool reads as "Being connected" (the state a tool with no connection has always had);
//  3. a tool being connected, or one whose login failed, is taken for "off" or the other way round;
//  4. the demo's tool states change: a tool that is listed as being connected stays "connecting".
import { describe, expect, test } from 'vitest'
import { HttpAgent } from '../agent/http/client'
import type { AgentData, Instant, StageIndex, ToolDetail, ToolsData } from '../agent/types'
import { toolState, toolView } from './derive'
import type { Ctx } from './derive'

const stub = new HttpAgent()
const EMPTY = stub.read()
const NO_STATE = stub.getSnapshot()
const at = (iso: string): Instant => ({ iso, ms: Date.parse(iso) })
const detail = (extra: Partial<ToolDetail> = {}): ToolDetail => ({ name: 'Slack', desc: 'd', ex: ['Q?'], read: 'r', draft: 'd', run: 'r', conn: 'c', site: 'slack.com', ...extra })
const ctxOf = (tools: Partial<ToolsData>, S: StageIndex = 1): Ctx => ({ S, agent: NO_STATE, data: { ...EMPTY, status: 'ready', tools: { ...EMPTY.tools, ...tools } } as AgentData })

describe('a tool with a history here', () => {
  test('after a disconnect: off, "Not connected", no suggested questions, and the failed revoke is on the detail', () => {
    const ctx = ctxOf({ details: { slack: detail({ accountId: 'slack:workspace', revokeFailed: true, canDisconnect: false }) }, catalog: [{ k: 'slack', name: 'Slack', desc: 'd', accountId: 'slack:workspace' }] })
    expect(toolState(ctx, 'slack')).toBe('off')
    const v = toolView(ctx, 'slack')
    expect(v).toMatchObject({ state: 'off', statusText: 'Not connected', listLine: 'Not connected', connectedRow: 'Not connected', lastRead: 'Not yet', examples: [] })
    expect(v.abilities[0]!.tag).toBe('Off')
    expect(ctx.data.tools.details.slack!.revokeFailed).toBe(true)
  })

  test('after a first connect that failed or was declined (details, nothing connected): the same off page, not a throw', () => {
    const ctx = ctxOf({ details: { slack: detail({ accountId: 'slack:workspace' }) } })
    expect(() => toolView(ctx, 'slack')).not.toThrow()
    expect(toolState(ctx, 'slack')).toBe('off')
  })

  // #321 review M1: a first login that failed (never connected) says so with the page's existing copy, not "Not connected".
  test('a first login that failed (loginFailedAt, nothing connected): off, with the failed-login status and "Needs reconnecting"', () => {
    const ctx = ctxOf({ details: { shopify: detail({ name: 'Shopify', accountId: 'shopify:store', loginFailedAt: at('2026-11-20T09:00:00.000Z') }) } })
    expect(toolState(ctx, 'shopify')).toBe('off')
    const v = toolView(ctx, 'shopify')
    expect(v.statusText).toMatch(/^Disconnected · login expired at /)
    expect(v).toMatchObject({ state: 'off', listLine: 'Needs reconnecting', connectedRow: 'Not connected', lastRead: 'Not yet', examples: [] })
  })

  test('a tool being connected is still "connecting"; a connected one with a failed login is still "disconnected"', () => {
    const connecting = ctxOf({ beingConnected: ['slack'], details: { slack: detail({ liveBy: at('2026-11-21T10:00:00.000Z') }) } })
    expect(toolState(connecting, 'slack')).toBe('connecting')
    const lost = ctxOf({ connected: ['slack'], connection: { slack: { status: 'disconnected', since: at('2026-11-20T09:00:00.000Z') } }, details: { slack: detail({ since: at('2026-11-01T09:00:00.000Z') }) } })
    expect(toolState(lost, 'slack')).toBe('disconnected')
    const healthy = ctxOf({ connected: ['slack'], details: { slack: detail({ since: at('2026-11-01T09:00:00.000Z') }) } })
    expect(toolState(healthy, 'slack')).toBe('connected')
  })

  test('a demo-style tool going live (progress, liveBy, in beingConnected) stays "connecting" even when listed nowhere else', () => {
    const ctx = ctxOf({ details: { ads: detail({ progress: true, liveBy: at('2026-11-21T10:00:00.000Z') }) } })
    expect(toolState(ctx, 'ads')).toBe('connecting')
  })

  test('unrecorded lastRead (epoch 0) reads "Connected" on lists and "Not yet" on the tool page', () => {
    const connected = ctxOf({
      connected: ['shopify'],
      details: { shopify: detail({ name: 'Shopify', since: at('2026-11-01T09:00:00.000Z') }) },
    })
    expect(toolView(connected, 'shopify')).toMatchObject({ state: 'connected', listLine: 'Connected', lastRead: 'Not yet' })

    const lost = ctxOf({
      connected: ['slack'],
      connection: { slack: { status: 'disconnected', since: at('2026-11-20T09:00:00.000Z') } },
      details: { slack: detail({ since: at('2026-11-01T09:00:00.000Z') }) },
    })
    expect(toolView(lost, 'slack')).toMatchObject({ state: 'disconnected', listLine: 'Needs reconnecting', lastRead: 'Not yet' })
  })
})
