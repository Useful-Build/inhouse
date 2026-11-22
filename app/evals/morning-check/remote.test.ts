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
//     token still calls route 67; a local run without one starts.
import { readdirSync, readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { readTestShop, type ShopDb } from '../../server/egress/test-shop.ts'
import { DoorRefusal, type RunSql } from '../targets/door.ts'
import { runMode } from './args.ts'
import { createMorningDoor, type MorningDoor } from './door.ts'
import { AMBER, META, hostOf } from './expected.ts'
import { clearOnSignals, remoteEnv } from './remote.ts'
import { ROUTINE_ID, runAll } from './runner.ts'

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

  it.each([`now|${ROUTINE_ID}|${'a'.repeat(31)}'`, `due|${ROUTINE_ID}|2026-11-22`, `now|other|${'a'.repeat(32)}`])('refuses the slot key %s before any SQL', async key => {
    const { run, statements } = database()
    await expect(createMorningDoor(run).slot(key)).rejects.toBeInstanceOf(DoorRefusal)
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

describe('run.mjs arguments (failure 6)', () => {
  const common = { 'out-dir': 'o', sha: 'abc1234', 'issuer-key-file': 'k.json', aud: 'aud' }
  const doorEnv = { INHOUSE_EVAL_D1_NAME: 'inhouse-sbx-pr12-db', INHOUSE_EVAL_WRANGLER_CONFIG: 'w.json', CF_SANDBOX_ACCOUNT_ID: 'acct' }

  it('remote: the origin, the door\'s database and config, the release token only when given', () => {
    expect(runMode({ ...common, target: 'https://pr12.example.dev' }, doorEnv)).toEqual({ mode: 'remote', baseUrl: 'https://pr12.example.dev', releaseJwt: null, database: 'inhouse-sbx-pr12-db', wranglerConfig: 'w.json' })
    expect(runMode({ ...common, target: 'https://pr12.example.dev/' }, { ...doorEnv, MORNING_CHECK_RELEASE_JWT: 'j' })).toMatchObject({ mode: 'remote', releaseJwt: 'j' })
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
