// PR 4, the conversation: a new question pinned near the top while the answer grows (UI_BASE_V2 D1), a scroll up that
// holds with Jump to latest, the time and model markers, Copy and Edit on your own messages, Regenerate and thumbs on
// answers, the mode and time in the opened step list, the steps line on an error turn, and markdown answers (a code block
// with Copy, a wide table that scrolls inside its wrapper).
import { expect, fxFor, test } from './support/fx.js'
import type { Locator, Page } from '@playwright/test'

async function start(page: Page, scenario: string, hash: string) {
  await fxFor(page, undefined).seed({ scenario, demo: { ambient: 'Always' } })
  await page.goto('/?demo' + hash)
}

const settled = (page: Page) => page.evaluate(() => Promise.all(document.getAnimations().filter(a => a.timeline instanceof DocumentTimeline && a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => undefined))))
const shot = async (page: Page, name: string) => { await settled(page); await page.screenshot({ path: test.info().outputPath(`${name}.png`) }) }
// The sample agent's chat channel (tools.json).
const CHANNEL = 'Slack'
const main = (page: Page) => page.locator('main')
const log = (page: Page) => page.getByRole('log', { name: 'Conversation' })
const msg = (page: Page, text: string) => log(page).locator('[data-chat-msg]').filter({ hasText: text })
const stepsButtons = (page: Page) => log(page).getByRole('button', { name: /\d+ steps/ })
const composer = (page: Page) => page.getByRole('textbox', { name: 'Message Inhouse' })
/** The thread's scroll position: top, and distance from the bottom. */
const scrollState = (page: Page) => page.evaluate(() => {
  const el = document.querySelector('[role="log"]')!.closest('.overflow-auto')!
  return { top: el.scrollTop, fromBottom: el.scrollHeight - el.scrollTop - el.clientHeight, room: el.scrollHeight - el.clientHeight }
})

/** More than this much room to scroll: the thread is taller than its view. */
const NEAR_BOTTOM_PX = 80
const MD_Q = "Give me the query for last week's orders by SKU"
const REFUNDS_Q = 'Why did refunds jump?'
const DIAGRAM_Q = 'Show me a diagram of how a refund moves through the team'
const HOSTILE_DIAGRAM_Q = 'Show me a diagram of the refund steps with links'
const REFUNDS_A = 'Refund requests rose from 14 last week to 31 this week'

test('Conversation: markdown, scroll-up while streaming, Jump to latest, the time and model markers, Copy, Edit, Regenerate, thumbs and the mode and time', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await start(page, 'Normal', '#/today')

  // A question from Today starts a chat; the markdown answer has a code block and a wide table.
  await page.getByRole('textbox', { name: 'Ask Inhouse' }).fill(MD_Q)
  await page.keyboard.press('Enter')
  const code = log(page).locator('[data-md-code]')
  await expect(code).toBeVisible({ timeout: 15_000 })
  await expect(code).toContainText('GROUP BY sku, product')
  // A fenced block is the base Code Block, in plain text (no highlighting spans inside).
  await expect(code).toHaveAttribute('data-slot', 'code-block')
  await expect(code.locator('[data-slot="code-block-code"] span')).toHaveCount(0)
  await expect(log(page).locator('strong', { hasText: 'Shopify' })).toBeVisible()
  await expect(log(page).locator('ul > li')).toHaveCount(2)
  await expect(log(page).locator('ol > li')).toHaveCount(2)
  await expect(log(page).getByRole('link', { name: 'Shopify' })).toHaveAttribute('href', '#/tools/shopify')
  // Markdown headings sit below the page's structure (### is an h4).
  await expect(log(page).getByRole('heading', { name: 'Last week by SKU', level: 4 })).toBeVisible()
  await expect(log(page).locator('h1')).toHaveCount(0)
  await expect(log(page).getByText('###')).toHaveCount(0)
  // The code block and the table are keyboard-scrollable regions, each with its own name.
  await expect(log(page).getByRole('region', { name: 'Code block 1, sql' })).toHaveAttribute('tabindex', '0')
  await expect(log(page).getByRole('region', { name: /^Table 1: SKU, Product, Units$/ })).toHaveAttribute('tabindex', '0')

  // The answer's steps line names the tools it read and the step count; opened, the list ends with the mode that answered
  // and how long it took.
  await expect(stepsButtons(page).last()).toContainText(/Checked Shopify · \d+ steps/)
  await expect(log(page)).not.toHaveAttribute('aria-busy', 'true')
  await expect(log(page).locator('blockquote')).toContainText("Amazon orders aren't in this query")
  await expect(log(page).getByRole('link', { name: 'Amazon orders' })).toHaveCount(0)
  await stepsButtons(page).last().click()
  await expect(stepsButtons(page).last()).toHaveAttribute('aria-expanded', 'true')
  await expect(log(page).locator('[data-steps-meta]').last()).toHaveText(/^Smart · [\d.]+m?s$/)

  // A time marker heads the thread, a line across it with the time centred, in the first question's row; no model marker yet.
  const timeMarkers = log(page).locator('[data-thread-marker="time"]')
  await expect(timeMarkers).toHaveCount(1)
  await expect(timeMarkers).toHaveText(/^Today \d{1,2}:\d\d\s[AP]M$/)
  await expect(msg(page, MD_Q).first().locator('[data-thread-marker="time"]')).toHaveCount(1)
  await expect(log(page).locator('[data-thread-marker="model"]')).toHaveCount(0)

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

  // Ask again on another model and scroll up while the answer streams: the view keeps its place and Jump to latest shows.
  const before = await stepsButtons(page).count()
  await page.getByRole('button', { name: 'Model: Smart' }).click()
  await page.getByRole('menuitemradio', { name: /Fast/ }).click()
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
  // The answer's words are still being revealed after the run ends (aria-busy on the log). Wait for the last of them, or a
  // last line lands under the jump (#529: 24 px short of the end straight after the click) or after the hover below,
  // when following the bottom moves the hovered row 24 px up from under the pointer.
  await expect(log(page)).not.toHaveAttribute('aria-busy', 'true')
  expect((await scrollState(page)).top).toBe(0)
  await shot(page, 'scrolled-up-jump-to-latest')
  await jump.click()
  // The jump's scroll lands from the click handler; read until it has, not once.
  await expect.poll(async () => (await scrollState(page)).fromBottom).toBeLessThanOrEqual(1)
  await expect(jump).toHaveCount(0)
  // Message Scroller follows the bottom while its jump settles (data-autoscrolling, about 180ms); a programmatic scroll
  // in that window (the hover below scrolls the first answer into view) is snapped back to the end on the next resize.
  await expect(page.locator('[data-autoscrolling]')).toHaveCount(0)

  // The answer on Fast says so above its steps line, once; a question a minute later gets no second time marker.
  const switched = log(page).locator('[data-thread-marker="model"]')
  await expect(switched).toHaveCount(1)
  await expect(switched).toHaveText('Switched to Fast')
  await expect(msg(page, REFUNDS_A).last().locator('[data-thread-marker="model"]')).toHaveCount(1)
  await expect(timeMarkers).toHaveCount(1)

  // An earlier answer: its actions hide until hover, sit at the row's left edge, and don't move when they show. Its steps
  // line is above its card, so it is not part of the row.
  await page.mouse.move(5, 5)
  const earlier = log(page).locator('[data-answer]').first()
  const actions = earlier.locator('[data-answer-actions]')
  const bar = actions.locator('xpath=..')
  const opacity = (l: Locator) => l.evaluate(el => getComputedStyle(el).opacity)
  await expect.poll(() => opacity(actions)).toBe('0')
  expect(await opacity(bar)).toBe('1')
  const x = async (l: Locator) => (await l.boundingBox())!.x
  const atRest = await x(actions)
  expect(atRest - await x(bar)).toBeLessThanOrEqual(8)
  await bar.hover()
  await expect.poll(() => opacity(actions)).toBe('1')
  expect(await x(actions)).toBe(atRest)
  // Opening More doesn't move the actions or the More button under the pointer.
  const more = bar.getByRole('button', { name: 'More' })
  const moreAt = await x(more)
  await more.click()
  await expect(page.getByRole('menu', { name: 'Message actions' })).toBeVisible()
  expect(await x(actions)).toBe(atRest)
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

  // Scrolled up, Regenerate still goes to the question like a new ask: pinned near the top with the answer growing under it,
  // which leaves no room below.
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
  await expect(stepsButtons(page).last()).toContainText(/Checked Gorgias and Shopify · \d+ steps/)
  await expect(composer(page)).toHaveValue('Draft I keep')

  // The newest answer behaves like the earlier ones: at rest its actions are hidden; hover or keyboard focus shows them.
  // At rest means its words have all shown (the log drops aria-busy) and Message Scroller has stopped moving the thread;
  // a hover while the reveal still grew the card landed where the card no longer was.
  await expect(log(page)).not.toHaveAttribute('aria-busy', 'true')
  await expect(page.locator('[data-autoscrolling]')).toHaveCount(0)
  const fresh = msg(page, REFUNDS_A).last()
  const freshSteps = stepsButtons(page).last()
  const freshActions = fresh.locator('[data-answer-actions]')
  await page.mouse.move(5, 5)
  await expect.poll(() => opacity(freshActions)).toBe('0')
  expect(await opacity(freshSteps)).toBe('1')
  await shot(page, 'newest-answer-at-rest')
  await fresh.hover()
  await expect.poll(() => opacity(freshActions)).toBe('1')
  await shot(page, 'newest-answer-hover')
  await page.mouse.move(5, 5)
  await expect.poll(() => opacity(freshActions)).toBe('0')
  // Reply is reachable by Tab from the steps line (its actions are only hidden, not out of the tab order).
  const reply = fresh.getByRole('button', { name: 'Reply', exact: true })
  await freshSteps.focus()
  for (let i = 0; i < 8 && !(await reply.evaluate(el => el === document.activeElement)); i++) await page.keyboard.press('Tab')
  await expect(reply).toBeFocused()
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
  await expect(page.getByRole('dialog').getByRole('textbox', { name: 'Details' })).toHaveValue(/This answer looks wrong/)
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

test('Conversation: an error turn has a steps line that opens the trace, and the empty chat names only connected tools', async ({ page }) => {
  await start(page, 'Tool disconnected', '#/chats/stuck')
  await expect(main(page).getByText('Which orders are stuck over 3 days?').first()).toBeVisible()

  await composer(page).fill(REFUNDS_Q)
  await page.keyboard.press('Enter')
  const err = log(page).locator('[data-chat-msg]').filter({ has: page.getByRole('button', { name: 'Try again' }) })
  await expect(err).toBeVisible({ timeout: 15_000 })
  const steps = err.getByRole('button', { name: /\d+ steps/ })
  await expect(steps).toBeVisible()
  // No tool was read, so the line is only the step count; opened, the list ends with how long it took.
  await expect(steps).toContainText(/^\d+ stepschevron_right$/)
  await steps.click()
  await expect(err.locator('[data-steps-meta]')).toHaveText(/^(?:[\w ]+ · )?[\d.]+m?s$/)
  await shot(page, 'error-turn-steps')
  await err.getByRole('button', { name: 'Details', exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'What your Inhouse agent did' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog', { name: 'What your Inhouse agent did' })).toHaveCount(0)

  // Gorgias is disconnected, so the new chat's sentence leaves it out.
  await page.getByRole('complementary', { name: 'Sidebar' }).getByRole('button', { name: 'New chat' }).click()
  await expect(main(page).getByText('Connected to Shopify, Amazon, ShipBob, Xero and Meta Ads.')).toBeVisible()
})

test('Conversation: the steps line expands and collapses and opens the trace, sources are one pill, a draft is its own card, the column is 880px', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await start(page, 'Normal', '#/chats/stuck')
  const first = log(page).locator('[data-answer]').first()
  await expect(first).toBeVisible()

  // The steps line: collapsed, it opens its list in place (aria-expanded), closes again, and Details opens the trace window.
  const steps = first.getByRole('button', { name: /\d+ steps/ })
  await expect(steps).toHaveAttribute('aria-expanded', 'false')
  await expect(first.getByRole('button', { name: 'Details', exact: true })).toHaveCount(0)
  await steps.click()
  await expect(steps).toHaveAttribute('aria-expanded', 'true')
  await expect(first.getByRole('button', { name: 'Details', exact: true })).toBeVisible()
  await steps.click()
  await expect(steps).toHaveAttribute('aria-expanded', 'false')
  await expect(first.getByRole('button', { name: 'Details', exact: true })).toHaveCount(0)
  await steps.click()
  // The opening list is clipped, not a scroll box (overflow: clip): nothing can scroll Details up into the clip, where the
  // growing list would pull it out from under a click (#607).
  await expect(first.locator('[data-steps] > [data-slot=trace-collapsible-content]')).toHaveCSS('overflow-y', 'clip')
  await first.getByRole('button', { name: 'Details', exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'What your Inhouse agent did' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog', { name: 'What your Inhouse agent did' })).toHaveCount(0)

  // Sources: one pill with the count (no numbered chips in the answer) that opens a plain list, one row per source.
  const pill = first.locator('[data-sources]').getByRole('button')
  await expect(pill).toContainText('2 sources')
  await expect(pill).toHaveAttribute('aria-expanded', 'false')
  await expect(first.locator('[data-sources] li')).toHaveCount(0)
  await pill.click()
  await expect(pill).toHaveAttribute('aria-expanded', 'true')
  await expect(first.locator('[data-sources] li')).toHaveText([/Orders.*Shopify/s, /Shipments.*ShipBob/s])
  await expect(first.getByRole('button', { name: /^\[?\d+\]?$/ })).toHaveCount(0)

  // A draft to approve is its own card after the answer's card, never inside it.
  const turn = log(page).locator('[data-answer]').filter({ has: page.locator('[data-approval]') })
  const draft = turn.locator('[data-approval]')
  await expect(draft).toHaveCount(1)
  expect(await draft.evaluate(el => el.closest('.bg-card') !== null)).toBe(false)
  const card = turn.locator('.bg-card').first()
  const [cardBox, draftBox] = [await card.boundingBox(), await draft.boundingBox()]
  expect(draftBox!.y).toBeGreaterThanOrEqual(cardBox!.y + cardBox!.height)

  // The chat column is 880px at 1440 (the thread and the composer).
  expect((await log(page).boundingBox())!.width).toBe(880)
  expect((await page.locator('[data-composer]').boundingBox())!.width).toBeLessThanOrEqual(880)
})

test('Conversation: a mermaid fence is drawn as a diagram, with its source one click away', async ({ page }) => {
  await start(page, 'Normal', '#/today')
  await page.getByRole('textbox', { name: 'Ask Inhouse' }).fill(DIAGRAM_Q)
  await page.keyboard.press('Enter')
  // Mermaid loads with the first diagram, so allow for the chunk; the figure is an image with a name, inside a keyboard-scrollable region.
  const diagram = log(page).locator('[data-md-diagram][data-state="ready"]')
  await expect(diagram).toBeVisible({ timeout: 30_000 })
  const figure = diagram.locator('svg[role="img"]')
  await expect(figure).toHaveAttribute('aria-label', 'Diagram 1')
  // SVG labels set each word in its own <tspan>, with no spaces between them in the text: compare the words.
  await expect.poll(() => figure.evaluate(svg => [...svg.querySelectorAll('text')].map(t => t.textContent).join(' ').replace(/\s+/g, ''))).toContain('Customerasksforarefund')
  await expect(log(page).getByRole('region', { name: 'Diagram 1', exact: true })).toHaveAttribute('tabindex', '0')
  // No link, image or embedded page can come from a diagram, and it is not shown as a code block.
  await expect(diagram.locator('a, image, foreignObject, script')).toHaveCount(0)
  await expect(log(page).locator('[data-md-code]')).toHaveCount(0)
  // The diagram stays inside the answer column.
  const box = await diagram.evaluate(el => ({ right: el.getBoundingClientRect().right, col: el.closest('[role="log"]')!.getBoundingClientRect().right }))
  expect(box.right).toBeLessThanOrEqual(box.col + 0.5)
  // Show source reveals the fence's text as a code block.
  await diagram.getByRole('button', { name: 'Show diagram 1 source' }).click()
  await expect(diagram.locator('[data-md-code]')).toContainText('flowchart LR')
  await expect(diagram.getByRole('button', { name: 'Hide diagram 1 source' })).toHaveAttribute('aria-pressed', 'true')
  // `-->` shows as typed, never as a ligature arrow: in the code block and in the figure's own text.
  expect(await diagram.locator('[data-md-code] pre').evaluate(el => getComputedStyle(el).fontVariantLigatures)).toBe('none')
  expect(await figure.locator('text').first().evaluate(el => getComputedStyle(el).fontVariantLigatures)).toBe('none')
  await shot(page, 'mermaid-diagram')
})

test('Conversation: a diagram that tries links, HTML labels and addresses in its style is drawn clean, its linked node kept', async ({ page }) => {
  // Every address the sample's diagrams name (mock-script.ts HOSTILE_DIAGRAM_ANSWER): none may be requested.
  const hostile: string[] = []
  page.on('request', r => { if (/\/hostile-|help\.example\.test/.test(r.url())) hostile.push(r.url()) })
  await start(page, 'Normal', '#/today')
  await page.getByRole('textbox', { name: 'Ask Inhouse' }).fill(HOSTILE_DIAGRAM_Q)
  await page.keyboard.press('Enter')
  const diagrams = log(page).locator('[data-md-diagram]')
  await expect(diagrams).toHaveCount(2, { timeout: 30_000 })
  // The second names an address in its classDef: it is never handed to Mermaid (which lays a figure out in the live page,
  // where that address would be fetched), so it shows its source.
  await expect(diagrams.nth(1)).toHaveAttribute('data-state', 'failed', { timeout: 30_000 })
  await expect(diagrams.nth(1)).toContainText("Couldn't draw this diagram.")
  await expect(diagrams.nth(1).locator('[data-md-code]')).toContainText('classDef hostile')
  // The first is drawn: the config lock kept HTML labels off, so it needs no foreignObject (which would fail it to its source).
  for (const n of [1]) {
    const diagram = diagrams.nth(n - 1)
    await expect(diagram).toHaveAttribute('data-state', 'ready', { timeout: 30_000 })
    await expect(diagram.locator('svg[role="img"]')).toHaveAttribute('aria-label', `Diagram ${n}`)
    await expect(diagram.locator('a, image, foreignObject, script, feImage, animate, set')).toHaveCount(0)
    // No address anywhere in the figure: not in its <style>, not in a style attribute, not in any other attribute.
    const leaks = await diagram.locator('svg').evaluate(svg => {
      const bad = /url\(\s*(?!['"]?#)|image-set\(|image\(|src\(|@import|\\/i
      const found: string[] = []
      for (const el of [svg, ...svg.querySelectorAll('*')]) {
        for (const a of el.attributes) if (bad.test(a.value)) found.push(`${el.localName}[${a.name}]=${a.value}`)
        if (el.localName === 'style' && bad.test(el.textContent ?? '')) found.push(`style: ${el.textContent}`)
      }
      return found
    })
    expect(leaks).toEqual([])
  }
  // The linked node is still drawn: the link is gone, its shape and text stay.
  await expect.poll(() => diagrams.nth(0).locator('svg').evaluate(svg => [...svg.querySelectorAll('text')].map(t => t.textContent).join('').replace(/\s+/g, ''))).toContain('Refundpolicy')
  // ...in its place: every label sits inside the figure (a link's own transform is kept when the link is dropped).
  const outside = await diagrams.nth(0).locator('svg').evaluate(svg => {
    const box = svg.getBoundingClientRect()
    return [...svg.querySelectorAll('text')].map(t => t.getBoundingClientRect())
      .filter(r => r.width > 0 && (r.left < box.left - 1 || r.top < box.top - 1 || r.right > box.right + 1 || r.bottom > box.bottom + 1)).length
  })
  expect(outside).toBe(0)
  // The finished answer keeps the figure it drew (no remount, no redraw at the end of the answer).
  const figure = await diagrams.nth(0).locator('svg').elementHandle()
  await expect(log(page)).not.toHaveAttribute('aria-busy', 'true')
  expect(await figure!.evaluate(el => el.isConnected)).toBe(true)
  await expect(diagrams.nth(0)).toHaveAttribute('data-state', 'ready')
  expect(hostile).toEqual([])
})
