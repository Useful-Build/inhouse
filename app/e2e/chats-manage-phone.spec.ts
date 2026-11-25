// PR 3, managing chats on a phone (390 px): the row menu shows without hover in the drawer, and Rename works there.
import { expect, test } from './support/fx.js'

test('Phone: the chat row menu opens from the drawer and renames in place; Escape cancels without closing the drawer', async ({ page, fx }) => {
  await fx.seed({ stage: 'Act', demo: { ambient: 'Always' } })
  await page.goto('/?demo#/chats/refunds')
  const side = page.getByRole('complementary', { name: 'Sidebar' })
  await page.getByRole('button', { name: 'Menu' }).click()
  const row = side.locator('[data-chat-row]').filter({ has: page.getByRole('button', { name: 'Why did refunds jump?', exact: true }) })
  const trigger = row.getByRole('button', { name: 'Chat actions' })
  // No hover on a phone: the trigger is there from the start.
  await expect(trigger).toBeVisible()
  await page.screenshot({ path: test.info().outputPath('phone-chat-row-menu-trigger.png') })
  await trigger.click()
  const menu = page.getByRole('menu', { name: 'Chat actions' })
  await expect(menu).toBeVisible()
  const box = await menu.boundingBox()
  expect(box && box.x >= 0 && box.x + box.width <= 390, 'menu fits 390 px').toBe(true)
  await page.screenshot({ path: test.info().outputPath('phone-chat-row-menu.png') })

  // Escape cancels a rename and leaves the drawer open.
  await menu.getByRole('menuitem', { name: 'Rename' }).click()
  const field = side.getByRole('textbox', { name: 'Chat title' })
  await expect(field).toBeFocused()
  await field.fill('Not this one')
  await page.keyboard.press('Escape')
  await expect(side).toBeVisible()
  await expect(side.getByRole('button', { name: 'Why did refunds jump?', exact: true })).toBeVisible()

  await trigger.click()
  await page.getByRole('menuitem', { name: 'Rename' }).click()
  await field.fill('Refunds after the price change')
  await page.screenshot({ path: test.info().outputPath('phone-chat-rename.png') })
  await page.keyboard.press('Enter')
  await expect(side.getByRole('button', { name: 'Refunds after the price change', exact: true })).toBeVisible()
  await expect(side.getByRole('button', { name: 'Why did refunds jump?', exact: true })).toHaveCount(0)

  // The open chat's top bar follows once the drawer closes.
  await side.getByRole('button', { name: 'Refunds after the price change', exact: true }).click()
  await expect(side).toHaveCount(0)
  await expect(page.getByRole('banner')).toContainText('Refunds after the price change')
  await page.screenshot({ path: test.info().outputPath('phone-chat-renamed.png') })

  // On a phone the top bar's title opens the chat's menu (no "···" there, so the title keeps its room), Export included.
  await page.getByRole('banner').getByRole('button', { name: 'Refunds after the price change' }).click()
  const barMenu = page.getByRole('menu', { name: 'Chat actions' })
  const names = ['Rename', 'Pin', 'Copy link', 'Export', 'Delete']
  await expect(barMenu.getByRole('menuitem')).toHaveCount(names.length)
  for (const [i, n] of names.entries()) await expect(barMenu.getByRole('menuitem').nth(i)).toHaveAccessibleName(n)
  const barBox = await barMenu.boundingBox()
  expect(barBox && barBox.x >= 0 && barBox.x + barBox.width <= 390, 'top bar menu fits 390 px').toBe(true)
  await page.evaluate(() => Promise.all(document.getAnimations().filter(a => a.timeline instanceof DocumentTimeline && a.effect?.getTiming().iterations !== Infinity).map(a => a.finished)))
  await page.screenshot({ path: test.info().outputPath('phone-chat-title-menu.png') })
  await page.keyboard.press('Escape')
  await expect(barMenu).toHaveCount(0)

  // The title button says what it opens, and Escape in the top bar's rename field puts focus back on it.
  const title = page.getByRole('banner').getByRole('button', { name: 'Chat actions, Refunds after the price change' })
  const titleBox = await title.boundingBox()
  expect(titleBox && titleBox.height >= 44, 'title button is 44 px tall').toBe(true)
  await title.click()
  await page.getByRole('menuitem', { name: 'Rename' }).click()
  const barField = page.getByRole('banner').getByRole('textbox', { name: 'Chat title' })
  await expect(barField).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(title).toBeFocused()
})
