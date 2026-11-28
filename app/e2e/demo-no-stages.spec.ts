// The demo has no stages (decision A13, option B), as the product (e2e/real/no-stages.spec.ts). Ways it can fail, written
// first:
//  1. a page, a Settings page, the command palette, the demo switches, a skill's page or a routine's panel shows a stage
//     word ("Watch", "Act", "Run", "stage") or a stage tag (a lock whose screen reader text says "included in a later
//     stage"), in any scenario's words;
//  2. a skill's page still says which stage it works from, or wears a stage badge;
//  3. the demo switches still offer a Stage.
// Every word on the page counts, hidden ones too (a tag's screen reader text, a closed drawer); the audit log is history
// and isn't walked, as in the product's spec.
import type { Page } from '@playwright/test'
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

/** Each page with what proves it has drawn (not the page before it). */
const PAGES: [hash: string, ready: (p: Page) => ReturnType<Page['getByRole']>][] = [
  ['#/today', p => p.getByRole('heading', { level: 1 }).filter({ hasText: /Good morning|Welcome/ })],
  ['#/approvals', p => p.getByRole('heading', { level: 1, name: 'Approvals', exact: true })],
  ['#/activity', p => p.getByRole('heading', { level: 1, name: 'Activity', exact: true })],
  ['#/library', p => p.getByRole('heading', { level: 1, name: 'All files', exact: true })],
  ['#/routines', p => p.getByRole('heading', { level: 1, name: 'Routines', exact: true })],
  ['#/skills', p => p.getByRole('heading', { level: 1, name: 'Skills', exact: true })],
  ['#/tools', p => p.getByRole('heading', { level: 1, name: 'Tools', exact: true })],
  ['#/tools/shopify', p => p.getByRole('heading', { level: 1, name: 'Shopify', exact: true })],
  ['#/tools/amazon', p => p.getByRole('heading', { level: 1, name: 'Amazon', exact: true })],
  ['#/tools/slack', p => p.getByRole('heading', { level: 1, name: 'Slack', exact: true })],
  ['#/usage', p => p.getByRole('heading', { level: 1, name: 'Usage', exact: true })],
  ['#/chats/all', p => p.getByRole('heading', { level: 1, name: 'All chats', exact: true })],
  // On the first day there are no chats, so a chat's link opens a new one.
  ['#/chats/stuck', p => p.getByRole('banner').getByText(/^(Stuck orders over 3 days|New chat)$/)],
  ['#/chats/order-tags', p => p.getByRole('banner').getByText(/^(Wholesale and gift tags|New chat)$/)],
]
const SETTINGS: [tab: string, heading: string][] = [
  ['you-general', 'General'], ['you-memory', 'Memory'], ['you-permissions', 'Always allowed'], ['team-agent', 'Inhouse agent'],
  ['team-modes', 'Models'], ['team-memory', 'Team memory'], ['team-spend', 'Spending cap'], ['team-members', 'Members'],
  ['team-slack', 'Slack notices'], ['team-data', 'Data and access'],
]
const SKILLS = ['Morning check', 'Answers with sources', 'Payout check', 'Reorder drafting', 'Supplier chase', 'Stuck order nudge',
  'Customer reply drafts', 'Returns restock', 'Oversell guard']

for (const scenario of ['Normal', 'First day', 'Cap reached'] as const) {
  test(`${scenario}: no page, Settings page, palette or demo switch names a stage`, async ({ fx, page }) => {
    await fx.seed({ scenario })
    await fx.open('#/today')
    await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible()
    for (const [hash, ready] of PAGES) {
      await go(page, hash)
      await expect(ready(page).first(), hash).toBeVisible()
      await expectNoStageWords(page, `${scenario} ${hash}`)
    }
    for (const [tab, heading] of SETTINGS) {
      await go(page, `#/settings/${tab}`)
      await expect(page.getByRole('heading', { level: 1, name: heading, exact: true }), tab).toBeVisible()
      await expectNoStageWords(page, `${scenario} ${tab}`)
    }
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

test("every skill's page and every routine's panel: no stage, no Works from, no stage badge", async ({ fx, page }) => {
  await fx.seed({})
  await fx.open('#/skills')
  for (const name of SKILLS) {
    await go(page, '#/skills')
    await page.getByRole('main').getByRole('button', { name, exact: true }).click()
    await expect(page.getByRole('heading', { level: 1, name, exact: true })).toBeVisible()
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
