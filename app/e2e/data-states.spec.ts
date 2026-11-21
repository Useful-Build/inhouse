// PR 3, data states and what flows from them (H10, M16, M17, M39, D6): First day and Loading open every page at Watch,
// Act and Run without a crash, a console error or another state's data; pausing and disconnecting a tool change the
// Tools count, the tool page and the composer alike; a $50 cap shows the banner without changing what was spent; Slack
// is a connected channel from Act. Screenshots of each state go to the report.
import { expect, fxFor, test, type Stage } from './support/fx.js'
import type { Page } from '@playwright/test'

async function start(page: Page, stage: Stage, scenario: string, hash: string) {
  await fxFor(page, undefined).seed({ stage, scenario })
  await page.goto('/?demo' + hash)
}

// A toast that leaves mid-shot cancels its animation: cancelled counts as settled.
const settled = (page: Page) => page.evaluate(() => Promise.all(document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => undefined))))
const shot = async (page: Page, name: string) => { await settled(page); await page.screenshot({ path: test.info().outputPath(`${name}.png`) }) }
const side = (page: Page) => page.getByRole('complementary', { name: 'Sidebar' })
const go = (page: Page, h: string) => page.evaluate(x => { location.hash = x }, h)
/** Collects every console error and uncaught exception from now on. */
function errorsOf(page: Page): string[] {
  const out: string[] = []
  page.on('console', m => { if (m.type() === 'error') out.push(m.text()) })
  page.on('pageerror', e => out.push(e.message))
  return out
}

const PAGES = ['#/today', '#/library', '#/chats', '#/chats/all', '#/approvals', '#/routines', '#/activity', '#/tools', '#/tools/shopify', '#/skills', '#/usage',
  '#/settings/you-general', '#/settings/team-spend', '#/settings/team-audit', '#/settings/team-memory']

for (const scenario of ['First day', 'Loading']) {
  for (const stage of ['Watch', 'Act', 'Run'] as const) {
    test(`${scenario} at ${stage}: every page opens without a crash, a console error or another state's data`, async ({ page }) => {
      const errors = errorsOf(page)
      await start(page, stage, scenario, '#/today')
      await expect(page.getByRole('button', { name: `Demo switches: ${stage}, ${scenario}` })).toBeVisible()
      for (const hash of PAGES) {
        await go(page, hash)
        await expect(page.locator('main')).toBeVisible()
        await expect(page.getByText('Something went wrong.'), hash).toHaveCount(0)
        // Nothing found, asked or spent yet: no chats in the sidebar, no files, no money spent.
        await expect(side(page).locator('[data-chat-row]'), hash).toHaveCount(0)
        if (hash === '#/library') await expect(page.locator('[data-file-id]')).toHaveCount(0)
        if (hash === '#/usage') await expect(page.locator('main')).toContainText('$0.00')
        if (hash === '#/chats') await expect(page.getByRole('heading', { name: 'What do you want to know?' })).toBeVisible()
        if (hash === '#/chats/all') await expect(page.getByText('No chats yet', { exact: true })).toBeVisible()
        if (hash === '#/activity') await expect(page.locator('button[data-activity-row]')).toHaveCount(0)
      }
      await go(page, '#/today')
      if (scenario === 'First day') await expect(page.getByText('0 of 6 tools connected')).toBeVisible()
      else await expect(page.getByText('4 of 6 done')).toBeVisible()
      await shot(page, `${scenario === 'First day' ? 'first-day' : 'loading'}-${stage.toLowerCase()}-today`)
      expect(errors, errors.join('\n')).toEqual([])
    })
  }
}

const toolsCount = (page: Page) => page.getByRole('heading', { name: /^Connected/ })
const toolRow = (page: Page, name: string) => page.locator('[data-tool-row]').filter({ hasText: name })
const ability = (page: Page, key: 'read' | 'draft' | 'run') => page.locator(`[data-ability="${key}"]`)
const composerTools = (page: Page) => page.getByRole('button', { name: /^Tools read in this chat:/ })

test('Tools: pausing a tool and a disconnected tool change the count, the tool page and the composer alike', async ({ page }) => {
  await start(page, 'Act', 'Normal', '#/tools/shopify')
  await page.getByRole('button', { name: 'Pause access' }).click()
  // The tool page: paused, Read and Draft say so, no suggested questions.
  await expect(page.locator('main')).toContainText('Access paused')
  await expect(ability(page, 'read')).toContainText('Paused')
  await expect(ability(page, 'draft')).toContainText('Paused')
  await expect(page.locator('[data-tool-example]')).toHaveCount(0)
  await shot(page, 'tool-paused-page')
  // Tools: five of six read now, Shopify's row says paused.
  await go(page, '#/tools')
  await expect(toolsCount(page)).toContainText('5 of 6')
  await expect(toolRow(page, 'Shopify')).toContainText('Access paused')
  // The composer: Shopify isn't among the tools read, and the count agrees.
  await side(page).getByRole('button', { name: 'New chat' }).click()
  await expect(composerTools(page)).toHaveAccessibleName(/5 of 6 tools connected$/)
  await expect(composerTools(page)).not.toHaveAccessibleName(/Shopify/)
  await expect(page.locator('main')).not.toContainText('Your Inhouse agent reads Shopify')
  await shot(page, 'tool-paused-composer')
})

test('Tools: a disconnected tool reads as off on its page, in the count and in the composer', async ({ page }) => {
  await start(page, 'Act', 'Tool disconnected', '#/tools/gorgias')
  await expect(page.locator('main')).toContainText('Disconnected · login expired at 5:41 AM')
  await expect(ability(page, 'read')).toContainText('Off')
  await expect(ability(page, 'draft')).toContainText('Off')
  await expect(page.locator('main')).not.toContainText('Today, 6:00 AM')
  await expect(page.locator('[data-tool-example]')).toHaveCount(0)
  await shot(page, 'tool-disconnected-page')
  await go(page, '#/tools')
  await expect(toolsCount(page)).toContainText('5 of 6')
  await expect(toolRow(page, 'Gorgias')).toContainText('Needs reconnecting')
  await go(page, '#/chats/new')
  await expect(composerTools(page)).toHaveAccessibleName(/5 of 6 tools connected$/)
  await expect(composerTools(page)).not.toHaveAccessibleName(/Gorgias/)
})

test('First day: a tool being connected shows when it connects, as Today says, never an old connect date', async ({ page }) => {
  await start(page, 'Act', 'First day', '#/today')
  // Today's setup list is the source: Shopify today, Amazon and ShipBob tomorrow, the rest this week.
  await expect(page.locator('main')).toContainText('Connecting today')
  await go(page, '#/tools')
  await expect(toolRow(page, 'Shopify')).toContainText('Connecting today')
  await expect(toolRow(page, 'Amazon')).toContainText('Tomorrow')
  await expect(toolRow(page, 'Meta Ads')).toContainText('This week')
  await expect(page.locator('main')).not.toContainText(/\bNov (2|9|11|12|13)\b/)
  await shot(page, 'first-day-tools')
  await go(page, '#/tools/shopify')
  await expect(page.locator('main')).toContainText('Being connected')
  await expect(page.locator('main dt', { hasText: /^Connected$/ }).locator('xpath=..')).toContainText('Not yet')
  await expect(page.locator('main')).not.toContainText(/\bNov 2\b/)
  await shot(page, 'first-day-tool-page')
  // No chats yet: no Recent chats heading over an empty list.
  await expect(side(page).getByText('Recent chats')).toHaveCount(0)
  await expect(side(page).getByRole('button', { name: 'See all' })).toHaveCount(0)
})

test('A $50 cap shows the cap banner and never changes what was spent', async ({ page }) => {
  await start(page, 'Act', 'Normal', '#/usage')
  await expect(page.locator('main')).toContainText('$78.40')
  await expect(page.getByText('Spending cap reached.')).toHaveCount(0)
  await go(page, '#/settings/team-spend')
  const cap = page.getByRole('textbox', { name: 'Monthly cap' })
  await cap.fill('$50')
  await cap.press('Enter')
  await expect(cap).toHaveValue('$50')
  await go(page, '#/today')
  await expect(page.getByRole('alert')).toContainText('Spending cap reached.')
  await expect(page.getByRole('alert')).toContainText('$78.40 of $50')
  await go(page, '#/usage')
  // Spend, the cost per conversation and the peak day are what was spent; only "reached" moves with the cap.
  await expect(page.locator('main')).toContainText('$78.40 of $50')
  await expect(page.locator('main')).toContainText('Cap reached')
  await expect(page.locator('main')).toContainText('$0.19')
  await shot(page, 'cap-50-usage')
})

test('Slack is a connected channel at Act, and included from Act at Watch', async ({ page }) => {
  await start(page, 'Act', 'Normal', '#/tools')
  const slack = page.locator('[data-channel-row]').filter({ hasText: 'Slack' })
  await expect(slack).toContainText('Connected Nov 2')
  // A channel, not a tool the agent reads, and not in Add a tool either.
  await expect(page.locator('[data-tool-row]').filter({ hasText: 'Slack' })).toHaveCount(0)
  await expect(page.locator('main').getByText('Slack', { exact: true })).toHaveCount(1)
  await shot(page, 'slack-act')
  await page.getByRole('button', { name: /^Demo switches:/ }).click()
  await page.getByRole('radiogroup', { name: 'Stage' }).getByRole('radio', { name: 'Watch' }).click()
  await page.getByRole('button', { name: 'Close demo switches' }).click()
  await expect(slack).toContainText('Included from Act')
  await shot(page, 'slack-watch')
})
