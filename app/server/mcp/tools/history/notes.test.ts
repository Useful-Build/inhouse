// The history tools and the server's own notes (Stage 1 M2-G, from #441's review). Ways it can fail, written first: a
// job's carry-on note or an action's result (a `user` row the server wrote, `extra_json.source` `job` or `action`) comes
// back as the person's words, in a search hit (whose snippet can drop the note's "[Automatic note ...]" prefix) or in a
// read; or a person's own message is labelled as a note.
import { env } from 'cloudflare:workers'
import { beforeAll, describe, expect, it } from 'vitest'
import { historyStore } from './store.ts'
import { handlers } from './index.ts'
import type { ToolScope } from '../../server/tool.ts'

const db = env.DB
const ME = 'm_hnotes'
const CHAT = 'c_hnotes'
const row = (id: string, pos: number, role: string, text: string, extra: string | null) =>
  db.prepare('INSERT INTO chat_messages (id, chat_id, run_id, turn_id, pos, role, text, extra_json, at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(id, CHAT, 'r_hn', `t_hn${pos}`, pos, role, text, extra, 1000 + pos).run()

beforeAll(async () => {
  await db.prepare("INSERT INTO members (id, kind, role, status, name, created_at_ms) VALUES (?, 'person', 'member', 'active', 'Noa', 1)").bind(ME).run()
  await db.prepare("INSERT INTO chats (id, owner_id, title, created_at_ms, last_at_ms) VALUES (?, ?, 'Pelican restock', 1, 1)").bind(CHAT, ME).run()
  await row('t_hn0.u', 0, 'user', 'Tag the pelican orders as wholesale', JSON.stringify({ quote: 'x' }))
  await row('t_hn1.u', 1, 'user', '[Automatic note from Inhouse, not a message from the person] Continue the pelican task from where you stopped.', JSON.stringify({ source: 'job' }))
  await row('t_hn2.u', 2, 'user', '[Automatic note from Inhouse, not a message from the person] An action you asked for earlier has a result: "Add a tag to order 7" went out (pelican).', JSON.stringify({ source: 'action' }))
  await row('t_hn3.0', 3, 'agent', 'Tagged the pelican order.', JSON.stringify({ trace: 't_hn3' }))
})

describe('the server\'s notes read as Inhouse\'s, never the person\'s', () => {
  it('search: each hit\'s role', async () => {
    const hits = await historyStore({ db }).search(ME, 'pelican', { afterMs: null, beforeMs: null, limit: 10 })
    expect(Object.fromEntries(hits.map(h => [h.messageId, h.role]))).toEqual({ 't_hn0.u': 'user', 't_hn1.u': 'inhouse', 't_hn2.u': 'inhouse', 't_hn3.0': 'agent' })
  })
  it('read: each message\'s role, and the words the agent reads', async () => {
    const chat = await historyStore({ db }).read(ME, CHAT, { fromPos: 0, limit: 10 })
    expect(chat!.messages.map(m => m.role)).toEqual(['user', 'inhouse', 'inhouse', 'agent'])
    const scope = { memberId: ME, chatId: 'c_other', runId: 'r_x', turnId: 't_x', nowMs: 2000, requestId: 'req' } as ToolScope
    const r = await handlers.history_read!.call({ chat_id: CHAT, from_position: 0, limit: 10 }, scope, { db })
    const text = r.content[0]!.text
    expect(text).toContain('Person (1970-01-01): Tag the pelican orders as wholesale')
    expect(text).toContain('Inhouse (an automatic note, not the person) (1970-01-01): [Automatic note from Inhouse')
    expect(text.match(/Person \(/g)).toHaveLength(1)
  })
})
