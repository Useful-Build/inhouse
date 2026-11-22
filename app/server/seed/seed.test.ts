// The seed and the first Admin's SQL, on the real migrations. Ways they can fail, written down first:
//  1. the seed writes rows without their audit lines, or skips a part the test build needs (an Admin, two Members, a
//     pending invite, an Inhouse person, settings, the smoke row);
//  2. the seed runs twice over one database;
//  3. the first-admin SQL breaks on a value with quotes or other characters, or stores it altered;
//  4. it runs a value the schema refuses, or invites twice when run twice.
import { fc, test } from '@fast-check/vitest'
import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { openStores } from '../db/stores.ts'
import { linesSince, reset } from '../db/test-support.ts'
import { SEED_INHOUSE, SEED_INVITE, SEED_PEOPLE } from './brand.ts'
import { firstAdminSql } from './first-admin.ts'
import { seedBrand } from './seed.ts'

const db = env.DB
const stores = openStores(env)

describe('the seed (failures 1, 2)', () => {
  it('writes the invented brand through the data layer, each change with its line, and refuses a second run', async () => {
    const seeded = await seedBrand(db, stores, 1_800_000_000_000)
    const people = (await db.prepare("SELECT id, role, status, subject, email_norm FROM members WHERE kind = 'person' ORDER BY created_at_ms, id").all()).results
    expect(people).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: seeded.members.admin, role: 'admin', status: 'active', subject: SEED_PEOPLE.admin.subject }),
      expect.objectContaining({ id: seeded.members.dana, role: 'member', status: 'active', subject: SEED_PEOPLE.dana.subject }),
      expect.objectContaining({ id: seeded.members.leo, role: 'member', status: 'active' }),
      expect.objectContaining({ id: seeded.members.invite, status: 'invited', subject: null, email_norm: SEED_INVITE.email }),
    ]))
    expect(await stores.members.resolveInhouse({ ...SEED_INHOUSE, requestId: 'r', nowMs: 1 })).toMatchObject({ memberId: seeded.members.inhouse })
    expect(seeded.members.smoke).toBe('m_smoke')
    const actions = (await linesSince(db, 0)).map(l => l.action)
    expect(actions.filter(a => a === 'member.invited')).toHaveLength(4)
    expect(actions.filter(a => a === 'member.bound')).toHaveLength(3)
    expect(actions.filter(a => a === 'inhouse.first_sign_in')).toHaveLength(1)
    expect(actions.filter(a => a === 'setting.changed')).toHaveLength(8)
    expect((await stores.settings.list(seeded.members.dana, 'personal')).map(s => s.key)).toEqual(['g:name', 'g:theme', 'n:weekly'])
    // P3 (p3-design section 11): the test build's brand has a spending cap, or every E2E turn is refused cap_reached.
    expect(await db.prepare("SELECT value_json FROM settings WHERE key = 's:cap'").first('value_json')).toBe('"$320"')
    await expect(seedBrand(db, stores, 1_800_000_000_000)).rejects.toThrow(/already has people/)
  })
})

describe('the first Admin SQL (failures 3, 4)', () => {
  const nameArb = fc.string({ minLength: 1, maxLength: 80 }).filter(s => s.trim().length > 0 && !s.includes('\0'))
  test.prop([nameArb, fc.option(nameArb, { nil: undefined })], { numRuns: 50 })('runs as written and stores each value exactly', async (name, title) => {
    await reset(db)
    const email = `first-${Math.random().toString(36).slice(2, 8)}@example.test`
    const sql = firstAdminSql({ name, email, ...(title === undefined ? {} : { title }) }, 1_800_000_000_000)
    for (const s of sql) await db.prepare(s).run()
    for (const s of sql) await db.prepare(s).run()
    const rows = (await db.prepare('SELECT * FROM members WHERE email_norm = ?').bind(email).all<{ id: string; name: string; title: string | null; role: string; status: string }>()).results
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ name: name.trim(), title: title === undefined ? null : title.trim(), role: 'admin', status: 'invited' })
    const lines = (await linesSince(db, 0)).filter(l => l.target_id === rows[0].id)
    expect(lines.map(l => [l.action, l.actor_id, JSON.parse(l.args_json)])).toEqual([['member.invited', 'm_system', { memberId: rows[0].id, role: 'admin' }]])
  })
  it('refuses a value the schema refuses', () => {
    expect(() => firstAdminSql({ name: 'Ok Name', email: 'not an email' }, 1)).toThrow()
    expect(() => firstAdminSql({ name: ' ', email: 'ok@example.test' }, 1)).toThrow()
  })
})
