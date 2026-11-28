// Slack's own page: Tools → Slack opens #/tools/slack, with Back to Tools. The demo has no stages (decision A13), so no
// "included from Act" page any more, and no Notifications settings page to link to.
import { expect, test, type Fx } from './support/fx.js'
import type { Page } from '@playwright/test'
import { atRest } from './states.js'

async function start(page: Page, fx: Fx, hash: string) {
  await fx.seed({ demo: { ambient: 'Always' } })
  await page.goto('/?demo' + hash)
}
const shot = async (page: Page, name: string) => { await atRest(page); await page.screenshot({ path: test.info().outputPath(`${name}.png`) }) }

test('Slack row opens its page with the channel details, no tool abilities, and Back returns to Tools', async ({ fx, page }) => {
  await start(page, fx, '#/tools')
  await page.locator('[data-channel-row]').click()
  await expect(page).toHaveURL(/#\/tools\/slack$/)
  await expect(page.getByRole('heading', { level: 1, name: 'Slack' })).toBeVisible()
  await expect(page.getByText('Connected · Nov 2')).toBeVisible()
  const details = page.locator('main dl')
  await expect(details.locator('div', { has: page.getByText('Channel', { exact: true }) }).locator('dd')).toHaveText('#ops')
  await expect(details.getByText('What it sends', { exact: true })).toBeVisible()
  await expect(details.locator('dd ul li').first()).toBeVisible()
  await expect(page.getByText('Who can ask')).toHaveCount(0)
  await expect(page.locator('[data-ability]')).toHaveCount(0)
  await expect(page.getByText(/^Read$|^Draft$/)).toHaveCount(0)
  await shot(page, 'slack-act')

  await expect(page.getByRole('button', { name: 'Notification settings' })).toHaveCount(0)

  await page.locator('main').getByRole('button', { name: 'Tools', exact: true }).click()
  await expect(page).toHaveURL(/#\/tools$/)
  await expect(page.locator('[data-channel-row]')).toBeVisible()
})
