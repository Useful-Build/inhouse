// Brand skills (P6a, master plan standing decision 6): the store, the `skill_save` tool, routes 79, 84 and 85 (handlers
// called directly; the matrix's role rule is matrix.test.ts's), and the run's start. Ways it can fail, written first:
//  1. a member changes or deletes another member's skill, or an admin can't; a removed admin still can;
//  2. a 26th skill, or one past the brand's 192 KiB, is saved; a change that grows past it is saved;
//  3. a stale rev deletes, or a refused write changes anything or writes an audit line;
//  4. an audit line holds the skill's name, description or instructions;
//  5. frontmatter (`allowed-tools` and the like) survives into what's kept, served or sent to the runner;
//  6. a routine's run (`m_system`) saves a skill;
//  7. the list shows a brand skill without its maker, or says the reader may change one they may not;
//  8. an unknown name or id answers anything but 404; one of ours can be read but a brand skill can't, or the other way;
//  9. a turn's start doesn't carry the brand's skills as they are when it's placed.
import { env } from 'cloudflare:workers'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { deleteBrandSkill, listSkills, readSkill } from '../api/skills.ts'
import { openStores } from '../db/stores.ts'
import { ctx, lastLineId, personPrincipal, reqId } from '../db/test-support.ts'
import { TOOL_HANDLERS } from '../mcp/tools/index.ts'
import type { ToolResult, ToolScope } from '../mcp/server/tool.ts'
import { NEEDS_PERSON_TEXT, NOT_OWNER_TEXT } from '../mcp/tools/skills/index.ts'
import { BRAND_SKILL_BODY_MAX, BRAND_SKILLS_BYTES_MAX, BRAND_SKILLS_MAX, BrandSkillFiles } from '../../shared/protocol/brand-skills.ts'
import { deleteSkill, saveSkill, skillFiles } from './store.ts'

const db = env.DB
const stores = openStores(env)
const DANA = 'm_bs_dana'
const LEO = 'm_bs_leo'
const ADMIN = 'm_bs_admin'
const GONE_ADMIN = 'm_bs_gone'
const NOW = 1_800_000_000_000
const at = (actorId: string) => ({ actorId, requestId: reqId(), nowMs: NOW })
const inhouse = { kind: 'inhouse', memberId: 'm_bs_ih', subject: 's_i', grant: { id: 'g', endsAtMs: NOW + 1 }, requestId: 'r', expMs: 4_102_444_800_000 } as const
const SECRET = 'Zebra-Ledger-secret-words'
const skill = (name: string, over: { description?: string; body?: string } = {}) => ({ name, description: over.description ?? `Writes the ${name}.`, body: over.body ?? `Read the orders.\n\n${SECRET}` })

beforeAll(async () => {
  for (const [id, role, status] of [[DANA, 'member', 'active'], [LEO, 'member', 'active'], [ADMIN, 'admin', 'active'], [GONE_ADMIN, 'admin', 'removed']] as const) {
    await db.prepare("INSERT INTO members (id, kind, role, status, name, created_at_ms) VALUES (?, 'person', ?, ?, ?, 0) ON CONFLICT (id) DO NOTHING").bind(id, role, status, id === DANA ? 'Dana Example' : 'Test person').run()
  }
  await db.prepare("INSERT INTO members (id, kind, role, status, name, created_at_ms) VALUES ('m_bs_ih', 'inhouse', NULL, 'active', 'Inhouse', 0) ON CONFLICT (id) DO NOTHING").run()
})
let from = 0
beforeEach(async () => {
  await db.prepare('DELETE FROM brand_skills').run()
  from = await lastLineId(db)
})
const auditLines = async () => (await db.prepare("SELECT actor_id, action, target_kind, target_id, args_json FROM audit_log WHERE action LIKE 'brand_skill.%' AND id > ? ORDER BY id").bind(from).all<Record<string, string>>()).results
const made = async (by: string, s = skill('weekly-report')) => {
  const o = await saveSkill(db, s, at(by))
  if (!('ok' in o)) throw new Error(`refused: ${JSON.stringify(o)}`)
  return o.ok
}
const route = async (h: typeof listSkills, principal: Parameters<typeof ctx>[1], init: Parameters<typeof ctx>[2]) => {
  const { c } = ctx(stores, principal, init)
  const res = await h(c as never)
  return { status: res.status, body: (await res.json()) as any }
}
const readRow = (name: string) => db.prepare('SELECT created_by, updated_by, rev FROM brand_skills WHERE name = ?').bind(name).first<{ created_by: string | null; updated_by: string | null; rev: number }>()

describe('saving (the store)', () => {
  it('a member makes one, live at once; the frontmatter is dropped; the audit line holds the id only', async () => {
    const o = await saveSkill(db, skill('weekly-report', { body: '---\nname: x\nallowed-tools: Bash, WebFetch\n---\n\nRead the orders.\r\n' }), at(DANA))
    expect(o).toMatchObject({ created: true, ok: { name: 'weekly-report', body: 'Read the orders.', created_by: DANA, updated_by: DANA, rev: 1 } })
    const lines = await auditLines()
    expect(lines.map(l => [l.actor_id, l.action, l.target_kind])).toEqual([[DANA, 'brand_skill.created', 'brand_skill']])
    expect(JSON.parse(lines[0]!.args_json!)).toEqual({ skillId: (o as { ok: { id: string } }).ok.id })
  })

  it('its maker and an admin change it; another member, a removed admin and the Inhouse team-less actor cannot', async () => {
    const s = await made(DANA)
    expect(await saveSkill(db, skill('weekly-report', { body: 'Leo was here.' }), at(LEO))).toEqual({ refused: 'not_owner' })
    expect(await saveSkill(db, skill('weekly-report', { body: 'Gone admin.' }), at(GONE_ADMIN))).toEqual({ refused: 'inactive' })
    const byDana = await saveSkill(db, skill('weekly-report', { body: 'Dana changed it.' }), at(DANA))
    expect(byDana).toMatchObject({ created: false, ok: { body: 'Dana changed it.', rev: 2, created_by: DANA } })
    const byAdmin = await saveSkill(db, skill('weekly-report', { body: 'The admin changed it.' }), at(ADMIN))
    expect(byAdmin).toMatchObject({ created: false, ok: { body: 'The admin changed it.', rev: 3, created_by: DANA, updated_by: ADMIN } })
    expect((await auditLines()).map(l => [l.actor_id, l.action, l.target_id])).toEqual([
      [DANA, 'brand_skill.created', s.id], [DANA, 'brand_skill.changed', s.id], [ADMIN, 'brand_skill.changed', s.id],
    ])
  })

  it('refuses a bad name, description or body with words the agent can pass on, and writes nothing', async () => {
    for (const bad of [skill('Weekly Report'), skill('pdf'), skill('claude-helper'), skill('x', { description: 'Uses <b>tags</b>' }), skill('x', { body: '---\na: 1\n---\n' }), skill('x', { body: 'a\u0007b' })]) {
      const o = await saveSkill(db, bad, at(DANA))
      expect(o, bad.name).toMatchObject({ refused: 'invalid' })
      expect((o as { why: string }).why.length).toBeGreaterThan(10)
    }
    expect((await db.prepare('SELECT count(*) AS n FROM brand_skills').first<{ n: number }>())!.n).toBe(0)
    expect(await auditLines()).toEqual([])
  })

  it.each(['insert', 'update'] as const)('refuses a save when membership ends immediately before the %s', async (operation) => {
    const actorId = `m_bs_race_${operation}`
    await db.prepare("INSERT INTO members (id, kind, role, status, name, created_at_ms) VALUES (?, 'person', 'member', 'active', 'Racing member', 0)").bind(actorId).run()
    if (operation === 'update') await made(actorId)
    const auditBefore = await auditLines()
    const racingDb = {
      prepare: (sql: string) => db.prepare(sql),
      async batch(statements: D1PreparedStatement[]) {
        if (operation === 'insert') {
          expect(await stores.members.pseudonymise(actorId, at(ADMIN))).toMatchObject({ ok: { id: actorId } })
        } else {
          // A removed member can still be named as creator, so ownership alone would allow this write.
          await db.prepare("UPDATE members SET status = 'removed' WHERE id = ?").bind(actorId).run()
        }
        return db.batch(statements)
      },
    }
    expect(await saveSkill(racingDb, skill('weekly-report', { body: 'Raced.' }), at(actorId))).toEqual({ refused: 'inactive' })
    expect(await readRow('weekly-report')).toEqual(operation === 'update' ? { created_by: actorId, updated_by: actorId, rev: 1 } : null)
    expect(await auditLines()).toEqual(auditBefore)
  })

  it(`holds at most ${BRAND_SKILLS_MAX} skills and ${BRAND_SKILLS_BYTES_MAX} bytes together, in the write's own statement`, async () => {
    for (let i = 0; i < BRAND_SKILLS_MAX; i++) await made(DANA, skill(`skill-${i}`, { body: 'Short.' }))
    expect(await saveSkill(db, skill('one-more'), at(DANA))).toEqual({ refused: 'limit' })
    await db.prepare('DELETE FROM brand_skills').run()
    // Each body a full 12,000 three-byte characters: 36,000 bytes, so five fit and the sixth doesn't.
    const big = '€'.repeat(BRAND_SKILL_BODY_MAX)
    for (let i = 0; i < 5; i++) await made(DANA, skill(`big-${i}`, { body: big }))
    expect(await saveSkill(db, skill('big-5', { body: big }), at(DANA))).toEqual({ refused: 'too_large' })
    // Growing one past the budget is refused too, and changes nothing.
    await made(DANA, skill('small', { body: 'Short.' }))
    expect(await saveSkill(db, skill('small', { body: big }), at(DANA))).toEqual({ refused: 'too_large' })
    const files = await skillFiles(db)
    expect(files.find(f => f.name === 'small')!.body).toBe('Short.')
    expect(BrandSkillFiles.safeParse(files).success).toBe(true)
  })
})

describe('deleting (the store)', () => {
  it('its maker or an admin deletes it at its rev; a stale rev is a conflict; another member is refused; an unknown id is not found', async () => {
    const a = await made(DANA, skill('a-skill'))
    const b = await made(DANA, skill('b-skill'))
    expect(await deleteSkill(db, { id: a.id, ifRev: 1 }, at(LEO))).toEqual({ refused: 'not_owner' })
    expect(await deleteSkill(db, { id: a.id, ifRev: 2 }, at(DANA))).toMatchObject({ conflict: { id: a.id, rev: 1 } })
    expect(await deleteSkill(db, { id: 'bs_AAAAAAAAAAAAAAAAAAAAAA', ifRev: 1 }, at(DANA))).toEqual({ refused: 'not_found' })
    expect(await auditLines()).toHaveLength(2)
    expect(await deleteSkill(db, { id: a.id, ifRev: 1 }, at(DANA))).toMatchObject({ ok: { id: a.id } })
    expect(await deleteSkill(db, { id: b.id, ifRev: 1 }, at(ADMIN))).toMatchObject({ ok: { id: b.id } })
    expect(await skillFiles(db)).toEqual([])
    const lines = await auditLines()
    expect(lines.slice(2).map(l => [l.actor_id, l.action, l.target_id])).toEqual([[DANA, 'brand_skill.deleted', a.id], [ADMIN, 'brand_skill.deleted', b.id]])
    for (const l of lines) for (const word of [SECRET, 'a-skill', 'b-skill', 'Writes the']) expect(l.args_json).not.toContain(word)
    // Its name is free again.
    await made(LEO, skill('a-skill'))
  })
})

describe('skill_save (the tool)', () => {
  let n = 0
  const scope = (memberId: string): ToolScope => ({ memberId, chatId: 'c_bs', runId: 'r_AAAAAAAAAAAAAAAAAAAAAA', turnId: 't_AAAAAAAAAAAAAAAAAAAAAA', nowMs: NOW, requestId: `req-bs-tool-${++n}` })
  const call = async (args: Record<string, unknown>, s: ToolScope): Promise<ToolResult> => {
    const h = TOOL_HANDLERS.get('skill_save')!
    return h.call(h.input.parse(args), s, { db })
  }
  it('saves as the run\'s person and says it is live from the next chat; a change by another member is refused in words', async () => {
    const a = await call(skill('weekly-report'), scope(DANA))
    expect(a.isError).toBeUndefined()
    expect(a.structuredContent).toMatchObject({ name: 'weekly-report', created: true })
    expect(a.content[0]!.text).toContain('next chat')
    const b = await call(skill('weekly-report', { body: 'Changed.' }), scope(LEO))
    expect(b).toMatchObject({ isError: true, structuredContent: { error: 'forbidden' } })
    expect(b.content[0]!.text).toBe(NOT_OWNER_TEXT)
  })
  it("a routine's run is refused: a skill needs a person", async () => {
    const r = await call(skill('weekly-report'), scope('m_system'))
    expect(r).toMatchObject({ isError: true, structuredContent: { error: 'forbidden' } })
    expect(r.content[0]!.text).toBe(NEEDS_PERSON_TEXT)
    expect(await skillFiles(db)).toEqual([])
  })
  it('a bad name is refused with what to change', async () => {
    const r = await call(skill('Weekly report'), scope(DANA))
    expect(r).toMatchObject({ isError: true, structuredContent: { error: 'invalid' } })
    expect(r.content[0]!.text).toContain('lower-case')
  })
})

describe('routes 79, 84 and 85', () => {
  it("lists ours, then the brand's with its maker's name; canChange is the maker's and an admin's, never the Inhouse team's", async () => {
    await made(DANA, skill('weekly-report'))
    const names = (b: { n: string }[]) => b.map(s => s.n)
    const asLeo = await route(listSkills, personPrincipal(LEO, 'member'), { path: '/api/skills' })
    expect(asLeo.status).toBe(200)
    expect(names(asLeo.body)).toEqual(['dataviz', 'pdf', 'word', 'spreadsheet', 'skill-creator', 'weekly-report'])
    const mine = asLeo.body.at(-1)
    expect(mine).toMatchObject({ n: 'weekly-report', by: 'Dana Example', mine: true, need: 0, canChange: false, rev: 1 })
    expect(mine).not.toHaveProperty('body')
    expect((await route(listSkills, personPrincipal(DANA, 'member'), { path: '/api/skills' })).body.at(-1).canChange).toBe(true)
    expect((await route(listSkills, personPrincipal(ADMIN, 'admin'), { path: '/api/skills' })).body.at(-1).canChange).toBe(true)
    expect((await route(listSkills, inhouse as never, { path: '/api/skills' })).body.at(-1).canChange).toBe(false)
    for (const s of asLeo.body.slice(0, 5)) expect(s.mine).toBeUndefined()
  })

  it("reads one of ours (frontmatter and the licence note dropped) and a brand skill; an unknown or ill-formed name is 404", async () => {
    await made(DANA, skill('weekly-report'))
    const pdf = await route(readSkill, personPrincipal(LEO, 'member'), { path: '/api/skills/pdf', params: { name: 'pdf' } })
    expect(pdf.status).toBe(200)
    expect(pdf.body.body).toMatch(/^# PDF files/)
    expect(pdf.body.tools).toEqual([])
    const creator = await route(readSkill, personPrincipal(LEO, 'member'), { path: '/api/skills/skill-creator', params: { name: 'skill-creator' } })
    expect(creator.body.body).toMatch(/^# Skill Creator/)
    const dataviz = await route(readSkill, personPrincipal(LEO, 'member'), { path: '/api/skills/dataviz', params: { name: 'dataviz' } })
    expect(dataviz.body.body).toMatch(/^# Charts and tables/)
    const brand = await route(readSkill, personPrincipal(LEO, 'member'), { path: '/api/skills/weekly-report', params: { name: 'weekly-report' } })
    expect(brand).toMatchObject({ status: 200, body: { body: `Read the orders.\n\n${SECRET}`, updatedAt: { ms: NOW } } })
    for (const name of ['no-such-skill', '../pdf', 'PDF', '']) {
      expect((await route(readSkill, personPrincipal(LEO, 'member'), { path: `/api/skills/${encodeURIComponent(name)}`, params: { name } })).status, name).toBe(404)
    }
  })

  it('deletes at the rev: the maker and an admin, not another member (403 not_owner), a stale rev is 409 with the skill as it is, an unknown id 404', async () => {
    const s = await made(DANA, skill('weekly-report'))
    const del = (who: string, role: 'member' | 'admin', id: string, ifRev: number) =>
      route(deleteBrandSkill, personPrincipal(who, role), { method: 'POST', path: `/api/skills/brand/${id}/delete`, body: { ifRev }, params: { id } })
    expect(await del(LEO, 'member', s.id, 1)).toMatchObject({ status: 403, body: { error: { code: 'forbidden', reason: 'not_owner' } } })
    expect(await del(DANA, 'member', s.id, 7)).toMatchObject({ status: 409, body: { error: { code: 'conflict', current: { n: 'weekly-report', rev: 1, canChange: true } } } })
    expect((await del(DANA, 'member', 'bs_AAAAAAAAAAAAAAAAAAAAAA', 1)).status).toBe(404)
    expect((await del(DANA, 'member', 'not-an-id', 1)).status).toBe(404)
    expect(await del(ADMIN, 'admin', s.id, 1)).toMatchObject({ status: 200, body: { n: 'weekly-report' } })
    expect(await skillFiles(db)).toEqual([])
  })
})

describe('person deletion (members.pseudonymise)', () => {
  it('keeps the brand skills the deleted person made, clears links to the person, shows "a former member", and leaves only admins able to edit or delete them', async () => {
    const FORMER = 'm_bs_former'
    await db.prepare(
      "INSERT INTO members (id, kind, role, status, name, email_norm, subject, created_at_ms) VALUES (?, 'person', 'admin', 'active', 'Former Maker', 'former@example.test', 'sub_former', 0) ON CONFLICT (id) DO UPDATE SET role = 'admin', name = 'Former Maker', email_norm = 'former@example.test', subject = 'sub_former', status = 'active', pseudonymised_at_ms = NULL, removed_at_ms = NULL",
    ).bind(FORMER).run()

    const madeByFormer = await made(FORMER, skill('former-only'))
    const editedByAdmin = await made(FORMER, skill('former-then-admin'))
    expect(await saveSkill(db, skill('former-then-admin', { body: 'Admin updated.' }), at(ADMIN))).toMatchObject({ created: false })
    const editedByFormer = await made(ADMIN, skill('admin-then-former'))
    expect(await saveSkill(db, skill('admin-then-former', { body: 'Former updated.' }), at(FORMER))).toMatchObject({ created: false })
    await made(ADMIN, skill('admin-only'))

    const auditBefore = await lastLineId(db)
    expect(await stores.members.pseudonymise(FORMER, at(ADMIN))).toMatchObject({ ok: { id: FORMER, name: 'Former member' } })
    expect(await lastLineId(db)).toBe(auditBefore)

    // Refused pseudonymisation (last active admin) changes no brand skill links.
    expect(await stores.members.pseudonymise(ADMIN, at(ADMIN))).toEqual({ refused: 'last_admin' })

    // Every skill stays live and runnable; all references to the deleted person are NULL.
    expect((await skillFiles(db)).map(f => f.name)).toEqual(['admin-only', 'admin-then-former', 'former-only', 'former-then-admin'])
    expect(await readRow('former-only')).toEqual({ created_by: null, updated_by: null, rev: 1 })
    expect(await readRow('former-then-admin')).toEqual({ created_by: null, updated_by: ADMIN, rev: 2 })
    expect(await readRow('admin-then-former')).toEqual({ created_by: ADMIN, updated_by: null, rev: 2 })
    expect(await readRow('admin-only')).toEqual({ created_by: ADMIN, updated_by: ADMIN, rev: 1 })

    // Routes 79 and 84: lists "a former member", and only active admins have canChange: true.
    const asMember = (await route(listSkills, personPrincipal(LEO, 'member'), { path: '/api/skills' })).body as { n: string; by: string; canChange?: boolean }[]
    expect(asMember.find(s => s.n === 'former-only')).toMatchObject({ by: 'a former member', mine: true, canChange: false })
    expect(asMember.find(s => s.n === 'former-then-admin')).toMatchObject({ by: 'a former member', mine: true, canChange: false })
    expect(asMember.find(s => s.n === 'admin-then-former')).toMatchObject({ by: 'Test person', mine: true, canChange: false })
    const asFormer = (await route(listSkills, personPrincipal(FORMER, 'member'), { path: '/api/skills' })).body as { n: string; canChange?: boolean }[]
    expect(asFormer.find(s => s.n === 'former-only')?.canChange).toBe(false)
    const asAdmin = (await route(listSkills, personPrincipal(ADMIN, 'admin'), { path: '/api/skills' })).body as { n: string; by: string; canChange?: boolean }[]
    expect(asAdmin.find(s => s.n === 'former-only')).toMatchObject({ by: 'a former member', canChange: true })
    const noGrantInhouse = { ...inhouse, grant: null }
    const asInhouse = (await route(listSkills, noGrantInhouse as never, { path: '/api/skills' })).body as { n: string; by: string; canChange?: boolean }[]
    expect(asInhouse.find(s => s.n === 'former-only')).toMatchObject({ by: 'a former member', canChange: false })

    // Only admins can edit or delete a skill whose maker's data was deleted.
    expect(await saveSkill(db, skill('former-only', { body: 'Member edit.' }), at(LEO))).toEqual({ refused: 'not_owner' })
    expect(await saveSkill(db, skill('former-only', { body: 'Former edit.' }), at(FORMER))).toEqual({ refused: 'inactive' })
    expect(await deleteSkill(db, { id: madeByFormer.id, ifRev: 1 }, at(LEO))).toEqual({ refused: 'not_owner' })
    expect(await deleteSkill(db, { id: madeByFormer.id, ifRev: 1 }, at(FORMER))).toEqual({ refused: 'not_owner' })
    expect(await saveSkill(db, skill('former-only', { body: 'Admin edit.' }), at(ADMIN))).toMatchObject({
      created: false,
      ok: { created_by: null, updated_by: ADMIN, rev: 2, body: 'Admin edit.' },
    })
    expect(await deleteSkill(db, { id: editedByAdmin.id, ifRev: 2 }, at(ADMIN))).toMatchObject({ ok: { id: editedByAdmin.id } })
    expect(await deleteSkill(db, { id: editedByFormer.id, ifRev: 2 }, at(ADMIN))).toMatchObject({ ok: { id: editedByFormer.id } })
  })
})
