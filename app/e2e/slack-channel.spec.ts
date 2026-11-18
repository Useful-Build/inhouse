// Slack's own page: Tools → Slack opens #/tools/slack, with Back to Tools; before Act it says it's included from Act.
import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'

async function start(page: Page, hash: string, stage = 'Act') {
  await page.addInitScript(s => {
    if (sessionStorage.getItem('e2e-seeded')) return
    localStorage.clear()
    localStorage.setItem('inhouse.demo.switches.v1', JSON.stringify({ stage: s, scenario: 'Normal', ambient: 'Always', animateMark: false }))
    sessionStorage.setItem('e2e-seeded', '1')
  }, stage)
  await page.goto('/?demo' + hash)
}
const shot = async (page: Page, name: string) => { await page.waitForTimeout(300); await page.screenshot({ path: test.info().outputPath(`${name}.png`) }) }

test('Slack row opens its page with the channel details, no tool abilities, and Back returns to Tools', async ({ page }) => {
  await start(page, '#/tools')
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

  await page.getByRole('button', { name: 'Notification settings' }).click()
  await expect(page).toHaveURL(/#\/settings\/you-notif$/)
  await page.goBack()
  await expect(page).toHaveURL(/#\/tools\/slack$/)

  await page.locator('main').getByRole('button', { name: 'Tools', exact: true }).click()
  await expect(page).toHaveURL(/#\/tools$/)
  await expect(page.locator('[data-channel-row]')).toBeVisible()
})

test('Before Act the Slack page says it is included from Act', async ({ page }) => {
  await start(page, '#/tools', 'Watch')
  await expect(page.locator('[data-channel-row]')).toContainText('Included from Act')
  await page.locator('[data-channel-row]').click()
  await expect(page).toHaveURL(/#\/tools\/slack$/)
  await expect(page.getByRole('heading', { level: 1, name: 'Slack' })).toBeVisible()
  await expect(page.getByText('Included from Act').first()).toBeVisible()
  await expect(page.getByText('Connected · Nov 2')).toHaveCount(0)
  await expect(page.locator('main dl').getByText('Website', { exact: true })).toBeVisible()
  await expect(page.getByText('Channel', { exact: true })).toHaveCount(0)
  await expect(page.getByText('What it sends')).toHaveCount(0)
  await shot(page, 'slack-watch')
})
