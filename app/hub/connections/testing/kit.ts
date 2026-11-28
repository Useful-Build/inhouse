// Test kit for connections (Stage 1 M4-R1; tests only, never imported by hub code, so never bundled). One in-memory
// SignIn core per account over a MemStore, the `__connections__` index as one more core, and the gateway's deps over
// them, with a seam (`around`) a test uses to schedule, delay or crash any object call.
import { addressVerdict } from '../../../server/egress/ip'
import type { CallerScope, ConnectionActor, ConnectionBindingInput, ConnectionDestinations } from '../../index/contract'
import { parseKeyRing } from '../../crypto/keyring'
import type { Upstream } from '../../oauth/http'
import { buildRegistry } from '../../registry/registry'
import { connectors } from '../../connectors/index'
import type { HubConnector } from '../../registry/registry'
import { SignInCore } from '../../signin/core'
import { FakeAlarm, MemStore, ringJson } from '../../signin/testing/kit'
import { MODERN } from '../../testing/fixtures/kit'
import type { ConnectionGatewayDeps, ConnectionObjectStub, IndexStub } from '../gateway'
import { connectionHooks, methodHooks, type ConnectionHooks, type ObjectOps } from '../hooks'
import { INDEX_OBJECT } from '../index'
import type { ResolvePublic } from '../destinations'

export const server: CallerScope = { kind: 'server', job: 'test', requestId: 'req-conn' }
export const run: CallerScope = { kind: 'run', runId: 'run-1', principalId: 'p-1', requestId: 'req-conn' }
export const inhouse: ConnectionActor = { kind: 'inhouse', memberId: 'mem_test_inhouse' }
export const admin: ConnectionActor = { kind: 'admin', memberId: 'mem_test_admin' }

export const OPEN = `${MODERN}/open/mcp`
export const KEYED = `${MODERN}/key/mcp`

export const START_MS = Date.UTC(2026, 10, 28, 9, 0, 0)

export function destinations(mcp: string, extra: Partial<ConnectionDestinations> = {}): ConnectionDestinations {
  return { mcp, metadata: [], issuer: null, authorize: null, token: null, registration: null, revoke: null, ...extra }
}

/** An address binding: open by default; `key` puts a key in `X-Api-Key`. */
export function binding(mcp = OPEN, opts: { path?: 'none' | 'signin' | 'key'; extra?: Partial<ConnectionDestinations>; settings?: Record<string, string> } = {}): ConnectionBindingInput {
  const path = opts.path ?? 'none'
  return { transport: 'https', path, destinations: destinations(mcp, opts.extra), ...(path === 'key' ? { key: { header: 'X-Api-Key', prefix: '' } } : {}), settings: opts.settings ?? {} }
}

/** A resolver that judges literals as the hub does and takes every name as public (the fixtures' names). */
export const fixtureResolver: ResolvePublic = async host => addressVerdict(host) !== 'blocked'

type Around = <T>(accountId: string, method: string, call: () => Promise<T>) => Promise<T>

export class ConnWorld {
  clock = { ms: START_MS }
  readonly stores = new Map<string, MemStore>()
  readonly cores = new Map<string, SignInCore>()
  readonly alarms = new Map<string, FakeAlarm>()
  ringJson = ringJson(['k1'], 'k1')
  hooks: ConnectionHooks = { ...connectionHooks }
  ops: ObjectOps = {}
  resolvePublic: ResolvePublic = fixtureResolver
  /** Wraps every object and index call (a scheduler, a delay, a crash). */
  around: Around = (_a, _m, call) => call()
  /** Every object and index call, in order. */
  readonly calls: string[] = []
  modules: readonly HubConnector[] = connectors as readonly HubConnector[]
  upstream: Upstream
  constructor(upstream: Upstream) {
    this.upstream = upstream
  }

  store(accountId: string): MemStore {
    let s = this.stores.get(accountId)
    if (!s) {
      s = new MemStore()
      this.stores.set(accountId, s)
    }
    return s
  }

  core(accountId: string): SignInCore {
    let c = this.cores.get(accountId)
    if (!c) {
      const alarm = new FakeAlarm()
      this.alarms.set(accountId, alarm)
      c = new SignInCore({
        store: this.store(accountId),
        now: () => this.clock.ms,
        alarm,
        upstream: async () => this.upstream,
        keyring: () => parseKeyRing(this.ringJson),
        shopify: () => null,
        scopesFor: async () => null,
        connectionHooks: this.hooks,
        objectOps: this.ops,
        resolvePublic: host => this.resolvePublic(host),
        callTimeoutMs: 2_000,
      })
      this.cores.set(accountId, c)
    }
    return c
  }

  /** A new core over the same store (an evicted object coming back). */
  evict(accountId: string): void {
    this.cores.delete(accountId)
  }

  #wrap<T>(accountId: string, method: string, call: () => Promise<T>): Promise<T> {
    this.calls.push(`${accountId}.${method}`)
    return this.around(accountId, method, call)
  }

  object(accountId: string): ConnectionObjectStub {
    const c = () => this.core(accountId)
    return {
      prepareConnection: req => this.#wrap(accountId, 'prepareConnection', () => c().prepareConnection(req)),
      getConnection: a => this.#wrap(accountId, 'getConnection', () => c().getConnection(a)),
      updateConnection: req => this.#wrap(accountId, 'updateConnection', () => c().updateConnection(req)),
      removeConnection: a => this.#wrap(accountId, 'removeConnection', () => c().removeConnection(a)),
      abandonConnection: (a, g) => this.#wrap(accountId, 'abandonConnection', () => c().abandonConnection(a, g)),
      connectionSummary: a => this.#wrap(accountId, 'connectionSummary', () => c().connectionSummary(a)),
      reencrypt: a => this.#wrap(accountId, 'reencrypt', () => c().reencrypt(a)),
    }
  }

  index(): IndexStub {
    const c = () => this.core(INDEX_OBJECT)
    return {
      indexAdd: e => this.#wrap(INDEX_OBJECT, 'indexAdd', () => c().indexAdd(e)),
      indexRemove: (a, upTo) => this.#wrap(INDEX_OBJECT, 'indexRemove', () => c().indexRemove(a, upTo)),
      indexList: () => this.#wrap(INDEX_OBJECT, 'indexList', () => c().indexList()),
    }
  }

  deps(): ConnectionGatewayDeps {
    return { registry: buildRegistry(this.modules), object: id => this.object(id), index: () => this.index(), hooks: methodHooks }
  }

  /** The record a connection's object holds now (raw). */
  raw(accountId: string): unknown {
    return this.stores.get(accountId)?.get('record')
  }
}

/** A promise a test settles by hand. */
export function deferred<T = void>(): { promise: Promise<T>; resolve(v: T): void } {
  let resolve!: (v: T) => void
  const promise = new Promise<T>(r => {
    resolve = r
  })
  return { promise, resolve }
}
