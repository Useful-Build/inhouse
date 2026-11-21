// Test kit for P5 W4's delivery path (tests only; never imported by hub code). One Slack SignIn core over H0's in-memory
// store, W1's fake OAuth MCP server for the connect and the token, and W4's fake Slack Web API for the posts.
import { parseKeyRing, type KeyRingResult } from '../../../crypto/keyring'
import { buildRegistry, kindFor } from '../../../registry/registry'
import { SignInCore } from '../../../signin/core'
import { MemStore, ringJson } from '../../../signin/testing/kit'
import { counterRandom, GetAlarm, slackEnv, type Env } from '../../../oauth/testing/kit'
import { slackConnector } from '../../mcp/slack/route'
import { createMcpUpstream, FIXED_EPOCH_MS, mintTestCode, type FakeMcpServer } from '../../../../test/upstreams/mcp/server'
import { createSlackWebUpstream, SLACK_WEB_PATHS, type FakeSlackWeb } from '../../../../test/upstreams/slack/server'
import type { DeliveryDeps, DeliveryStub } from '../gateway'

export const SLACK = 'slack:workspace'
export const ORIGIN = 'https://app.example.com'

export type DeliveryWorld = {
  clock: { ms: number }
  env: Env
  origin: { value: unknown }
  mcp: FakeMcpServer
  web: FakeSlackWeb
  core: SignInCore
  stub: DeliveryStub
  deps: DeliveryDeps
}

export function deliveryWorld(): DeliveryWorld {
  const clock = { ms: FIXED_EPOCH_MS }
  const env = slackEnv()
  const origin: { value: unknown } = { value: ORIGIN }
  const ring = ringJson(['k1'], 'k1')
  const mcp = createMcpUpstream('slack', { now: () => clock.ms })
  const web = createSlackWebUpstream()
  const registry = buildRegistry([slackConnector])
  const upstream = async (req: Request) => {
    const url = new URL(req.url)
    if (url.host === 'slack.com' && (SLACK_WEB_PATHS as readonly string[]).includes(url.pathname)) return web.fetch(req)
    if (mcp.hosts.includes(url.host)) return mcp.fetch(req)
    return new Response('no fake for host', { status: 599 })
  }
  const core = new SignInCore({
    store: new MemStore(),
    now: () => clock.ms,
    alarm: new GetAlarm(),
    upstream: async () => upstream,
    keyring: (): Promise<KeyRingResult> => parseKeyRing(ring),
    shopify: () => null,
    scopesFor: async () => null,
    provider: async id => {
      if (id !== SLACK) return null
      const clientConfig = slackConnector.configure(env as Record<string, unknown>)
      return clientConfig ? { kind: 'oauth_mcp', connector: slackConnector, clientConfig } : null
    },
    kindFor: async id => kindFor(registry, id),
    random: counterRandom(1),
    appOrigin: () => origin.value,
  })
  const stub: DeliveryStub = {
    slackPost: (a, r) => core.slackPost(a, r),
    slackChannelInfo: (a, c) => core.slackChannelInfo(a, c),
    slackChannelList: (a, c) => core.slackChannelList(a, c),
  }
  return { clock, env, origin, mcp, web, core, stub, deps: { signIn: () => stub } }
}

/** Connects the Slack account as the fake AS would (no browser). */
export async function connectSlack(w: DeliveryWorld): Promise<void> {
  const started = await w.core.beginConnect({ accountId: SLACK, memberId: 'm_test_0001' })
  if (!started.ok) throw new Error(`connect start failed: ${started.error.code}`)
  const { code, state } = await mintTestCode(started.value.authorizeUrl, { nowMs: w.clock.ms })
  const done = await w.core.completeConnect({ state, code, memberId: 'm_test_0001' })
  if (!done.ok) throw new Error(`connect failed: ${done.error.code}`)
}
