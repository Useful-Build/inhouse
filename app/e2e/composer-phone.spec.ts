// PR 4, the composer on a phone (390 px): it sits above the home bar's safe area, and opening a chat doesn't focus
// it (no keyboard popping up on navigation).
import { expect, fxFor, test } from './support/fx.js'

test('Phone: the chat composer stays above the safe area, and opening a chat leaves it unfocused', async ({ page }) => {
  await page.clock.install() // time keeps flowing; runFor adds app time on top, so no real sleep
  await fxFor(page, undefined).seed({ stage: 'Act', demo: { ambient: 'Always' } })
  await page.goto('/?demo#/chats/refunds')
  const field = page.getByRole('textbox', { name: 'Message your Inhouse agent' })
  const composer = page.locator('[data-composer]')
  await expect(field).toBeVisible()
  await page.clock.runFor(300) // covers timer-based focus only (a setTimeout), not a focus after a real network or frame wait
  await expect(field).not.toBeFocused()

  // Opening another chat from the drawer doesn't focus it either.
  const side = page.getByRole('complementary', { name: 'Sidebar' })
  await page.getByRole('button', { name: 'Menu' }).click()
  await side.getByRole('button', { name: 'Stuck orders over 3 days', exact: true }).click()
  await expect(side).toHaveCount(0)
  await expect(page.getByRole('banner')).toContainText('Stuck orders over 3 days')
  await page.clock.runFor(300)
  await expect(field).not.toBeFocused()

  // Headless Chromium has no home bar (the inset is 0), so give the safe-area token a phone's 34 px:
  // the composer moves up by exactly that and stays fully on screen.
  const bottomGap = () => composer.evaluate(el => innerHeight - el.getBoundingClientRect().bottom)
  const before = await bottomGap()
  expect(before).toBeGreaterThanOrEqual(0)
  await page.addStyleTag({ content: ':root { --app-safe-bottom: 34px; }' })
  await expect.poll(bottomGap).toBe(before + 34)
  const box = await composer.boundingBox()
  expect(box && box.x >= 0 && box.x + box.width <= 390 && box.y + box.height <= 844 - 34, 'composer fits above the safe area').toBe(true)
  await page.screenshot({ path: test.info().outputPath('phone-composer-safe-area.png') })

  // A tap still focuses it, and a multi-line draft grows it upward without leaving the screen.
  await field.click()
  await expect(field).toBeFocused()
  await field.fill('Which orders are stuck?\nOnly ShipBob\nOldest first')
  expect(await bottomGap()).toBe(before + 34)
  await page.screenshot({ path: test.info().outputPath('phone-composer-multiline.png') })

  // A phone has no Shift+Enter: Enter makes a new line (the keyboard says "enter"), and only Send sends.
  await expect(field).toHaveAttribute('enterkeyhint', 'enter')
  await field.fill('Which orders are late?')
  await field.press('Enter')
  await field.pressSequentially('Oldest first')
  await expect(field).toHaveValue('Which orders are late?\nOldest first')
  const log = page.getByRole('log', { name: 'Conversation' })
  await expect(log.locator('[data-chat-msg]').filter({ hasText: 'Which orders are late?' })).toHaveCount(0)
  await composer.getByRole('button', { name: 'Send' }).click()
  await expect(log.locator('[data-chat-msg]').filter({ hasText: 'Which orders are late?' })).toBeVisible()
  await expect(field).toHaveValue('')

  // A rejected file's Dismiss button is 28px with a 44px tap area around it.
  await field.evaluate(el => {
    const dt = new DataTransfer()
    dt.items.add(new File([new Uint8Array(21_000_000)], 'walkthrough.mov', { type: 'video/quicktime' }))
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
  })
  const dismiss = composer.getByRole('button', { name: 'Dismiss walkthrough.mov' })
  await expect(dismiss).toBeVisible()
  const dbox = (await dismiss.boundingBox())!
  expect([dbox.width, dbox.height]).toEqual([28, 28])
  const tap = await dismiss.evaluate(el => { const a = getComputedStyle(el, '::after'); return [parseFloat(a.width), parseFloat(a.height)] })
  expect(tap).toEqual([44, 44])
})
