// PR 5, ask G: `ensureChat` on the migrated D1 (0005's service rows, 0100's chats). Ways it can fail, written down
// first: the system member can't own a chat; a second call makes a second row or changes the first one's title; an id
// that belongs to another owner is silently shared; a member that doesn't exist owns a chat.
import { env } from 'cloudflare:workers'
import { beforeAll, describe, expect, it } from 'vitest'
import { ensureChat } from './chats.ts'

const db = env.DB
const chatRow = (id: string) => db.prepare('SELECT id, owner_id, title, pinned, deleted_at_ms, created_at_ms, last_at_ms, rev FROM chats WHERE id = ?').bind(id).first()

beforeAll(async () => {
  await db.prepare("INSERT INTO members (id, kind, role, status, name, email_norm, created_at_ms) VALUES ('m_ensure_ada', 'person', 'member', 'active', 'Ada', 'ensure-ada@example.com', 1)").run()
})

describe('ensureChat (G)', () => {
  it('makes a chat owned by m_system, once; a second call keeps the first row as it is', async () => {
    await ensureChat(db, { id: 'rc_ensure_one', ownerId: 'm_system', title: 'Morning check, 2026-11-20' }, 1000)
    await ensureChat(db, { id: 'rc_ensure_one', ownerId: 'm_system', title: 'Another title' }, 2000)
    expect(await chatRow('rc_ensure_one')).toEqual({
      id: 'rc_ensure_one', owner_id: 'm_system', title: 'Morning check, 2026-11-20', pinned: 0, deleted_at_ms: null,
      created_at_ms: 1000, last_at_ms: 1000, rev: 1,
    })
    expect(await db.prepare("SELECT COUNT(*) AS n FROM chats WHERE id = 'rc_ensure_one'").first('n')).toBe(1)
  })

  it('throws for an id another owner holds, and leaves that chat alone', async () => {
    await ensureChat(db, { id: 'c_ensure_ada', ownerId: 'm_ensure_ada', title: 'Ada\'s chat' }, 1000)
    await expect(ensureChat(db, { id: 'c_ensure_ada', ownerId: 'm_system', title: 'x' }, 2000)).rejects.toThrow('belongs to another owner')
    expect(await chatRow('c_ensure_ada')).toMatchObject({ owner_id: 'm_ensure_ada', title: 'Ada\'s chat' })
  })

  it('refuses an owner that is not a member', async () => {
    await expect(ensureChat(db, { id: 'rc_ensure_nobody', ownerId: 'm_nobody_here', title: 'x' })).rejects.toThrow()
    expect(await chatRow('rc_ensure_nobody')).toBeNull()
  })
})
