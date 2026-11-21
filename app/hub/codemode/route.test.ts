// shopify_script_run through the registry (P5 W2, A.1, A.2, A.3 caps, A.7.10 and the B2 cap addendum). The counters are
// the real SignIn core's (bumpCounter) over the in-memory store with a pinned clock; the Dynamic Worker is a stand-in
// (the workers project runs the real one). Failure modes:
// - the 51st script of a run or the 301st of a UTC day loads a worker, or the cap's message is lost on the way out;
// - the day doesn't reset at UTC midnight, or a server-scope call escapes the day's count;
// - a run id shaped like a day key spends the day's budget;
// - a paused or unconfigured Shopify still lists or runs the tool;
// - a log line carries the code, or a script failure turns into a tool error the model can't read.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildRegistry, callReadyTool, listReadyTools, type ReadyGatewayDeps, type Readiness } from '../registry/registry'
import type { CallerScope, HubResult } from '../index/contract'
import { shopifyConnector } from '../connectors/shopify/route'
import { harness, type Harness } from '../signin/testing/kit'
import { codeModeConnector, utcDay } from './route'
import { DAY_CAP, DAY_CAP_MESSAGE, RUN_CAP, RUN_CAP_MESSAGE } from './caps'
import type { CodeMode, CodeModeOutcome } from './types'

const SIX = ['orders_search', 'order_get', 'refunds_search', 'returns_search', 'products_search', 'inventory_levels_get']
const runScope = (runId: string): CallerScope => ({ kind: 'run', runId, principalId: 'p-1', requestId: 'r-1' })
const serverScope: CallerScope = { kind: 'server', job: 'morning-check', requestId: 'r-1' }
const CODE = 'const r = await shop.graphql("{ shop { currencyCode } }"); return r.data'
/** 2026-11-21 23:59:00 UTC: one minute before the day turns. */
const LATE_MS = Date.UTC(2026, 10, 21, 23, 59, 0)

type World = { h: Harness; runs: string[]; readiness: Readiness; configured: boolean; deps: ReadyGatewayDeps; outcome: CodeModeOutcome }

function world(): World {
  const h = harness({ clock: { ms: LATE_MS - 60 * 60_000 } })
  const w = { h, runs: [] as string[], readiness: { ready: true, policies: [] } as Readiness, configured: true, outcome: { outcome: 'ok', result: { n: 1 }, calls: 1, bytes: 10, ms: 5 } as CodeModeOutcome } as World
  const codemode: CodeMode = {
    bumpCounter: (key, limit, ttl) => h.core.bumpCounter(key, limit, ttl),
    run: async code => {
      w.runs.push(code)
      return w.outcome
    },
  }
  w.deps = {
    registry: buildRegistry([shopifyConnector, codeModeConnector]),
    isConfigured: () => w.configured,
    shopifyFor: () => ({ graphql: async () => ({ ok: true, value: { data: null } }) }),
    nowMs: () => h.clock.ms,
    isReady: async () => w.readiness,
    mcpFor: () => ({ call: async () => ({ ok: true, value: { content: [] } }) }),
    codemode,
  }
  return w
}

const call = (w: World, scope: CallerScope, code = CODE) => callReadyTool(w.deps, scope, 'shopify_script_run', { code })
let lines: string[] = []
beforeEach(() => {
  lines = []
  vi.spyOn(console, 'log').mockImplementation((s: unknown) => void lines.push(String(s)))
})
afterEach(() => vi.restoreAllMocks())

describe('shopify_script_run: the module', () => {
  it('registers beside the six with the shopify id, account and scopes', async () => {
    const w = world()
    const t = w.deps.registry.tools.get('shopify_script_run')!
    expect(t.connector.id).toBe('shopify')
    expect(t.connector.accountId).toBe('shopify:store')
    expect(t.description.length).toBeLessThanOrEqual(1024)
    expect(t.inputSchema).toMatchObject({ type: 'object', additionalProperties: false, required: ['code'] })
    const listed = (await listReadyTools(w.deps)).map(x => x.name)
    expect(listed.sort()).toEqual([...SIX, 'shopify_script_run'].sort())
    expect(new Set((await listReadyTools(w.deps)).map(x => x.connector))).toEqual(new Set(['shopify']))
  })

  it('pausing Shopify hides and refuses it with the six; unconfigured lists neither', async () => {
    const w = world()
    w.readiness = { ready: false, code: 'paused' }
    expect(await listReadyTools(w.deps)).toEqual([])
    expect(await call(w, runScope('run-1'))).toMatchObject({ ok: false, error: { code: 'paused' } })
    expect(await callReadyTool(w.deps, runScope('run-1'), 'orders_search', {})).toMatchObject({ ok: false, error: { code: 'paused' } })
    w.readiness = { ready: true, policies: [] }
    w.configured = false
    expect(await listReadyTools(w.deps)).toEqual([])
    expect(await call(w, runScope('run-1'))).toMatchObject({ ok: false, error: { code: 'not_configured' } })
    expect(w.runs).toEqual([])
  })

  it('without code mode wired it is not_configured and loads nothing', async () => {
    const w = world()
    delete w.deps.codemode
    expect(await call(w, runScope('run-1'))).toMatchObject({ ok: false, error: { code: 'not_configured' } })
  })

  it('bad input is invalid_args before any counter', async () => {
    const w = world()
    for (const args of [{}, { code: '' }, { code: 'x'.repeat(20_001) }, { code: 'return 1', extra: 1 }]) {
      expect(await callReadyTool(w.deps, runScope('run-1'), 'shopify_script_run', args)).toMatchObject({ ok: false, error: { code: 'invalid_args' } })
    }
    expect([...w.h.store.map.keys()].filter(k => k.startsWith('cm:'))).toEqual([])
  })
})

describe('shopify_script_run: results', () => {
  it('a result is { result, calls, ms }; a script failure is a successful result carrying its error', async () => {
    const w = world()
    expect(await call(w, runScope('run-1'))).toEqual({ ok: true, value: { data: { result: { n: 1 }, calls: 1, ms: 5 } } })
    w.outcome = { outcome: 'error', error: 'TypeError: x is not a function', calls: 0, bytes: 0, ms: 2 }
    expect(await call(w, runScope('run-1'))).toEqual({ ok: true, value: { data: { error: 'TypeError: x is not a function', calls: 0, ms: 2 } } })
  })

  it('logs one hub_codemode line per run with the hash, never the code', async () => {
    const w = world()
    await call(w, runScope('run-1'), 'return "SECRET_CODE_TEXT"')
    const cm = lines.map(l => JSON.parse(l) as Record<string, unknown>).filter(l => l.event === 'hub_codemode')
    expect(cm).toHaveLength(1)
    expect(cm[0]).toEqual({ event: 'hub_codemode', ms: 5, codeHash: expect.stringMatching(/^[0-9a-f]{12}$/), calls: 1, bytes: 10, outcome: 'ok' })
    expect(lines.join('\n')).not.toContain('SECRET_CODE_TEXT')
  })
})

describe('shopify_script_run: caps', () => {
  it(`the ${RUN_CAP}th script of a run runs, the ${RUN_CAP + 1}st is rate_limited with its message and loads nothing`, async () => {
    const w = world()
    for (let i = 1; i <= RUN_CAP; i++) expect((await call(w, runScope('run-1'))).ok, `call ${i}`).toBe(true)
    expect(w.runs).toHaveLength(RUN_CAP)
    const r = (await call(w, runScope('run-1'))) as HubResult<unknown>
    expect(r).toMatchObject({ ok: false, error: { code: 'rate_limited' } })
    if (!r.ok) expect(r.error.message).toContain(RUN_CAP_MESSAGE)
    expect(w.runs).toHaveLength(RUN_CAP)
    const last = JSON.parse(lines.at(-1)!) as Record<string, unknown>
    expect(last).toMatchObject({ event: 'hub_codemode', outcome: 'run_cap', calls: 0 })
    // Another run still has its own budget.
    expect((await call(w, runScope('run-2'))).ok).toBe(true)
  })

  it(`the ${DAY_CAP}th script of a UTC day runs, the ${DAY_CAP + 1}st is refused until midnight, then the count resets`, async () => {
    const w = world()
    w.h.clock.ms = LATE_MS
    for (let i = 0; i < DAY_CAP; i++) {
      // Runs of 50 and server jobs: both count toward the brand's day.
      const scope = i % 7 === 0 ? serverScope : runScope(`run-${Math.floor(i / 40)}`)
      expect((await call(w, scope)).ok, `call ${i + 1}`).toBe(true)
    }
    expect(w.runs).toHaveLength(DAY_CAP)
    const refused = (await call(w, runScope('fresh-run'))) as HubResult<unknown>
    expect(refused).toMatchObject({ ok: false, error: { code: 'rate_limited', retryAfterMs: 60_000 } })
    if (!refused.ok) expect(refused.error.message).toContain(DAY_CAP_MESSAGE)
    expect((await call(w, serverScope)).ok).toBe(false)
    expect(w.runs).toHaveLength(DAY_CAP)
    expect(JSON.parse(lines.at(-1)!)).toMatchObject({ event: 'hub_codemode', outcome: 'daily_cap' })
    // One second before midnight: still refused. At midnight UTC: a new day.
    w.h.clock.ms = Date.UTC(2026, 10, 22) - 1_000
    expect((await call(w, runScope('fresh-run-2'))).ok).toBe(false)
    w.h.clock.ms = Date.UTC(2026, 10, 22)
    expect((await call(w, runScope('fresh-run-3'))).ok).toBe(true)
    expect(w.runs).toHaveLength(DAY_CAP + 1)
  })

  it('a run id shaped like a day or job key never spends that budget', async () => {
    const w = world()
    const day = utcDay(w.h.clock.ms).key
    for (let i = 0; i < RUN_CAP; i++) await call(w, runScope(`day:${day}`))
    for (let i = 0; i < RUN_CAP; i++) await call(w, runScope('job:morning-check'))
    expect((await call(w, serverScope)).ok).toBe(true)
    expect(w.h.store.get<{ count: number }>(`cm:day:${day}`)?.count).toBe(2 * RUN_CAP + 1)
  })
})

describe('bumpCounter (SignIn core)', () => {
  it('counts to the limit, writes nothing past it, expires at its first ttl and sets the alarm by then', async () => {
    const h = harness()
    const t0 = h.clock.ms
    expect(await h.core.bumpCounter('k', 2, 1_000)).toEqual({ ok: true, value: { ok: true, count: 1 } })
    expect(h.alarm.at).toBe(t0 + 1_000)
    h.clock.ms += 500
    expect(await h.core.bumpCounter('k', 2, 1_000)).toEqual({ ok: true, value: { ok: true, count: 2 } })
    expect(await h.core.bumpCounter('k', 2, 1_000)).toEqual({ ok: true, value: { ok: false, count: 2 } })
    expect(h.store.get('cm:k')).toEqual({ count: 2, expiresAtMs: t0 + 1_000 })
    h.clock.ms = t0 + 1_000
    expect(await h.core.bumpCounter('k', 2, 1_000)).toEqual({ ok: true, value: { ok: true, count: 1 } })
    await h.core.alarm()
    h.clock.ms = t0 + 3_000
    await h.core.alarm()
    expect(h.store.get('cm:k')).toBeUndefined()
  })

  it('refuses bad arguments', async () => {
    const h = harness()
    for (const [k, l, t] of [['', 1, 1], ['k', 0, 1], ['k', 1.5, 1], ['k', 1, 0], ['k', 1, 25 * 60 * 60_000], ['k', 1, Number.NaN]] as const) {
      expect(await h.core.bumpCounter(k, l, t)).toMatchObject({ ok: false, error: { code: 'invalid_args' } })
    }
  })
})

describe('utcDay', () => {
  it('names the UTC date and ends at the next UTC midnight', () => {
    expect(utcDay(Date.UTC(2026, 10, 21, 23, 59, 59, 999))).toEqual({ key: '2026-11-21', endsAtMs: Date.UTC(2026, 10, 22) })
    expect(utcDay(Date.UTC(2026, 10, 22))).toEqual({ key: '2026-11-22', endsAtMs: Date.UTC(2026, 10, 23) })
    expect(utcDay(Date.UTC(2026, 11, 31, 12))).toEqual({ key: '2026-12-31', endsAtMs: Date.UTC(2027, 0, 1) })
  })
})
