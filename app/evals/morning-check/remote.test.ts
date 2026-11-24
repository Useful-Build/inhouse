// The remote mode (door.ts, remote.ts, args.ts): unit tests only, no live run. The door runs on an in-memory SQLite with
// every real migration applied (server/migrations/), and the override it writes is read back by the product's own reader
// (server/egress/test-shop.ts), so the two can't drift apart. Ways it can go wrong, written first:
//  1. the door writes a host that isn't one of the set's shops (a real store), or runs SQL before refusing;
//  2. an override outlives its case (not cleared after a case that throws, or before the first case), or a write or clear
//     isn't confirmed (a lost write reads as success);
//  3. the product reads the door's row as something else (format drift), so the hub gets no override and reads SHOPIFY_SHOP;
//  4. the slot reader gives grade.ts other shapes than the local reader (a renamed column, a number as a string);
//  5. a key or turn id reaches SQL unchecked;
//  6. remote mode mixed with local options, or missing the door's settings, starts anyway; a remote run without a release
//     token still calls route 67; a local run without one starts;
//  7. behind the eval host's Access: a request goes without the service token or the person JWT in both headers, a run with
//     only half the token starts, a per-PR run (no token) sends anything new, or the secret reaches an error or an answer;
//  8. the results claim --model while the slots ran on the brand's Default model (another model): graded under the wrong name;
//  9. the graded run (EVAL_DB) starts without the Access token or --budget, with --model-setting or a model the product
//     doesn't serve, or a per-PR run takes --budget; the scripted proof's door refuses its per-PR database;
// 10. two runs hold the eval lease at once, a run starts over another's test shop override, the lease outlives the run
//     (exit, signal), the cap isn't pinned or reads back other than MORNING_CHECK_CAP, or a run goes past its --budget.
import { readdirSync, readFileSync } from 'node:fs'
import fc from 'fast-check'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { readTestShop, type ShopDb } from '../../server/egress/test-shop.ts'
import { assertMorningCheckDatabase, assertSandboxDatabase, createDoor, D1_NOW_MS, DoorRefusal, EVAL_DB, EVAL_LEASE_TTL_MS, PER_PR_DB, wranglerRunner, type RunSql } from '../targets/door.ts'
import { EVAL_CAP } from '../targets/product.ts'
import { defaultModelLabel, refuseSharedEvalDb, runMode } from './args.ts'
import { createMorningDoor, type MorningDoor } from './door.ts'
import { AMBER, META, hostOf } from './expected.ts'
import { clearOnSignals, ensureDefaultModel, gradedRun, MORNING_CHECK_CAP, remoteEnv, remoteHttp, type ApiCall, type GradedDoor, type SettingsApi } from './remote.ts'
import { ROUTINE_ID, runAll } from './runner.ts'
import { GRADED_PROMPT_VERSION } from '../prompt-version.ts'

const migrations = fileURLToPath(new URL('../../server/migrations/', import.meta.url))
function database() {
  const db = new DatabaseSync(':memory:')
  for (const f of readdirSync(migrations).filter(f => f.endsWith('.sql')).sort()) db.exec(readFileSync(migrations + f, 'utf8'))
  const statements: string[] = []
  const run: RunSql = async sql => {
    statements.push(sql)
    return db.prepare(sql).all() as Record<string, unknown>[]
  }
  /** The product reader's D1, over the same database. */
  const d1 = { prepare: (sql: string) => ({ bind: (...p: (string | number)[]) => ({ first: async () => db.prepare(sql).get(...p) ?? null }) }) } as unknown as ShopDb
  return { db, run, statements, d1 }
}

const HOST = hostOf('late-orders')
const KEY = `now|${ROUTINE_ID}|${'a'.repeat(32)}`

describe('the door: the test shop override', () => {
  it('sets one of the set\'s shops, which the product reads as that host, and clears it (failure 3)', async () => {
    const { run, d1 } = database()
    const door = createMorningDoor(run, () => 5)
    await door.setShop(HOST)
    expect(await readTestShop(d1)).toBe(HOST)
    await door.setShop(hostOf('outage-all'))
    expect(await readTestShop(d1)).toBe(hostOf('outage-all'))
    expect(await door.clearShop(), 'the clear names what it removed').toBe(hostOf('outage-all'))
    expect(await readTestShop(d1)).toBeNull()
    expect(await door.clearShop(), 'nothing left to remove').toBeNull()
  })

  it.each(['example-fixture.myshopify.com', 'real-store.myshopify.com', `${HOST}'; DROP TABLE settings; --`, 'example-mc-late-orders'])('refuses %s before any SQL (failure 1)', async host => {
    const { run, statements } = database()
    await expect(createMorningDoor(run).setShop(host)).rejects.toBeInstanceOf(DoorRefusal)
    expect(statements).toEqual([])
  })

  it('a write or clear that doesn\'t read back is a loud failure (failure 2)', async () => {
    const lost: RunSql = async () => []
    await expect(createMorningDoor(lost).setShop(HOST)).rejects.toThrow(/reads back \[\]/)
    const stuck: RunSql = async sql => (sql.startsWith('SELECT') ? [{ value_json: JSON.stringify(HOST) }] : [])
    await expect(createMorningDoor(stuck).clearShop()).rejects.toThrow(/still set/)
  })
})

describe('the door: what grade.ts reads (failure 4, 5)', () => {
  it('reads a slot, its items and its turn\'s tools as the local reader\'s shapes', async () => {
    const { db, run } = database()
    db.exec(`INSERT INTO routine_slots (slot_key, routine_id, kind, local_date, tz, due_at_ms, deadline_ms, state, chat_id, client_key, prompt_text, submit_json, routine_rev, creator_id, turn_id, failure, result_text, claimed_at_ms)
      VALUES ('${KEY}', '${ROUTINE_ID}', 'manual', '2026-11-22', 'UTC', 1, 2, 'ended', 'c', 'k', 'p', '{}', 1, 'm', 'turn_1', 'incomplete', 'found 1 thing; couldn''t read returns', 1234)`)
    db.exec(`INSERT INTO today_items (id, key, local_date, slot_key, claimed_at_ms, run_id, item_json, created_at_ms) VALUES ('i2', 'b', '2026-11-22', '${KEY}', 1234, 'r', '{"key":"b"}', 1), ('i1', 'a', '2026-11-22', '${KEY}', 1234, 'r', '{"key":"a"}', 1)`)
    db.exec(`INSERT INTO tool_calls (turn_id, n, chat_id, member_id, hook, tool, decision, input_bytes, input_sha256, at_ms) VALUES ('turn_1', 2, 'c', 'm', 'pre', 'StructuredOutput', 'allow', 1, 'x', 1), ('turn_1', 1, 'c', 'm', 'pre', 'mcp__apps__orders_search', 'allow', 1, 'x', 1)`)
    const door = createMorningDoor(run)
    expect(await door.slot(KEY)).toEqual({ slot_key: KEY, state: 'ended', failure: 'incomplete', result_text: 'found 1 thing; couldn\'t read returns', turn_id: 'turn_1', claimed_at_ms: 1234 })
    expect(await door.items(KEY)).toEqual(['{"key":"b"}', '{"key":"a"}'])
    expect(await door.tools('turn_1')).toEqual(['mcp__apps__orders_search', 'StructuredOutput'])
    expect(await door.slot(`now|${ROUTINE_ID}|${'b'.repeat(32)}`)).toBeNull()
  })

  it('reads the model a slot was submitted with, null while there\'s no slot, and refuses a submit without one (failure 8)', async () => {
    const { db, run } = database()
    const insert = (key: string, submit: string) => db.prepare(`INSERT INTO routine_slots (slot_key, routine_id, kind, local_date, tz, due_at_ms, deadline_ms, state, chat_id, client_key, prompt_text, submit_json, routine_rev, creator_id, claimed_at_ms)
      VALUES (?, '${ROUTINE_ID}', 'manual', '2026-11-22', 'UTC', 1, 2, 'ended', 'c', 'k', 'p', ?, 1, 'm', 1)`).run(key, submit)
    insert(KEY, JSON.stringify({ model: 'claude-opus-5-5', pickerId: 'opus', effort: 'medium', priority: 'next' }))
    const door = createMorningDoor(run)
    expect(await door.model(KEY)).toBe('claude-opus-5-5')
    expect(await door.model(`now|${ROUTINE_ID}|${'b'.repeat(32)}`)).toBeNull()
    insert(`now|${ROUTINE_ID}|${'c'.repeat(32)}`, '{}')
    await expect(door.model(`now|${ROUTINE_ID}|${'c'.repeat(32)}`)).rejects.toThrow('slot model that is not a string')
  })

  it.each([`now|${ROUTINE_ID}|${'a'.repeat(31)}'`, `due|${ROUTINE_ID}|2026-11-22`, `now|other|${'a'.repeat(32)}`])('refuses the slot key %s before any SQL', async key => {
    const { run, statements } = database()
    await expect(createMorningDoor(run).slot(key)).rejects.toBeInstanceOf(DoorRefusal)
    await expect(createMorningDoor(run).model(key)).rejects.toBeInstanceOf(DoorRefusal)
    await expect(createMorningDoor(run).items(key)).rejects.toBeInstanceOf(DoorRefusal)
    await expect(createMorningDoor(run).tools("t' OR 1=1 --")).rejects.toBeInstanceOf(DoorRefusal)
    expect(statements).toEqual([])
  })
})

describe('the remote runner env', () => {
  function fakes(alarm: boolean) {
    const log: string[] = []
    const warnings: string[] = []
    let held: string | null = null
    let now = 0
    const door: MorningDoor = {
      setShop: async (h: string) => { held = h; log.push(`set ${h}`) },
      close: () => {},
      clearShop: async () => { const was = held; held = null; log.push('clear'); return was },
      slot: async (k: string) => { log.push(`poll ${held ?? 'none'}`); return { slot_key: k, state: 'ended', failure: null, result_text: 'found 0 things', turn_id: null, claimed_at_ms: 1 } },
      items: async () => [],
      tools: async () => [],
      model: async () => 'claude-sonnet-5-5',
    }
    const env = remoteEnv({
      door, runNow: async k => { log.push(`run ${k.length}`) }, alarm: alarm ? async b => { log.push(`alarm ${JSON.stringify(b)}`) } : null,
      pause: async () => { now += 1000 }, nowMs: () => now, caseTimeoutMs: 60_000, settleMs: 10_000, warn: line => void warnings.push(line),
    })
    return { env, log, door, warnings, held: () => held, leave: (h: string) => { held = h } }
  }
  const twoCases = () => [META.find(c => c.id === 'clean-empty')!, META.find(c => c.id === 'outage-all')!]
  const meta = { date: '2026-11-22', sha: 'abc1234', model: 'scripted' }

  it('a leftover override at the run\'s start is removed and said loudly, once; the cases\' own clears say nothing (failure 2)', async () => {
    const { env, warnings, leave } = fakes(false)
    leave(hostOf('fixture'))
    await runAll(env, twoCases(), meta)
    expect(warnings).toEqual([expect.stringContaining(`removed a leftover test shop override (${hostOf('fixture')})`)])
    expect(warnings[0]).toContain('only one runner per deployment')
    const clean = fakes(false)
    await runAll(clean.env, twoCases(), meta)
    expect(clean.warnings).toEqual([])
  })

  it('a clear that fails after a case keeps that case\'s result and stops the run, naming it (LOW 5)', async () => {
    const { env, door } = fakes(false)
    let clears = 0
    const real = door.clearShop
    door.clearShop = async () => { if (++clears === 2) throw new Error('wrangler d1 execute exited 1'); return real() }
    const written: number[] = []
    const file = await runAll(env, twoCases(), meta, f => void written.push(f.cases.length))
    expect(file.cases.map(c => c.id)).toEqual(['clean-empty'])
    expect(file.cases[0]!.verdict.pass).toBe(true)
    expect(file.stopped).toEqual({ at: 'clean-empty', reason: expect.stringContaining('the test shop override could not be cleared (wrangler d1 execute exited 1)') })
    expect(file.notRun).toEqual(['outage-all'])
    expect(written).toEqual([1])
  })

  it('a case that throws and whose clear fails too throws with both causes', async () => {
    const { env, door } = fakes(false)
    door.slot = async () => { throw new Error('the door read failed') }
    let clears = 0
    door.clearShop = async () => { if (++clears === 2) throw new Error('clear failed'); return null }
    await expect(runAll(env, twoCases(), meta)).rejects.toThrow('the door read failed; and the test shop override could not be cleared: clear failed')
  })

  it('a slot that never appears stops the run after that case: wrong database (LOW 6)', async () => {
    const { env, door } = fakes(false)
    door.slot = async () => null
    const file = await runAll(env, twoCases(), meta)
    expect(file.cases.map(c => [c.id, c.observed.ok ? 'ok' : c.observed.cause])).toEqual([['clean-empty', 'no_slot']])
    expect(file.stopped).toEqual({ at: 'clean-empty', reason: expect.stringContaining('slot not found in this D1 (wrong database?)') })
    expect(file.notRun).toEqual(['outage-all'])
  })

  it('sets each case\'s shop, clears it before the first case and after every case, even one that throws (failure 2)', async () => {
    const { env, log, door, held } = fakes(true)
    const cases = [META.find(c => c.id === 'clean-empty')!, META.find(c => c.id === 'outage-all')!]
    await runAll(env, cases, { date: '2026-11-22', sha: 'abc1234', model: 'scripted' })
    expect(log.filter(l => l === 'clear' || l.startsWith('set ') || l.startsWith('poll '))).toEqual(['clear', `set ${hostOf('clean-empty')}`, `poll ${hostOf('clean-empty')}`, 'clear', `set ${hostOf('outage-all')}`, `poll ${hostOf('outage-all')}`, 'clear'])
    door.slot = async () => { throw new Error('wrangler d1 execute exited 1') }
    await expect(runAll(env, cases, { date: '2026-11-22', sha: 'abc1234', model: 'scripted' })).rejects.toThrow(/exited 1/)
    expect(held()).toBeNull()
  })

  it('with a release token, Run now then route 67 with pokeTick; without one, Run now alone and no nudge (failure 6)', async () => {
    const withToken = fakes(true)
    await withToken.env.trigger('f'.repeat(32))
    await withToken.env.nudge()
    expect(withToken.log).toEqual(['run 32', 'alarm {"action":"alarm","pokeTick":true}', 'alarm {"action":"alarm"}'])
    const without = fakes(false)
    await without.env.trigger('f'.repeat(32))
    await without.env.nudge()
    expect(without.log).toEqual(['run 32'])
  })

  it('with checkModel, each case keeps the model its slot ran on; a run on --model passes (failure 8)', async () => {
    const { door } = fakes(false)
    let now = 0
    const env = remoteEnv({ door, runNow: async () => {}, alarm: null, pause: async () => { now += 1000 }, nowMs: () => now, caseTimeoutMs: 60_000, settleMs: 10_000, warn: () => {}, checkModel: true })
    const file = await runAll(env, twoCases(), { ...meta, model: 'claude-sonnet-5-5' })
    expect(file.cases.map(c => [c.id, c.ranOn, c.verdict.pass])).toEqual([['clean-empty', 'claude-sonnet-5-5', true], ['outage-all', 'claude-sonnet-5-5', false]])
    expect(file.stopped).toBeUndefined()
  })

  it('with checkModel, a slot that ran on another model fails its case and stops the run, naming both (failure 8)', async () => {
    const { door } = fakes(false)
    door.model = async () => 'claude-opus-5-5'
    let now = 0
    const env = remoteEnv({ door, runNow: async () => {}, alarm: null, pause: async () => { now += 1000 }, nowMs: () => now, caseTimeoutMs: 60_000, settleMs: 10_000, warn: () => {}, checkModel: true })
    const file = await runAll(env, twoCases(), { ...meta, model: 'claude-sonnet-5-5' })
    expect(file.cases).toHaveLength(1)
    expect(file.cases[0]).toMatchObject({ id: 'clean-empty', ranOn: 'claude-opus-5-5', verdict: { pass: false, reasons: ['ran on claude-opus-5-5, not claude-sonnet-5-5'] } })
    expect(file.stopped).toEqual({ at: 'clean-empty', reason: expect.stringContaining('clean-empty ran on claude-opus-5-5, not claude-sonnet-5-5') })
    expect(file.notRun).toEqual(['outage-all'])
    expect(file.summary.thresholdMet).toBe(false)
  })

  // P5 (#337): with promptVersions set (run.mjs: route 33's trace), each case keeps the system prompt version its turn was
  // sent, and a turn not sent v3 (the static v2 fallback, or no version recorded) fails its case with that reason.
  // #337 round 3 (M4): the store check reads exactly what the turns use: after the case's shop is set (route 70 then carries
  // the test shop, as the turns' reads and prompt do) and before Run now. A store not served stops the run there, before
  // that case's spend: the case is not run, never graded.
  it('with storeTools, route 70 is read after the case\'s shop is set and before Run now', async () => {
    const { door, log } = fakes(false)
    let now = 0
    const env = remoteEnv({ door, runNow: async () => void log.push('run'), alarm: null, pause: async () => { now += 1000 }, nowMs: () => now, caseTimeoutMs: 60_000, settleMs: 10_000, warn: () => {},
      storeTools: async () => { log.push('tools'); return { connected: ['shopify'], details: { shopify: { name: 'Shopify' } }, connection: {} } } })
    const file = await runAll(env, [META.find(c => c.id === 'clean-empty')!], meta)
    expect(file.stopped).toBeUndefined()
    expect(log.filter(l => l.startsWith('set ') || l.startsWith('tools') || l === 'run')).toEqual([`set ${hostOf('clean-empty')}`, 'tools', 'run'])
  })

  it('with storeTools, a store not served stops the run at that case, before Run now: it and the rest are not run', async () => {
    for (const [tools, text] of [
      [{ connected: [], details: {}, connection: {} }, 'Shopify is not connected on the brand\'s Tools page'],
      [{ connected: ['shopify'], details: { shopify: { name: 'Shopify', paused: true } }, connection: {} }, 'Shopify is paused on the brand\'s Tools page'],
    ] as const) {
      const { door, log } = fakes(false)
      let now = 0
      const env = remoteEnv({ door, runNow: async () => void log.push('run'), alarm: null, pause: async () => { now += 1000 }, nowMs: () => now, caseTimeoutMs: 60_000, settleMs: 10_000, warn: () => {}, storeTools: async () => tools })
      const file = await runAll(env, twoCases(), meta)
      expect(log.includes('run'), text).toBe(false)
      expect(file.cases).toEqual([])
      expect(file.notRun).toEqual(['clean-empty', 'outage-all'])
      expect(file.stopped).toEqual({ at: 'clean-empty', reason: expect.stringContaining(text) })
      expect(log.at(-1), 'the override cleared').toBe('clear')
    }
  })

  it('with promptTrace, a case whose turn was sent v3 passes as before and keeps prompt 3', async () => {
    const { door } = fakes(false)
    const slot = door.slot
    door.slot = async (k: string) => ({ ...(await slot(k))!, turn_id: 't_AAAAAAAAAAAAAAAAAAAAAA' })
    const asked: string[] = []
    let now = 0
    const env = remoteEnv({ door, runNow: async () => {}, alarm: null, pause: async () => { now += 1000 }, nowMs: () => now, caseTimeoutMs: 60_000, settleMs: 10_000, warn: () => {}, promptTrace: async t => { asked.push(t); return { promptVersions: [GRADED_PROMPT_VERSION], promptApps: [['Shopify']] } } })
    const file = await runAll(env, twoCases(), meta)
    expect(file.cases.map(c => [c.id, c.prompt, c.verdict.pass])).toEqual([['clean-empty', GRADED_PROMPT_VERSION, true], ['outage-all', GRADED_PROMPT_VERSION, false]])
    expect(asked).toEqual(['t_AAAAAAAAAAAAAAAAAAAAAA', 't_AAAAAAAAAAAAAAAAAAAAAA'])
  })

  it('with promptTrace, a turn sent v2 or with none recorded fails its case naming why (never a pass)', async () => {
    for (const [versions, sent] of [[[2], 2], [undefined, 'missing'], [[null], 'missing']] as const) {
      const { door } = fakes(false)
      const slot = door.slot
      door.slot = async (k: string) => ({ ...(await slot(k))!, turn_id: 't_AAAAAAAAAAAAAAAAAAAAAA' })
      let now = 0
      const env = remoteEnv({ door, runNow: async () => {}, alarm: null, pause: async () => { now += 1000 }, nowMs: () => now, caseTimeoutMs: 60_000, settleMs: 10_000, warn: () => {}, promptTrace: async () => (versions === undefined ? {} : { promptVersions: versions, promptApps: [['Shopify']] }) })
      const file = await runAll(env, [META.find(c => c.id === 'clean-empty')!], meta)
      expect(file.cases[0], String(sent)).toMatchObject({ prompt: sent, verdict: { pass: false, reasons: [`prompt_version:${sent}: the turn was not sent the system prompt v${GRADED_PROMPT_VERSION}`] } })
    }
  })

  // #337 round 3 (M3): a v3 turn whose prompt didn't name Shopify fails its case too, naming the apps it named.
  it('with promptTrace, a v3 turn whose prompt named no store fails as prompt_apps', async () => {
    for (const [apps, code] of [[[[]], 'prompt_apps:none'], [[['Slack']], 'prompt_apps:Slack'], [undefined, 'prompt_apps:missing']] as const) {
      const { door } = fakes(false)
      const slot = door.slot
      door.slot = async (k: string) => ({ ...(await slot(k))!, turn_id: 't_AAAAAAAAAAAAAAAAAAAAAA' })
      let now = 0
      const env = remoteEnv({ door, runNow: async () => {}, alarm: null, pause: async () => { now += 1000 }, nowMs: () => now, caseTimeoutMs: 60_000, settleMs: 10_000, warn: () => {}, promptTrace: async () => ({ promptVersions: [GRADED_PROMPT_VERSION], ...(apps === undefined ? {} : { promptApps: apps }) }) })
      const file = await runAll(env, [META.find(c => c.id === 'clean-empty')!], meta)
      expect(file.cases[0], code).toMatchObject({ prompt: GRADED_PROMPT_VERSION, verdict: { pass: false, reasons: [`${code}: the turn's prompt did not name Shopify as connected`] } })
    }
  })

  // #337 round 2 (Sonnet M3): a slot that ended with no turn has no prompt to check, so it fails as missing (it would
  // otherwise grade on its stored rows alone), and no trace is read for it.
  it('with promptTrace, a slot with no turn reads no trace and fails as prompt_version:missing', async () => {
    const { door } = fakes(false)
    let now = 0
    const env = remoteEnv({ door, runNow: async () => {}, alarm: null, pause: async () => { now += 1000 }, nowMs: () => now, caseTimeoutMs: 60_000, settleMs: 10_000, warn: () => {}, promptTrace: async () => { throw new Error('trace read') } })
    const file = await runAll(env, [META.find(c => c.id === 'clean-empty')!], meta)
    expect(file.cases[0]).toMatchObject({ prompt: 'missing', verdict: { pass: false, reasons: [`prompt_version:missing: the turn was not sent the system prompt v${GRADED_PROMPT_VERSION}`] } })
  })

  it('without checkModel (the scripted proof\'s spec), no slot model is read nor kept', async () => {
    const { env, door } = fakes(false)
    door.model = async () => { throw new Error('model read') }
    const file = await runAll(env, twoCases(), meta)
    expect(file.cases.map(c => c.ranOn)).toEqual([undefined, undefined])
  })

  it('a fresh 32-hex key per case', () => {
    const { env } = fakes(false)
    const a = env.newKey()
    expect(a).toMatch(/^[0-9a-f]{32}$/)
    expect(env.newKey()).not.toBe(a)
  })
})

// The whole remote path on a fake build: the real door on the real schema, and a "build" whose Run now reads the override
// with the product's own reader (server/egress/test-shop.ts) and leaves the rows a morning check on that shop would. The
// grader is untouched. It must see each case's own shop, grade both as passes, and leave no override.
describe('runAll in remote mode, the real door on a fake build', () => {
  it('each case runs on its own shop, grades unchanged, and no override is left', async () => {
    const { db, run, d1 } = database()
    const seen: (string | null)[] = []
    let turn = 0
    const runNow = async (clientKey: string) => {
      const host = await readTestShop(d1)
      seen.push(host)
      if (host === null) return
      const key = `now|${ROUTINE_ID}|${clientKey}`
      const t = `turn_${++turn}`
      const outage = host === hostOf('outage-all')
      db.prepare(`INSERT INTO routine_slots (slot_key, routine_id, kind, local_date, tz, due_at_ms, deadline_ms, state, chat_id, client_key, prompt_text, submit_json, routine_rev, creator_id, turn_id, failure, result_text, claimed_at_ms)
        VALUES (?, ?, 'manual', '2026-11-22', 'UTC', 1, 2, 'ended', 'c', ?, 'p', '{}', 1, 'm', ?, ?, ?, ?)`).run(key, ROUTINE_ID, clientKey, t, outage ? 'incomplete' : null, outage ? "found 0 things; couldn't read orders, products, inventory, refunds, returns" : 'found 1 thing', turn)
      db.prepare("INSERT INTO tool_calls (turn_id, n, chat_id, member_id, hook, tool, decision, input_bytes, input_sha256, at_ms) VALUES (?, 1, 'c', 'm', 'pre', 'mcp__apps__orders_search', 'allow', 1, 'x', 1)").run(t)
      if (!outage) {
        const item = { key: 'late-orders', sev: AMBER, sources: [{ n: 'Order #2001' }, { n: '#2002' }, { n: '#2003' }] }
        db.prepare("INSERT INTO today_items (id, key, local_date, slot_key, claimed_at_ms, run_id, item_json, created_at_ms) VALUES (?, 'late-orders', '2026-11-22', ?, 1, 'r', ?, 1)").run(`i_${t}`, key, JSON.stringify(item))
      }
    }
    let now = 0
    const env = remoteEnv({ door: createMorningDoor(run), runNow, alarm: null, pause: async () => { now += 1000 }, nowMs: () => now, caseTimeoutMs: 60_000, settleMs: 10_000, warn: () => {} })
    const cases = ['outage-all', 'late-orders'].map(id => META.find(c => c.id === id)!)
    const file = await runAll(env, cases, { date: '2026-11-22', sha: 'abc1234', model: 'scripted' })
    expect(seen).toEqual([hostOf('outage-all'), hostOf('late-orders')])
    expect(file.cases.map(c => [c.id, c.verdict.pass, c.verdict.reasons])).toEqual([['outage-all', true, []], ['late-orders', true, []]])
    expect(file.cases[0]!.observed).toMatchObject({ ok: true, coverage: 'incomplete', calls: ['mcp__apps__orders_search'] })
    expect(await readTestShop(d1)).toBeNull()
  })
})

describe('run.mjs stop handlers (MEDIUM 3)', () => {
  function signals(clear: () => Promise<string | null>, close: () => void = () => {}) {
    const handlers = new Map<string, () => void>()
    const log: string[] = []
    let exited: (code: number) => void = () => {}
    const exit = new Promise<number>(done => { exited = done })
    clearOnSignals({ close, clearShop: clear }, { on: (s, h) => void handlers.set(s, h), exit: code => { log.push(`exit ${code}`); exited(code) }, error: line => void log.push(line) })
    return { handlers, log, exit }
  }

  it.each([['SIGINT', 130], ['SIGTERM', 143]] as const)('%s clears the override, awaited, then exits %i', async (signal, code) => {
    let release: () => void = () => {}
    const cleared = new Promise<void>(done => { release = done })
    const order: string[] = []
    const s = signals(async () => { order.push('clear started'); await cleared; order.push('clear done'); return null }, () => void order.push('closed'))
    expect([...s.handlers.keys()]).toEqual(['SIGINT', 'SIGTERM'])
    s.handlers.get(signal)!()
    expect(s.log.filter(l => l.startsWith('exit'))).toEqual([])
    release()
    expect(await s.exit).toBe(code)
    expect(order).toEqual(['closed', 'clear started', 'clear done'])
  })

  // Opus round 2 LOW: a SIGTERM to node alone leaves runAll going; its next setShop must not write after the clear.
  it('after the signal the door is closed: the run\'s next useShop is refused before any INSERT, and nothing is left set', async () => {
    const { run, statements, d1 } = database()
    const door = createMorningDoor(run)
    const env = remoteEnv({ door, runNow: async () => {}, alarm: null, pause: async () => {}, nowMs: () => 0, caseTimeoutMs: 1, settleMs: 1, warn: () => {} })
    await env.useShop(HOST)
    const s = signals(() => door.clearShop(), () => door.close())
    s.handlers.get('SIGTERM')!()
    const after = statements.length
    await expect(env.useShop(hostOf('outage-all'))).rejects.toBeInstanceOf(DoorRefusal)
    expect(await s.exit).toBe(143)
    expect(statements.slice(after).filter(q => q.startsWith('INSERT'))).toEqual([])
    expect(await readTestShop(d1)).toBeNull()
    // A run that goes on after the signal fails its case on the refused shop and never presses Run now.
    const pressed: string[] = []
    const going = remoteEnv({ door, runNow: async k => void pressed.push(k), alarm: null, pause: async () => {}, nowMs: () => 0, caseTimeoutMs: 1, settleMs: 1, warn: () => {} })
    const file = await runAll(going, [META.find(c => c.id === 'late-orders')!], { date: '2026-11-22', sha: 'abc1234', model: 'scripted' })
    expect(file.cases[0]!.observed).toMatchObject({ ok: false, cause: expect.stringContaining('the door is closed') })
    expect(pressed).toEqual([])
    expect(statements.slice(after).filter(q => q.startsWith('INSERT'))).toEqual([])
  })

  it('a clear that fails is printed and the exit code stays the signal\'s', async () => {
    const s = signals(async () => { throw new Error('wrangler d1 execute exited 1') })
    s.handlers.get('SIGTERM')!()
    expect(await s.exit).toBe(143)
    expect(s.log).toContain('run.mjs: the test shop override could not be cleared: wrangler d1 execute exited 1')
  })
})

// The Default model before the first Run now (routine turns run on it; the scripted model answers only Fast). The fake
// server models route 12's rule (server/auth/matrix.ts, its own tests in matrix.test.ts): an Admin writing `g:mode` gets 403
// admin_read_only; the Inhouse team member's write is accepted with or without a live grant (matrix.ts answers a technical
// row for Inhouse OK, and server/api/routes-wired.test.ts writes one with no grant open), so the grant step is only
// setStage's, checked here for order and cleanup. Ways it can go wrong: a case is pressed before the setting is written,
// the write goes as the Admin (refused live), a grant is left open after it (also when the write fails or throws), a
// refused or unconfirmed write lets the run go on, a stale revision is sent, a write failure and a grant that won't end
// hide each other, or a run that didn't ask for a model writes one anyway.
describe('the Default model, set before the first Run now', () => {
  function server(initial: { value: string; rev: number } | null, o: { grantStatus?: number; leftoverGrant?: boolean; putStatus?: number; endFails?: boolean } = {}) {
    const events: string[] = []
    let row = initial
    let grants: { id: string; rev: number; live: boolean }[] = o.leftoverGrant ? [{ id: 'g_old', rev: 3, live: true }] : []
    const answer = (status: number, json: unknown) => ({ status, json })
    const as = (who: 'admin' | 'inhouse'): ApiCall => async (method, path, body) => {
      events.push(`${who} ${method} ${path}${body === undefined ? '' : ` ${JSON.stringify(body)}`}`)
      if (method === 'GET' && path === '/api/settings/technical') return answer(200, { items: row ? [{ key: 'g:mode', value: row.value, rev: row.rev }] : [] })
      if (who === 'admin' && method === 'GET' && path === '/api/grants') return answer(200, { items: grants })
      if (who === 'admin' && method === 'POST' && path === '/api/grants') {
        if ((o.grantStatus ?? 201) !== 201) return answer(o.grantStatus!, { error: { code: 'conflict' } })
        grants = [...grants, { id: `g_${grants.length + 1}`, rev: 1, live: true }]
        return answer(201, grants.at(-1))
      }
      const end = /^\/api\/grants\/([^/]+)\/end$/.exec(path)
      if (who === 'admin' && method === 'POST' && end) {
        if (o.endFails) return answer(500, { error: { code: 'internal' } })
        grants = grants.map(g => (g.id === end[1] ? { ...g, live: false, rev: g.rev + 1 } : g))
        return answer(200, {})
      }
      if (method === 'PUT' && path === '/api/settings/technical/g%3Amode') {
        if (who === 'admin') return answer(403, { error: { code: 'forbidden', reason: 'admin_read_only' } })
        if (o.putStatus !== undefined) return answer(o.putStatus, { error: { code: 'conflict' } })
        row = { value: (body as { value: string }).value, rev: (row?.rev ?? 0) + 1 }
        return answer(200, row)
      }
      return answer(404, { error: { code: 'not_found' } })
    }
    return { api: { admin: as('admin'), inhouse: as('inhouse') } as SettingsApi, events, live: () => grants.filter(g => g.live).length }
  }
  function fakeRun(api: SettingsApi | null, events: string[]) {
    const door: MorningDoor = {
      close: () => {}, setShop: async () => {}, clearShop: async () => null,
      slot: async k => ({ slot_key: k, state: 'ended', failure: null, result_text: 'found 0 things', turn_id: null, claimed_at_ms: 1 }),
      items: async () => [], tools: async () => [], model: async () => null,
    }
    let now = 0
    return remoteEnv({
      door, runNow: async () => void events.push('Run now'), alarm: null, pause: async () => { now += 1000 }, nowMs: () => now, caseTimeoutMs: 60_000, settleMs: 10_000, warn: () => {},
      ...(api ? { defaultModel: () => ensureDefaultModel(api, 'Fast') } : {}),
    })
  }
  const one = [META.find(c => c.id === 'clean-empty')!]
  const meta = { date: '2026-11-22', sha: 'abc1234', model: 'scripted' }

  it('unset (Opus): grants ended, one opened by the Admin, the Inhouse write with its revision, grants ended, read back, then Run now', async () => {
    const s = server(null)
    await runAll(fakeRun(s.api, s.events), [...one, META.find(c => c.id === 'clean-steady')!], meta)
    expect(s.events).toEqual([
      'admin GET /api/settings/technical', 'admin GET /api/grants', 'admin POST /api/grants {"hours":1}',
      'inhouse PUT /api/settings/technical/g%3Amode {"value":"Fast","ifRev":0}', 'admin GET /api/grants', 'admin POST /api/grants/g_1/end {"ifRev":1}',
      'admin GET /api/settings/technical', 'Run now', 'Run now',
    ])
    expect(s.live()).toBe(0)
  })

  it('a live grant left over is ended first; another model is written over with that row\'s revision', async () => {
    const s = server({ value: 'Deep', rev: 4 }, { leftoverGrant: true })
    await runAll(fakeRun(s.api, s.events), one, meta)
    expect(s.events.slice(1, 4)).toEqual(['admin GET /api/grants', 'admin POST /api/grants/g_old/end {"ifRev":3}', 'admin POST /api/grants {"hours":1}'])
    expect(s.events).toContain('inhouse PUT /api/settings/technical/g%3Amode {"value":"Fast","ifRev":4}')
    expect(s.live()).toBe(0)
  })

  it('already Fast: read only, no grant, no write', async () => {
    const s = server({ value: 'Fast', rev: 2 })
    await runAll(fakeRun(s.api, s.events), one, meta)
    expect(s.events).toEqual(['admin GET /api/settings/technical', 'admin GET /api/settings/technical', 'Run now'])
  })

  it('written as the Admin, the write is refused 403 admin_read_only: the run stops before any Run now, no grant left open', async () => {
    const s = server(null)
    await expect(runAll(fakeRun({ admin: s.api.admin, inhouse: s.api.admin }, s.events), one, meta)).rejects.toThrow('setting the Default model to Fast answered 403: {"error":{"code":"forbidden","reason":"admin_read_only"}}')
    expect(s.events).not.toContain('Run now')
    expect(s.live()).toBe(0)
  })

  it('a grant that can\'t be opened: no write, the run stops before any Run now', async () => {
    const s = server(null, { grantStatus: 409 })
    await expect(runAll(fakeRun(s.api, s.events), one, meta)).rejects.toThrow('opening a support grant answered 409')
    expect(s.events.some(e => e.startsWith('inhouse PUT'))).toBe(false)
    expect(s.events).not.toContain('Run now')
    expect(s.live()).toBe(0)
  })

  it('a stale revision (409 on the write): the run stops before any Run now, no grant left open', async () => {
    const s = server({ value: 'Deep', rev: 4 }, { putStatus: 409 })
    await expect(runAll(fakeRun(s.api, s.events), one, meta)).rejects.toThrow('setting the Default model to Fast answered 409')
    expect(s.events).not.toContain('Run now')
    expect(s.live()).toBe(0)
  })

  it('the Inhouse call throws (a network failure): the rejection is its own, and no grant is left open', async () => {
    const s = server(null)
    const api: SettingsApi = { admin: s.api.admin, inhouse: async () => { throw new Error('fetch failed: the Inhouse app is unreachable') } }
    await expect(runAll(fakeRun(api, s.events), one, meta)).rejects.toThrow('fetch failed: the Inhouse app is unreachable')
    expect(s.events).not.toContain('Run now')
    expect(s.live()).toBe(0)
  })

  it('a write that fails and grants that won\'t end are both reported (LOW 3)', async () => {
    const s = server(null, { putStatus: 409, endFails: true })
    const run = runAll(fakeRun(s.api, s.events), one, meta)
    await expect(run).rejects.toThrow('setting the Default model to Fast answered 409')
    await expect(run).rejects.toThrow('and live support grants could not be ended: morning-check: ending support grant g_1 answered 500')
    expect(s.events).not.toContain('Run now')
  })

  it('grants that won\'t end after a good write still stop the run', async () => {
    const s = server(null, { endFails: true })
    await expect(runAll(fakeRun(s.api, s.events), one, meta)).rejects.toThrow('live support grants could not be ended: morning-check: ending support grant g_1 answered 500')
    expect(s.events).not.toContain('Run now')
  })

  it('a write that doesn\'t read back stops the run before any Run now', async () => {
    const s = server(null)
    const lying: SettingsApi = { admin: async (method, path, body) => (method === 'GET' && path === '/api/settings/technical' ? { status: 200, json: { items: [] } } : s.api.admin(method, path, body)), inhouse: s.api.inhouse }
    const events: string[] = []
    await expect(runAll(fakeRun(lying, events), one, meta)).rejects.toThrow('the Default model reads back undefined, not Fast')
    expect(events).toEqual([])
    expect(s.live()).toBe(0)
  })

  it('a run that asks for no model writes none (the real-model run)', async () => {
    const events: string[] = []
    await runAll(fakeRun(null, events), one, meta)
    expect(events).toEqual(['Run now'])
  })

  it.each(['fast mode', '../x', '', 'Fast"}'])('refuses the label %j before any call', async label => {
    const s = server(null)
    await expect(ensureDefaultModel(s.api, label)).rejects.toThrow('is not a Default model label')
    expect(s.events).toEqual([])
  })
})

// Behind the eval host's Access lock, as main's evals/probe.test.ts checks the probe: every request carries the service token
// (targets/product.ts accessHeaders, as run.mjs passes it) after the person's sign-in headers; a per-PR run (no token) sends
// the sign-in headers alone; the secret never reaches an error or an answer.
describe('requests behind the eval host\'s Access (failure 7)', () => {
  const SECRET = 'eval-ci-secret-SHOULD-NOT-PRINT'
  const edge = { 'CF-Access-Client-Id': 'id.access', 'CF-Access-Client-Secret': SECRET }
  const auth = { 'Cf-Access-Jwt-Assertion': 'eyJhbGciOiJSUzI1NiJ9.e30.sig', 'X-Test-Sign-In': 'same' }
  function server(answer: (url: string) => Response | Promise<Response>) {
    const seen: { url: string; method?: string; headers: Record<string, string>; body?: string }[] = []
    const f = (async (url: URL, init?: RequestInit) => {
      seen.push({ url: String(url), method: init?.method, headers: init?.headers as Record<string, string>, body: init?.body as string | undefined })
      return answer(String(url))
    }) as unknown as typeof fetch
    return { f, seen }
  }

  it('run.mjs builds its edge from targets/product.ts accessHeaders and sends no header literal of its own', () => {
    const runMjs = readFileSync(new URL('./run.mjs', import.meta.url), 'utf8')
    expect(runMjs).toMatch(/const http = remoteHttp\(m\.mode === 'remote' && m\.access \? accessHeaders\(process\.env\) : \{\}\)/)
    expect(runMjs.match(/fetch\(/g), 'only the local build\'s health probe calls fetch itself').toHaveLength(1)
    expect(readFileSync(new URL('./remote.ts', import.meta.url), 'utf8')).not.toMatch(/CF-Access-Client|Cf-Access-Jwt|X-Inhouse/)
  })

  it('with the token, Run now, route 67 and the settings calls each send the sign-in headers, then the token', async () => {
    const s = server(() => new Response('{}', { status: 200 }))
    const http = remoteHttp(edge, s.f)
    await http.post(new URL('https://eval.example.test/api/routines/x/run'), { clientKey: 'k' }, auth)
    await http.post(new URL('https://eval.example.test/api/ops/alarm'), { action: 'alarm' }, auth)
    await http.send('GET', new URL('https://eval.example.test/api/usage'), auth)
    await http.send('PUT', new URL('https://ih.eval.example.test/api/settings/technical/g%3Amode'), auth, { value: 'Fast' })
    expect(s.seen).toHaveLength(4)
    for (const r of s.seen) expect(r.headers).toEqual({ 'Content-Type': 'application/json', ...auth, Origin: new URL(r.url).origin, ...edge })
    expect(s.seen.map(r => r.method)).toEqual(['POST', 'POST', 'GET', 'PUT'])
    expect(s.seen[2]!.body).toBeUndefined()
  })

  it('a caller\'s own copy of the token is overridden by the edge (the edge goes last)', async () => {
    const s = server(() => new Response('{}', { status: 200 }))
    await remoteHttp(edge, s.f).send('GET', new URL('https://eval.example.test/api/me'), { ...auth, 'CF-Access-Client-Secret': 'other' })
    expect(s.seen[0]!.headers['CF-Access-Client-Secret']).toBe(SECRET)
  })

  it('without the token (a per-PR deploy), the sign-in headers alone', async () => {
    const s = server(() => new Response('', { status: 202 }))
    await remoteHttp({}, s.f).post(new URL('https://pr12.example.dev/api/routines/x/run'), {}, auth)
    expect(s.seen[0]!.headers).toEqual({ 'Content-Type': 'application/json', ...auth, Origin: 'https://pr12.example.dev' })
  })

  it('no refusal, answer or failure carries the secret', async () => {
    const echo = server(() => new Response(`denied: client secret ${SECRET} is not allowed`, { status: 403 }))
    const http = remoteHttp(edge, echo.f)
    const refused = await http.post(new URL('https://eval.example.test/api/routines/x/run'), {}, auth).then(() => '', (e: Error) => e.message)
    expect(refused).toMatch(/^run\.mjs: POST \/api\/routines\/x\/run answered 403: denied: client secret \[secret\]/)
    expect(refused).not.toContain(SECRET)
    expect((await http.send('GET', new URL('https://eval.example.test/api/usage'), auth)).text).not.toContain(SECRET)
    const down = server(() => { throw new TypeError(`fetch failed: ${SECRET}`) })
    const failed = await remoteHttp(edge, down.f).send('GET', new URL('https://eval.example.test/api/grants'), auth).then(() => '', (e: Error) => e.message)
    expect(failed).toBe('run.mjs: GET /api/grants failed: fetch failed: [secret]')
  })
})

describe('run.mjs arguments (failure 6)', () => {
  const common = { 'out-dir': 'o', sha: 'abc1234', 'issuer-key-file': 'k.json', aud: 'aud' }
  const doorEnv = { INHOUSE_EVAL_D1_NAME: 'inhouse-sbx-pr12-db', INHOUSE_EVAL_WRANGLER_CONFIG: 'w.json', CF_SANDBOX_ACCOUNT_ID: 'acct' }

  it('remote: the origin, the door\'s database and config, the release token only when given', () => {
    expect(runMode({ ...common, target: 'https://pr12.example.dev' }, doorEnv)).toEqual({ mode: 'remote', baseUrl: 'https://pr12.example.dev', releaseJwt: null, database: 'inhouse-sbx-pr12-db', wranglerConfig: 'w.json', modelSetting: null, access: false, graded: null })
    expect(runMode({ ...common, target: 'https://pr12.example.dev/' }, { ...doorEnv, MORNING_CHECK_RELEASE_JWT: 'j' })).toMatchObject({ mode: 'remote', releaseJwt: 'j' })
  })

  // The scripted proof (the spec) never runs on the eval deployment's EVAL_DB: it writes Fast for the scripted model. It
  // takes the morning-check door rule, so a PR's test database passes (ops#24 runs it there).
  it('the scripted proof refuses EVAL_DB before any write and opens its door on the morning-check rule', () => {
    expect(() => refuseSharedEvalDb(EVAL_DB)).toThrow(DoorRefusal)
    expect(() => refuseSharedEvalDb('inhouse-sbx-pr12-db')).not.toThrow()
    const spec = readFileSync(new URL('../../e2e/api/morning-check-remote.spec.ts', import.meta.url), 'utf8')
    expect(spec.indexOf('refuseSharedEvalDb(process.env.INHOUSE_EVAL_D1_NAME!)'), 'the spec refuses it before the setting is written').toBeLessThan(spec.indexOf('ensureDefaultModel({'))
    expect(spec.lastIndexOf('refuseSharedEvalDb('), 'and before its door').toBeLessThan(spec.indexOf('wranglerRunner({'))
    expect(spec).toContain("env: process.env, rule: 'morning-check' })")
    const runMjs = readFileSync(new URL('./run.mjs', import.meta.url), 'utf8')
    expect(runMjs).toContain("env: process.env, rule: 'morning-check' })")
    expect(runMjs).not.toContain('refuseSharedEvalDb')
  })

  it('--model-setting: remote only, a plain label, with the Inhouse app\'s origin and aud (only the Inhouse team writes g:mode)', () => {
    const ms = { 'model-setting': 'Fast', 'inhouse-origin': 'https://ih-pr12.example.dev', 'inhouse-aud': 'ih-aud' }
    expect(runMode({ ...common, target: 'https://pr12.example.dev', ...ms }, doorEnv)).toMatchObject({ mode: 'remote', modelSetting: { label: 'Fast', inhouseOrigin: 'https://ih-pr12.example.dev', inhouseAud: 'ih-aud' } })
    expect(() => runMode({ ...common, target: 'https://pr12.example.dev', ...ms, 'model-setting': 'fast mode' }, doorEnv)).toThrow('--model-setting must be a Default model label')
    expect(() => runMode({ ...common, target: 'https://pr12.example.dev', 'model-setting': 'Fast' }, doorEnv)).toThrow('needs --inhouse-origin and --inhouse-aud')
    expect(() => runMode({ ...common, target: 'https://pr12.example.dev', ...ms, 'inhouse-origin': 'https://ih.example.dev/api' }, doorEnv)).toThrow('--inhouse-origin must be')
    expect(() => runMode({ ...common, target: 'https://pr12.example.dev', 'inhouse-aud': 'x' }, doorEnv)).toThrow('--inhouse-aud only go with --model-setting')
    expect(() => runMode({ ...common, 'persist-dir': 'p', 'base-url': 'http://localhost:8788', ...ms }, { MORNING_CHECK_RELEASE_JWT: 'j' })).toThrow('--model-setting is for a deployed build (--target) only')
  })

  it('the Access service token (failure 7): both or neither; half is refused naming the variables only; no release token beside it; never on a per-PR deploy or local', () => {
    const SECRET = 'eval-ci-secret-SHOULD-NOT-PRINT'
    const token = { INHOUSE_EVAL_ACCESS_CLIENT_ID: 'id.access', INHOUSE_EVAL_ACCESS_CLIENT_SECRET: SECRET }
    const graded = { ...common, target: 'https://eval.example.dev', model: 'claude-sonnet-5-5', budget: '5' }
    const evalEnv = { ...doorEnv, INHOUSE_EVAL_D1_NAME: EVAL_DB, INHOUSE_EVAL_ORIGIN: 'https://eval.example.dev', ...token }
    expect(runMode(graded, evalEnv)).toMatchObject({ mode: 'remote', releaseJwt: null, modelSetting: null, access: true })
    expect(JSON.stringify(runMode(graded, evalEnv)), 'the mode holds no secret').not.toContain(SECRET)
    const refusal = (env: Record<string, string | undefined>, args: Record<string, string> = graded) => { try { runMode(args, env); return '' } catch (e) { return (e as Error).message } }
    // #306 review L4: a per-PR deploy has no Access, so the token never goes to one.
    expect(refusal({ ...doorEnv, ...token }, { ...common, target: 'https://pr12.example.dev' })).toContain(`are for the eval deployment (${EVAL_DB}) only`)
    expect(refusal({ ...doorEnv, ...token }, { ...common, target: 'https://pr12.example.dev' })).not.toContain(SECRET)
    for (const half of [{ INHOUSE_EVAL_ACCESS_CLIENT_ID: 'id.access' }, { INHOUSE_EVAL_ACCESS_CLIENT_SECRET: SECRET }]) {
      const m = refusal({ ...doorEnv, ...half })
      expect(m).toContain('INHOUSE_EVAL_ACCESS_CLIENT_ID and INHOUSE_EVAL_ACCESS_CLIENT_SECRET are not both set')
      expect(m).not.toContain(SECRET)
    }
    expect(refusal({ ...doorEnv, ...token, MORNING_CHECK_RELEASE_JWT: 'j' })).toContain('MORNING_CHECK_RELEASE_JWT is for a per-PR test deploy')
    const local = { ...common, 'persist-dir': 'p', 'base-url': 'http://localhost:8788' }
    expect(refusal({ MORNING_CHECK_RELEASE_JWT: 'j', ...token }, local)).toContain('are for a deployed build behind Access (--target) only')
    expect(refusal({ MORNING_CHECK_RELEASE_JWT: 'j', INHOUSE_EVAL_ACCESS_CLIENT_SECRET: SECRET }, local)).not.toContain(SECRET)
  })

  it('the graded run (EVAL_DB, failure 9): Access and --budget required, the model mapped, no --model-setting or release token', () => {
    const SECRET = 'eval-ci-secret-SHOULD-NOT-PRINT'
    const token = { INHOUSE_EVAL_ACCESS_CLIENT_ID: 'id.access', INHOUSE_EVAL_ACCESS_CLIENT_SECRET: SECRET }
    const evalEnv = { ...doorEnv, INHOUSE_EVAL_D1_NAME: EVAL_DB, INHOUSE_EVAL_ORIGIN: 'https://eval.example.dev/', ...token }
    const args = { ...common, target: 'https://eval.example.dev', model: 'claude-sonnet-5-5', budget: '12.5' }
    expect(runMode(args, evalEnv)).toMatchObject({ mode: 'remote', database: EVAL_DB, access: true, graded: { budgetUsd: 12.5, label: 'Fast' } })
    expect(runMode({ ...args, budget: '50' }, evalEnv)).toMatchObject({ graded: { budgetUsd: 50 } })
    const refusal = (a: Record<string, string | undefined>, env: Record<string, string | undefined> = evalEnv) => { try { runMode(a, env); return '' } catch (e) { return (e as Error).message } }
    expect(refusal(args, { ...doorEnv, INHOUSE_EVAL_D1_NAME: EVAL_DB })).toContain('goes to the Access-locked eval host')
    // #306 review M1: --target is the eval host the product suite names, so the token only ever goes there.
    expect(refusal({ ...args, target: 'https://elsewhere.example.dev' })).toContain('--target must be INHOUSE_EVAL_ORIGIN (the eval host), which names another origin')
    expect(refusal(args, { ...evalEnv, INHOUSE_EVAL_ORIGIN: undefined })).toContain('which is not set')
    // #306 review L2: a case's window stays under the lease's TTL less a margin (100 minutes).
    expect(runMode({ ...args, 'timeout-min': '90', 'settle-min': '9' }, evalEnv)).toMatchObject({ graded: { label: 'Fast' } })
    for (const [t, st] of [['90', '10'], ['100', '0'], ['x', '2'], ['20', 'Infinity']]) expect(refusal({ ...args, 'timeout-min': t, 'settle-min': st }), `${t}+${st}`).toContain('--timeout-min plus --settle-min must be under 100')
    for (const budget of [undefined, '0', '-1', 'ten', '1e3', '5.555']) expect(refusal({ ...args, budget }), String(budget)).toContain('needs --budget <usd> above zero')
    expect(refusal({ ...args, budget: '50.01' })).toContain('above the eval brand\'s $50 cap')
    expect(refusal({ ...args, model: 'claude-sonnet-4' })).toContain('is no model the product serves')
    expect(refusal({ ...args, 'model-setting': 'Fast', 'inhouse-origin': 'https://ih.example.dev', 'inhouse-aud': 'x' })).toContain('--model-setting is for a per-PR scripted run')
    expect(refusal(args, { ...evalEnv, MORNING_CHECK_RELEASE_JWT: 'j' })).toContain('MORNING_CHECK_RELEASE_JWT is for a per-PR test deploy')
    expect(refusal({ ...common, target: 'https://pr12.example.dev', budget: '5' }, doorEnv)).toContain('--budget is for the graded run')
    expect(refusal({ ...common, 'persist-dir': 'p', 'base-url': 'http://localhost:8788', budget: '5' }, { MORNING_CHECK_RELEASE_JWT: 'j' })).toContain('--budget is for the graded run')
  })

  it('--model maps to the catalogue\'s Default model label, and nothing else does', () => {
    expect(['claude-fable-5-2', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'].map(defaultModelLabel)).toEqual(['Max', 'Smart', 'Fast', 'Instant'])
    for (const m of [undefined, '', 'sonnet', 'Fast', 'claude-sonnet-5-5 ']) expect(() => defaultModelLabel(m), String(m)).toThrow('is no model the product serves')
  })

  it.each(['persist-dir', 'base-url', 'restart-cmd', 'shop-pattern', 'restart-wait-sec'])('remote with --%s is refused', k => {
    expect(() => runMode({ ...common, target: 'https://pr12.example.dev', [k]: 'x' }, doorEnv)).toThrow(`can't be used with --${k}`)
  })

  it.each(['http://pr12.example.dev', 'https://pr12.example.dev/api', 'https://u:p@pr12.example.dev', 'https://pr12.example.dev?x=1', 'pr12.example.dev', ''])('remote with --target %s is refused', target => {
    expect(() => runMode({ ...common, target }, doorEnv)).toThrow(/--target must be/)
  })

  it.each(Object.keys(doorEnv))('remote without %s is refused', k => {
    expect(() => runMode({ ...common, target: 'https://pr12.example.dev' }, { ...doorEnv, [k]: undefined })).toThrow(k)
  })

  it('local: as before, --persist-dir, --base-url and the release token required', () => {
    const local = { ...common, 'persist-dir': 'p', 'base-url': 'http://localhost:8788' }
    expect(runMode(local, { MORNING_CHECK_RELEASE_JWT: 'j' })).toEqual({ mode: 'local', baseUrl: 'http://localhost:8788', persistDir: 'p', releaseJwt: 'j' })
    expect(() => runMode(local, {})).toThrow('MORNING_CHECK_RELEASE_JWT is not set')
    expect(() => runMode({ ...common, 'base-url': 'x' }, { MORNING_CHECK_RELEASE_JWT: 'j' })).toThrow('--persist-dir is required')
  })

  it.each(Object.keys(common))('either mode without --%s is refused', k => {
    expect(() => runMode({ ...common, [k]: undefined, target: 'https://pr12.example.dev' }, doorEnv)).toThrow(`--${k} is required`)
  })
})

// 2a: the morning-check door rule beside the product's strict one.
describe('the morning-check database rule (targets/door.ts)', () => {
  const ok = { CF_SANDBOX_ACCOUNT_ID: 'acct' }
  it('admits EVAL_DB and a PR\'s test database; the product\'s rule still admits EVAL_DB only', () => {
    for (const n of [EVAL_DB, 'inhouse-sbx-pr1-db', 'inhouse-sbx-pr12-db', 'inhouse-sbx-pr999999-db']) expect(assertMorningCheckDatabase(n, ok), n).toBe(n)
    expect(() => assertSandboxDatabase('inhouse-sbx-pr12-db', ok)).toThrow(/eval deployment's database/)
  })
  it.each(['inhouse-sbx-db', 'inhouse-sbx-hub', 'inhouse-sbx-pr12', 'inhouse-sbx-pr12-files', 'inhouse-sbx-pr0-db', 'inhouse-sbx-pr01-db', 'inhouse-sbx-pr1234567-db', 'inhouse-prod-db', 'inhouse-sbx-pr12-db\n', 'inhouse-sbx-eval', ''])('refuses %j', n => {
    expect(() => assertMorningCheckDatabase(n, ok)).toThrow(DoorRefusal)
  })
  it('refuses without the sandbox account', () => {
    expect(() => assertMorningCheckDatabase('inhouse-sbx-pr12-db', {})).toThrow(/CF_SANDBOX_ACCOUNT_ID/)
  })
  it('PER_PR_DB is scripts/sandbox/names.mjs\'s per-PR rule with the -db word: perPrNames(N).d1, never the candidate\'s', async () => {
    const names = await import(/* @vite-ignore */ new URL('../../scripts/sandbox/names.mjs', import.meta.url).href) as { PER_PR: RegExp; perPrNames: (n: number) => Record<string, string>; evalNames: () => Record<string, string> }
    fc.assert(fc.property(fc.integer({ min: 1, max: 999_999 }), n => {
      const all = names.perPrNames(n)
      expect(PER_PR_DB.test(all.d1!)).toBe(true)
      expect(names.PER_PR.test(all.d1!)).toBe(true)
      for (const [k, v] of Object.entries(all)) if (k !== 'd1') expect(PER_PR_DB.test(v), v).toBe(false)
    }))
    fc.assert(fc.property(fc.string(), s => { if (PER_PR_DB.test(s)) expect(names.PER_PR.test(s)).toBe(true) }))
    expect(PER_PR_DB.test(names.evalNames().d1!)).toBe(false)
  })
  it('wranglerRunner takes the morning-check rule only when asked', () => {
    const cfg = (db: string) => () => JSON.stringify({ account_id: 'acct', d1_databases: [{ database_name: db }] })
    const base = { config: '/tmp/sbx.jsonc', env: ok, spawn: () => ({ status: 0, stdout: '[{"results":[]}]' }) }
    expect(() => wranglerRunner({ ...base, database: 'inhouse-sbx-pr12-db', readConfig: cfg('inhouse-sbx-pr12-db') })).toThrow(/eval deployment's database/)
    expect(() => wranglerRunner({ ...base, database: 'inhouse-sbx-pr12-db', readConfig: cfg('inhouse-sbx-pr12-db'), rule: 'morning-check' })).not.toThrow()
    expect(() => wranglerRunner({ ...base, database: 'inhouse-sbx-db', readConfig: cfg('inhouse-sbx-db'), rule: 'morning-check' })).toThrow(DoorRefusal)
  })
})

// 2b, 2g: the eval door's Default model, lease and override read, on the real schema.
describe('the eval door: Default model, lease, override (failure 10)', () => {
  const T = 1_800_000_000_000
  it('setDefaultModel writes g:mode as the routine reads it and reads it back; refuses a label with markup', async () => {
    const { db, run } = database()
    const door = createDoor(run)
    await door.setDefaultModel('Fast')
    await door.setDefaultModel('Smart')
    expect(db.prepare("SELECT value_json, rev FROM settings WHERE owner = 'brand' AND key = 'g:mode'").get()).toEqual({ value_json: '"Smart"', rev: 2 })
    for (const bad of ['fast mode', "Fast'; --", '']) await expect(door.setDefaultModel(bad), bad).rejects.toBeInstanceOf(DoorRefusal)
    await expect(createDoor(async () => []).setDefaultModel('Fast')).rejects.toThrow('the Default model reads back []')
  })
  it('a lease is taken, renewed by its holder, refused to another until it expires, and given back', async () => {
    const { run } = database()
    let now = T
    const door = createDoor(run, () => String(now))
    const at = (ms: number) => { now = ms; return door }
    await at(T).takeLease('morning-check:abc')
    await at(T + 1000).takeLease('morning-check:abc')
    await expect(at(T + 2000).takeLease('product:7-1')).rejects.toThrow(/another eval run \(morning-check:abc\) holds the eval deployment until /)
    await door.releaseLease('product:7-1')
    await expect(at(T + 3000).takeLease('product:7-1'), 'another\'s give-back leaves the lease alone').rejects.toThrow(/morning-check:abc/)
    await at(T + 1000 + EVAL_LEASE_TTL_MS).takeLease('product:7-1')
    await expect(at(T + 1001 + EVAL_LEASE_TTL_MS).takeLease('morning-check:abc')).rejects.toThrow(/product:7-1/)
    await door.releaseLease('product:7-1')
    await at(T + 1002 + EVAL_LEASE_TTL_MS).takeLease('morning-check:def')
  })
  // #306 review L5: the expiry is D1's clock, never the runner's: the statement carries no runner time.
  it('by default the lease runs on the database\'s own clock', async () => {
    const { db, run, statements } = database()
    const before = Date.now()
    await createDoor(run).takeLease('morning-check:abc')
    const after = Date.now()
    expect(statements[0]).toContain(D1_NOW_MS)
    expect(statements[0]).not.toMatch(/\b1[0-9]{12}\b/)
    const lease = JSON.parse((db.prepare("SELECT value_json FROM settings WHERE owner = 'test-control' AND key = 'eval:lease'").get() as { value_json: string }).value_json) as { tag: string; until: number }
    expect(lease.tag).toBe('morning-check:abc')
    expect(lease.until).toBeGreaterThanOrEqual(before + EVAL_LEASE_TTL_MS - 1)
    expect(lease.until).toBeLessThanOrEqual(after + EVAL_LEASE_TTL_MS + 1)
  })
  it('refuses a tag that isn\'t one before any SQL', async () => {
    const { run, statements } = database()
    const door = createDoor(run)
    for (const tag of ["x'; DROP TABLE settings; --", '', 'a b']) await expect(door.takeLease(tag), tag).rejects.toBeInstanceOf(DoorRefusal)
    await expect(door.releaseLease('a b')).rejects.toBeInstanceOf(DoorRefusal)
    expect(statements).toEqual([])
  })
  it('the lease row never reads as a setting or as the test shop override', async () => {
    const { run, d1 } = database()
    const door = createDoor(run)
    await door.takeLease('morning-check:abc')
    expect(await readTestShop(d1)).toBeNull()
    expect(await door.testShop()).toBeNull()
    await createMorningDoor(run).setShop(HOST)
    expect(await door.testShop()).toBe(JSON.stringify(HOST))
  })
  // The property: whatever the order of takes, renewals, give-backs and clock steps across runs, at most one run holds the
  // lease at any time, and a take that went through means the taker is the holder.
  it('the lease is never held by two runs (property)', async () => {
    const tags = ['product:1-1', 'product:2-1', 'morning-check:a', 'morning-check:b']
    const step = fc.oneof(
      fc.record({ op: fc.constant('take' as const), who: fc.integer({ min: 0, max: 3 }), dt: fc.integer({ min: 0, max: EVAL_LEASE_TTL_MS * 2 }) }),
      fc.record({ op: fc.constant('release' as const), who: fc.integer({ min: 0, max: 3 }), dt: fc.constant(0) }),
    )
    await fc.assert(fc.asyncProperty(fc.array(step, { maxLength: 25 }), async steps => {
      const { db, run } = database()
      let now = T
      const door = createDoor(run, () => String(now))
      for (const s of steps) {
        now += s.dt
        const tag = tags[s.who]!
        let took = false
        if (s.op === 'take') took = await door.takeLease(tag).then(() => true, (e: unknown) => { if (!(e instanceof DoorRefusal)) throw e; return false })
        else await door.releaseLease(tag)
        const rows = db.prepare("SELECT value_json FROM settings WHERE owner = 'test-control' AND key = 'eval:lease'").all() as { value_json: string }[]
        expect(rows.length).toBeLessThanOrEqual(1)
        const holder = rows[0] ? (JSON.parse(rows[0].value_json) as { tag: string; until: number }) : null
        if (took) expect(holder).toEqual({ tag, until: now + EVAL_LEASE_TTL_MS })
        if (s.op === 'release') expect(holder?.tag).not.toBe(tag)
      }
    }), { numRuns: 60 })
  })
})

// 2c, 2g: the graded run's start, its check before each case and its give-back.
describe('the graded run (failure 10)', () => {
  it('MORNING_CHECK_CAP is the product eval\'s EVAL_CAP, written as the literal line ops eval-gate matches', () => {
    expect(MORNING_CHECK_CAP).toBe(EVAL_CAP)
    expect(readFileSync(new URL('./remote.ts', import.meta.url), 'utf8')).toContain("\nexport const MORNING_CHECK_CAP = '$50'\n")
  })

  function fakes(o: { spent?: readonly number[]; capMinor?: number; shop?: string | null; otherLease?: boolean; elsewhere?: boolean; chatStatus?: number; takeGate?: Promise<void>; tools?: unknown } = {}) {
    const log: string[] = []
    const spent = [...(o.spent ?? [1000])]
    let last = spent[0]!
    const chats = new Set<string>()
    const door: GradedDoor = {
      hasChat: async id => { log.push(`hasChat ${id}`); return chats.has(id) },
      takeLease: async tag => { log.push(`take ${tag}`); await o.takeGate; if (o.otherLease) throw new DoorRefusal('refusing: another eval run (product:7-1) holds the eval deployment') },
      releaseLease: async tag => void log.push(`release ${tag}`),
      testShop: async () => o.shop ?? null,
      setSpendingCap: async cap => void log.push(`cap ${cap}`),
      setDefaultModel: async label => void log.push(`mode ${label}`),
    }
    const admin: ApiCall = async (method, path, body) => {
      log.push(`${method} ${path}`)
      if (method === 'POST' && path === '/api/chats') {
        // --target answers from another database when `elsewhere`: the door never sees the chat.
        if (!o.elsewhere) chats.add((body as { id: string }).id)
        return { status: o.chatStatus ?? 201, json: {} }
      }
      if (path === '/api/tools') return { status: 200, json: o.tools ?? { connected: ['shopify'], details: { shopify: { name: 'Shopify' } }, connection: {} } }
      last = spent.length ? spent.shift()! : last
      return { status: 200, json: { total: { minor: last }, cap: { minor: o.capMinor ?? 5000 } } }
    }
    return { log, g: gradedRun({ door, admin, tag: 'morning-check:abc1234:1', label: 'Fast', budgetUsd: 5, probeId: () => 'eval-probe-1' }) }
  }

  it('start: the lease, the probe chat read back, the override check, the cap pinned and read back, then the Default model', async () => {
    const { log, g } = fakes()
    await g.start()
    expect(log).toEqual(['take morning-check:abc1234:1', 'POST /api/chats', 'hasChat eval-probe-1', 'cap $50', 'GET /api/usage', 'mode Fast'])
    await g.release()
    await g.release()
    expect(log.filter(l => l.startsWith('release'))).toEqual(['release morning-check:abc1234:1'])
  })

  it('start refuses another run\'s lease, an override it didn\'t write, another cap, a month at the cap; the model is never set', async () => {
    for (const [o, text] of [
      [{ otherLease: true }, 'another eval run (product:7-1)'],
      // #306 review M1: --target answers from another database than the door's (or won't make the chat): nothing is set.
      [{ elsewhere: true }, 'the door\'s database does not hold the chat --target just made'],
      [{ chatStatus: 403 }, '--target did not make the probe chat (POST /api/chats answered 403)'],
      [{ shop: '"example-mc-late-orders.myshopify.com"' }, 'a test shop override (hub:shop "example-mc-late-orders.myshopify.com") is already set'],
      [{ capMinor: 32000 }, 'Spending cap is not $50'],
      [{ spent: [5000] }, 'has reached the $50 cap'],
    ] as const) {
      const { log, g } = fakes(o)
      await expect(g.start(), text).rejects.toThrow(text)
      expect(log.some(l => l.startsWith('mode'))).toBe(false)
      if (!('capMinor' in o) && !('spent' in o)) expect(log.some(l => l.startsWith('cap')), text).toBe(false)
    }
  })

  it('a give-back while the take is still in flight waits for it, then gives the won lease back (#306 review L3)', async () => {
    let open!: () => void
    const { log, g } = fakes({ takeGate: new Promise<void>(r => (open = r)) })
    const starting = g.start()
    const releasing = g.release()
    open()
    await starting
    await releasing
    expect(log.filter(l => l.startsWith('take') || l.startsWith('release'))).toEqual(['take morning-check:abc1234:1', 'release morning-check:abc1234:1'])
  })

  it('the month rolling over during the run stops it before the next case (#306 review L1)', async () => {
    const { g } = fakes({ spent: [4000, 4100, 50] })
    await g.start()
    expect(await g.beforeCase()).toBeNull()
    expect(await g.beforeCase()).toMatch(/^the month rolled over during the run \(route 42's total \$0\.50 is below the \$40\.00 at its start\)/)
  })

  it('before each case: renews the lease, stops once the run has spent its --budget, or the month reached the cap', async () => {
    const { log, g } = fakes({ spent: [1000, 1200, 1499, 1500] })
    await g.start()
    expect(await g.beforeCase()).toBeNull()
    expect(await g.beforeCase()).toBeNull()
    expect(await g.beforeCase()).toMatch(/^the run has spent \$5\.00 \(route 42, since its start\), reaching its --budget \$5\.00/)
    expect(log.filter(l => l.startsWith('take'))).toHaveLength(4)
    const atCap = fakes({ spent: [4800, 5000] })
    await atCap.g.start()
    expect(await atCap.g.beforeCase()).toMatch(/has reached the \$50 cap/)
    await expect(fakes().g.beforeCase()).rejects.toThrow('was not started')
  })

  it('runAll stops before the case the budget halts, the rest not run', async () => {
    const { g } = fakes({ spent: [1000, 1000, 1600] })
    await g.start()
    const door: MorningDoor = {
      close: () => {}, setShop: async () => {}, clearShop: async () => null, model: async () => 'claude-sonnet-5-5',
      slot: async k => ({ slot_key: k, state: 'ended', failure: null, result_text: 'found 0 things', turn_id: null, claimed_at_ms: 1 }), items: async () => [], tools: async () => [],
    }
    let now = 0
    const env = remoteEnv({ door, runNow: async () => {}, alarm: null, pause: async () => { now += 1000 }, nowMs: () => now, caseTimeoutMs: 60_000, settleMs: 10_000, warn: () => {}, checkModel: true, beforeCase: () => g.beforeCase() })
    const cases = ['clean-empty', 'clean-steady', 'outage-all'].map(id => META.find(c => c.id === id)!)
    const file = await runAll(env, cases, { date: '2026-11-22', sha: 'abc1234', model: 'claude-sonnet-5-5' })
    expect(file.cases.map(c => c.id)).toEqual(['clean-empty'])
    expect(file.stopped).toEqual({ at: 'clean-steady', reason: expect.stringContaining('reaching its --budget $5.00') })
    expect(file.notRun).toEqual(['clean-steady', 'outage-all'])
  })

  it('a check that throws before a case stops the run there, recorded in the partial results', async () => {
    const door: MorningDoor = {
      close: () => {}, setShop: async () => {}, clearShop: async () => null, model: async () => 'claude-sonnet-5-5',
      slot: async k => ({ slot_key: k, state: 'ended', failure: null, result_text: 'found 0 things', turn_id: null, claimed_at_ms: 1 }), items: async () => [], tools: async () => [],
    }
    let calls = 0
    let now = 0
    const env = remoteEnv({ door, runNow: async () => {}, alarm: null, pause: async () => { now += 1000 }, nowMs: () => now, caseTimeoutMs: 60_000, settleMs: 10_000, warn: () => {},
      beforeCase: async () => { if (++calls === 2) throw new DoorRefusal('refusing: another eval run (product:9-1) holds the eval deployment'); return null } })
    const written: { cases: number; stopped?: { at: string; reason: string } }[] = []
    const cases = ['clean-empty', 'clean-steady', 'outage-all'].map(id => META.find(c => c.id === id)!)
    const file = await runAll(env, cases, { date: '2026-11-22', sha: 'abc1234', model: 'claude-sonnet-5-5' }, f => void written.push({ cases: f.cases.length, ...(f.stopped ? { stopped: f.stopped } : {}) }))
    expect(file.stopped).toEqual({ at: 'clean-steady', reason: 'before clean-steady, the graded run\'s check failed: refusing: another eval run (product:9-1) holds the eval deployment' })
    expect(file.notRun).toEqual(['clean-steady', 'outage-all'])
    expect(written.at(-1)).toEqual({ cases: 1, stopped: file.stopped })
  })

  it('a signal clears the override, then gives the lease back, then exits', async () => {
    const log: string[] = []
    const handlers = new Map<string, () => void>()
    let exited!: (code: number) => void
    const done = new Promise<number>(r => (exited = r))
    clearOnSignals({ close: () => void log.push('close'), clearShop: async () => { log.push('clear'); return null } }, { on: (sg, h) => void handlers.set(sg, h), exit: code => { log.push(`exit ${code}`); exited(code) }, error: () => {} }, async () => void log.push('release'))
    handlers.get('SIGTERM')!()
    expect(await done).toBe(143)
    expect(log).toEqual(['close', 'clear', 'release', 'exit 143'])
  })

  it('run.mjs starts the graded run inside the try its finally gives the lease back from, after the env and results are made', () => {
    const runMjs = readFileSync(new URL('./run.mjs', import.meta.url), 'utf8')
    const start = runMjs.indexOf('await graded.start()')
    const tryAt = runMjs.lastIndexOf('\ntry {', start)
    expect(start).toBeGreaterThan(-1)
    expect(runMjs.indexOf('const env = door ? remoteEnv(')).toBeLessThan(tryAt)
    expect(runMjs.indexOf('const out = openResults(')).toBeLessThan(tryAt)
    expect(start).toBeLessThan(runMjs.indexOf('await runAll('))
    expect(runMjs.indexOf('process.exit(', tryAt), 'no exit skips the finally').toBe(-1)
    expect(runMjs.indexOf('graded ? () => graded.release() : undefined)')).toBeLessThan(tryAt)
    expect(runMjs.lastIndexOf('if (graded) await graded.release()')).toBeGreaterThan(runMjs.indexOf('} finally {', start))
    expect(runMjs).toContain("the eval brand's Default model (g:mode) stays ${m.graded.label}")
  })
})
