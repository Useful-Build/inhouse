// PR 4 on a phone (390px): every answer shows its action row and every question its Copy and Edit, without hover.
import { expect, test } from './support/fx.js'

test('Phone conversation: every answer and question shows its actions', async ({ page, fx }) => {
  await fx.seed({ demo: { ambient: 'Always' } })
  await page.goto('/?demo#/chats/refunds')
  const log = page.getByRole('log', { name: 'Conversation' })
  await expect(log.getByText('Refund requests rose').first()).toBeVisible()

  // One more answer. Its steps line sits above its card, so the action row is Copy and More.
  const before = await log.getByRole('button', { name: 'More', exact: true }).count()
  await page.getByRole('textbox', { name: 'Message Inhouse' }).fill('Which orders are stuck?')
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
