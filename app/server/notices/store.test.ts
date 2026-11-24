// The notice store (0231 and `addNotice`), in the Workers runtime on the real migrations. Ways it can fail:
//  1. a repeat of one id writes a second notice, or the audience-pair CHECK is swallowed (the writer's own statement must throw);
//  2. a body gets into a template that doesn't allow one (P4's own), or a notice holds a name;
//  3. deleting a member's notices (`audience_member_id`) leaves their bodies behind, or their read rows.
import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { addNotice, NOTICE_INSERT_SQL, noticeInsert } from './store.ts'
import type { NoticeInput } from './store.ts'
import { NOTICE_TEMPLATES } from './templates.ts'

const db = env.DB
const NAME = 'Dana Fixture-Kim'
const seed = () => db.batch([
  db.prepare("INSERT OR IGNORE INTO members (id, kind, role, status, name, created_at_ms) VALUES ('m_dana', 'person', 'admin', 'active', ?, 1)").bind(NAME),
])
const base: NoticeInput = { id: 'n-base', audience: 'admins', template: 'routine_failed', fields: { code: 'run_failed' }, icon: 'error', link: { to: 'page', page: 'routines' }, atMs: 5 }
const n = async (id: string) => (await db.prepare('SELECT COUNT(*) AS c FROM notices WHERE id = ?').bind(id).first<number>('c')) ?? -1

describe('notices', () => {
  it('a repeated id is one row; a CHECK failure aborts the batch instead of vanishing (failure 1)', async () => {
    await seed()
    await db.batch([addNotice(db, { ...base, id: 'n-once' }), addNotice(db, { ...base, id: 'n-once' })])
    expect(await n('n-once')).toBe(1)
    await expect(db.prepare("INSERT INTO notices (id, audience, template, fields_json, icon, at_ms, link_json, source) VALUES ('n-raw1', 'member', 't', '{}', 'i', 1, '{}', 's')").run()).rejects.toThrow()
    await expect(db.prepare("INSERT INTO notices (id, audience, audience_member_id, template, fields_json, icon, at_ms, link_json, source) VALUES ('n-raw2', 'team', 'm_dana', 't', '{}', 'i', 1, '{}', 's')").run()).rejects.toThrow()
    const withPerson = { ...NOTICE_TEMPLATES, shown: { source: 'test', text: '{person} did it', who: 'W', fields: {} } }
    await db.batch([noticeInsert(db, withPerson, { ...base, id: 'n-member', template: 'shown', fields: {}, audience: 'member', audienceMemberId: 'm_dana', personId: 'm_dana', waiting: true })])
    expect(await db.prepare("SELECT audience_member_id, person_id, waiting, source FROM notices WHERE id = 'n-member'").first())
      .toEqual({ audience_member_id: 'm_dana', person_id: 'm_dana', waiting: 1, source: 'test' })
    // The writer's real statement against the table's audience-pair CHECK: bypass the JS check by binding the SQL directly.
    const sqlText = NOTICE_INSERT_SQL
    expect(sqlText).toContain('ON CONFLICT (id) DO NOTHING')
    await expect(db.prepare(sqlText).bind('n-pair2', 'member', null, 'routine_failed', '{}', null, 'i', null, 1, 0, '{}', 's').run()).rejects.toThrow(/CHECK/)
    await expect(db.prepare(sqlText).bind('n-pair3', 'team', 'm_dana', 'routine_failed', '{}', null, 'i', null, 1, 0, '{}', 's').run()).rejects.toThrow(/CHECK/)
    expect(await n('n-pair2') + await n('n-pair3')).toBe(0)
  })

  it("refuses a body on P4's own templates and keeps names out (failure 2)", async () => {
    await seed()
    // P4's own rows only: P5's notify and system rows take a body (p5-w4 section 3).
    for (const template of Object.keys(NOTICE_TEMPLATES).filter(t => !NOTICE_TEMPLATES[t]!.body)) {
      expect(() => addNotice(db, { ...base, id: `n-body-${template}`, template, fields: template === 'routine_failed' ? { code: 'x' } : template === 'morning_check_found' ? { items: 1 } : {}, body: 'hi' })).toThrow(/takes no body/)
    }
    await db.batch([addNotice(db, { ...base, id: 'n-names', audience: 'member', audienceMemberId: 'm_dana' })])
    const dump = JSON.stringify((await db.prepare('SELECT * FROM notices').all()).results)
    expect(dump).not.toContain('Dana')
  })

  it("deleting a member's notices removes their bodies and read rows (failure 3)", async () => {
    await seed()
    const table = { ...NOTICE_TEMPLATES, notify_message: { source: 'notify', text: 'Message', who: 'Agent', fields: {}, body: { max: 1622 } } }
    await db.batch([noticeInsert(db, table, { ...base, id: 'n-del', template: 'notify_message', fields: {}, audience: 'member', audienceMemberId: 'm_dana', body: '<b>hello</b>' })])
    await db.prepare("INSERT INTO notice_reads (member_id, notice_id, at_ms) VALUES ('m_dana', 'n-del', 6)").run()
    expect(await db.prepare("SELECT body FROM notices WHERE id = 'n-del'").first<string>('body')).toBe('<b>hello</b>')
    await db.batch([
      db.prepare("DELETE FROM notice_reads WHERE member_id = 'm_dana' OR notice_id IN (SELECT id FROM notices WHERE audience_member_id = 'm_dana')"),
      db.prepare("DELETE FROM notices WHERE audience_member_id = 'm_dana'"),
    ])
    expect(await n('n-del')).toBe(0)
    expect(await db.prepare('SELECT COUNT(*) AS c FROM notice_reads').first<number>('c')).toBe(0)
  })

  it('a body-optional row takes a notice without a body; a required one still refuses it (P5 W4, B2 2026-11-21)', async () => {
    await seed()
    const table = {
      ...NOTICE_TEMPLATES,
      opt_row: { source: 'test', text: 'Optional', who: 'W', fields: {}, body: { max: 10, optional: true as const } },
      req_row: { source: 'test', text: 'Required', who: 'W', fields: {}, body: { max: 10 } },
    }
    await db.batch([
      noticeInsert(db, table, { ...base, id: 'n-opt-none', template: 'opt_row', fields: {} }),
      noticeInsert(db, table, { ...base, id: 'n-opt-body', template: 'opt_row', fields: {}, body: 'ten chars!' }),
    ])
    expect(await n('n-opt-none') + await n('n-opt-body')).toBe(2)
    expect(() => noticeInsert(db, table, { ...base, id: 'n-req-none', template: 'req_row', fields: {} })).toThrow(/needs a body/)
    expect(() => noticeInsert(db, table, { ...base, id: 'n-opt-long', template: 'opt_row', fields: {}, body: 'eleven char' })).toThrow(/1 to 10 code points/)
  })
})
