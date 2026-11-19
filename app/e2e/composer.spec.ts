// PR 4, the composer: a growing multi-line field, Send that turns into Stop mid-answer and is off while empty,
// files by paste and drop with a limit, and a draft kept per chat (and Today's apart).
import { expect, test } from '@playwright/test'
import type { Locator, Page } from '@playwright/test'

async function start(page: Page, hash = '#/today') {
  await page.addInitScript(() => {
    if (sessionStorage.getItem('e2e-seeded')) return
    localStorage.clear()
    localStorage.setItem('inhouse.demo.switches.v1', JSON.stringify({ stage: 'Act', scenario: 'Normal', ambient: 'Always', animateMark: false }))
    sessionStorage.setItem('e2e-seeded', '1')
  })
  await page.goto('/?demo' + hash)
}

const shot = async (page: Page, name: string) => { await page.waitForTimeout(300); await page.screenshot({ path: test.info().outputPath(`${name}.png`) }) }
const composer = (page: Page) => page.locator('[data-composer]')
const chatField = (page: Page) => page.getByRole('textbox', { name: 'Message your Inhouse agent' })
const todayField = (page: Page) => page.getByRole('textbox', { name: 'Ask your Inhouse agent' })
const side = (page: Page) => page.getByRole('complementary', { name: 'Sidebar' })
const openChat = (page: Page, title: string) => side(page).getByRole('button', { name: title, exact: true }).click()
const height = (l: Locator) => l.evaluate(el => el.getBoundingClientRect().height)

/** Pastes files into the field the way a browser does: a paste event whose clipboard holds them. */
async function pasteFiles(field: Locator, files: { name: string; type: string; bytes: number }[]) {
  await field.evaluate((el, list) => {
    const dt = new DataTransfer()
    for (const f of list) dt.items.add(new File([new Uint8Array(f.bytes)], f.name, { type: f.type }))
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
  }, files)
}

/** Drags files over the composer (checking the drop state shows), then drops them, on the composer or a part inside it. */
async function dropFiles(page: Page, files: { name: string; type: string; bytes: number }[], target?: Locator) {
  const box = composer(page)
  const dt = await page.evaluateHandle(list => {
    const d = new DataTransfer()
    for (const f of list) d.items.add(new File([new Uint8Array(f.bytes)], f.name, { type: f.type }))
    return d
  }, files)
  await box.dispatchEvent('dragenter', { dataTransfer: dt })
  await box.dispatchEvent('dragover', { dataTransfer: dt })
  await expect(box).toHaveAttribute('data-dragging', 'true')
  await expect(box).toHaveCSS('border-top-style', 'dashed')
  await shot(page, 'composer-drop-state')
  await (target ?? box).dispatchEvent('drop', { dataTransfer: dt })
  await expect(box).not.toHaveAttribute('data-dragging', 'true')
  await expect(box).toHaveCSS('border-top-style', 'solid')
}

test('Composer: a multi-line question grows the field and keeps its lines; Send is off while empty; Stop ends the run', async ({ page }) => {
  await start(page, '#/chats/refunds')
  const field = chatField(page)
  // Opening a chat on desktop puts the caret in its composer.
  await expect(field).toBeFocused()

  // On desktop Enter sends, and the keyboard hint says so.
  await expect(field).toHaveAttribute('enterkeyhint', 'send')
  const send = composer(page).getByRole('button', { name: 'Send' })
  await expect(send).toBeDisabled()
  await field.fill('   ')
  await expect(send).toBeDisabled()
  await field.fill('')

  // The refunds chat already holds one answer; the stopped run must not add another.
  const answers = await page.getByText(/Refund requests rose from 14/).count()
  const one = await height(field)
  await field.pressSequentially('Why did refunds jump this week?')
  await expect(send).toBeEnabled()
  await page.keyboard.press('Shift+Enter')
  await field.pressSequentially('Split it by product')
  await page.keyboard.press('Shift+Enter')
  await field.pressSequentially('and by channel')
  await expect(field).toHaveValue('Why did refunds jump this week?\nSplit it by product\nand by channel')
  const three = await height(field)
  expect(three, `one line ${one}px, three lines ${three}px`).toBeGreaterThan(one * 2)

  // It stops growing at 8 lines and scrolls.
  for (let i = 0; i < 10; i++) await page.keyboard.press('Shift+Enter')
  const capped = await field.evaluate(el => {
    const cs = getComputedStyle(el)
    return { h: el.clientHeight, scroll: el.scrollHeight, lines8: 8 * parseFloat(cs.lineHeight) + parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom) }
  })
  expect(capped.scroll).toBeGreaterThan(capped.h)
  // Scrolled, its top edge fades, so a cut line reads as more above (M12).
  await expect.poll(() => field.evaluate(el => getComputedStyle(el).maskImage)).toContain('gradient')
  // The cap is exactly 8 lines of text plus the field's padding.
  expect(capped.h, `capped at ${capped.h}px, 8 lines are ${capped.lines8}px`).toBeCloseTo(capped.lines8, 0)
  const max = await height(field)
  for (let i = 0; i < 3; i++) await page.keyboard.press('Shift+Enter')
  expect(await height(field)).toBe(max)
  for (let i = 0; i < 13; i++) await page.keyboard.press('Backspace')
  await expect(field).toHaveValue('Why did refunds jump this week?\nSplit it by product\nand by channel')
  await shot(page, 'composer-multiline')

  await page.keyboard.press('Enter')
  const sent = page.locator('main [data-chat-msg]').filter({ hasText: 'Split it by product' }).last()
  await expect(sent).toBeVisible()
  // The bubble keeps the line breaks: three lines tall, the words on separate lines.
  expect(await sent.locator('div').first().evaluate(el => (el as HTMLElement).innerText)).toContain('this week?\nSplit it by product\nand by channel')
  await expect(field).toHaveValue('')
  expect(await height(field)).toBe(one)

  // While the answer streams, Send is Stop in the same place. A typed message gets its own Queue button beside Stop, and
  // Enter queues it: it waits above the box, not in the thread (H8).
  const stop = composer(page).getByRole('button', { name: 'Stop' })
  await expect(stop).toBeVisible()
  await expect(composer(page).getByRole('button', { name: 'Send' })).toHaveCount(0)
  await field.fill('And last month?')
  await expect(composer(page).getByRole('button', { name: 'Queue message' })).toBeVisible()
  await expect(stop).toBeVisible()
  await page.keyboard.press('Enter')
  await expect(page.locator('main [data-chat-msg]').filter({ hasText: 'And last month?' })).toHaveCount(0)
  const queued = page.getByRole('list', { name: 'Queued messages' }).getByRole('listitem')
  await expect(queued).toHaveCount(1)
  await expect(queued).toContainText('And last month?')
  await expect(field).toHaveValue('')
  await shot(page, 'composer-stop')
  // Remove takes it out; nothing is sent.
  await queued.getByRole('button', { name: 'Remove queued message' }).click()
  await expect(queued).toHaveCount(0)
  await field.fill('And last month?')

  await stop.click()
  await expect(page.getByText('You stopped your Inhouse agent. Nothing was changed.')).toBeVisible()
  await expect(stop).toHaveCount(0)
  await expect(composer(page).getByRole('button', { name: 'Send' })).toBeEnabled()
  await page.waitForTimeout(3000)
  await expect(page.getByText(/Refund requests rose from 14/)).toHaveCount(answers)
})

test('Composer: pasted and dropped files become chips, a file over the limit says why and is not added, and they go with the question', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await start(page, '#/chats/stuck')
  const field = chatField(page)
  await expect(field).toBeFocused()

  // Pasting plain text types it, with no chip.
  await page.evaluate(() => navigator.clipboard.writeText('Orders from the sheet'))
  await page.keyboard.press('ControlOrMeta+V')
  await expect(field).toHaveValue('Orders from the sheet')
  await expect(composer(page).getByRole('button', { name: /^Remove / })).toHaveCount(0)
  await field.fill('')

  await pasteFiles(field, [{ name: 'returns-week-46.csv', type: 'text/csv', bytes: 4_200 }])
  await expect(composer(page).getByRole('button', { name: 'Remove returns-week-46.csv' })).toBeVisible()
  // Pasting a file doesn't type anything.
  await expect(field).toHaveValue('')

  // Dropped on the field itself, the files still land in the composer.
  await dropFiles(page, [
    { name: 'damaged-parcel.png', type: 'image/png', bytes: 180_000 },
    { name: 'warehouse-walkthrough.mov', type: 'video/quicktime', bytes: 21_000_000 },
  ], field)
  await expect(composer(page).getByRole('button', { name: 'Remove damaged-parcel.png' })).toBeVisible()
  await expect(composer(page).getByRole('button', { name: 'Remove warehouse-walkthrough.mov' })).toHaveCount(0)
  const note = composer(page).locator('[data-rejected]')
  await expect(note).toHaveCount(1)
  await expect(note).toContainText('warehouse-walkthrough.mov')
  await expect(note).toContainText('Over the 20 MB limit')
  // Rejected files are announced once, together, in one alert region.
  await expect(composer(page).locator('[role=alert]')).toHaveCount(1)
  await expect(composer(page).locator('[role=alert] [data-rejected]')).toHaveCount(1)
  await shot(page, 'composer-files')

  // The count limit: 10 files per message.
  await pasteFiles(field, Array.from({ length: 9 }, (_, i) => ({ name: `invoice-${i + 1}.pdf`, type: 'application/pdf', bytes: 2_000 })))
  await expect(composer(page).getByRole('button', { name: /^Remove / })).toHaveCount(10)
  await expect(note).toHaveCount(1)
  await expect(note).toContainText('invoice-9.pdf')
  await expect(note).toContainText('Only 10 files per message')
  // Dismiss is a real button: 28px square.
  const dismiss = note.getByRole('button', { name: 'Dismiss invoice-9.pdf' })
  const dbox = (await dismiss.boundingBox())!
  expect([dbox.width, dbox.height]).toEqual([28, 28])
  expect((await composer(page).getByRole('button', { name: 'Remove returns-week-46.csv' }).boundingBox())!.height).toBe(28)
  await dismiss.click()
  await expect(note).toHaveCount(0)
  for (let i = 1; i <= 8; i++) await composer(page).getByRole('button', { name: `Remove invoice-${i}.pdf` }).click()
  await expect(composer(page).getByRole('button', { name: /^Remove / })).toHaveCount(2)

  await field.fill('Which of these orders are late?')
  await page.keyboard.press('Enter')
  const sent = page.locator('main [data-chat-msg]').filter({ hasText: 'Which of these orders are late?' })
  await expect(sent).toContainText('returns-week-46.csv')
  await expect(sent).toContainText('damaged-parcel.png')
  await expect(composer(page).getByRole('button', { name: /^Remove / })).toHaveCount(0)

  // A drag that is called off with Escape clears the drop state, and a file dropped outside the composer is ignored
  // (the browser doesn't leave the app to open it).
  const dt = await page.evaluateHandle(() => { const d = new DataTransfer(); d.items.add(new File(['x'], 'stray.pdf', { type: 'application/pdf' })); return d })
  await composer(page).dispatchEvent('dragenter', { dataTransfer: dt })
  await expect(composer(page)).toHaveAttribute('data-dragging', 'true')
  await page.keyboard.press('Escape')
  await expect(composer(page)).not.toHaveAttribute('data-dragging', 'true')
  const ignored = await page.evaluate(() => {
    const d = new DataTransfer(); d.items.add(new File(['x'], 'stray.pdf', { type: 'application/pdf' }))
    const ev = new DragEvent('drop', { dataTransfer: d, bubbles: true, cancelable: true })
    document.querySelector('header')!.dispatchEvent(ev)
    return ev.defaultPrevented
  })
  expect(ignored).toBe(true)
  await expect(composer(page).getByRole('button', { name: /^Remove / })).toHaveCount(0)

  // A new chat starts with no files, even after another new chat that had some.
  await side(page).getByRole('button', { name: 'New chat' }).click()
  await pasteFiles(chatField(page), [{ name: 'new-chat.csv', type: 'text/csv', bytes: 1_000 }])
  await expect(composer(page).getByRole('button', { name: 'Remove new-chat.csv' })).toBeVisible()
  await side(page).getByRole('button', { name: 'New chat' }).click()
  await expect(composer(page).getByRole('button', { name: /^Remove / })).toHaveCount(0)
})

test('Composer: each chat keeps its own draft and files, Today keeps its own, sending clears only that one, Reset demo clears all', async ({ page }) => {
  await start(page, '#/chats/refunds')
  await expect(chatField(page)).toBeFocused()
  await chatField(page).fill('Draft for refunds\nsecond line')
  await pasteFiles(chatField(page), [{ name: 'refunds.csv', type: 'text/csv', bytes: 3_000 }])

  // Clicking the chat that is already open keeps its draft, files and reply.
  await page.getByRole('log', { name: 'Conversation' }).getByRole('button', { name: 'Reply', exact: true }).last().click()
  await expect(composer(page).getByText('Replying to Inhouse agent')).toBeVisible()
  await openChat(page, 'Why did refunds jump?')
  await expect(chatField(page)).toHaveValue('Draft for refunds\nsecond line')
  await expect(composer(page).getByRole('button', { name: 'Remove refunds.csv' })).toBeVisible()
  await expect(composer(page).getByText('Replying to Inhouse agent')).toBeVisible()
  const stopReplying = composer(page).getByRole('button', { name: 'Stop replying' })
  expect((await stopReplying.boundingBox())!.height).toBeGreaterThanOrEqual(24)
  await stopReplying.click()
  await expect(composer(page).getByText('Replying to Inhouse agent')).toHaveCount(0)

  await openChat(page, 'Stuck orders over 3 days')
  await expect(chatField(page)).toBeFocused()
  await expect(chatField(page)).toHaveValue('')
  await expect(composer(page).getByRole('button', { name: /^Remove / })).toHaveCount(0)
  await chatField(page).fill('Draft for stuck orders')

  await side(page).getByRole('button', { name: 'Today', exact: true }).click()
  await expect(todayField(page)).toHaveValue('')
  await expect(composer(page).getByRole('button', { name: /^Remove / })).toHaveCount(0)
  await todayField(page).fill('Draft on Today')
  await pasteFiles(todayField(page), [{ name: 'today-note.txt', type: 'text/plain', bytes: 500 }])

  await openChat(page, 'Why did refunds jump?')
  await expect(chatField(page)).toHaveValue('Draft for refunds\nsecond line')
  await expect(composer(page).getByRole('button', { name: 'Remove refunds.csv' })).toBeVisible()
  await expect(composer(page).getByRole('button', { name: 'Remove today-note.txt' })).toHaveCount(0)

  await openChat(page, 'Stuck orders over 3 days')
  await expect(chatField(page)).toHaveValue('Draft for stuck orders')
  await expect(composer(page).getByRole('button', { name: /^Remove / })).toHaveCount(0)

  // Back and Forward land on the same drafts.
  await page.goBack()
  await expect(chatField(page)).toHaveValue('Draft for refunds\nsecond line')
  await page.goForward()
  await expect(chatField(page)).toHaveValue('Draft for stuck orders')

  // Asking in a chat leaves Today's draft alone.
  await chatField(page).fill('Which carrier is slowest?')
  await chatField(page).press('Enter')
  await expect(page.locator('main [data-chat-msg]').filter({ hasText: 'Which carrier is slowest?' })).toBeVisible()
  await side(page).getByRole('button', { name: 'Today', exact: true }).click()
  await expect(todayField(page)).toHaveValue('Draft on Today')
  await expect(composer(page).getByRole('button', { name: 'Remove today-note.txt' })).toBeVisible()

  // Sending from Today starts a chat with Today's file and clears Today's draft only.
  await side(page).getByRole('button', { name: 'Today', exact: true }).click()
  await expect(todayField(page)).toHaveValue('Draft on Today')
  await expect(composer(page).getByRole('button', { name: 'Remove today-note.txt' })).toBeVisible()
  await todayField(page).press('Enter')
  const sent = page.locator('main [data-chat-msg]').filter({ hasText: 'Draft on Today' })
  await expect(sent).toContainText('today-note.txt')
  await expect(chatField(page)).toHaveValue('')
  await side(page).getByRole('button', { name: 'Today', exact: true }).click()
  await expect(todayField(page)).toHaveValue('')
  await expect(composer(page).getByRole('button', { name: /^Remove / })).toHaveCount(0)

  await openChat(page, 'Why did refunds jump?')
  await expect(chatField(page)).toHaveValue('Draft for refunds\nsecond line')
  await shot(page, 'composer-draft-kept')

  // Reset demo clears every draft.
  await page.getByRole('button', { name: /^Demo switches/ }).click()
  await page.getByRole('button', { name: 'Reset demo' }).click()
  await openChat(page, 'Why did refunds jump?')
  await expect(chatField(page)).toHaveValue('')
  await expect(composer(page).getByRole('button', { name: /^Remove / })).toHaveCount(0)
  await openChat(page, 'Stuck orders over 3 days')
  await expect(chatField(page)).toHaveValue('')
})
