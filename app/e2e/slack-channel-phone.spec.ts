// Slack's page at 390 px: the row opens it and nothing is cut or scrolls sideways.
import { expect, test } from './support/fx.js'
import { atRest } from './states.js'

test('Phone: the Slack row opens its page and nothing is cut', async ({ page, fx }) => {
  await fx.seed({ demo: { ambient: 'Always' } })
  await page.goto('/?demo#/tools')
  await page.locator('[data-channel-row]').click()
  await expect(page).toHaveURL(/#\/tools\/slack$/)
  await expect(page.getByRole('heading', { level: 1, name: 'Slack' })).toBeVisible()
  await expect(page.getByText('Approvals waiting for you', { exact: true })).toBeVisible()
  expect(await page.evaluate(() => [document.documentElement, document.querySelector('main')!].every(e => e.scrollWidth - e.clientWidth <= 1))).toBe(true)
  await atRest(page)
  await page.screenshot({ path: test.info().outputPath('390-slack.png') })
})
