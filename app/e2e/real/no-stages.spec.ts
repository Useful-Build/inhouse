// Stage 1 M2-I: the product has no stages (decision "Master plan: one agent", plan note N17). The seed still stores the
// technical `stage` setting as Watch; the product leaves it unread and pins its view to the Act view until M5. Replaces
// stage-from-server.spec.ts, which proved the product read that setting. Ways it can fail, written first:
//  1. a page, the Settings menu or the command palette shows a stage word ("Watch", "Act", "Run", "stage") or a stage tag
//     (a lock badge whose screen reader text says "included in a later stage");
//  2. Stage and plan is still in the Settings menu, or a link to it still opens it;
//  3. the view follows the stored Watch: Approvals shows the "In Act, ..." block, or Spending cap's Pause button is
//     locked (it works from Act), or a click on it doesn't pause and resume the brand;
//  4. a skill's page still shows the stage it works from.
// The audit log is not walked: it is history, and lines written before the retirement keep their words (N17).
import type { Page } from '@playwright/test'
import { expect, test } from '../support/test-build/index.js'
import { open, signInAs } from '../support/clients/real.js'
import { actor, call } from '../api/kit.ts'

const phone = (page: Page) => (page.viewportSize()?.width ?? 1440) < 600
/** A stage word as the old screens wrote one. "Run now" (a routine's button) is an action, not the stage. */
const STAGE_NAME = /\b(Watch|Act|Run)\b(?! now)/
const STAGE_WORD = /\bstages?\b/i

/**
 * Every word on the page, hidden ones included (a tag's screen reader text, a closed drawer), once `ready` shows. `skip`:
 * parts that are someone's own words, not the app's (a skill's instructions to the agent say "Run `python3`").
 */
async function expectNoStageWords(page: Page, where: string, skip?: string) {
  const text = await page.locator('body').evaluate((b, sel) => {
    const copy = b.cloneNode(true) as HTMLElement
    if (sel) copy.querySelectorAll(sel).forEach(e => e.remove())
    return copy.textContent ?? ''
  }, skip)
  expect(text, `${where} names a stage`).not.toMatch(STAGE_NAME)
  expect(text, `${where} says "stage"`).not.toMatch(STAGE_WORD)
}

const PAGES: [hash: string, heading: string][] = [
  ['#/today', ''], ['#/approvals', 'Approvals'], ['#/activity', 'Activity'], ['#/library', ''],
  ['#/routines', 'Routines'], ['#/skills', 'Skills'], ['#/tools', 'Tools'], ['#/usage', 'Usage'],
]
/** The product's Settings pages for an Admin, but the audit log (see above). Slack notices shows only with Slack connected. */
const SETTINGS: [tab: string, heading: string][] = [
  ['you-general', 'General'], ['you-memory', 'Memory'], ['you-permissions', 'Always allowed'], ['team-agent', 'Inhouse agent'],
  ['team-modes', 'Models'], ['team-memory', 'Team memory'], ['team-spend', 'Spending cap'], ['team-members', 'Members'],
  ['team-data', 'Data and access'],
]

test('No page an Admin opens names a stage or shows a stage tag', async ({ page, context }) => {
  await signInAs(context, 'admin')
  for (const [hash, heading] of PAGES) {
    await open(page, 'admin', hash)
    // Today's and the Library's headings are words of their own (a greeting, a folder): any page heading will do.
    await expect(heading ? page.getByRole('heading', { level: 1, name: heading, exact: true }) : page.getByRole('heading', { level: 1 }).first(), hash).toBeVisible()
    await expectNoStageWords(page, hash)
  }
  for (const [tab, heading] of SETTINGS) {
    await open(page, 'admin', `#/settings/${tab}`)
    await expect(page.getByRole('heading', { level: 1, name: heading, exact: true }), tab).toBeVisible()
    await expectNoStageWords(page, tab)
  }
})

test("A skill's page and a routine's panel don't say which stage they work from", async ({ page, context }) => {
  await signInAs(context, 'admin')
  await open(page, 'admin', '#/skills')
  // The Inhouse team's PDF skill, which the server always lists (server/skills/list.ts).
  await page.getByRole('main').getByRole('button', { name: 'pdf', exact: true }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'pdf', exact: true })).toBeVisible()
  await expect(page.getByRole('main').getByText('Who can change it', { exact: true })).toBeVisible()
  // The instructions are the skill's own text for the agent (runner/image/plugin/skills/pdf/SKILL.md: "Run `python3`"),
  // so the check reads everything else on the page. They have loaded, so leaving them out is a real cut.
  const instructions = 'article[aria-labelledby="skill-instructions"]'
  await expect(page.locator(instructions)).toContainText('PDF')
  await expectNoStageWords(page, 'the pdf skill', instructions)
  await expect(page.getByRole('main').getByText('Works from', { exact: true })).toHaveCount(0)

  // The morning check: the one routine the test build always has.
  await open(page, 'admin', '#/routines')
  await page.locator('[data-routine-open="routine-morning-check"]').click()
  await expect(page.getByRole('dialog', { name: 'Morning check' })).toBeVisible()
  await expectNoStageWords(page, 'the morning check')
})

test('Stage and plan is gone: not in the Settings menu or the command palette, and a link to it lands on General', async ({ page, context }) => {
  await signInAs(context, 'admin')
  await open(page, 'admin', '#/settings/team-plan')
  await expect(page.getByRole('heading', { level: 1, name: 'General', exact: true })).toBeVisible()
  await expect(page.locator('[data-toast]').filter({ hasText: "That page doesn't exist. You're on General." })).toBeVisible()
  if (phone(page)) await page.getByRole('button', { name: 'Back to settings' }).click()
  const nav = page.getByRole('navigation', { name: 'Settings' })
  await expect(nav.getByRole('button', { name: 'Data and access', exact: true })).toBeVisible()
  await expect(nav.getByRole('button', { name: 'Stage and plan', exact: true })).toHaveCount(0)
  await expectNoStageWords(page, 'the Settings menu')

  // The palette lists every page and Settings page: none is a stage's, and none has a stage tag.
  test.skip(phone(page), 'the command palette is a keyboard shortcut on a computer')
  await page.keyboard.press('ControlOrMeta+K')
  const palette = page.getByRole('dialog')
  await expect(palette.getByRole('option', { name: /Data and access/ })).toBeVisible()
  await expect(palette.getByRole('option', { name: /Stage and plan/ })).toHaveCount(0)
  const text = await palette.evaluate(d => d.textContent ?? '')
  expect(text).not.toMatch(STAGE_NAME)
  expect(text).not.toMatch(STAGE_WORD)
})

test('The view is pinned to Act whatever the stored stage: Approvals has no "In Act" block, and Pause pauses and resumes', async ({ page, context, request }) => {
  await signInAs(context, 'admin')
  await open(page, 'admin', '#/approvals')
  await expect(page.getByRole('heading', { level: 1, name: 'Approvals', exact: true })).toBeVisible()
  await expect(page.locator('[data-watch-block]')).toHaveCount(0)
  await expectNoStageWords(page, 'Approvals')

  // Pause is offered at Act (it was locked at the stored Watch): a click pauses the brand, the next resumes it, each
  // through its route (36, 37). The specs run one at a time; the brand is resumed whatever happens.
  const admin = actor('admin')
  try {
    await open(page, 'admin', '#/settings/team-spend')
    await expect(page.getByRole('heading', { level: 1, name: 'Spending cap', exact: true })).toBeVisible()
    const main = page.getByRole('main')
    const pause = main.getByRole('button', { name: 'Pause Inhouse agent', exact: true })
    await expect(pause).toBeEnabled()
    const posted = (path: string) => page.waitForResponse(r => r.request().method() === 'POST' && new URL(r.url()).pathname === path)
    const [paused] = await Promise.all([posted('/api/pause'), pause.click()])
    expect(paused.status()).toBe(200)
    await expect(page.locator('[data-toast]').filter({ hasText: 'Your Inhouse agent is paused.' })).toBeVisible()
    expect(((await call(request, admin, 'GET', '/api/pause')).json as { paused: boolean }).paused).toBe(true)
    const resume = main.getByRole('button', { name: 'Resume Inhouse agent', exact: true })
    const [resumed] = await Promise.all([posted('/api/resume'), resume.click()])
    expect(resumed.status()).toBe(200)
    await expect(main.getByRole('button', { name: 'Pause Inhouse agent', exact: true })).toBeVisible()
    expect(((await call(request, admin, 'GET', '/api/pause')).json as { paused: boolean }).paused).toBe(false)
  } finally {
    expect((await call(request, admin, 'POST', '/api/resume', { json: {} })).status).toBe(200)
  }
})

test("The account menu's Team settings opens the Inhouse agent page, not Stage and plan", async ({ page, context }) => {
  await signInAs(context, 'admin')
  await open(page, 'admin', '#/today')
  if (phone(page)) await page.getByRole('button', { name: 'Menu' }).click()
  await page.getByRole('complementary', { name: 'Sidebar' }).getByRole('button', { name: /account and settings/i }).click()
  await page.getByRole('menu', { name: 'Account' }).getByRole('menuitem', { name: 'Team settings', exact: true }).click()
  // A phone shows the Settings menu first; a computer the page itself.
  if (!phone(page)) await expect(page.getByRole('heading', { level: 1, name: 'Inhouse agent', exact: true })).toBeVisible()
  await expect(page).toHaveURL(/#\/settings(\/team-agent)?$/)
  await expect(page.locator('[data-toast]').filter({ hasText: "That page doesn't exist" })).toHaveCount(0)
})
