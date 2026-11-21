// The memory tools' rules (p3-design section 10), through the MCP server as the run's person. Ways they can fail,
// written down first:
//  1. a person fact doesn't count at once, or a brand fact does before an admin's OK;
//  2. `memory_update` of a brand fact keeps it active (a change skipping approval), or changes another's person fact;
//  3. `memory_forget` forgets a team fact or another member's fact;
//  4. a write applies over a change made between its read and its write (a barrier at that await), or a save whose
//     answer was lost, sent again, saves twice;
//  5. `memory_list` pages skip or repeat a fact.
import { env } from 'cloudflare:workers'
import { beforeAll, describe, expect, it } from 'vitest'
import { handleMcp } from '../../server/index.ts'
import { memoryStore } from './store.ts'

const db = env.DB
const A = 'm_tools_a'
const B = 'm_tools_b'
let id = 0
async function call(who: string, name: string, args: Record<string, unknown>, database: D1Database = db) {
  const res = await handleMcp(new Request('http://egress.internal/mcp/', { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args } }) }),
    { memberId: who, chatId: 'c_tools', runId: 'r_AAAAAAAAAAAAAAAAAAAAAA', turnId: 't_AAAAAAAAAAAAAAAAAAAAAA' }, { db: database, now: () => 1_800_000_000_000 })
  const body = (await res.json()) as { result: { structuredContent: Record<string, unknown>; isError?: true } }
  return body.result
}
const status = (memoryId: string) => db.prepare('SELECT status, text, rev FROM memories WHERE id = ?').bind(memoryId).first<{ status: string; text: string; rev: number }>()
const saved = async (who: string, scope: string, text: string) => ((await call(who, 'memory_save', { scope, text })).structuredContent.fact as { memory_id: string }).memory_id
const search = async (who: string, query: string) => ((await call(who, 'memory_search', { query })).structuredContent.facts as { text: string }[]).map(f => f.text)

/** `db` with a step run just before the first batch whose SQL matches `when` (a barrier at the store's await). */
function withBarrier(when: RegExp, step: () => Promise<unknown>): D1Database {
  const sqlOf = new WeakMap<object, string>()
  let fired = false
  return new Proxy(db, {
    get(target, prop) {
      if (prop === 'prepare') return (sql: string) => {
        const s = target.prepare(sql)
        return new Proxy(s, { get(t, p) { const v = Reflect.get(t, p, t); return p === 'bind' ? (...a: unknown[]) => { const b = (v as (...x: unknown[]) => D1PreparedStatement).apply(t, a); sqlOf.set(b, sql); return b } : typeof v === 'function' ? v.bind(t) : v } })
      }
      if (prop === 'batch') return async (stmts: D1PreparedStatement[]) => {
        if (!fired && stmts.some(s => when.test(sqlOf.get(s) ?? ''))) {
          fired = true
          await step()
        }
        return target.batch(stmts)
      }
      const v = Reflect.get(target, prop, target)
      return typeof v === 'function' ? v.bind(target) : v
    },
  })
}

beforeAll(async () => {
  await db.batch([
    db.prepare("INSERT INTO members (id, kind, role, status, name, created_at_ms) VALUES (?, 'person', 'member', 'active', 'Ann', 1)").bind(A),
    db.prepare("INSERT INTO members (id, kind, role, status, name, created_at_ms) VALUES (?, 'person', 'member', 'active', 'Ben', 1)").bind(B),
  ])
})

describe('saving (failure 1)', () => {
  it('a person fact counts at once for its owner only; a brand fact waits and nobody finds it', async () => {
    const mine = await saved(A, 'person', 'Ann likes order tables sorted by date')
    expect(await status(mine)).toMatchObject({ status: 'active' })
    expect(await search(A, 'sorted')).toEqual(['Ann likes order tables sorted by date'])
    expect(await search(B, 'sorted')).toEqual([])
    const team = await saved(A, 'brand', 'We restock on Fridays')
    expect(await status(team)).toMatchObject({ status: 'waiting' })
    expect(await search(A, 'restock')).toEqual([])
  })
  it('the same save sent again (its answer lost) finds the first and saves nothing new', async () => {
    const first = await call(A, 'memory_save', { scope: 'person', text: 'Ann wants totals in bold' })
    const again = await call(A, 'memory_save', { scope: 'person', text: 'Ann wants totals in bold' })
    expect(again.structuredContent).toMatchObject({ already_saved: true, fact: { memory_id: (first.structuredContent.fact as { memory_id: string }).memory_id } })
    expect(await db.prepare("SELECT COUNT(*) AS n FROM memories WHERE text = 'Ann wants totals in bold'").first<number>('n')).toBe(1)
  })
})

describe('updating and forgetting (failures 2 and 3)', () => {
  it('a brand fact changed goes back to waiting; a person fact changes in place; another member\'s is not found', async () => {
    const team = await saved(B, 'brand', 'Kestrel ships in 14 days')
    await db.prepare("UPDATE memories SET status = 'active' WHERE id = ?").bind(team).run()   // an admin's OK (P6)
    const up = await call(A, 'memory_update', { memory_id: team, text: 'Kestrel ships in 10 days' })
    expect(up.isError).toBeUndefined()
    expect(await status(team)).toEqual({ status: 'waiting', text: 'Kestrel ships in 10 days', rev: 2 })
    const mine = await saved(A, 'person', 'Ann prefers short replies')
    expect((await call(A, 'memory_update', { memory_id: mine, text: 'Ann prefers very short replies' })).isError).toBeUndefined()
    expect(await status(mine)).toEqual({ status: 'active', text: 'Ann prefers very short replies', rev: 2 })
    expect((await call(B, 'memory_update', { memory_id: mine, text: 'Changed by Ben' })).structuredContent).toEqual({ error: 'not_found' })
    expect((await call(A, 'memory_update', { memory_id: team, text: 'Again' })).structuredContent).toEqual({ error: 'not_found' })   // waiting: not visible
    expect(await status(mine)).toMatchObject({ text: 'Ann prefers very short replies' })
  })
  it('forget takes only the member\'s own person fact', async () => {
    const team = await saved(A, 'brand', 'Returns within thirty days')
    await db.prepare("UPDATE memories SET status = 'active' WHERE id = ?").bind(team).run()
    expect((await call(A, 'memory_forget', { memory_id: team })).structuredContent).toEqual({ error: 'team_fact' })
    expect(await status(team)).toMatchObject({ status: 'active' })
    const bens = await saved(B, 'person', 'Ben likes dark mode')
    expect((await call(A, 'memory_forget', { memory_id: bens })).structuredContent).toEqual({ error: 'not_found' })
    expect(await status(bens)).toMatchObject({ status: 'active' })
    expect((await call(B, 'memory_forget', { memory_id: bens })).structuredContent).toEqual({ memory_id: bens, forgotten: true })
    expect(await status(bens)).toMatchObject({ status: 'forgotten', rev: 2 })
    expect((await call(B, 'memory_forget', { memory_id: bens })).structuredContent).toEqual({ error: 'not_found' })
  })
})

describe('a change between the read and the write (failure 4)', () => {
  it('update and forget refuse with conflict and leave the other change standing', async () => {
    const mine = await saved(A, 'person', 'Ann orders on Mondays')
    const meddle = () => db.prepare("UPDATE memories SET text = 'Ann orders on Tuesdays', rev = rev + 1 WHERE id = ?").bind(mine).run()
    const up = await call(A, 'memory_update', { memory_id: mine, text: 'Ann orders on Wednesdays' }, withBarrier(/^\s*UPDATE memories SET text/, meddle))
    expect(up.structuredContent).toEqual({ error: 'conflict' })
    expect(await status(mine)).toEqual({ status: 'active', text: 'Ann orders on Tuesdays', rev: 2 })
    const forget = await call(A, 'memory_forget', { memory_id: mine }, withBarrier(/^\s*UPDATE memories SET status = 'forgotten'/, () => db.prepare('UPDATE memories SET rev = rev + 1 WHERE id = ?').bind(mine).run()))
    expect(forget.structuredContent).toEqual({ error: 'conflict' })
    expect(await status(mine)).toMatchObject({ status: 'active', rev: 3 })
  })
  it('a route forget racing an agent update: whichever lands second sees the other (store level)', async () => {
    const store = memoryStore({ db })
    const mine = await saved(A, 'person', 'Ann reads reports at nine')
    const r = await memoryStore({ db: withBarrier(/^\s*UPDATE memories SET text/, () => store.setPersonForgotten({ id: mine, ownerId: A, forgotten: true, ifRev: 1 }, { actorId: A, requestId: 'r', nowMs: 1 })) })
      .update({ memberId: A, id: mine, text: 'Ann reads reports at ten', nowMs: 2, requestId: 'r2' })
    expect(r).toEqual({ conflict: true })
    expect(await status(mine)).toEqual({ status: 'forgotten', text: 'Ann reads reports at nine', rev: 2 })
  })
})

describe('listing (failure 5)', () => {
  it('pages through every visible fact once, newest first', async () => {
    const C = 'm_tools_c'
    await db.prepare("INSERT INTO members (id, kind, role, status, name, created_at_ms) VALUES (?, 'person', 'member', 'active', 'Cal', 1)").bind(C).run()
    const texts = ['Cal one', 'Cal two', 'Cal three', 'Cal four', 'Cal five']
    for (const t of texts) await saved(C, 'person', t)
    const seen: string[] = []
    let cursor: string | null = null
    do {
      const page = (await call(C, 'memory_list', cursor ? { scope: 'person', limit: 2, cursor } : { scope: 'person', limit: 2 })).structuredContent
      seen.push(...(page.facts as { text: string }[]).map(f => f.text))
      cursor = page.next_cursor as string | null
    } while (cursor)
    expect(seen).toEqual([...texts].reverse())
    expect((await call(C, 'memory_list', { cursor: 'not-ours!' })).structuredContent).toEqual({ error: 'invalid_cursor' })
    expect((await call(C, 'memory_list', { cursor: 'Zm9v' })).structuredContent).toEqual({ error: 'invalid_cursor' })
  })
})
