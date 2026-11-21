// PR 4, the conversation: auto-scroll only near the bottom with Jump to latest, Copy and Edit on your own messages,
// Regenerate and thumbs on answers, the mode and time in the steps button, the steps link on an error turn, and
// markdown answers (a code block with Copy, a wide table that scrolls inside its wrapper).
import { expect, fxFor, test } from './support/fx.js'
import type { Locator, Page } from '@playwright/test'

async function start(page: Page, scenario: string, hash: string) {
  await fxFor(page, undefined).seed({ stage: 'Act', scenario, demo: { ambient: 'Always' } })
  await page.goto('/?demo' + hash)
}

const settled = (page: Page) => page.evaluate(() => Promise.all(document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished)))
const shot = async (page: Page, name: string) => { await settled(page); await page.screenshot({ path: test.info().outputPath(`${name}.png`) }) }
// The sample agent's chat channel (tools.json).
const CHANNEL = 'Slack'
const main = (page: Page) => page.locator('main')
const log = (page: Page) => page.getByRole('log', { name: 'Conversation' })
const msg = (page: Page, text: string) => log(page).locator('[data-chat-msg]').filter({ hasText: text })
const stepsButtons = (page: Page) => log(page).getByRole('button', { name: /\d+ steps/ })
const composer = (page: Page) => page.getByRole('textbox', { name: 'Message your Inhouse agent' })
/** The thread's scroll position: top, and distance from the bottom. */
const scrollState = (page: Page) => page.evaluate(() => {
  const el = document.querySelector('[role="log"]')!.closest('.overflow-auto')!
  return { top: el.scrollTop, fromBottom: el.scrollHeight - el.scrollTop - el.clientHeight, room: el.scrollHeight - el.clientHeight }
})

/** The app keeps the view at the bottom within 80px of it. */
const NEAR_BOTTOM_PX = 80
const MD_Q = "Give me the query for last week's orders by SKU"
const REFUNDS_Q = 'Why did refunds jump?'
const REFUNDS_A = 'Refund requests rose from 14 last week to 31 this week'

test('Conversation: markdown, scroll-up while streaming, Jump to latest, Copy, Edit, Regenerate, thumbs and the mode and time', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await start(page, 'Normal', '#/today')

  // A question from Today starts a chat; the markdown answer has a code block and a wide table.
  await page.getByRole('textbox', { name: 'Ask your Inhouse agent' }).fill(MD_Q)
  await page.keyboard.press('Enter')
  const code = log(page).locator('[data-md-code]')
  await expect(code).toBeVisible({ timeout: 15_000 })
  await expect(code).toContainText('GROUP BY sku, product')
  await expect(log(page).locator('strong', { hasText: 'Shopify' })).toBeVisible()
  await expect(log(page).locator('ul > li')).toHaveCount(2)
  await expect(log(page).locator('ol > li')).toHaveCount(2)
  await expect(log(page).locator('blockquote')).toContainText("Amazon orders aren't in this query")
  await expect(log(page).getByRole('link', { name: 'Shopify' })).toHaveAttribute('href', '#/tools/shopify')
  // A heading is a heading, not "###" text, and it sits below the page's structure (### is an h4); a javascript: link is plain text.
  await expect(log(page).getByRole('heading', { name: 'Last week by SKU', level: 4 })).toBeVisible()
  await expect(log(page).locator('h1')).toHaveCount(0)
  await expect(log(page).getByText('###')).toHaveCount(0)
  await expect(log(page).getByRole('link', { name: 'Amazon orders' })).toHaveCount(0)
  await expect(log(page).locator('blockquote')).toContainText('Amazon orders')
  // The code block and the table are keyboard-scrollable regions, each with its own name.
  await expect(log(page).getByRole('region', { name: 'Code block 1, sql' })).toHaveAttribute('tabindex', '0')
  await expect(log(page).getByRole('region', { name: /^Table 1: SKU, Product, Units$/ })).toHaveAttribute('tabindex', '0')

  // The answer shows the mode that answered and when, inside the steps button.
  await expect(stepsButtons(page).last()).toHaveText(/^Smart · \d+ steps · [\d.]+m?s · \d{1,2}:\d\d\s[AP]M(chevron_right)?$/)

  // Copy code puts the query on the clipboard.
  await code.getByRole('button', { name: 'Copy code block 1, sql' }).click()
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain("WHERE created_at BETWEEN '2026-11-07' AND '2026-11-13'")

  // The wide table scrolls sideways inside its wrapper and the answer stays inside the chat column.
  const table = log(page).locator('[data-md-table]')
  const t = await table.evaluate(el => ({ sw: el.scrollWidth, cw: el.clientWidth, right: el.getBoundingClientRect().right, col: el.closest('[role="log"]')!.getBoundingClientRect().right }))
  expect(t.sw).toBeGreaterThan(t.cw)
  expect(t.right).toBeLessThanOrEqual(t.col + 0.5)
  await table.evaluate(el => { el.scrollLeft = 200 })
  expect(await table.evaluate(el => el.scrollLeft)).toBeGreaterThan(0)
  await shot(page, 'markdown-answer')

  // Ask again and scroll up while the answer streams: the view keeps its place and Jump to latest shows.
  const before = await stepsButtons(page).count()
  await composer(page).fill(REFUNDS_Q)
  await page.keyboard.press('Enter')
  await expect(page.locator('[data-composer]').getByRole('button', { name: 'Stop', exact: true })).toBeVisible()
  expect((await scrollState(page)).room).toBeGreaterThan(NEAR_BOTTOM_PX)
  await log(page).hover()
  await page.mouse.wheel(0, -2000)
  await expect.poll(async () => (await scrollState(page)).top).toBe(0)
  const jump = page.getByRole('button', { name: 'Jump to latest' })
  await expect(jump).toBeVisible()
  await expect(stepsButtons(page)).toHaveCount(before + 1, { timeout: 15_000 })
  await expect(page.locator('[data-composer]').getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0)
  expect((await scrollState(page)).top).toBe(0)
  await shot(page, 'scrolled-up-jump-to-latest')
  await jump.click()
  expect((await scrollState(page)).fromBottom).toBeLessThanOrEqual(1)
  await expect(jump).toHaveCount(0)

  // An earlier answer: its actions hide until hover while its steps line shows, at the row's left edge, and doesn't move
  // when the actions show.
  await page.mouse.move(5, 5)
  const earlier = stepsButtons(page).first()
  const bar = earlier.locator('xpath=..')
  const actions = bar.locator('[data-answer-actions]')
  const opacity = (l: Locator) => l.evaluate(el => getComputedStyle(el).opacity)
  await expect.poll(() => opacity(actions)).toBe('0')
  expect(await opacity(earlier)).toBe('1')
  expect(await opacity(bar)).toBe('1')
  const x = async (l: Locator) => (await l.boundingBox())!.x
  const atRest = await x(earlier)
  expect(atRest - await x(bar)).toBeLessThanOrEqual(8)
  await bar.hover()
  await expect.poll(() => opacity(actions)).toBe('1')
  expect(await x(earlier)).toBe(atRest)
  // Opening More doesn't move the steps line or the More button under the pointer.
  const more = bar.getByRole('button', { name: 'More' })
  const moreAt = await x(more)
  await more.click()
  await expect(page.getByRole('menu', { name: 'Message actions' })).toBeVisible()
  expect(await x(earlier)).toBe(atRest)
  expect(await x(more)).toBe(moreAt)
  await page.keyboard.press('Escape')
  await expect(page.getByRole('menu', { name: 'Message actions' })).toHaveCount(0)

  // Copy your own message. Edit shows "Editing" with the question in the box, focused, and Cancel puts back the draft
  // that was there (M11).
  const mine = msg(page, REFUNDS_Q).filter({ hasNot: page.locator('[data-md-code]') }).last()
  await mine.hover()
  await mine.getByRole('button', { name: 'Copy message' }).click()
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(REFUNDS_Q)
  await composer(page).fill('Draft I keep')
  await mine.hover()
  await mine.getByRole('button', { name: 'Edit message' }).click()
  const editingBar = page.locator('[data-composer]').getByText('Editing your message')
  await expect(editingBar).toBeVisible()
  await expect(composer(page)).toHaveValue(REFUNDS_Q)
  await expect(composer(page)).toBeFocused()
  expect(await composer(page).evaluate((el: HTMLTextAreaElement) => [el.selectionStart, el.selectionEnd])).toEqual([REFUNDS_Q.length, REFUNDS_Q.length])
  await page.locator('[data-composer]').getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(editingBar).toHaveCount(0)
  await expect(composer(page)).toHaveValue('Draft I keep')
  await expect(msg(page, REFUNDS_A)).toHaveCount(1)

  // Scrolled up, Regenerate still goes to the bottom like a new question.
  await log(page).hover()
  await page.mouse.wheel(0, -2000)
  await expect(jump).toBeVisible()

  // Regenerate asks the question again in place of the old answer: a new answer, the old one gone, the draft kept.
  const answer = msg(page, REFUNDS_A).last()
  const old = await answer.elementHandle()
  await answer.getByRole('button', { name: 'Regenerate' }).click()
  await expect(page.locator('[data-composer]').getByRole('button', { name: 'Stop', exact: true })).toBeVisible()
  await expect(jump).toHaveCount(0)
  await expect.poll(async () => (await scrollState(page)).fromBottom).toBeLessThanOrEqual(1)
  await expect(msg(page, REFUNDS_A)).toHaveCount(1, { timeout: 15_000 })
  await expect(page.locator('[data-composer]').getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0)
  expect(await old!.evaluate(el => el.isConnected)).toBe(false)
  await expect(log(page).locator('[data-chat-msg]').getByText(REFUNDS_Q, { exact: true })).toHaveCount(1)
  await expect(stepsButtons(page)).toHaveCount(before + 1)
  await expect(stepsButtons(page).last()).toHaveText(/^Smart · /)
  await expect(composer(page)).toHaveValue('Draft I keep')

  // The newest answer behaves like the earlier ones: at rest only its steps line shows; hover or keyboard focus shows
  // the actions.
  const fresh = msg(page, REFUNDS_A).last()
  const freshSteps = stepsButtons(page).last()
  const freshActions = freshSteps.locator('xpath=..').locator('[data-answer-actions]')
  await page.mouse.move(5, 5)
  await expect.poll(() => opacity(freshActions)).toBe('0')
  expect(await opacity(freshSteps)).toBe('1')
  await shot(page, 'newest-answer-at-rest')
  await fresh.hover()
  await expect.poll(() => opacity(freshActions)).toBe('1')
  await shot(page, 'newest-answer-hover')
  await page.mouse.move(5, 5)
  await expect.poll(() => opacity(freshActions)).toBe('0')
  await freshSteps.focus()
  await page.keyboard.press('Tab')
  await expect(fresh.getByRole('button', { name: 'Reply', exact: true })).toBeFocused()
  await expect.poll(() => opacity(freshActions)).toBe('1')
  await shot(page, 'newest-answer-focus')

  // Reply and Copy sit in the row only; the ··· menu keeps the rest, and the actions stay shown while it's open.
  await fresh.getByRole('button', { name: 'More', exact: true }).click()
  const menu = page.getByRole('menu', { name: 'Message actions' })
  await expect(menu).toBeVisible()
  await page.mouse.move(5, 5)
  // Focus is in the portaled menu (outside the row), the pointer is off it and the fade has run: only data-on holds them.
  await expect.poll(() => menu.evaluate(m => m.contains(document.activeElement))).toBe(true)
  await settled(page)
  await expect(freshActions).toHaveAttribute('data-on', '1')
  await expect.poll(() => opacity(freshActions)).toBe('1')
  const names = [`Send to ${CHANNEL}`, 'Report a wrong answer', 'Delete']
  await expect(menu.getByRole('menuitem')).toHaveCount(names.length)
  for (const [i, n] of names.entries()) await expect(menu.getByRole('menuitem').nth(i)).toHaveAccessibleName(n)
  await page.keyboard.press('Escape')

  // Thumbs: up is a pressed toggle, down opens the report window.
  const up = fresh.getByRole('button', { name: 'Good answer' })
  await up.click()
  await expect(up).toHaveAttribute('aria-pressed', 'true')
  await fresh.getByRole('button', { name: 'Bad answer' }).click()
  await expect(page.getByRole('dialog')).toBeVisible()
  await expect(page.getByRole('dialog').getByRole('textbox').first()).toHaveValue(/This answer looks wrong/)
  await page.keyboard.press('Escape')
  await expect(fresh.getByRole('button', { name: 'Bad answer' })).toHaveAttribute('aria-pressed', 'true')
  await expect(up).toHaveAttribute('aria-pressed', 'false')

  // Regenerate has Undo: the old answer comes back (with its rating) and the new question goes.
  await fresh.getByRole('button', { name: 'Regenerate' }).click()
  await expect(page.locator('[data-composer]').getByRole('button', { name: 'Stop', exact: true })).toBeVisible()
  await page.locator('[data-toast]').last().getByRole('button', { name: 'Undo', exact: true }).click()
  await expect(page.locator('[data-composer]').getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0)
  await expect(msg(page, REFUNDS_A)).toHaveCount(1)
  await expect(log(page).locator('[data-chat-msg]').getByText(REFUNDS_Q, { exact: true })).toHaveCount(1)
  await expect(stepsButtons(page)).toHaveCount(before + 1)
  await expect(msg(page, REFUNDS_A).last().getByRole('button', { name: 'Bad answer' })).toHaveAttribute('aria-pressed', 'true')
})

test('Conversation: an error turn has a steps link that opens the trace, and the empty chat names only connected tools', async ({ page }) => {
  await start(page, 'Tool disconnected', '#/chats/stuck')
  await expect(main(page).getByText('Which orders are stuck over 3 days?').first()).toBeVisible()

  await composer(page).fill(REFUNDS_Q)
  await page.keyboard.press('Enter')
  const err = log(page).locator('[data-chat-msg]').filter({ has: page.getByRole('button', { name: 'Try again' }) })
  await expect(err).toBeVisible({ timeout: 15_000 })
  const steps = err.getByRole('button', { name: /\d+ steps/ })
  await expect(steps).toBeVisible()
  await expect(steps).toHaveText(/\d+ steps · [\d.]+m?s · \d{1,2}:\d\d\s[AP]M(chevron_right)?$/)
  await shot(page, 'error-turn-steps')
  await steps.click()
  await expect(page.getByRole('dialog', { name: 'What your Inhouse agent did' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog', { name: 'What your Inhouse agent did' })).toHaveCount(0)

  // Gorgias is disconnected, so the new chat's sentence leaves it out.
  await page.getByRole('complementary', { name: 'Sidebar' }).getByRole('button', { name: 'New chat' }).click()
  await expect(main(page).getByText('Your Inhouse agent reads Shopify, Amazon, ShipBob, Xero and Meta Ads.')).toBeVisible()
})
