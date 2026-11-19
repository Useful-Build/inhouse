// Slack's page at 390 px: the row opens it and nothing is cut or scrolls sideways.
import { expect, test } from '@playwright/test'
import { settled } from './settled.js'

test('Phone: the Slack row opens its page and nothing is cut', async ({ page }) => {
  await page.addInitScript(() => {
    if (sessionStorage.getItem('e2e-seeded')) return
    localStorage.clear()
    localStorage.setItem('inhouse.demo.switches.v1', JSON.stringify({ stage: 'Act', scenario: 'Normal', ambient: 'Always', animateMark: false }))
    sessionStorage.setItem('e2e-seeded', '1')
  })
  await page.goto('/?demo#/tools')
  await page.locator('[data-channel-row]').click()
  await expect(page).toHaveURL(/#\/tools\/slack$/)
  await expect(page.getByRole('heading', { level: 1, name: 'Slack' })).toBeVisible()
  await expect(page.getByText('Approvals waiting for you', { exact: true })).toBeVisible()
  expect(await page.evaluate(() => [document.documentElement, document.querySelector('main')!].every(e => e.scrollWidth - e.clientWidth <= 1))).toBe(true)
  await settled(page)
  await page.screenshot({ path: test.info().outputPath('390-slack.png') })
})
