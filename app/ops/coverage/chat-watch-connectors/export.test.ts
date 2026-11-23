// Export over P3 and P4's stores (P8 C1, acceptance 2 and 3). Ways it can fail, written down first:
//  1. a person's export misses part of their chats: an agent answer (it names no person), an output file (no creator),
//     a file's bytes, a tool call, or a person memory;
//  2. it holds anything of Q's;
//  3. the brand export header misses a registry entry, or an `export: true` store isn't there in full;
//  4. any export holds a transcript, a Durable Object row or a derived index row.
import { env } from 'cloudflare:workers'
import { beforeAll, describe, expect, it } from 'vitest'
import { SYSTEM_MEMBER_ID } from '../../../server/db/ids.ts'
import { openStores } from '../../../server/db/stores.ts'
import { seedBrand } from '../../../server/seed/seed.ts'
import type { Seeded } from '../../../server/seed/seed.ts'
import { addPerson, readLines, token } from '../../delete/test-support.ts'
import { planExport, runExport } from '../../export/export.ts'
import type { ExportScope } from '../../export/export.ts'
import { tables } from '../../tables/index.ts'
import { addChat, addMemory } from './test-support.ts'

const db = env.DB
const bucket = env.FILES as R2Bucket
const T = 1_800_000_000_000
let seeded: Seeded
let p = ''
let q = ''
const marker = { p: `pz${token()}`, q: `qz${token()}` }
const pChats = [`c_${token()}`, `c_${token()}`]
const qChat = `c_${token()}`

const exportOf = async (scope: ExportScope) => {
  const d = { db, bucket, at: { actorId: SYSTEM_MEMBER_ID, requestId: `req-${token()}`, nowMs: T } }
  const plan = await planExport(d, scope)
  if (!('ok' in plan)) throw new Error(`export refused: ${plan.refused}`)
  return (await readLines(runExport(d, plan.ok))).lines
}

beforeAll(async () => {
  seeded = await seedBrand(db, openStores(env), T)
  p = (await addPerson(db, { role: 'member', status: 'active' }, seeded.members.admin, T)).id
  q = (await addPerson(db, { role: 'member', status: 'active' }, seeded.members.admin, T)).id
  for (const id of pChats) await addChat(db, bucket, { id, owner: p, lastAtMs: T, marker: marker.p, deletedAtMs: id === pChats[1] ? T : undefined })
  await addChat(db, bucket, { id: qChat, owner: q, lastAtMs: T, marker: marker.q })
  await addMemory(db, { id: `mem_${token()}`, owner: p, createdBy: p, marker: marker.p, updatedAtMs: T })
  await addMemory(db, { id: `mem_${token()}`, owner: q, createdBy: q, marker: marker.q, updatedAtMs: T })
})

describe('export coverage', () => {
  it('the person export holds P\'s whole chats with the agent\'s answers, their files\' bytes and person memories, and nothing of Q\'s', async () => {
    const lines = await exportOf({ kind: 'person', memberId: p })
    const rows = (store: string) => lines.filter(l => l.store === store) as { row?: Record<string, unknown>; key?: string; base64?: string }[]
    expect(rows('chats').map(l => l.row?.id).sort()).toEqual([...pChats].sort())
    // Both messages of each chat: the person's question and the agent's answer (author_id NULL).
    expect(rows('chat_messages').map(l => l.row?.id).sort()).toEqual(pChats.flatMap(c => [`${c}.a`, `${c}.u`]).sort())
    expect(rows('chat_messages').some(l => l.row?.author_id === null)).toBe(true)
    expect(rows('tool_calls').map(l => l.row?.chat_id).sort()).toEqual([...pChats].sort())
    expect(rows('chat_files').map(l => l.row?.chat_id).sort()).toEqual([...pChats].sort())
    expect(rows('files/').map(l => l.key).sort()).toEqual(pChats.map(c => `files/${c}/f_${c}`).sort())
    expect(rows('files/').map(l => atob(l.base64 ?? ''))).toEqual(pChats.map(() => `bytes ${marker.p}`))
    expect(rows('memories').map(l => l.row?.owner_id)).toEqual([p])
    // Nothing of Q's anywhere.
    expect(JSON.stringify(lines)).not.toContain(marker.q)
    expect(JSON.stringify(lines)).not.toContain(qChat)
  })

  it('the brand export header lists every registry entry and holds every export: true store in full', async () => {
    const lines = await exportOf({ kind: 'brand' })
    const header = lines[0] as { stores: { name: string }[] }
    expect(header.stores.map(s => s.name)).toEqual(tables.map(e => e.name))
    const end = lines.at(-1) as { counts: Record<string, number> }
    for (const e of tables.filter(t => t.export && t.kind === 'd1')) {
      const n = (await db.prepare(`SELECT COUNT(*) AS n FROM ${e.name}`).first<{ n: number }>())!.n
      expect(end.counts[e.name], e.name).toBe(n)
    }
    expect(end.counts['files/']).toBe(3)
  })

  it('counts and exports a person’s message, tool call and file row in another person’s chat', async () => {
    const messageId = `${qChat}.guest`
    const fileId = `f_${qChat}`
    await db.batch([
      db.prepare("INSERT INTO chat_messages (id, chat_id, run_id, turn_id, pos, role, author_id, text, at_ms) VALUES (?, ?, 'r', 't', 2, 'user', ?, 'guest message', ?)")
        .bind(messageId, qChat, p, T),
      db.prepare('UPDATE tool_calls SET member_id = ? WHERE chat_id = ?').bind(p, qChat),
      db.prepare('UPDATE chat_files SET created_by = ? WHERE id = ?').bind(p, fileId),
    ])
    const d = { db, bucket, at: { actorId: SYSTEM_MEMBER_ID, requestId: `req-${token()}`, nowMs: T } }
    const plan = await planExport(d, { kind: 'person', memberId: p })
    if (!('ok' in plan)) throw new Error(`export refused: ${plan.refused}`)
    const { lines } = await readLines(runExport(d, plan.ok, { pageSize: 1 }))
    expect(plan.ok.counts).toMatchObject({ chats: 2, chat_messages: 5, tool_calls: 3, chat_files: 3 })
    expect(lines.at(-1)).toEqual({ end: true, counts: plan.ok.counts })
    expect(lines.filter(l => l.store === 'chat_messages')).toContainEqual({
      store: 'chat_messages', row: expect.objectContaining({ id: messageId, chat_id: qChat, author_id: p }),
    })
    expect(lines.filter(l => l.store === 'tool_calls')).toContainEqual({
      store: 'tool_calls', row: expect.objectContaining({ chat_id: qChat, member_id: p }),
    })
    expect(lines.filter(l => l.store === 'chat_files')).toContainEqual({
      store: 'chat_files', row: expect.objectContaining({ id: fileId, created_by: p }),
    })
    expect(JSON.stringify(lines)).not.toContain(marker.q)
  })

  it('no export holds a transcript, a Durable Object row or a derived index row', async () => {
    for (const scope of [{ kind: 'brand' }, { kind: 'person', memberId: p }] as ExportScope[]) {
      const stores = new Set((await exportOf(scope)).map(l => l.store).filter(Boolean))
      for (const e of tables.filter(t => t.kind === 'do' || t.derived || t.name === 'sessions/')) expect(stores.has(e.name), `${scope.kind} ${e.name}`).toBe(false)
    }
  })
})
