// Test kit for P5 W1's OAuth path (tests only; never imported by hub code). One SignIn core per account over H0's
// in-memory store, a clock, an alarm that answers getAlarm, deterministic randomness and the fake OAuth MCP server.
import type { KeyRingResult } from '../../crypto/keyring'
import { parseKeyRing } from '../../crypto/keyring'
import type { CallerScope } from '../../index/contract'
import { slackConnector } from '../../connectors/mcp/slack/route'
import { notesConnector, NOTES_ACCOUNT } from '../../connectors/mcp/testing/notes-connector'
import { buildRegistry, kindFor, type HubConnector, type McpConnectorModule, type ReadyGatewayDeps } from '../../registry/registry'
import { SignInCore, type McpProvider } from '../../signin/core'
import { FakeAlarm, MemStore, ringJson } from '../../signin/testing/kit'
import { createMcpUpstream, FIXED_EPOCH_MS, mintTestCode, SLACK_TEST, type FakeMcpServer } from '../../../test/upstreams/mcp/server'
import type { ConnectDeps, ConnectStub } from '../gateway'

export const SLACK = 'slack:workspace'
export const NOTES = NOTES_ACCOUNT
export const MEMBER = 'mem_test_0001'
export const OTHER_MEMBER = 'mem_test_0002'
export const SERVER: CallerScope = { kind: 'server', job: 'test', requestId: 'req-test' }
export const RUN: CallerScope = { kind: 'run', runId: 'run-1', principalId: 'p-1', requestId: 'req-1' }

/** The 5 least scopes, written out here (not read from the connector), sorted. */
export const SLACK_BASE = ['channels:history', 'channels:read', 'chat:write', 'search:read.public', 'users:read']
export const SLACK_PRIVATE = [...SLACK_BASE, 'groups:history', 'search:read.private'].sort()

export class GetAlarm extends FakeAlarm {
  async get() {
    return this.at
  }
}

/** Unique, deterministic bytes: a counter in the first bytes. */
export function counterRandom(seed = 1): (n: number) => Uint8Array {
  let i = seed
  return n => {
    const out = new Uint8Array(n)
    let v = i++
    for (let k = 0; k < n && k < 6; k++) {
      out[k] = v & 0xff
      v = Math.floor(v / 256)
    }
    out[n - 1] = 0xa5
    return out
  }
}

export type Env = {
  SLACK_CLIENT_ID?: string
  SLACK_CLIENT_SECRET?: string
  SLACK_TEAM_ID?: string
  SLACK_PRIVATE_SEARCH?: string
  CONNECT_REDIRECT_URI?: string
}

export const slackEnv = (): Env => ({
  SLACK_CLIENT_ID: SLACK_TEST.clientId,
  SLACK_CLIENT_SECRET: SLACK_TEST.clientSecret,
  SLACK_TEAM_ID: SLACK_TEST.teamId,
  SLACK_PRIVATE_SEARCH: 'off',
  CONNECT_REDIRECT_URI: SLACK_TEST.redirectUri,
})

export type World = {
  clock: { ms: number }
  env: Env
  ring: { json: string | undefined }
  slack: FakeMcpServer
  notes: FakeMcpServer
  stores: Map<string, MemStore>
  alarms: Map<string, GetAlarm>
  cores: Map<string, SignInCore>
  modules: HubConnector[]
  core(accountId: string): SignInCore
  store(accountId: string): MemStore
  alarm(accountId: string): GetAlarm
  provider(accountId: string): McpProvider | null
  /** Every upstream request the hub sent, by host. */
  hostsSeen: string[]
}

export function world(opts: { rotation?: boolean; modules?: HubConnector[]; seed?: number; noProvider?: boolean } = {}): World {
  const clock = { ms: FIXED_EPOCH_MS }
  const env = slackEnv()
  const ring = { json: ringJson(['k1'], 'k1') }
  const slack = createMcpUpstream('slack', { now: () => clock.ms, rotation: opts.rotation })
  const notes = createMcpUpstream('notes', { now: () => clock.ms, rotation: opts.rotation })
  const modules = opts.modules ?? [slackConnector, notesConnector]
  const registry = buildRegistry(modules)
  const random = counterRandom(opts.seed ?? 1)
  const hostsSeen: string[] = []
  const upstream = async (req: Request) => {
    const host = new URL(req.url).host
    hostsSeen.push(host)
    if (slack.hosts.includes(host)) return slack.fetch(req)
    if (notes.hosts.includes(host)) return notes.fetch(req)
    return new Response('no fake for host', { status: 599 })
  }
  const w: World = {
    clock,
    env,
    ring,
    slack,
    notes,
    stores: new Map(),
    alarms: new Map(),
    cores: new Map(),
    modules,
    hostsSeen,
    provider(accountId) {
      if (opts.noProvider) return null
      const connector = registry.modules.find((m): m is McpConnectorModule => m.accountId === accountId && m.kind === 'oauth_mcp')
      if (!connector) return null
      const clientConfig = connector.configure(env as Record<string, unknown>)
      return clientConfig ? { kind: 'oauth_mcp', connector, clientConfig } : null
    },
    store(accountId) {
      if (!this.stores.has(accountId)) this.stores.set(accountId, new MemStore())
      return this.stores.get(accountId)!
    },
    alarm(accountId) {
      if (!this.alarms.has(accountId)) this.alarms.set(accountId, new GetAlarm())
      return this.alarms.get(accountId)!
    },
    core(accountId) {
      let c = this.cores.get(accountId)
      if (!c) {
        c = new SignInCore({
          store: this.store(accountId),
          now: () => clock.ms,
          alarm: this.alarm(accountId),
          upstream: async () => upstream,
          keyring: (): Promise<KeyRingResult> => parseKeyRing(ring.json),
          shopify: () => null,
          scopesFor: async () => null,
          provider: async id => w.provider(id),
          kindFor: async id => kindFor(registry, id),
          random,
        })
        this.cores.set(accountId, c)
      }
      return c
    },
  }
  return w
}

/** A new core over the same store (an evicted object coming back). */
export function evict(w: World, accountId: string): void {
  w.cores.delete(accountId)
}

/** Start, mint a code as the fake AS would, and call back. */
export async function connect(w: World, accountId = SLACK, member = MEMBER, mint: Parameters<typeof mintTestCode>[1] = {}) {
  const started = await w.core(accountId).beginConnect({ accountId, memberId: member })
  if (!started.ok) return { started, completed: null }
  const { code, state } = await mintTestCode(started.value.authorizeUrl, { nowMs: w.clock.ms, ...mint })
  const completed = await w.core(accountId).completeConnect({ state, code, memberId: member })
  return { started, completed, state, code }
}

export function connectDeps(w: World): ConnectDeps {
  const registry = buildRegistry(w.modules)
  return {
    registry,
    isConfigured: c => (c.kind === 'oauth_mcp' ? c.configure(w.env as Record<string, unknown>) !== null : true),
    signIn: id => {
      const core = w.core(id)
      return {
        beginConnect: r => core.beginConnect(r),
        completeConnect: r => core.completeConnect(r),
        failConnect: r => core.failConnect(r),
        disconnect: a => core.disconnect(a),
        setPaused: (a, p) => core.setPaused(a, p),
        status: a => core.accountStatus(a),
      } satisfies ConnectStub
    },
  }
}

export function readyDeps(w: World, calls: string[] = []): ReadyGatewayDeps {
  const registry = buildRegistry(w.modules)
  return {
    registry,
    isConfigured: c => (c.kind === 'oauth_mcp' ? c.configure(w.env as Record<string, unknown>) !== null : true),
    shopifyFor: () => ({
      graphql: async document => {
        calls.push(document)
        return { ok: true, value: { data: null } }
      },
    }),
    nowMs: () => w.clock.ms,
    isReady: async id => {
      const r = await w.core(id).ready(id)
      return r.ok ? r.value : { ready: false, code: 'not_configured' }
    },
    mcpFor: c => ({ call: (upstream, args) => w.core(c.accountId).mcpCall({ accountId: c.accountId, upstream, args }) }),
  }
}

export const codeOf = (r: { ok: boolean; error?: { code: string } }) => (r.ok ? 'ok' : r.error!.code)
