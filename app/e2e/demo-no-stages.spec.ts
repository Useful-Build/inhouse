// The demo has no stages (decision A13, option B), as the product (e2e/real/no-stages.spec.ts). Ways it can fail, written
// first:
//  1. a page, a Settings page, the command palette, the demo switches, Help (every guide), the bell, a Today card's window,
//     a Usage tab, a chat, a tool's page, a skill's page or a routine's panel shows a stage word ("Watch", "Act", "Run",
//     "stage") or a stage tag (a lock whose screen reader text says "included in a later stage"), in any scenario;
//  2. a skill's page still says which stage it works from, or wears a stage badge;
//  3. the demo switches still offer a Stage.
// Every word on the page counts, hidden ones too (a tag's screen reader text, a closed drawer); the audit log is history
// and isn't walked, as in the product's spec. Lists (chats, tools, skills, routines, guides, Usage's tabs) are read from
// the page, so a new one is swept too.
import type { Locator, Page } from '@playwright/test'
import { expect, test } from './support/fx.js'

/** A stage word as the old screens wrote one. "Run now" (a routine's button) is an action, not the stage. */
const STAGE_NAME = /\b(Watch|Act|Run)\b(?! now)/
const STAGE_WORD = /\bstages?\b/i

async function expectNoStageWords(page: Page, where: string) {
  const text = await page.locator('body').evaluate(b => b.textContent ?? '')
  expect(text, `${where} names a stage`).not.toMatch(STAGE_NAME)
  expect(text, `${where} says "stage"`).not.toMatch(STAGE_WORD)
}
const go = (page: Page, hash: string) => page.evaluate(h => { location.hash = h }, hash)
const h1 = (page: Page, name: string | RegExp) => page.getByRole('heading', { level: 1, name, exact: typeof name === 'string' })

type Scenario = 'Normal' | 'First day' | 'Cap reached'
/** Slack is connected on a normal day and at the cap; on the first day its links land on Tools and General. */
const slack = (s: Scenario) => s !== 'First day'

/** Each page with what proves it has drawn (not the page before it). */
const pages = (s: Scenario): [hash: string, ready: (p: Page) => Locator][] => [
  ['#/today', p => p.getByRole('heading', { level: 1 }).filter({ hasText: /Good morning|Welcome/ })],
  ['#/approvals', p => h1(p, 'Approvals')],
  ['#/activity', p => h1(p, 'Activity')],
  ['#/library', p => h1(p, 'All files')],
  ['#/routines', p => h1(p, 'Routines')],
  ['#/skills', p => h1(p, 'Skills')],
  ['#/tools', p => h1(p, 'Tools')],
  ['#/tools/slack', p => h1(p, slack(s) ? 'Slack' : 'Tools')],
  ['#/chats/all', p => h1(p, 'All chats')],
]
const SETTINGS = (s: Scenario): [tab: string, heading: string][] => [
  ['you-general', 'General'], ['you-memory', 'Memory'], ['you-permissions', 'Always allowed'], ['team-agent', 'Inhouse agent'],
  ['team-modes', 'Models'], ['team-memory', 'Team memory'], ['team-spend', 'Spending cap'], ['team-members', 'Members'],
  ['team-slack', slack(s) ? 'Slack notices' : 'General'], ['team-data', 'Data and access'],
]

for (const scenario of ['Normal', 'First day', 'Cap reached'] as const) {
  test(`${scenario}: no page, Settings page, Usage tab, Help guide, bell, palette or demo switch names a stage`, async ({ fx, page }) => {
    test.setTimeout(120_000)
    await fx.seed({ scenario })
    await fx.open('#/today')
    await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible()
    for (const [hash, ready] of pages(scenario)) {
      await go(page, hash)
      await expect(ready(page).first(), hash).toBeVisible()
      await expectNoStageWords(page, `${scenario} ${hash}`)
    }
    for (const [tab, heading] of SETTINGS(scenario)) {
      await go(page, `#/settings/${tab}`)
      await expect(h1(page, heading), tab).toBeVisible()
      await expectNoStageWords(page, `${scenario} ${tab}`)
    }
    // Usage: every tab of the breakdown (round 1's "Run jobs" sat on Job).
    await go(page, '#/usage')
    await expect(h1(page, 'Usage')).toBeVisible()
    const tabs = page.getByRole('radiogroup', { name: 'Break down by' }).getByRole('radio')
    const nTabs = await tabs.count()
    expect(nTabs).toBeGreaterThan(2)
    for (let i = 0; i < nTabs; i++) {
      await tabs.nth(i).click()
      await expect(tabs.nth(i)).toHaveAttribute('aria-checked', 'true')
      await expectNoStageWords(page, `${scenario} Usage tab ${i + 1}`)
    }
    // The bell.
    await page.getByRole('button', { name: /^Notifications/ }).click()
    await expect(page.getByRole('dialog', { name: 'Notifications' })).toBeVisible()
    await expectNoStageWords(page, `${scenario} the bell`)
    await page.keyboard.press('Escape')
    // Help and guides, every guide open in turn.
    await page.getByRole('complementary', { name: 'Sidebar' }).getByRole('button', { name: /account and settings/i }).click()
    await page.getByRole('menuitem', { name: 'Help and guides' }).click()
    const help = page.getByRole('dialog', { name: 'Help and guides' })
    const guides = help.locator('[data-slot="accordion-trigger"]')
    const nGuides = await guides.count()
    expect(nGuides).toBeGreaterThan(0)
    for (let i = 0; i < nGuides; i++) {
      await guides.nth(i).click()
      await expect(guides.nth(i)).toHaveAttribute('aria-expanded', 'true')
      await expectNoStageWords(page, `${scenario} Help guide ${i + 1}`)
    }
    await page.keyboard.press('Escape')
    // The command palette lists every page and Settings page.
    await page.keyboard.press('ControlOrMeta+K')
    const palette = page.getByRole('dialog', { name: 'Search' })
    await expect(palette.getByRole('option', { name: /Data and access/ })).toBeVisible()
    await expectNoStageWords(page, `${scenario} the command palette`)
    await page.keyboard.press('Escape')
    // The demo switches offer scenarios only.
    await page.getByRole('button', { name: /^Demo switches/ }).click()
    const panel = page.getByRole('dialog', { name: 'Demo switches' })
    await expect(panel.getByText('Scenario', { exact: true })).toBeVisible()
    await expectNoStageWords(page, `${scenario} the demo switches`)
  })
}

test("every Today card's window, every chat and every tool page name no stage", async ({ fx, page }) => {
  test.setTimeout(180_000)
  await fx.seed({})
  await fx.open('#/today')
  const cards = page.getByRole('article')
  await expect(cards.first()).toBeVisible()
  const titles = await cards.evaluateAll(els => els.map(e => e.getAttribute('aria-label')!))
  expect(titles.length).toBeGreaterThan(3)
  for (const title of titles) {
    await page.getByRole('article', { name: title, exact: true }).getByRole('button', { name: title, exact: true }).click()
    const window = page.getByRole('dialog')
    await expect(window).toBeVisible()
    await expectNoStageWords(page, `the window of "${title}"`)
    await page.keyboard.press('Escape')
    await expect(window).toHaveCount(0)
  }
  await go(page, '#/chats/all')
  await expect(h1(page, 'All chats')).toBeVisible()
  const nChats = await page.locator('main [data-chat-open]').count()
  expect(nChats).toBeGreaterThan(5)
  for (let i = 0; i < nChats; i++) {
    await go(page, '#/chats/all')
    await expect(h1(page, 'All chats')).toBeVisible()
    const row = page.locator('main [data-chat-open]').nth(i)
    const name = await row.evaluate(b => b.querySelector('.ellipsis')!.textContent!)
    await row.click()
    await expect(page.getByRole('banner').getByText(name, { exact: true }), name).toBeVisible()
    await expect(page.getByRole('log', { name: 'Conversation' })).toBeVisible()
    await expectNoStageWords(page, `the chat "${name}"`)
  }
  await go(page, '#/tools')
  await expect(h1(page, 'Tools')).toBeVisible()
  const nTools = await page.locator('[data-tool-row]').count()
  expect(nTools).toBeGreaterThan(5)
  for (let i = 0; i < nTools; i++) {
    await go(page, '#/tools')
    await expect(h1(page, 'Tools')).toBeVisible()
    const row = page.locator('[data-tool-row]').nth(i)
    const name = await row.locator('span span').first().innerText()
    await row.click()
    await expect(h1(page, name)).toBeVisible()
    await expectNoStageWords(page, `the ${name} tool page`)
  }
})

test("every skill's page and every routine's panel: no stage, no Works from, no stage badge", async ({ fx, page }) => {
  test.setTimeout(120_000)
  await fx.seed({})
  await fx.open('#/skills')
  await expect(h1(page, 'Skills')).toBeVisible()
  const names = (await page.locator('main [data-skill-open]').allInnerTexts()).map(n => n.trim())
  expect(names.length).toBeGreaterThan(5)
  for (const [i, name] of names.entries()) {
    await go(page, '#/skills')
    await expect(h1(page, 'Skills')).toBeVisible()
    await page.locator('main [data-skill-open]').nth(i).click()
    await expect(h1(page, name)).toBeVisible()
    await expect(page.getByRole('main').getByText('Who can change it', { exact: true })).toBeVisible()
    await expect(page.getByRole('main').getByText('Works from', { exact: true })).toHaveCount(0)
    // The skill's own instructions have loaded, so the sweep reads them too: the demo's are its sample text.
    await expect(page.locator('article[aria-labelledby="skill-instructions"]')).toContainText('When to use')
    await expectNoStageWords(page, `the ${name} skill`)
  }
  await go(page, '#/routines')
  const routines = page.locator('[data-routine-open]')
  await expect(routines.first()).toBeVisible()
  const n = await routines.count()
  expect(n).toBeGreaterThan(3)
  for (let i = 0; i < n; i++) {
    const open = routines.nth(i)
    const name = (await open.innerText()).trim()
    await open.click()
    const panel = page.getByRole('dialog', { name })
    await expect(panel).toBeVisible()
    await expectNoStageWords(page, `the ${name} routine`)
    await page.keyboard.press('Escape')
    await expect(panel).toHaveCount(0)
  }
})
