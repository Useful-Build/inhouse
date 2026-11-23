// What R's deletion-log replay needs from C1 (#346 review H1). Ways it can fail, written down first:
//  1. a retention run logs a cutoff under a name that isn't a registered store (`chats:trash`), so R's replay refuses
//     `replay_unknown_store` and every restore after a retention run stops;
//  2. a custom job can't be replayed at its logged cutoffs: the replay needs the job's own condition, with no limit,
//     from the logged cutoffs alone (never a new clock);
//  3. the chat cascade or the bell's ordered delete has no runner in the shape R's `PersonRunner` takes, so a replayed
//     person deletion refuses `replay_custom_unrun`.
import { runInDurableObject } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { beforeAll, describe, expect, it } from 'vitest'
import { SYSTEM_MEMBER_ID } from '../../../server/db/ids.ts'
import { openStores } from '../../../server/db/stores.ts'
import { seedBrand } from '../../../server/seed/seed.ts'
import type { Seeded } from '../../../server/seed/seed.ts'
import { RestoreRefusal } from '../../backup/errors.ts'
import { groupRuns } from '../../backup/reconcile/replay.ts'
import type { PersonRunner } from '../../backup/reconcile/replay.ts'
import { listDeletionLog } from '../../delete/log.ts'
import { addPerson, token } from '../../delete/test-support.ts'
import { planRetention, runRetention } from '../../retention/retention.ts'
import { DEFAULT_DAYS, periodsFor } from '../../retention/rules.ts'
import { tables } from '../../tables/index.ts'
import { personRunners, replayRetention } from './replay.ts'
import { addChat, addMemory, addNotice, addRead } from './test-support.ts'

const db = env.DB
const bucket = env.FILES as R2Bucket
const DAY = 86_400_000
const NOW = 2_200_000_000_000
let seeded: Seeded
const entry = (name: string) => tables.find(t => t.name === name)!
const has = async (table: string, where: string, ...args: (string | number)[]) => (await db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).bind(...args).first<{ n: number }>())!.n

beforeAll(async () => {
  seeded = await seedBrand(db, openStores(env), NOW - 9_000 * DAY)
})

describe('the log R replays (failure 1)', () => {
  it('a retention run logs its cutoffs under registered store names only, with an age tag for a fixed period', async () => {
    const stores = ['chats', 'chat_files', 'library_uploads', 'memories', 'tool_calls']
    const registry = stores.map(entry)
    let wall = NOW + 1
    const before = (await listDeletionLog(bucket)).map(e => e.key)
    const d = { db, bucket, at: { actorId: SYSTEM_MEMBER_ID, requestId: 'r', nowMs: NOW }, clock: () => ++wall, registry }
    await runRetention(d, await planRetention(d, { periods: periodsFor(registry) }))
    const mine = (await listDeletionLog(bucket)).filter(e => !before.includes(e.key))
    const runs = groupRuns(mine)
    expect(runs).toHaveLength(1)
    const cutoffs = runs[0].cutoffs ?? []
    for (const c of cutoffs) expect(tables.some(t => t.name === c.store), c.store).toBe(true)
    const tagged = (mine[0].entry.cutoffs ?? []).map(c => `${c.store}${c.age ? `/${c.age}` : ''}`).sort()
    expect(tagged).toEqual(['chat_files/trash', 'chats', 'chats/trash', 'library_uploads/pending', 'library_uploads/trash', 'memories/forgotten', 'tool_calls'])
  })
})

describe('replaying a custom job (failure 2)', () => {
  it('replayRetention applies the chat cascade at the logged cutoffs with no limit, and keeps the chat exactly at the cutoff', async () => {
    const cut = NOW - DEFAULT_DAYS.chats * DAY
    const trash = NOW - DEFAULT_DAYS.trash * DAY
    const old: string[] = []
    for (let i = 0; i < 95; i++) {
      const id = `c_${token()}`
      old.push(id)
      await addChat(db, bucket, { id, owner: seeded.members.dana, lastAtMs: cut - 1 - i, marker: `rp${i}` })
    }
    const edge = `c_${token()}`
    await addChat(db, bucket, { id: edge, owner: seeded.members.dana, lastAtMs: cut, marker: 'rpedge' })
    const removed = await replayRetention('chats', { db, bucket }, [{ cutoffMs: cut }, { cutoffMs: trash, age: 'trash' }])
    expect(removed.chats).toBe(95)
    expect(await has('chats', `id IN (${old.map(() => '?').join(', ')})`, ...old)).toBe(0)
    expect(await has('chats', 'id = ?', edge)).toBe(1)
  })

  it('replayRetention applies a fixed-period job from its age tag (forgotten memories), and refuses a store with no job or a missing cutoff', async () => {
    const forgotten = NOW - DEFAULT_DAYS.forgottenMemory * DAY
    const id = `mem_${token()}`
    await addMemory(db, { id, owner: null, createdBy: SYSTEM_MEMBER_ID, marker: 'rpmem', status: 'forgotten', updatedAtMs: forgotten - 1 })
    expect((await replayRetention('memories', { db, bucket }, [{ cutoffMs: forgotten, age: 'forgotten' }])).memories).toBe(1)
    expect(await has('memories', 'id = ?', id)).toBe(0)
    await expect(replayRetention('members', { db, bucket }, [{ cutoffMs: 1 }])).rejects.toThrow(/members/)
    await expect(replayRetention('chats', { db, bucket }, [{ cutoffMs: 1 }])).rejects.toThrow(/chats.*trash/)
    await expect(replayRetention('members', { db, bucket }, [{ cutoffMs: 1 }])).rejects.toBeInstanceOf(RestoreRefusal)
    await expect(replayRetention('chats', { db, bucket }, [{ cutoffMs: 1 }])).rejects.toMatchObject({ reason: expect.stringMatching(/^deletion_log_invalid: /) })
    // A store another job serves replays as nothing (its job's store carries the cutoff).
    expect(await replayRetention('chat_messages', { db, bucket }, [])).toEqual({})
  })

  it('replayRetention refuses replay_stopped for busy past-cutoff chats and still reaches quiet chats behind 45+ busy ones', async () => {
    const cut = NOW - DEFAULT_DAYS.chats * DAY
    const trash = NOW - DEFAULT_DAYS.trash * DAY
    // Prefix 'cb_' sorts cleanly; create 46 past-cutoff chats where the first 45 are busy and the 46th is quiet.
    const prefix = `cb_${token()}_`
    const busyIds = Array.from({ length: 45 }, (_, i) => `${prefix}${String(i).padStart(2, '0')}`)
    const quietId = `${prefix}45_quiet`
    for (const id of [...busyIds, quietId]) {
      await addChat(db, bucket, { id, owner: seeded.members.dana, lastAtMs: cut - 10, marker: `busy${id}` })
    }
    const stub = env.BRAND_AGENT.get(env.BRAND_AGENT.idFromName(`replay-busy-chats-${token()}`))
    await runInDurableObject(stub, async (_obj, state) => {
      await state.storage.deleteAlarm()
      const sql = state.storage.sql
      for (const id of busyIds) {
        sql.exec("INSERT INTO chat_state (chat_id, owner_id, live_run_id, last_at_ms) VALUES (?, ?, ?, ?)", id, seeded.members.dana, `run_${id}`, cut - 10)
      }
      sql.exec('INSERT INTO chat_state (chat_id, owner_id, live_run_id, last_at_ms) VALUES (?, ?, NULL, ?)', quietId, seeded.members.dana, cut - 10)

      await expect(replayRetention('chats', { db, bucket, sql }, [{ cutoffMs: cut }, { cutoffMs: trash, age: 'trash' }]))
        .rejects.toMatchObject({ name: 'RestoreRefusal', reason: expect.stringMatching(/^replay_stopped: chats: 45 busy/) })

      // Eligible quiet unit behind 45 busy ones was reached and deleted, while busy ones stay untouched.
      expect(await has('chats', 'id = ?', quietId)).toBe(0)
      expect(await has('chats', `id IN (${busyIds.map(() => '?').join(', ')})`, ...busyIds)).toBe(45)

      // Once busy chats settle, a re-run deletes all 45 and succeeds.
      for (const id of busyIds) sql.exec('UPDATE chat_state SET live_run_id = NULL WHERE chat_id = ?', id)
      const finished = await replayRetention('chats', { db, bucket, sql }, [{ cutoffMs: cut }, { cutoffMs: trash, age: 'trash' }])
      expect(finished.chats).toBe(45)
      expect(await has('chats', `id IN (${busyIds.map(() => '?').join(', ')})`, ...busyIds)).toBe(0)
    })
  })

  it('replayRetention refuses replay_stopped when an ended run past cutoff is unsafe in BrandAgent, and deletes safe runs', async () => {
    const cut = NOW - DEFAULT_DAYS.steps * DAY
    const stub = env.BRAND_AGENT.get(env.BRAND_AGENT.idFromName(`replay-unsafe-run-${token()}`))
    await runInDurableObject(stub, async (_obj, state) => {
      await state.storage.deleteAlarm()
      const sql = state.storage.sql
      const addEnded = (runId: string, opts: { d1Flushed?: number; reserved?: number; settled?: number; effect?: boolean }) => {
        const turnId = `t_${runId}`
        sql.exec("INSERT INTO runs (run_id, chat_id, owner_id, state, started_at_ms, ended_at_ms) VALUES (?, ?, 'm_x', 'ended', ?, ?)", runId, `c_${runId}`, cut - 20, cut - 1)
        sql.exec(
          `INSERT INTO turns (turn_id, run_id, chat_id, owner_id, ord, client_key, payload_hash, state, priority, text,
            attachments_json, model, picker_id, side_model, effort, max_turns, answer_position, reserved, settled, d1_flushed, created_at_ms)
           VALUES (?, ?, ?, 'm_x', 0, ?, 'ph', 'ended', 'now', 'hi', '[]', 'm', 'p', 's', 'e', 1, 'after', ?, ?, ?, ?)`,
          turnId, runId, `c_${runId}`, `ck_${runId}`, opts.reserved ?? 0, opts.settled ?? 1, opts.d1Flushed ?? 1, cut - 20,
        )
        if (opts.effect) {
          sql.exec("INSERT INTO turn_effects (turn_id, seq, kind, json) VALUES (?, 0, 'x', '{}')", turnId)
        }
      }
      addEnded('r_0_unflushed', { d1Flushed: 0 })
      addEnded('r_1_hold', { reserved: 1, settled: 0 })
      addEnded('r_2_effect', { effect: true })
      addEnded('r_3_safe', {})

      await expect(replayRetention('BrandAgent', { db, bucket, sql }, [{ cutoffMs: cut }]))
        .rejects.toMatchObject({ name: 'RestoreRefusal', reason: expect.stringMatching(/^replay_stopped: BrandAgent: 3 busy/) })

      // Safe run was deleted; unsafe runs remain until settled/flushed.
      expect(sql.exec("SELECT COUNT(*) AS n FROM runs WHERE run_id = 'r_3_safe'").one().n).toBe(0)
      expect(sql.exec('SELECT COUNT(*) AS n FROM runs').one().n).toBe(3)

      // Settle/flush all three -> re-run finishes cleanly.
      sql.exec('UPDATE turns SET d1_flushed = 1, settled = 1')
      sql.exec('DELETE FROM turn_effects')
      expect((await replayRetention('BrandAgent', { db, bucket, sql }, [{ cutoffMs: cut }])).BrandAgent).toBe(6)
      expect(sql.exec('SELECT COUNT(*) AS n FROM runs').one().n).toBe(0)
    })
  })
})

describe('person runners (failure 3)', () => {
  it('the person runners delete the person\'s chats (cascade) and member notices in R\'s PersonRunner shape; the served stores\' runners do nothing', async () => {
    const p = (await addPerson(db, { role: 'member', status: 'active' }, seeded.members.admin, NOW)).id
    const q = (await addPerson(db, { role: 'member', status: 'active' }, seeded.members.admin, NOW)).id
    const pChat = `c_${token()}`
    const qChat = `c_${token()}`
    const pObjs = await addChat(db, bucket, { id: pChat, owner: p, lastAtMs: NOW, marker: 'rpp' })
    await addChat(db, bucket, { id: qChat, owner: q, lastAtMs: NOW, marker: 'rpq' })
    const pNotice = `n_${token()}`
    await addNotice(db, { id: pNotice, audience: 'member', member: p, atMs: NOW })
    await addRead(db, p, pNotice, NOW)
    const runners: Readonly<Record<string, PersonRunner>> = personRunners({ db, bucket })
    expect(Object.keys(runners).sort()).toEqual(['chat_files', 'chat_messages', 'chats', 'files/', 'notices', 'sessions/', 'tool_calls'])
    for (const served of ['chat_messages', 'tool_calls', 'chat_files', 'files/', 'sessions/']) expect(await runners[served].deletePerson(p), served).toEqual({ ok: 0 })
    expect(await has('chats', 'id = ?', pChat)).toBe(1)
    expect(await runners.chats.deletePerson(p)).toEqual({ ok: 8 })
    expect(await has('chats', 'id = ?', pChat)).toBe(0)
    expect(await bucket.head(pObjs.fileKey)).toBeNull()
    expect(await has('chats', 'id = ?', qChat)).toBe(1)
    expect(await runners.notices.deletePerson(p)).toEqual({ ok: 2 })
    expect(await has('notices', 'id = ?', pNotice)).toBe(0)
    // Idempotent: a second replay finds nothing.
    expect(await runners.chats.deletePerson(p)).toEqual({ ok: 0 })
  })
})
