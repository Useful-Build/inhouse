// PR 4 on a phone (390px): every answer shows its action row and every question its Copy and Edit, without hover.
import { expect, test } from '@playwright/test'

test('Phone conversation: every answer and question shows its actions', async ({ page }) => {
  await page.addInitScript(() => {
    if (sessionStorage.getItem('e2e-seeded')) return
    localStorage.clear()
    localStorage.setItem('inhouse.demo.switches.v1', JSON.stringify({ stage: 'Act', scenario: 'Normal', ambient: 'Always', animateMark: false }))
    sessionStorage.setItem('e2e-seeded', '1')
  })
  await page.goto('/?demo#/chats/refunds')
  const log = page.getByRole('log', { name: 'Conversation' })
  await expect(log.getByText('Refund requests rose').first()).toBeVisible()

  // One more answer, with the mode and time in its steps button (the widest row).
  const before = await log.getByRole('button', { name: 'More', exact: true }).count()
  await page.getByRole('textbox', { name: 'Message your Inhouse agent' }).fill('Which orders are stuck?')
  await page.locator('[data-composer]').getByRole('button', { name: 'Send' }).click()
  await expect(log.getByRole('button', { name: 'More', exact: true })).toHaveCount(before + 1, { timeout: 15_000 })
  await page.mouse.click(5, 300) // no hover or focus inside the thread

  const rowOpacity = (name: string) => log.getByRole('button', { name, exact: true }).evaluateAll(els => els.map(el => getComputedStyle(el.parentElement!).opacity))
  const answers = await rowOpacity('More')
  expect(answers.length).toBeGreaterThanOrEqual(2)
  expect(answers.every(o => o === '1')).toBe(true)
  const questions = await rowOpacity('Edit message')
  expect(questions.length).toBeGreaterThanOrEqual(2)
  expect(questions.every(o => o === '1')).toBe(true)

  // The row fits the screen: nothing in it is cut off at the right edge.
  const overflow = await log.getByRole('button', { name: 'More', exact: true }).evaluateAll(els => els.map(el => el.parentElement!.getBoundingClientRect().right))
  expect(Math.max(...overflow)).toBeLessThanOrEqual(390)
  await page.screenshot({ path: test.info().outputPath('phone-actions.png'), fullPage: false })
})
