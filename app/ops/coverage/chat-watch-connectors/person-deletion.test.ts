// Person deletion over P3 and P4's stores (P8 C1, acceptance 3: one person's data goes and nothing else, run events and
// transcripts included). Foreign keys are on (D1 enforces them per statement). Ways it can fail, written down first:
//  1. it leaves P's chats, messages (the agent's answers too), tool calls, chat files, their Library marks, file bytes or
//     transcripts, P's person memories, the notices addressed only to P or their reads;
//  2. it touches Q's: any row or object of another person's, a team or admin notice, a brand fact P saved, an Activity
//     line, the audit log, the audit copy, a backup, a restore or an earlier deletion-log entry;
//  3. it deletes rows before objects (a re-run after an R2 failure can't find what's left), or children after parents
//     (D1 refuses the batch);
//  4. the BrandAgent part isn't through personData, its counts aren't the plan's, it runs while P has a live turn
//     (`busy`), or a BrandAgent change at the recount reads as stale data instead of busy;
//  5. a message, tool call or chat file names P in a chat P doesn't own, and the run leaves it (B2: the plan refuses);
//  6. a re-run, or a run resumed after a failure between any two steps, ends anywhere else;
//  7. the plan's counts differ from an independent count; a search still finds P's words.
import { fc, test } from '@fast-check/vitest'
import { env } from 'cloudflare:workers'
import { beforeAll, describe, expect, it } from 'vitest'
import { SYSTEM_MEMBER_ID } from '../../../server/db/ids.ts'
import { FORMER_MEMBER } from '../../../server/db/members.ts'
import { openStores } from '../../../server/db/stores.ts'
import { PERSON_DATA_TABLES } from '../../../server/do/brand-agent/ports.ts'
import { seedBrand } from '../../../server/seed/seed.ts'
import type { Seeded } from '../../../server/seed/seed.ts'
import { listDeletionLog, newRunId, writeLogEntry } from '../../delete/log.ts'
import { planPersonDeletion, runPersonDeletion } from '../../delete/person.ts'
import type { DeletionDeps, PersonDeletionPlan } from '../../delete/person.ts'
import { addPerson, recordingDb, snapshotAll, token, withoutLog, writesAudit } from '../../delete/test-support.ts'
import type { Snapshot } from '../../delete/test-support.ts'
import { planExport } from '../../export/export.ts'
import { planRetention } from '../../retention/retention.ts'
import { periodsFor } from '../../retention/rules.ts'
import { tables } from '../../tables/index.ts'
import { addActivity, addChat, addMemory, addNotice, addRead, agentDouble, withoutIndexes } from './test-support.ts'

const db = env.DB
const bucket = env.FILES as R2Bucket
const T = 1_800_000_000_000
let clock = T
let wall = T + 1_000_000_000
let seeded: Seeded
const deps = (over: Partial<DeletionDeps> = {}): DeletionDeps => ({ db, bucket, at: { actorId: SYSTEM_MEMBER_ID, requestId: `req-${token()}`, nowMs: (clock += 1000) }, clock: () => ++wall, ...over })
const planOk = async (d: DeletionDeps, memberId: string): Promise<PersonDeletionPlan> => {
  const r = await planPersonDeletion(d, { memberId })
  if (!('ok' in r)) throw new Error(`plan refused: ${r.refused}`)
  return r.ok
}

beforeAll(async () => {
  seeded = await seedBrand(db, openStores(env), T)
  await bucket.put('backups/d1/b1/manifest.json', '{"tables":[]}')
  await bucket.put('restore/r1/record.json', '{}')
  await bucket.put('audit-copy/2026-11-01/1-2.jsonl', '{}\n')
  await writeLogEntry(bucket, { format: 1, runId: newRunId(), step: 0, phase: 'done', kind: 'retention', atMs: T - 1, actorId: SYSTEM_MEMBER_ID, cutoffs: [], removed: [] })
})

interface World { p: string; q: string; marker: { p: string; q: string }; pChats: string[]; pNotice: string; agent: ReturnType<typeof agentDouble> }

/** Two people, each with chats (one in the trash), memories, notices and reads; P also saved a brand fact. */
async function world(chats: number, trashed: boolean): Promise<World> {
  const p = (await addPerson(db, { role: 'member', status: 'active' }, seeded.members.admin, T)).id
  const q = (await addPerson(db, { role: 'member', status: 'active' }, seeded.members.admin, T)).id
  const marker = { p: `pz${token()}`, q: `qz${token()}` }
  const pChats: string[] = []
  for (const [who, m] of [[p, marker.p], [q, marker.q]] as const) {
    for (let i = 0; i < chats; i++) {
      const id = `c_${token()}`
      await addChat(db, bucket, { id, owner: who, lastAtMs: T, marker: m, deletedAtMs: trashed && i === 0 ? T : undefined, fileMarkedAtMs: i === 1 ? T : undefined })
      if (who === p) pChats.push(id)
    }
    await addMemory(db, { id: `mem_${token()}`, owner: who, createdBy: who, marker: m, updatedAtMs: T })
  }
  await addMemory(db, { id: `mem_${token()}`, owner: null, createdBy: p, marker: `brandfact${token()}`, updatedAtMs: T })
  const pNotice = `n_${token()}`
  await addNotice(db, { id: pNotice, audience: 'member', member: p, atMs: T })
  await addRead(db, p, pNotice, T)
  const qNotice = `n_${token()}`
  await addNotice(db, { id: qNotice, audience: 'member', member: q, person: p, atMs: T })
  const team = `n_${token()}`
  await addNotice(db, { id: team, audience: 'team', person: p, atMs: T })
  await addRead(db, p, team, T)
  await addRead(db, q, team, T)
  await addActivity(db, { id: `a_${token()}`, actor: p, subject: q, atMs: T })
  const agent = agentDouble({ [p]: { runs: 2, turns: 3, events: 9, chat_state: chats, run_tokens: 1, model_calls: 4 }, [q]: { runs: 1, turns: 1, events: 2 } })
  return { p, q, marker, pChats, pNotice, agent }
}

/** The oracle: the snapshot as it must be after P's deletion, from P's id and chats alone (a plain filter). */
function expectedAfter(before: Snapshot, w: World): Snapshot {
  const pFiles = new Set(before.d1.chat_files.filter(r => w.pChats.includes(r.chat_id as string)).map(r => r.id))
  const pNotices = new Set(before.d1.notices.filter(r => r.audience_member_id === w.p).map(r => r.id))
  const drop: Record<string, (r: Record<string, unknown>) => boolean> = {
    chats: r => r.owner_id === w.p,
    chat_messages: r => w.pChats.includes(r.chat_id as string),
    tool_calls: r => w.pChats.includes(r.chat_id as string),
    chat_files: r => w.pChats.includes(r.chat_id as string),
    library_marks: r => r.source === 'chat' && pFiles.has(r.file_id),
    memories: r => r.owner_id === w.p,
    settings: r => r.owner === w.p,
    notices: r => pNotices.has(r.id),
    notice_reads: r => r.member_id === w.p || pNotices.has(r.notice_id),
  }
  const d1 = Object.fromEntries(Object.entries(before.d1).map(([t, rows]) => [t, rows.filter(r => !(drop[t]?.(r) ?? false))]))
  const r2 = Object.fromEntries(Object.entries(before.r2).filter(([k]) => !w.pChats.some(c => k.startsWith(`files/${c}/`) || k.startsWith(`sessions/${c}/`)) && !k.startsWith(`photos/${w.p}/`)))
  return { d1, r2 }
}
/** Both snapshots without P's member row (pseudonymised in place: checked on its own) and the indexes. */
const comparable = (s: Snapshot, w: World): Snapshot => {
  const x = withoutIndexes(withoutLog(s))
  return { d1: { ...x.d1, members: x.d1.members.filter(r => r.id !== w.p) }, r2: x.r2 }
}
const search = async (word: string) => ({
  messages: (await db.prepare('SELECT rowid FROM chat_messages_fts WHERE chat_messages_fts MATCH ?').bind(word).all()).results.length,
  memories: (await db.prepare('SELECT rowid FROM memories_fts WHERE memories_fts MATCH ?').bind(word).all()).results.length,
})

describe('one person, nothing else (failures 1, 2, 7)', () => {
  test.prop([fc.integer({ min: 1, max: 3 }), fc.boolean()], { numRuns: 6 })(
    'removes P\'s chats, messages, tool calls, chat files, their library marks and objects, and P\'s transcripts; Q\'s are byte-identical; leaves every other store byte-identical, audit_log and audit-copy/ included; the plan\'s counts equal an independent count',
    async (chats, trashed) => {
      const w = await world(chats, trashed)
      const before = await snapshotAll(db, bucket)
      const rec = recordingDb(db)
      const d = deps({ db: rec.db, brandAgent: w.agent })
      const plan = await planOk(d, w.p)
      // The independent count, from the snapshot.
      const oracle = expectedAfter(before, w)
      for (const t of ['chats', 'chat_messages', 'tool_calls', 'chat_files', 'library_marks', 'memories', 'notice_reads']) {
        expect(plan.counts[t], t).toBe(before.d1[t].length - oracle.d1[t].length)
      }
      expect(plan.counts.notices).toBe(before.d1.notices.length - oracle.d1.notices.length)
      expect(plan.counts['files/']).toBe(chats)
      expect(plan.counts['sessions/']).toBe(chats)
      expect(plan.counts['BrandAgent.events']).toBe(9)
      const r = await runPersonDeletion(d, plan)
      if (!('ok' in r)) throw new Error(`run refused: ${JSON.stringify(r)}`)
      expect(r.ok.removed).toEqual(plan.counts)
      const after = await snapshotAll(db, bucket)
      expect(comparable(after, w)).toEqual(comparable(oracle, w))
      expect(after.d1.members.find(m => m.id === w.p)?.pseudonymised_at_ms).not.toBeNull()
      // The audit log: never written.
      expect(rec.sql.filter(writesAudit)).toEqual([])
      // Search: none of P's words, all of Q's.
      expect(await search(w.marker.p)).toEqual({ messages: 0, memories: 0 })
      expect(await search(w.marker.q)).toEqual({ messages: 2 * chats, memories: 1 })
      // The BrandAgent: P's rows through personData, Q's untouched.
      expect(w.agent.calls.filter(c => c.personId === w.p).map(c => c.mode)).toEqual(['count', 'count', 'delete'])
      expect(w.agent.calls.some(c => c.personId === w.q)).toBe(false)
    },
  )
})

describe('the parts (failures 1, 2, 4)', () => {
  it('removes P\'s BrandAgent rows through personData, its counts equal the plan\'s, and Q\'s rows are identical', async () => {
    const w = await world(1, false)
    const qRows = { ...w.agent.rows[w.q] }
    const plan = await planOk(deps({ brandAgent: w.agent }), w.p)
    expect(Object.keys(plan.counts).filter(k => k.startsWith('BrandAgent.')).sort()).toEqual(PERSON_DATA_TABLES.map(t => `BrandAgent.${t}`).sort())
    const r = await runPersonDeletion(deps({ brandAgent: w.agent }), plan)
    if (!('ok' in r)) throw new Error(`run refused: ${JSON.stringify(r)}`)
    for (const t of PERSON_DATA_TABLES) expect(r.ok.removed[`BrandAgent.${t}`], t).toBe(plan.counts[`BrandAgent.${t}`])
    expect(w.agent.rows[w.p]).toEqual({})
    expect(w.agent.rows[w.q]).toEqual(qRows)
  })

  it('personData\'s counts cover exactly W1 PR 6\'s final table list', async () => {
    // The real object (a fresh one): its count keys are the exported list, no more and no fewer.
    const stub = env.BRAND_AGENT.get(env.BRAND_AGENT.idFromName(`c1-${token()}`))
    const answer = await stub.personData({ personId: 'm_nobody', mode: 'count' })
    if (!('counts' in answer)) throw new Error(`personData: ${JSON.stringify(answer)}`)
    expect(Object.keys(answer.counts).sort()).toEqual([...PERSON_DATA_TABLES].sort())
  })

  it('removes P\'s person memories, the notices addressed only to P and their reads; keeps team and admin notices and brand facts P saved', async () => {
    const w = await world(1, false)
    const r = await runPersonDeletion(deps({ brandAgent: w.agent }), await planOk(deps({ brandAgent: w.agent }), w.p))
    expect('ok' in r).toBe(true)
    expect((await db.prepare('SELECT COUNT(*) AS n FROM memories WHERE owner_id = ?').bind(w.p).first<{ n: number }>())!.n).toBe(0)
    expect((await db.prepare("SELECT COUNT(*) AS n FROM memories WHERE scope = 'brand' AND created_by = ?").bind(w.p).first<{ n: number }>())!.n).toBe(1)
    expect((await db.prepare('SELECT COUNT(*) AS n FROM notices WHERE audience_member_id = ?').bind(w.p).first<{ n: number }>())!.n).toBe(0)
    expect((await db.prepare("SELECT COUNT(*) AS n FROM notices WHERE person_id = ? AND audience IN ('team', 'member')").bind(w.p).first<{ n: number }>())!.n).toBe(2)
    expect((await db.prepare('SELECT COUNT(*) AS n FROM notice_reads WHERE member_id = ?').bind(w.p).first<{ n: number }>())!.n).toBe(0)
    expect((await db.prepare('SELECT COUNT(*) AS n FROM notice_reads WHERE member_id = ?').bind(w.q).first<{ n: number }>())!.n).toBe(1)
  })

  it('after the run Activity lines and notices that name P by id keep the id, and the id\'s member row is pseudonymised (A former member)', async () => {
    const w = await world(1, false)
    await runPersonDeletion(deps({ brandAgent: w.agent }), await planOk(deps({ brandAgent: w.agent }), w.p))
    expect((await db.prepare('SELECT COUNT(*) AS n FROM activity_lines WHERE actor_id = ?').bind(w.p).first<{ n: number }>())!.n).toBe(1)
    const row = await db.prepare('SELECT name, pseudonymised_at_ms FROM members WHERE id = ?').bind(w.p).first<{ name: string | null; pseudonymised_at_ms: number | null }>()
    expect(row?.pseudonymised_at_ms).not.toBeNull()
    expect(row?.name).toBe(FORMER_MEMBER)
  })

  it('planPersonDeletion, planRetention and planExport succeed over the whole merged registry: every entry has a rule or is derived', async () => {
    const w = await world(1, false)
    await expect(planPersonDeletion(deps({ brandAgent: w.agent }), { memberId: w.p })).resolves.toMatchObject({ ok: expect.anything() })
    await expect(planExport(deps(), { kind: 'person', memberId: w.p })).resolves.toMatchObject({ ok: expect.anything() })
    // Retention plans every store; its in-object BrandAgent part needs the object's storage, which only the handler has.
    await expect(planRetention({ db, bucket, at: { actorId: SYSTEM_MEMBER_ID, requestId: 'r', nowMs: T }, registry: tables.filter(e => e.name !== 'BrandAgent') }, { periods: periodsFor(tables.filter(e => e.name !== 'BrandAgent')) })).resolves.toBeDefined()
  })
})

describe('what it refuses (failures 4 and 5)', () => {
  it('refuses outside_chats when a message, tool call or chat file names P in a chat P doesn\'t own, and changes nothing', async () => {
    const w = await world(1, false)
    const qChat = `c_${token()}`
    await addChat(db, bucket, { id: qChat, owner: w.q, lastAtMs: T, marker: 'shared' })
    await db.prepare("INSERT INTO chat_files (id, chat_id, kind, path, name, content_type, bytes, sha256, r2_key, state, created_by, created_at_ms) VALUES (?, ?, 'input', '/in.txt', 'in.txt', 'text/plain', 1, 'ab', ?, 'saved', ?, ?)").bind(`f_in_${token()}`, qChat, `files/${qChat}/in`, w.p, T).run()
    const before = await snapshotAll(db, bucket)
    expect(await planPersonDeletion(deps({ brandAgent: w.agent }), { memberId: w.p })).toEqual({ refused: 'outside_chats' })
    expect(await snapshotAll(db, bucket)).toEqual(before)
  })

  it('a BrandAgent count difference at the recount refuses with busy and changes nothing; a D1 or R2 difference refuses with plan_stale and changes nothing', async () => {
    const w = await world(1, false)
    const plan = await planOk(deps({ brandAgent: w.agent }), w.p)
    // A run token pruned between plan and run (shapes.md personData r4): busy, then a new plan runs.
    w.agent.rows[w.p] = { ...w.agent.rows[w.p], run_tokens: 0 }
    const before = await snapshotAll(db, bucket)
    expect(await runPersonDeletion(deps({ brandAgent: w.agent }), plan)).toEqual({ refused: 'busy' })
    expect(await snapshotAll(db, bucket)).toEqual(before)
    const fresh = await planOk(deps({ brandAgent: w.agent }), w.p)
    // An R2 object lands in one of P's chats: plan_stale.
    await bucket.put(`files/${w.pChats[0]}/late`, 'late')
    const stale = await snapshotAll(db, bucket)
    expect(await runPersonDeletion(deps({ brandAgent: w.agent }), fresh)).toMatchObject({ refused: 'plan_stale' })
    expect(await snapshotAll(db, bucket)).toEqual(stale)
    expect('ok' in (await runPersonDeletion(deps({ brandAgent: w.agent }), await planOk(deps({ brandAgent: w.agent }), w.p)))).toBe(true)
  })

  it('when personData\'s delete answers busy the run writes a refused entry with reason busy and changes no D1 row or R2 object besides the pseudonymised member; a re-run after P\'s turns end finishes', async () => {
    const w = await world(1, false)
    w.agent.busy.add(w.p)
    const before = await snapshotAll(db, bucket)
    const r = await runPersonDeletion(deps({ brandAgent: w.agent }), await planOk(deps({ brandAgent: w.agent }), w.p))
    expect(r).toEqual({ refused: 'busy' })
    const after = await snapshotAll(db, bucket)
    expect(comparable(after, w)).toEqual(comparable(before, w))
    const mine = (await listDeletionLog(bucket)).filter(e => e.entry.memberId === w.p).map(e => [e.entry.phase, e.entry.reason])
    // Not `refused`: the member row is pseudonymised already, so R's replay repeats the run (#346 review M4).
    expect(mine).toEqual([['start', undefined], ['stopped_after_pseudonymise', 'busy']])
    w.agent.busy.delete(w.p)
    const again = await runPersonDeletion(deps({ brandAgent: w.agent }), await planOk(deps({ brandAgent: w.agent }), w.p))
    expect('ok' in again).toBe(true)
    expect((await db.prepare('SELECT COUNT(*) AS n FROM chats WHERE owner_id = ?').bind(w.p).first<{ n: number }>())!.n).toBe(0)
  })
})

describe('order and re-runs (failures 3 and 6)', () => {
  it('deletes objects before rows, and a re-run after an R2 failure finds and removes what was left', async () => {
    const w = await world(2, false)
    const failing = { ...bucket, list: bucket.list.bind(bucket), get: bucket.get.bind(bucket), head: bucket.head.bind(bucket), put: bucket.put.bind(bucket), delete: async () => { throw new Error('R2 delete failed (test)') } } as unknown as R2Bucket
    await expect(runPersonDeletion(deps({ bucket: failing, brandAgent: w.agent }), await planOk(deps({ brandAgent: w.agent }), w.p))).rejects.toThrow(/R2 delete failed/)
    // The chats are still in D1, so a re-run lists their prefixes again.
    expect((await db.prepare('SELECT COUNT(*) AS n FROM chats WHERE owner_id = ?').bind(w.p).first<{ n: number }>())!.n).toBe(2)
    const r = await runPersonDeletion(deps({ brandAgent: w.agent }), await planOk(deps({ brandAgent: w.agent }), w.p))
    expect('ok' in r).toBe(true)
    expect(Object.keys((await snapshotAll(db, bucket)).r2).filter(k => w.pChats.some(c => k.includes(c)))).toEqual([])
  })

  for (const step of ['start', 'pseudonymise', 'agent', 'cascade-objects', 'rows', 'objects'] as const) {
    it(`a second run, or a run resumed after a failure injected after ${step}, ends in the same state`, async () => {
      const w = await world(1, false)
      const before = await snapshotAll(db, bucket)
      await expect(runPersonDeletion(deps({ brandAgent: w.agent }), await planOk(deps({ brandAgent: w.agent }), w.p), { afterStep: async s => { if (s === step) throw new Error(`stop after ${step} (test)`) } })).rejects.toThrow(/stop after/)
      expect('ok' in (await runPersonDeletion(deps({ brandAgent: w.agent }), await planOk(deps({ brandAgent: w.agent }), w.p)))).toBe(true)
      const settled = await snapshotAll(db, bucket)
      expect(comparable(settled, w)).toEqual(comparable(expectedAfter(before, w), w))
      // A third run changes nothing more.
      expect('ok' in (await runPersonDeletion(deps({ brandAgent: w.agent }), await planOk(deps({ brandAgent: w.agent }), w.p)))).toBe(true)
      expect(withoutLog(await snapshotAll(db, bucket))).toEqual(withoutLog(settled))
    })
  }

  it('never touches backups/, restore/, audit-copy/ or earlier deletion-log entries', async () => {
    const w = await world(1, false)
    const kept = (s: Snapshot) => Object.fromEntries(Object.entries(s.r2).filter(([k]) => /^(backups|restore|audit-copy)\//.test(k)))
    const logBefore = (await listDeletionLog(bucket)).map(e => e.key)
    const before = await snapshotAll(db, bucket)
    await runPersonDeletion(deps({ brandAgent: w.agent }), await planOk(deps({ brandAgent: w.agent }), w.p))
    const after = await snapshotAll(db, bucket)
    expect(kept(after)).toEqual(kept(before))
    for (const k of logBefore) expect(after.r2[k]).toEqual(before.r2[k])
  })
})
