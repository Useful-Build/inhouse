// What R's deletion-log replay needs from C1 (#346 review H1). Ways it can fail, written down first:
//  1. a retention run logs a cutoff under a name that isn't a registered store (`chats:trash`), so R's replay refuses
//     `replay_unknown_store` and every restore after a retention run stops;
//  2. a custom job can't be replayed at its logged cutoffs: the replay needs the job's own condition, with no limit,
//     from the logged cutoffs alone (never a new clock);
//  3. the chat cascade or the bell's ordered delete has no runner in the shape R's `PersonRunner` takes, so a replayed
//     person deletion refuses `replay_custom_unrun`.
import { env } from 'cloudflare:workers'
import { beforeAll, describe, expect, it } from 'vitest'
import { SYSTEM_MEMBER_ID } from '../../../server/db/ids.ts'
import { openStores } from '../../../server/db/stores.ts'
import { seedBrand } from '../../../server/seed/seed.ts'
import type { Seeded } from '../../../server/seed/seed.ts'
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
    // A store another job serves replays as nothing (its job's store carries the cutoff).
    expect(await replayRetention('chat_messages', { db, bucket }, [])).toEqual({})
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
