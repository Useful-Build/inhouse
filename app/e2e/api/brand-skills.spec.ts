// Brand skills (P6a, master plan standing decision 6): routes 79, 84 and 85 and the `skill_save` tool. Oracles are the
// decision's text, written out here and never read from the server's rows:
//  - a member or an admin makes a skill in a chat; it's live at once (no approval), listed after ours with its maker's
//    name, and its frontmatter is dropped;
//  - its maker or an admin changes it (in a chat) or deletes it (route 85, at its rev); another member can't;
//  - the Inhouse team reads the brand's skills only under a live grant, and changes or deletes none; a token for another
//    brand's app is refused;
//  - each write leaves one audit line that holds the skill's id only, never its name or text.
// The chat part needs containers (the per-PR deployment); the rest seeds its rows in the local D1.
import { expect, test } from '@playwright/test'
import type { APIRequestContext } from '@playwright/test'
import { actor, audOf, call, endLiveGrants, expectError, mint } from './kit.ts'
import type { Actor } from './kit.ts'
import { auditMax, expectOneLine, readSql, writeSql } from './db.ts'
import { answerOf, createChat, needsContainer, send, textOf } from './chat-kit.ts'
import { memberIdOf, needsLocalD1 } from './watch-kit.ts'
import { BRAND_SKILL_REFUSED_ANSWER, BRAND_SKILL_SAVED_ANSWER } from '../../test/scripted-model/scenarios.ts'
import { randomBytes } from 'node:crypto'

const dana = actor('memberA')
const leo = actor('memberB')
const admin = actor('admin')
const inhouse = actor('inhouse')
test.describe.configure({ mode: 'serial' })

const OURS = ['dataviz', 'pdf', 'word', 'spreadsheet', 'skill-creator']
const SECRET = `E2E-brand-skill-text-${Date.now().toString(36)}`
interface Def { n: string; by: string; mine?: boolean; canChange?: boolean; id?: string; rev?: number }

const list = async (request: APIRequestContext, who: Actor): Promise<Def[]> => {
  const r = await call(request, who, 'GET', '/api/skills')
  expect(r.status, r.text).toBe(200)
  return r.json as Def[]
}
const del = (request: APIRequestContext, who: Actor, id: string, ifRev: number) => call(request, who, 'POST', `/api/skills/brand/${id}/delete`, { json: { ifRev } })
const seed = (name: string, by: string): string => {
  const id = `bs_${randomBytes(16).toString('base64url')}`
  writeSql(`INSERT INTO brand_skills (id, name, description, body, created_by, created_at_ms, updated_by, updated_at_ms, rev) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`,
    id, name, `Does ${name}.`, `Read the orders.\n\n${SECRET}`, by, Date.now(), by, Date.now())
  return id
}
const clean = () => writeSql("DELETE FROM brand_skills WHERE name LIKE 'e2e-%'")

test.describe('routes (seeded in the local D1)', () => {
  test.beforeAll(async ({ request }) => {
    needsLocalD1()
    await endLiveGrants(request)
    clean()
  })
  test.afterAll(() => clean())

  test("everyone lists ours, then the brand's with its maker's name; only its maker and an admin may change it", async ({ request }) => {
    seed('e2e-list-skill', await memberIdOf(request, dana))
    for (const [who, may] of [[dana, true], [leo, false], [admin, true]] as const) {
      const skills = await list(request, who)
      expect(skills.slice(0, 5).map(s => s.n)).toEqual(OURS)
      for (const s of skills.slice(0, 5)) expect([s.by, s.mine]).toEqual(['Inhouse team', undefined])
      const mine = skills.find(s => s.n === 'e2e-list-skill')
      expect(mine).toMatchObject({ mine: true, canChange: may, rev: 1 })
      expect(mine!.by).not.toBe('Inhouse team')
    }
    const page = await call(request, leo, 'GET', '/api/skills/e2e-list-skill')
    expect(page.status, page.text).toBe(200)
    expect(page.json.body).toBe(`Read the orders.\n\n${SECRET}`)
    const ours = await call(request, leo, 'GET', '/api/skills/pdf')
    expect([ours.status, ours.json.body.startsWith('---')]).toEqual([200, false])
    expectError(await call(request, leo, 'GET', '/api/skills/e2e-no-such-skill'), 404, 'not_found')
  })

  test('the Inhouse team reads only under a live grant and deletes nothing; another brand\'s token is refused', async ({ request }) => {
    const id = seed('e2e-grant-skill', await memberIdOf(request, dana))
    expectError(await call(request, inhouse, 'GET', '/api/skills'), 403, 'forbidden', 'grant_required')
    expectError(await call(request, inhouse, 'GET', '/api/skills/e2e-grant-skill'), 403, 'forbidden', 'grant_required')
    expect((await call(request, admin, 'POST', '/api/grants', { json: { hours: 1 } })).status).toBe(201)
    try {
      const skills = await list(request, inhouse)
      expect(skills.find(s => s.n === 'e2e-grant-skill')).toMatchObject({ canChange: false })
      expectError(await del(request, inhouse, id, 1), 403, 'forbidden')
    } finally {
      await endLiveGrants(request)
    }
    // A token minted for another app's audience (another brand's Access app) never reaches the routes.
    const foreign = await mint(dana, { aud: audOf('inhouse') })
    for (const [method, path] of [['GET', '/api/skills'], ['GET', '/api/skills/e2e-grant-skill'], ['POST', `/api/skills/brand/${id}/delete`]] as const) {
      const r = await call(request, dana, method, path, { token: foreign, ...(method === 'POST' ? { json: { ifRev: 1 } } : {}) })
      expect([401, 403], `${method} ${path}`).toContain(r.status)
    }
    expect(readSql<{ n: number }>("SELECT count(*) AS n FROM brand_skills WHERE name = 'e2e-grant-skill'")[0]!.n).toBe(1)
  })

  test('delete: another member is refused, a stale rev is a conflict, the maker and an admin delete, each with one line holding the id only', async ({ request }) => {
    const danaId = await memberIdOf(request, dana)
    const a = seed('e2e-delete-a', danaId)
    const b = seed('e2e-delete-b', danaId)
    let mark = auditMax()
    expectError(await del(request, leo, a, 1), 403, 'forbidden', 'not_owner')
    expect((await del(request, dana, a, 9)).status).toBe(409)
    expectError(await del(request, dana, 'bs_AAAAAAAAAAAAAAAAAAAAAA', 1), 404, 'not_found')
    expect(readSql<{ n: number }>("SELECT count(*) AS n FROM audit_log WHERE id > ? AND action LIKE 'brand_skill.%'", mark)[0]!.n).toBe(0)
    expect((await del(request, dana, a, 1)).status).toBe(200)
    const line = expectOneLine(mark, 'brand_skill.deleted', danaId, ['e2e-delete-a', SECRET, 'Does'])
    expect(JSON.parse(line.args_json)).toEqual({ skillId: a })
    mark = auditMax()
    expect((await del(request, admin, b, 1)).status).toBe(200)
    expectOneLine(mark, 'brand_skill.deleted', await memberIdOf(request, admin), ['e2e-delete-b', SECRET])
    const names = (await list(request, dana)).map(s => s.n)
    expect(names).not.toContain('e2e-delete-a')
    expect(names).not.toContain('e2e-delete-b')
  })
})

test.describe('skill_save in a chat (containers)', () => {
  test.beforeAll(() => {
    needsContainer()
    clean()
  })
  test.afterAll(() => clean())

  const ask = async (request: APIRequestContext, who: Actor, scenario: string): Promise<string> => {
    const chat = await createChat(request, who)
    const sent = await send(request, who, chat, `Save the weekly report skill (scenario:${scenario})`)
    return textOf(await answerOf(request, who, chat, sent.turnId))
  }

  test('a member makes one (frontmatter dropped, live at once); another member cannot change it; an admin can', async ({ request }) => {
    expect(await ask(request, dana, 'skill-save')).toContain(BRAND_SKILL_SAVED_ANSWER)
    const made = (await list(request, leo)).find(s => s.n === 'e2e-weekly-report')
    expect(made).toMatchObject({ mine: true, rev: 1 })
    const page = await call(request, leo, 'GET', '/api/skills/e2e-weekly-report')
    expect(page.json.body).toBe('# Weekly report\n\nRead the wholesale orders.')

    expect(await ask(request, leo, 'skill-save-change')).toContain(BRAND_SKILL_REFUSED_ANSWER)
    expect((await call(request, leo, 'GET', '/api/skills/e2e-weekly-report')).json.body).toBe('# Weekly report\n\nRead the wholesale orders.')

    expect(await ask(request, admin, 'skill-save-change')).toContain(BRAND_SKILL_SAVED_ANSWER)
    const changed = (await list(request, dana)).find(s => s.n === 'e2e-weekly-report')
    expect(changed).toMatchObject({ rev: 2 })
    expect((await call(request, dana, 'GET', '/api/skills/e2e-weekly-report')).json.body).toContain('and the returns')
  })
})
