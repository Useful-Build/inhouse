// UI chrome takes the brand's name and channel from the agent's data, never from the demo. A brand that isn't Northline and
// has no chat channel: the sidebar, a Library preview, and the Skills, Usage and Settings pages never say Northline, and no
// page of a short tour says Slack. What the agent wrote (draft bodies, sign-offs, emails) is its data and may name anyone.
// The mock reads the override from localStorage `inhouse.demo.data.v1` (see DATA_OVERRIDE_KEY in src/agent/mock.ts).
import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'

const BRAND = 'Fernwood Supply'

async function start(page: Page, stage: string, hash: string, scenario = 'Normal') {
  await page.addInitScript(([s, brand, sc]) => {
    if (sessionStorage.getItem('e2e-seeded')) return
    localStorage.clear()
    localStorage.setItem('inhouse.demo.switches.v1', JSON.stringify({ stage: s, scenario: sc, ambient: 'Off', animateMark: false }))
    localStorage.setItem('inhouse.demo.data.v1', JSON.stringify({ brandName: brand, channels: false }))
    sessionStorage.setItem('e2e-seeded', '1')
  }, [stage, BRAND, scenario])
  await page.goto('/?demo' + hash)
}
const go = (page: Page, h: string) => page.evaluate(x => { location.hash = x }, h)
const side = (page: Page) => page.getByRole('complementary', { name: 'Sidebar' })

test('another brand without a channel: its name shows in the chrome, and no page says Slack', async ({ page }) => {
  await start(page, 'Run', '#/library')
  await expect(side(page)).toContainText(BRAND)
  await expect(side(page)).not.toContainText('Northline')
  // A document's first page (the thumbnail) carries the brand's name.
  const card = page.locator('[data-file-id]').filter({ hasText: 'Purchase order' }).first()
  await expect(card).toContainText(`${BRAND} · Purchase order`)
  await page.screenshot({ path: test.info().outputPath('library-brand.png') })

  const tour = ['#/today', '#/approvals', '#/tools', '#/skills', '#/usage', '#/settings/you-notif', '#/settings/team-limits', '#/settings/team-data']
  for (const hash of tour) {
    await go(page, hash)
    await expect(page.locator('main')).toBeVisible()
    await expect(page.getByText('Something went wrong.'), hash).toHaveCount(0)
    await expect(page.locator('main'), hash).not.toContainText('Slack')
    // Today and Approvals hold drafts the agent wrote, so only the chrome pages are checked for the sample brand's name.
    if (!['#/today', '#/approvals'].includes(hash)) await expect(page.locator('main'), hash).not.toContainText('Northline')
    await expect(side(page), hash).not.toContainText('Northline')
  }

  // Settings: alerts go to email or the app, and there is no channel toggle.
  await go(page, '#/settings/you-notif')
  await expect(page.getByRole('combobox', { name: 'Send alerts to: Email' })).toBeVisible()
  await page.screenshot({ path: test.info().outputPath('settings-notif-no-channel.png') })
  // Usage: rows name chats alone.
  await go(page, '#/usage')
  await page.getByRole('radiogroup', { name: 'Break down by' }).getByRole('radio', { name: 'Job', exact: true }).click()
  const answering = page.locator('[data-usage-row]').filter({ hasText: 'Answering questions' })
  await expect(answering).toContainText('Chats')
  await expect(answering).not.toContainText('Chats and')
})

test('a chat answer\'s menu has no send-to-channel item without a channel', async ({ page }) => {
  await start(page, 'Run', '#/chats/refunds')
  const answer = page.locator('[data-chat-msg]').filter({ has: page.getByRole('button', { name: 'More', exact: true }) }).first()
  await answer.getByRole('button', { name: 'More', exact: true }).click()
  const menu = page.getByRole('menu', { name: 'Message actions' })
  const names = ['Report a wrong answer', 'Delete']
  await expect(menu.getByRole('menuitem')).toHaveCount(names.length)
  for (const [i, n] of names.entries()) await expect(menu.getByRole('menuitem').nth(i)).toHaveAccessibleName(n)
  await expect(menu).not.toContainText('Slack')
  await page.keyboard.press('Escape')
})

test('Today on the first day names no sample brand', async ({ page }) => {
  await start(page, 'Watch', '#/today', 'First day')
  const line = page.getByText('Today fills in the day after')
  await expect(line).toBeVisible()
  await expect(line).not.toContainText('Northline')
  // The line names the tool the page's own setup list says is next: the first row that isn't connected.
  const first = (await page.locator('[data-setup-row]').first().locator('span.font-medium').innerText()).trim()
  await expect(line).toContainText(`after ${first} is connected`)
})

test('Approvals at Watch names no channel', async ({ page }) => {
  await start(page, 'Watch', '#/approvals')
  const block = page.locator('[data-watch-block]')
  await expect(block).toContainText('someone approves it, here.')
  await expect(block).not.toContainText('Slack')
  await page.screenshot({ path: test.info().outputPath('approvals-watch-no-channel.png') })
})

test('the sample brand still shows its own name and channel', async ({ page }) => {
  await page.addInitScript(() => {
    if (sessionStorage.getItem('e2e-seeded')) return
    localStorage.clear()
    localStorage.setItem('inhouse.demo.switches.v1', JSON.stringify({ stage: 'Act', scenario: 'Normal', ambient: 'Off', animateMark: false }))
    sessionStorage.setItem('e2e-seeded', '1')
  })
  await page.goto('/?demo#/approvals')
  await expect(side(page)).toContainText('Northline Outdoor')
  await go(page, '#/settings/you-notif')
  await expect(page.getByRole('combobox', { name: 'Send alerts to: Slack' })).toBeVisible()
})
