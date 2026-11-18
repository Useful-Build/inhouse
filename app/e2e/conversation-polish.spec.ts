// PR 5 of UI plan 2, the conversation and composer: a pasted one-page message folds to about eight lines and Show more
// opens it without moving the view; a message queued mid-answer waits above the composer, and Send now stops the
// answer and runs it in the same run (with its own steps), the next queued one following on its own, and Retry on the
// stopped note; Stop pauses the queue (no message goes on its own after a later answer), Edit on a queued message asks
// before it replaces a draft, and focus follows Send now; a chat left mid-answer asks its queued message in the
// background (D9); queued messages wait, paused, across a reload; Edit shows "Editing", Escape puts the draft and its
// file back, a sent edit replaces the question and Undo brings the old one back; All chats keeps its time column on the
// card's edge through Select. On a phone: the answer row is Copy, steps and "···" (D3) with the thumbs as radio items,
// every step name in the trace reads in full, and Select mode's bar never covers the last chat.
import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'

async function start(page: Page, hash: string) {
  await page.addInitScript(() => {
    if (sessionStorage.getItem('e2e-seeded')) return
    localStorage.clear()
    localStorage.setItem('inhouse.demo.switches.v1', JSON.stringify({ stage: 'Act', scenario: 'Normal', ambient: 'Always', animateMark: false }))
    sessionStorage.setItem('e2e-seeded', '1')
  })
  await page.goto('/?demo' + hash)
}

const settled = (page: Page) => page.evaluate(() => Promise.all(document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished)))
const shot = async (page: Page, name: string) => { await settled(page); await page.screenshot({ path: test.info().outputPath(`${name}.png`) }) }
const log = (page: Page) => page.getByRole('log', { name: 'Conversation' })
const msg = (page: Page, text: string) => log(page).locator('[data-chat-msg]').filter({ hasText: text })
const field = (page: Page) => page.getByRole('textbox', { name: 'Message your Inhouse agent' })
const dock = (page: Page) => page.locator('[data-composer]')
const stop = (page: Page) => dock(page).getByRole('button', { name: 'Stop', exact: true })
const stepsButtons = (page: Page) => log(page).getByRole('button', { name: /\d+ steps/ })
const queued = (page: Page) => page.getByRole('list', { name: 'Queued messages' }).getByRole('listitem')
const scroller = (page: Page) => log(page).locator('xpath=ancestor::div[contains(@class,"overflow-auto")][1]')

const REFUNDS_Q = 'Why did refunds jump?'
const REFUNDS_A = 'Refund requests rose from 14 last week to 31 this week'
const MD_Q = "Give me the query for last week's orders by SKU"
const STUCK_Q = 'Which orders are stuck over 3 days?'
const STOPPED = 'You stopped your Inhouse agent. Nothing was changed.'
const RELOADED = 'Your Inhouse agent stopped when the page reloaded. Nothing was changed.'
const OTHER_Q = 'How are sales today?'
const SESSION = 'inhouse.ui.session.v1'
/** Waits out the session save (debounced 300 ms). */
const saved = (page: Page) => page.waitForTimeout(500)
const chip = (page: Page, text: string) => queued(page).filter({ hasText: text })

/** A one-page message: about forty lines, made up. */
const PAGE_TEXT = Array.from({ length: 20 }, (_, i) =>
  `Note ${i + 1}: order #${4800 + i} from the Kestrel shipment is still waiting at the warehouse.\nThe customer asked twice, so check the tracking number before you reply.`).join('\n')

test.describe('desktop', () => {
  test('Conversation polish: a pasted page folds and Show more opens it in place', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'])
    await start(page, '#/chats/new')
    await expect(field(page)).toBeFocused()
    await page.evaluate(t => navigator.clipboard.writeText(t), PAGE_TEXT)
    await page.keyboard.press('ControlOrMeta+V')
    await expect(field(page)).toHaveValue(PAGE_TEXT)
    await page.keyboard.press('Enter')
    await expect(stepsButtons(page)).toHaveCount(1, { timeout: 15_000 })
    await expect(stop(page)).toHaveCount(0)

    // Folded: about eight lines, the rest cut, Show more says it's closed.
    const bubble = msg(page, 'Note 1:').first()
    const text = bubble.locator('[data-long-text]')
    const fold = await text.evaluate(el => ({ h: el.clientHeight, full: el.scrollHeight, line: parseFloat(getComputedStyle(el).lineHeight) }))
    expect(fold.full).toBeGreaterThan(fold.h * 3)
    expect(Math.round(fold.h / fold.line)).toBe(8)
    // One name, its state in aria-expanded.
    const more = bubble.getByRole('button', { name: 'Show full message' })
    await expect(more).toHaveText('Show more')
    await expect(more).toHaveAttribute('aria-expanded', 'false')
    await shot(page, 'long-message-folded')

    // Show more opens the whole page where it is: the view doesn't move, and Jump to latest offers the way down.
    await more.scrollIntoViewIfNeeded()
    const top = await scroller(page).evaluate(el => el.scrollTop)
    await more.click()
    await expect(more).toHaveText('Show less')
    await expect(more).toHaveAttribute('aria-expanded', 'true')
    const open = await text.evaluate(el => ({ h: el.clientHeight, full: el.scrollHeight }))
    expect(open.full - open.h).toBeLessThanOrEqual(1)
    expect(open.h).toBeGreaterThan(fold.h * 3)
    expect(await text.innerText()).toContain('Note 20: order #4819')
    await page.waitForTimeout(200)
    expect(await scroller(page).evaluate(el => el.scrollTop)).toBe(top)
    await expect(page.getByRole('button', { name: 'Jump to latest' })).toBeVisible()
    await shot(page, 'long-message-open')

    // Show less folds it again.
    await more.click()
    await expect(more).toHaveAttribute('aria-expanded', 'false')
    expect(await text.evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true)
  })

  test('Conversation polish: queue two messages mid-answer, send one now, the other follows, and Retry the stopped answer', async ({ page }) => {
    test.setTimeout(120_000)
    await start(page, '#/chats/new')
    await field(page).fill(REFUNDS_Q)
    await page.keyboard.press('Enter')
    await expect(stop(page)).toBeVisible()

    // Two messages typed while it answers wait above the box, in order, not in the thread. Stop keeps its own button.
    for (const q of [MD_Q, STUCK_Q]) {
      await field(page).fill(q)
      await expect(dock(page).getByRole('button', { name: 'Queue message' })).toBeVisible()
      await page.keyboard.press('Enter')
      await expect(field(page)).toHaveValue('')
    }
    await expect(queued(page)).toHaveCount(2)
    await expect(queued(page).nth(0)).toContainText(MD_Q)
    await expect(queued(page).nth(1)).toContainText(STUCK_Q)
    await expect(msg(page, MD_Q)).toHaveCount(0)

    // Send now (each chip's buttons name its message): the running answer stops (a note says so, its Retry waits while
    // an answer runs), the first queued message joins the thread and is answered. The refunds answer never comes. Right
    // away, before the refunds answer could end on its own; the shot comes after.
    await queued(page).nth(0).getByRole('button', { name: /^Send now: Give me the query/ }).click()
    await expect(log(page).getByText(STOPPED)).toBeVisible()
    // Focus moves to the chip that took its place.
    await expect(chip(page, STUCK_Q).getByRole('button', { name: /^Send now: Which orders/ })).toBeFocused()
    await shot(page, 'queued-sent-now')
    await expect(msg(page, MD_Q)).toHaveCount(1)
    await expect(queued(page)).toHaveCount(1)
    await expect(queued(page).first()).toContainText(STUCK_Q)
    await expect(msg(page, STOPPED).getByRole('button', { name: 'Retry' })).toBeDisabled()
    await expect(log(page).locator('[data-md-code]')).toBeVisible({ timeout: 15_000 })

    // The thread reads question, note, sent-now question, its answer.
    const order = await log(page).locator('[data-chat-msg]').evaluateAll(els => els.map(el => el.textContent ?? ''))
    const iQ = order.findIndex(t => t.includes(REFUNDS_Q)), iNote = order.findIndex(t => t.includes(STOPPED)), iMd = order.findIndex(t => t.includes(MD_Q))
    expect(iQ).toBeGreaterThanOrEqual(0)
    expect(iNote).toBeGreaterThan(iQ)
    expect(iMd).toBeGreaterThan(iNote)

    // When that answer ends, the next queued message goes on its own, and the queue empties.
    await expect(msg(page, STUCK_Q)).toHaveCount(1, { timeout: 15_000 })
    await expect(queued(page)).toHaveCount(0)
    await expect(stepsButtons(page)).toHaveCount(2, { timeout: 15_000 })
    await expect(stop(page)).toHaveCount(0)
    await expect(msg(page, REFUNDS_A)).toHaveCount(0)

    // The sent-now answer has steps of its own: the run's second turn (`<run id>-t2`) holds the query's steps, and its
    // steps line and window show them (3 steps, "Last week by SKU"), not the refunds steps the run started with.
    const turns = await page.evaluate(() => JSON.parse(localStorage.getItem('inhouse.demo.runs.v1') ?? '[]') as [string, { trace: string }][])
    expect(turns.filter(([id, info]) => /-t2$/.test(id) && info.trace === 'query')).toHaveLength(1)
    const mdAnswer = log(page).locator('[data-answer]').filter({ has: page.locator('[data-md-code]') })
    await expect(mdAnswer).toHaveCount(1)
    await expect(mdAnswer.getByRole('button', { name: /\d+ steps/ })).toContainText('3 steps')
    await mdAnswer.getByRole('button', { name: /\d+ steps/ }).click()
    const trace = page.getByRole('dialog', { name: 'What your Inhouse agent did' })
    await expect(trace).toBeVisible()
    await expect(trace.getByText('Last week by SKU')).toBeVisible()
    await expect(trace.getByText("These steps aren't available yet.")).toHaveCount(0)
    await expect(trace.getByTestId('trace-row')).toHaveCount(4)
    await page.keyboard.press('Escape')
    await expect(trace).toHaveCount(0)
    await shot(page, 'queue-sent-now-and-followed')

    // Retry asks the stopped question again: the note goes and the refunds answer comes at the end.
    await msg(page, STOPPED).getByRole('button', { name: 'Retry' }).click()
    await expect(log(page).getByText(STOPPED)).toHaveCount(0)
    await expect(msg(page, REFUNDS_A)).toHaveCount(1, { timeout: 15_000 })
    await expect(msg(page, REFUNDS_Q).filter({ hasNot: page.locator('[data-answer]') })).toHaveCount(1)
    await expect(stop(page)).toHaveCount(0)
  })

  test('Conversation polish: Edit shows Editing, Escape puts the draft and its file back, and a sent edit replaces the question', async ({ page }) => {
    await start(page, '#/chats/new')
    await field(page).fill(REFUNDS_Q)
    await page.keyboard.press('Enter')
    await expect(stepsButtons(page)).toHaveCount(1, { timeout: 15_000 })
    await expect(stop(page)).toHaveCount(0)

    // A draft with a file in the box.
    await dock(page).getByRole('button', { name: 'Attach' }).click()
    await page.getByRole('menuitem', { name: /An order, product or customer/ }).click()
    await expect(dock(page).getByText('Order #4821')).toBeVisible()
    await field(page).fill('Draft I keep')

    // Edit: the question in the box, focused, with "Editing", and none of the draft's file.
    const mine = msg(page, REFUNDS_Q).filter({ hasNot: page.locator('[data-answer]') })
    await mine.hover()
    await mine.getByRole('button', { name: 'Edit message' }).click()
    const editing = dock(page).getByText('Editing your message')
    await expect(editing).toBeVisible()
    await expect(field(page)).toHaveValue(REFUNDS_Q)
    await expect(field(page)).toBeFocused()
    await expect(dock(page).getByText('Order #4821')).toHaveCount(0)
    await field(page).fill('Why did refunds jump on Amazon?')
    await shot(page, 'editing')

    // Escape cancels: the draft and its file are back, the thread unchanged, nothing asked.
    await page.keyboard.press('Escape')
    await expect(editing).toHaveCount(0)
    await expect(field(page)).toHaveValue('Draft I keep')
    await expect(dock(page).getByText('Order #4821')).toBeVisible()
    await expect(msg(page, 'on Amazon')).toHaveCount(0)
    await expect(stop(page)).toHaveCount(0)

    // Edit and send: the edited question takes the old one's place with a new answer, and the draft comes back.
    await mine.hover()
    await mine.getByRole('button', { name: 'Edit message' }).click()
    await expect(editing).toBeVisible()
    await field(page).fill(STUCK_Q)
    await page.keyboard.press('Enter')
    await expect(editing).toHaveCount(0)
    await expect(msg(page, STUCK_Q)).toHaveCount(1)
    await expect(stepsButtons(page)).toHaveCount(1, { timeout: 15_000 })
    await expect(stop(page)).toHaveCount(0)
    await expect(msg(page, REFUNDS_A)).toHaveCount(0)
    await expect(log(page).locator('[data-chat-msg]').getByText(REFUNDS_Q, { exact: true })).toHaveCount(0)
    await expect(field(page)).toHaveValue('Draft I keep')
    await expect(dock(page).getByText('Order #4821')).toBeVisible()

    // Undo of a sent edit, while its answer is still coming: the edited question and its partial answer go, the
    // question it replaced comes back with its answer, and nothing says it stopped.
    const stuck = msg(page, STUCK_Q).filter({ hasNot: page.locator('[data-answer]') })
    await stuck.hover()
    await stuck.getByRole('button', { name: 'Edit message' }).click()
    await expect(editing).toBeVisible()
    await field(page).fill(MD_Q)
    await page.keyboard.press('Enter')
    await expect(msg(page, MD_Q)).toHaveCount(1)
    await expect(stop(page)).toBeVisible()
    await page.locator('[data-toast]').filter({ hasText: 'Asking again' }).last().getByRole('button', { name: 'Undo', exact: true }).click()
    await expect(msg(page, MD_Q)).toHaveCount(0)
    await expect(stop(page)).toHaveCount(0)
    await expect(log(page).locator('[data-chat-msg]').getByText(STUCK_Q, { exact: true })).toHaveCount(1)
    await expect(stepsButtons(page)).toHaveCount(1)
    await expect(log(page).getByText(STOPPED)).toHaveCount(0)
    // Nothing more arrives from the run Undo stopped.
    await page.waitForTimeout(3500)
    await expect(log(page).locator('[data-md-code]')).toHaveCount(0)
    await expect(stepsButtons(page)).toHaveCount(1)
    await expect(field(page)).toHaveValue('Draft I keep')
    await shot(page, 'edit-undone')
  })

  test('Conversation polish: Stop pauses the queue, a later answer leaves it be, and Edit on a queued message asks before it replaces a draft', async ({ page }) => {
    test.setTimeout(90_000)
    await start(page, '#/chats/new')
    await field(page).fill(REFUNDS_Q)
    await page.keyboard.press('Enter')
    await expect(stop(page)).toBeVisible()
    for (const q of [MD_Q, STUCK_Q]) {
      await field(page).fill(q)
      await page.keyboard.press('Enter')
      await expect(field(page)).toHaveValue('')
    }
    await expect(queued(page)).toHaveCount(2)

    // Stop: the answer ends and both messages stay, paused, and a screen reader hears it.
    await stop(page).click()
    await expect(log(page).getByText(STOPPED)).toBeVisible()
    await expect(queued(page)).toHaveCount(2)
    for (const q of [MD_Q, STUCK_Q]) await expect(chip(page, q)).toContainText('Paused')
    await expect(page.getByRole('status').filter({ hasText: '2 messages paused' })).toHaveCount(1)
    await expect(msg(page, MD_Q)).toHaveCount(0)

    // A new message after Stop is a normal question. When its answer ends, the paused ones still wait.
    await field(page).fill(OTHER_Q)
    await expect(dock(page).getByRole('button', { name: 'Queue message' })).toHaveCount(0)
    await page.keyboard.press('Enter')
    await expect(msg(page, OTHER_Q)).toHaveCount(1)
    await expect(stepsButtons(page)).toHaveCount(1, { timeout: 15_000 })
    await expect(stop(page)).toHaveCount(0)
    await page.waitForTimeout(3500)
    await expect(queued(page)).toHaveCount(2)
    await expect(msg(page, MD_Q)).toHaveCount(0)
    await expect(msg(page, STUCK_Q)).toHaveCount(0)
    await expect(stop(page)).toHaveCount(0)
    await shot(page, 'queue-paused')

    // Edit on a queued message over a draft asks first: Cancel keeps both.
    await field(page).fill('Draft I keep')
    await chip(page, MD_Q).getByRole('button', { name: /^Edit queued message: Give me the query/ }).click()
    const ask = page.getByRole('dialog', { name: 'Replace your draft?' })
    await expect(ask).toBeVisible()
    await shot(page, 'queue-replace-draft')
    await ask.getByRole('button', { name: 'Cancel' }).click()
    await expect(ask).toHaveCount(0)
    await expect(field(page)).toHaveValue('Draft I keep')
    await expect(queued(page)).toHaveCount(2)

    // Replace: the queued message is in the box, focused, and out of the queue.
    await chip(page, MD_Q).getByRole('button', { name: /^Edit queued message: Give me the query/ }).click()
    await ask.getByRole('button', { name: 'Replace' }).click()
    await expect(ask).toHaveCount(0)
    await expect(field(page)).toHaveValue(MD_Q)
    await expect(field(page)).toBeFocused()
    await expect(queued(page)).toHaveCount(1)
    await expect(page.getByRole('status').filter({ hasText: '1 message paused' })).toHaveCount(1)

    // Send now on the last paused one: nothing runs, so it's simply asked, and focus goes to the box.
    await chip(page, STUCK_Q).getByRole('button', { name: /^Send now: Which orders/ }).click()
    await expect(queued(page)).toHaveCount(0)
    await expect(field(page)).toBeFocused()
    await expect(msg(page, STUCK_Q)).toHaveCount(1)
    await expect(stepsButtons(page)).toHaveCount(2, { timeout: 15_000 })
    await expect(field(page)).toHaveValue(MD_Q)
  })

  test('Conversation polish: a chat left mid-answer asks its queued message in the background (D9)', async ({ page }) => {
    test.setTimeout(90_000)
    await start(page, '#/chats/new')
    await field(page).fill(REFUNDS_Q)
    await page.keyboard.press('Enter')
    await expect(stop(page)).toBeVisible()
    await field(page).fill(MD_Q)
    await page.keyboard.press('Enter')
    await expect(queued(page)).toHaveCount(1)
    const mine = await page.evaluate(() => location.hash)
    expect(mine).toMatch(/^#\/chats\/chat-new-/)

    // Another chat: its own thread, no queue, nothing answering.
    await page.evaluate(() => { location.hash = '#/chats/stuck' })
    await expect(msg(page, 'Which orders are stuck')).not.toHaveCount(0)
    await expect(queued(page)).toHaveCount(0)
    await expect(stop(page)).toHaveCount(0)

    // Meanwhile the first chat's answer ends and its queued message is asked and answered there.
    await expect.poll(() => page.evaluate(([key, q]) => {
      const s = JSON.parse(localStorage.getItem(key) ?? '{}') as { chats?: Record<string, { extras: { role: string; text?: string; part?: { type: string } }[] }>; answering?: string[]; queued?: Record<string, unknown> }
      const chats = Object.values(s.chats ?? {})
      const asked = chats.some(c => c.extras.some(m => m.role === 'user' && m.text === q))
      return asked && !(s.answering ?? []).length && !Object.keys(s.queued ?? {}).length
    }, [SESSION, MD_Q] as const), { timeout: 20_000 }).toBe(true)
    await expect(msg(page, MD_Q)).toHaveCount(0)

    // Back in the first chat: the refunds answer, then the queued question with its answer, and an empty queue.
    await page.evaluate(h => { location.hash = h }, mine)
    await expect(msg(page, REFUNDS_A)).toHaveCount(1)
    await expect(msg(page, MD_Q)).toHaveCount(1)
    await expect(log(page).locator('[data-md-code]')).toBeVisible()
    await expect(queued(page)).toHaveCount(0)
    await expect(stop(page)).toHaveCount(0)
    await expect(log(page).getByText(STOPPED)).toHaveCount(0)
    await shot(page, 'queue-background-drain')
  })

  test('Conversation polish: queued messages wait, paused, across a reload, and Send now asks one', async ({ page }) => {
    test.setTimeout(90_000)
    await start(page, '#/chats/new')
    await field(page).fill(REFUNDS_Q)
    await page.keyboard.press('Enter')
    await expect(stop(page)).toBeVisible()
    for (const q of [MD_Q, STUCK_Q]) {
      await field(page).fill(q)
      await page.keyboard.press('Enter')
      await expect(field(page)).toHaveValue('')
    }
    await expect(queued(page)).toHaveCount(2)
    await page.reload()

    // The reload stopped the answer: the note says so, and both messages wait above the box, paused, in order.
    await expect(log(page).getByText(RELOADED)).toBeVisible()
    await expect(queued(page)).toHaveCount(2)
    await expect(queued(page).nth(0)).toContainText(MD_Q)
    await expect(queued(page).nth(1)).toContainText(STUCK_Q)
    for (const q of [MD_Q, STUCK_Q]) await expect(chip(page, q)).toContainText('Paused')
    // Nothing goes on its own.
    await page.waitForTimeout(3500)
    await expect(msg(page, MD_Q)).toHaveCount(0)
    await expect(stop(page)).toHaveCount(0)
    await shot(page, 'queue-after-reload')

    // Send now asks it; the other still waits, also after its answer ends.
    await chip(page, MD_Q).getByRole('button', { name: /^Send now: Give me the query/ }).click()
    await expect(msg(page, MD_Q)).toHaveCount(1)
    await expect(log(page).locator('[data-md-code]')).toBeVisible({ timeout: 15_000 })
    await expect(stop(page)).toHaveCount(0)
    await page.waitForTimeout(1000)
    await expect(queued(page)).toHaveCount(1)
    await expect(msg(page, STUCK_Q)).toHaveCount(0)

    // Saved as it is now: a second reload keeps the one left.
    await saved(page)
    await page.reload()
    await expect(queued(page)).toHaveCount(1)
    await expect(chip(page, STUCK_Q)).toContainText('Paused')
  })

  test("All chats: the time column ends on the card's edge and doesn't move when Select is toggled", async ({ page }) => {
    await start(page, '#/chats/all')
    const main = page.locator('main')
    const row = main.locator('[data-chat-row]').filter({ hasText: 'Kestrel delivery times' })
    const time = row.locator('[data-chat-open] > span').last()
    await expect(time).toHaveText('Nov 2')
    const card = row.locator('xpath=..')
    const edge = async () => (await card.boundingBox())!.x + (await card.boundingBox())!.width - ((await time.boundingBox())!.x + (await time.boundingBox())!.width)
    const before = await edge()
    expect(before).toBeLessThanOrEqual(24)
    await main.getByRole('button', { name: 'Select', exact: true }).click()
    await expect(page.getByRole('toolbar', { name: 'Selected chats' })).toBeVisible()
    expect(await edge()).toBe(before)
    await main.getByRole('button', { name: 'Done', exact: true }).click()
    expect(await edge()).toBe(before)
  })
  test('Composer at 768px: the tools label gives way and Send stays inside the box', async ({ page }) => {
    await page.setViewportSize({ width: 768, height: 900 })
    await start(page, '#/chats/new')
    await field(page).fill(REFUNDS_Q)
    const box = (await dock(page).boundingBox())!
    const send = (await dock(page).getByRole('button', { name: 'Send', exact: true }).boundingBox())!
    expect(send.x + send.width).toBeLessThanOrEqual(box.x + box.width)
    expect(send.x).toBeGreaterThan(box.x)
    await shot(page, 'composer-768')
  })
})

test.describe('phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true })

  test('Phone: the answer row is Copy, steps and More, and every step name in the trace reads in full', async ({ page }) => {
    await start(page, '#/chats/stuck')
    const answer = log(page).locator('[data-answer]').first()
    await expect(answer).toBeVisible()
    const bar = answer.getByRole('button', { name: 'Copy message' }).locator('xpath=..')
    const names = await bar.locator(':scope > button').evaluateAll(els => els.map(el => el.getAttribute('aria-label') ?? (el.textContent?.includes('steps') ? 'steps' : '')))
    expect(names).toEqual(['Copy message', 'steps', 'More'])
    await answer.getByRole('button', { name: 'More', exact: true }).click()
    const menu = page.getByRole('menu', { name: 'Message actions' })
    for (const n of ['Reply', 'Read aloud', 'Delete']) await expect(menu.getByRole('menuitem', { name: n })).toBeVisible()
    // The thumbs are a radio pair, so their state is read out.
    for (const n of ['Good answer', 'Bad answer']) await expect(menu.getByRole('menuitemradio', { name: n })).toHaveAttribute('aria-checked', 'false')
    await menu.getByRole('menuitemradio', { name: 'Good answer' }).click()
    await expect(menu).toHaveCount(0)
    await answer.getByRole('button', { name: 'More', exact: true }).click()
    await expect(menu.getByRole('menuitemradio', { name: 'Good answer' })).toHaveAttribute('aria-checked', 'true')
    await expect(menu.getByRole('menuitemradio', { name: 'Bad answer' })).toHaveAttribute('aria-checked', 'false')
    await page.keyboard.press('Escape')
    await expect(menu).toHaveCount(0)

    // The steps open as a plain list: every name wraps inside the window, none is cut.
    await answer.getByRole('button', { name: /\d+ steps/ }).click()
    const trace = page.getByRole('dialog', { name: 'What your Inhouse agent did' })
    await expect(trace).toBeVisible()
    const list = trace.getByRole('list', { name: 'Steps' })
    await expect(list).toBeVisible()
    const stepsStat = Number(await trace.getByText('Steps', { exact: true }).locator('xpath=following-sibling::div[1]').innerText())
    const stepNames = list.locator('[data-step-name]')
    await expect(stepNames).toHaveCount(stepsStat + 1)
    const win = (await trace.boundingBox())!
    for (let i = 0; i < stepsStat + 1; i++) {
      const n = stepNames.nth(i)
      await n.scrollIntoViewIfNeeded()
      const fit = await n.evaluate(el => ({ w: el.scrollWidth - el.clientWidth, h: el.scrollHeight - el.clientHeight, text: (el.textContent ?? '').trim() }))
      expect(fit.text.length, `step ${i} has a name`).toBeGreaterThan(0)
      expect(fit.w, `step ${i} "${fit.text}" is cut sideways`).toBeLessThanOrEqual(1)
      expect(fit.h, `step ${i} "${fit.text}" is cut below`).toBeLessThanOrEqual(1)
      const b = (await n.boundingBox())!
      expect(b.x).toBeGreaterThanOrEqual(win.x)
      expect(b.x + b.width).toBeLessThanOrEqual(win.x + win.width + 0.5)
      await expect(n).toBeVisible()
    }
    expect(await list.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true)
    await shot(page, 'phone-trace-steps')
  })

  test("Phone: in All chats' Select mode the bar never covers the last chat", async ({ page }) => {
    await start(page, '#/chats/all')
    const main = page.locator('main')
    await main.getByRole('button', { name: 'Select', exact: true }).click()
    const bar = page.getByRole('toolbar', { name: 'Selected chats' })
    await expect(bar).toBeVisible()
    await main.evaluate(el => { el.scrollTop = el.scrollHeight })
    const last = main.locator('[data-chat-row]').last()
    await expect.poll(async () => (await last.boundingBox())!.y + (await last.boundingBox())!.height).toBeLessThanOrEqual((await bar.boundingBox())!.y)
    await shot(page, 'phone-select-last-row')
  })
})
