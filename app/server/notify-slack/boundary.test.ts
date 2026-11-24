// P5 W4 brief "Tests" 8, the runner's side (B2, 2026-11-21): the egress wires the inhouse MCP server, so it builds the
// notifications deps from env; what must hold is that the runner's `/hub/` route never holds HUB_DELIVERY. This is code
// discipline plus checks, not config structure: every module of the Worker shares `env`. Ways it can fail:
//  1. the hub route's deps (what `/hub/` dispatches with) carry the delivery binding, or the whole env;
//  2. the deps the egress hands its routes expose the binding anywhere a route could reach it.
import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { egressDeps } from '../egress/index.ts'

/** Every value reachable from `root` through own properties (functions are leaves: a closure isn't a route's data). */
function reachable(root: unknown): unknown[] {
  const seen = new Set<unknown>()
  const walk = (v: unknown) => {
    if (v === null || (typeof v !== 'object' && typeof v !== 'function') || seen.has(v)) return
    seen.add(v)
    if (typeof v === 'object') for (const k of Reflect.ownKeys(v)) walk((v as Record<PropertyKey, unknown>)[k])
  }
  walk(root)
  return [...seen]
}

describe('test 8: the egress never hands HUB_DELIVERY to a route', () => {
  it("the hub route's deps hold the ReadGateway only, and no route's deps hold the delivery binding or the env", () => {
    const delivery = { trap: 'HUB_DELIVERY' }
    const hub = { listTools: () => null, callTool: () => null }
    const ctx = { waitUntil: () => {}, passThroughOnException: () => {}, props: {} } as unknown as ExecutionContext
    // Outside the test and eval builds (INHOUSE_TEST_BUILD unset) the hub route holds the ReadGateway itself. In them, P4's
    // test shop wrapper (`@test-shop`, server/egress/test-shop.ts) stands in its place: the same two read methods, over the
    // same ReadGateway and the D1, never the env or the delivery binding.
    for (const testBuild of [undefined, '1']) {
      const fakeEnv = { ...(env as unknown as Record<string, unknown>), HUB: hub, HUB_DELIVERY: delivery, INHOUSE_TEST_BUILD: testBuild } as unknown as Env
      const deps = egressDeps(fakeEnv, ctx, { runner: 'runner-test' } as never) as unknown as Record<string, unknown>
      const hubDeps = deps.hub as Record<string, unknown>
      expect(Object.keys(hubDeps).sort()).toEqual(['hub', 'log', 'now', 'requestId', 'stage'])
      if (testBuild === undefined) expect(hubDeps.hub).toBe(hub)
      else expect(Object.keys(hubDeps.hub as object).sort()).toEqual(['callTool', 'listTools'])
      const all = reachable(deps)
      expect(all).not.toContain(delivery)
      expect(all).not.toContain(fakeEnv)
    }
  })
})
