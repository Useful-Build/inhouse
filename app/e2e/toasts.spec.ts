// PR 3, the toast stack (H3, M3, M4): each toast keeps its own Undo and its own countdown, approvals going out share one
// toast with one Undo, a sent notice or any other notice never takes another toast's Undo, hover and focus pause the countdowns, the close button dismisses, and on a
// phone the stack sits above the chat's composer. Screenshots of each state are attached to the report.
// Time runs on Playwright's clock (`runFor`, and a held clock while a stack is built), so no check races a countdown.
import { expect, test, type Fx } from './support/fx.js'
import type { Page } from '@playwright/test'

async function start(page: Page, fx: Fx, hash = '#/today') {
  await page.clock.install()
  await fx.seed({ stage: 'Act' })
  await page.goto('/?demo' + hash)
}

const settled = (page: Page) => page.evaluate(() => Promise.all(document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished)))
const shot = async (page: Page, name: string) => { await settled(page); await page.screenshot({ path: test.info().outputPath(`${name}.png`) }) }
const card = (page: Page, title: string) => page.getByRole('article').filter({ hasText: title })
const toasts = (page: Page) => page.locator('[data-toast-stack] [data-toast]')
const toast = (page: Page, text: string | RegExp) => toasts(page).filter({ hasText: text })
const HELD = 'Approved. It goes out in 10 seconds.'
const PO = 'PO-1187 from Kestrel is 6 days late'
const STUCK = 'Order #4821 is stuck for 4 days'
const approveOnCard = (page: Page, title: string) => card(page, title).getByRole('button', { name: 'Approve', exact: true }).click()

/** Holds the clock: no toast counts down until `resume`. Half a second ahead, so the clock can't have passed it first. */
async function hold(page: Page) {
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 500))
}
/** Deletes a routine from its row menu, through the confirm dialog. */
async function deleteRoutine(page: Page, name: string) {
  await page.getByRole('button', { name: `Actions for ${name}` }).click()
  await page.getByRole('menu', { name: 'Routine actions' }).getByRole('menuitem', { name: 'Delete' }).click()
  await page.getByRole('dialog', { name: 'Delete routine' }).getByRole('button', { name: 'Delete', exact: true }).click()
  await expect(page.getByRole('button', { name, exact: true })).toHaveCount(0)
}

test('Toasts: two approvals five seconds apart share one toast, and its one Undo takes back both', async ({ fx, page }) => {
  await start(page, fx)
  await approveOnCard(page, PO)
  await expect(toast(page, HELD)).toHaveCount(1)
  await page.clock.runFor(5000)
  await approveOnCard(page, STUCK)
  // The second joins the first: one toast for both, so held approvals never grow the stack.
  await expect(toasts(page)).toHaveCount(1)
  await expect(toasts(page)).toContainText('Approved 2 drafts. They go out in 10 seconds.')
  await shot(page, 'toasts-two-approvals')

  // One Undo takes back both, before either goes out.
  await toasts(page).getByRole('button', { name: 'Undo', exact: true }).click()
  await expect(toasts(page)).toHaveCount(0)
  await expect(card(page, STUCK).getByRole('button', { name: 'Approve', exact: true })).toBeVisible()
  await expect(card(page, PO).getByRole('button', { name: 'Approve', exact: true })).toBeVisible()

  // Nothing went out.
  await page.clock.runFor(11_000)
  await expect(toast(page, /sent/i)).toHaveCount(0)
  await expect(card(page, PO).getByRole('button', { name: 'Approve', exact: true })).toBeVisible()
  await expect(card(page, STUCK).getByRole('button', { name: 'Approve', exact: true })).toBeVisible()
  await shot(page, 'toasts-two-approvals-undone')
})

test("Toasts: the first approval's sent notice shows on its own; the shared toast keeps its Undo for the second until it goes out", async ({ fx, page }) => {
  await start(page, fx)
  await approveOnCard(page, PO)
  await page.clock.runFor(5000)
  await approveOnCard(page, STUCK)
  const shared = toast(page, 'Approved 2 drafts.')
  await expect(shared).toContainText('They go out in 10 seconds.')

  // 10 s after the first approval it goes out: its notice shows, and the shared toast stays (same toast) for the second.
  await page.clock.runFor(5500)
  await expect(toast(page, 'Chase sent to Mei at Kestrel')).toBeVisible()
  await expect(shared).toContainText('1 goes out in 10 seconds.')
  await expect(shared.getByRole('button', { name: 'Undo', exact: true })).toBeVisible()
  await shot(page, 'toasts-sent-notice-keeps-other-undo')
  await shared.getByRole('button', { name: 'Undo', exact: true }).click()
  await expect(shared).toHaveCount(0)
  await expect(card(page, STUCK).getByRole('button', { name: 'Approve', exact: true })).toBeVisible()
  await page.clock.runFor(6000)
  await expect(toast(page, 'Message sent to ShipBob about #4821')).toHaveCount(0)
})

test('Toasts: delete two routines and undo both; a notice never pushes out an Undo', async ({ fx, page }) => {
  await start(page, fx, '#/routines')
  await expect(page.getByRole('heading', { level: 1, name: 'Routines' })).toBeVisible()
  await deleteRoutine(page, 'Monday reorder list')
  await deleteRoutine(page, 'Amazon payout check')
  await expect(toast(page, 'Deleted Monday reorder list').getByRole('button', { name: 'Undo', exact: true })).toBeVisible()
  await expect(toast(page, 'Deleted Amazon payout check').getByRole('button', { name: 'Undo', exact: true })).toBeVisible()
  await shot(page, 'toasts-routines-two-deletes')
  // Each Undo brings back its own routine.
  await toast(page, 'Deleted Monday reorder list').getByRole('button', { name: 'Undo', exact: true }).click()
  await toast(page, 'Deleted Amazon payout check').getByRole('button', { name: 'Undo', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Monday reorder list', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Amazon payout check', exact: true })).toBeVisible()
  await expect(toasts(page).filter({ has: page.getByRole('button', { name: 'Undo', exact: true }) })).toHaveCount(0)

  // Three deletes and two notices (Run now) make five: the oldest notice leaves, all three Undos stay. The clock holds
  // while the stack is built, so no toast times out on a slow run.
  await hold(page)
  await deleteRoutine(page, 'Monday reorder list')
  await deleteRoutine(page, 'Amazon payout check')
  await deleteRoutine(page, 'Weekly numbers report')
  for (let i = 0; i < 2; i++) {
    await page.getByRole('button', { name: 'Actions for Morning check' }).click()
    await page.getByRole('menu', { name: 'Routine actions' }).getByRole('menuitem', { name: 'Run now' }).click()
    // The menu animates out: opening it again before it has gone clicks the closing menu's item, which then detaches.
    await expect(page.getByRole('menu', { name: 'Routine actions' })).toHaveCount(0)
  }
  await expect(toasts(page)).toHaveCount(4)
  await toasts(page).first().hover()
  await expect(toasts(page).filter({ has: page.getByRole('button', { name: 'Undo', exact: true }) })).toHaveCount(3)
  await expect(toast(page, 'Morning check is running now')).toHaveCount(1)
  await shot(page, 'toasts-routines-stack-of-four')

  // A fourth delete pushes out the notice, not an Undo. Then a notice over four Undo toasts shows as a fifth.
  await deleteRoutine(page, 'Stuck orders check')
  await expect(toasts(page)).toHaveCount(4)
  await expect(toasts(page).filter({ has: page.getByRole('button', { name: 'Undo', exact: true }) })).toHaveCount(4)
  await page.getByRole('button', { name: 'Actions for Morning check' }).click()
  await page.getByRole('menu', { name: 'Routine actions' }).getByRole('menuitem', { name: 'Run now' }).click()
  await expect(toasts(page)).toHaveCount(5)
  await expect(toasts(page).filter({ has: page.getByRole('button', { name: 'Undo', exact: true }) })).toHaveCount(4)
  await expect(toasts(page).last()).toContainText('Morning check is running now')
  await shot(page, 'toasts-routines-notice-over-four-undos')

  await toast(page, 'Deleted Weekly numbers report').getByRole('button', { name: 'Undo', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Weekly numbers report', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Monday reorder list', exact: true })).toHaveCount(0)
  await page.clock.resume()
})

test('Toasts: a held approval is never pushed out, not even by four Undo toasts after it', async ({ fx, page }) => {
  await start(page, fx)
  await hold(page)
  await approveOnCard(page, PO)
  await expect(toast(page, HELD)).toHaveCount(1)
  // Four snoozes, each with Undo, after the held approval: the fifth toast pushes out the oldest snooze, never the hold.
  for (const title of [STUCK, 'Ridge 30L Pack runs out in 9 days', 'Trail Shell Jacket', 'Amazon paid out']) {
    await card(page, title).getByRole('button', { name: 'More' }).click()
    await page.getByRole('menuitem', { name: 'Snooze until tomorrow' }).click()
    await expect(page.getByRole('menu')).toHaveCount(0)
  }
  await expect(toasts(page)).toHaveCount(4)
  await expect(toasts(page).first()).toContainText(HELD)
  await expect(toast(page, HELD)).toHaveCount(1)
  await expect(toast(page, HELD).getByRole('button', { name: 'Undo', exact: true })).toBeVisible()
  await shot(page, 'toasts-held-stays')
  await page.clock.resume()
})

test('Toasts: after a keyboard Undo or Dismiss, focus goes to the next toast, then to the page', async ({ fx, page }) => {
  await start(page, fx)
  await hold(page)
  for (const title of [PO, STUCK]) {
    await card(page, title).getByRole('button', { name: 'More' }).click()
    await page.getByRole('menuitem', { name: 'Snooze until tomorrow' }).click()
    await expect(page.getByRole('menu')).toHaveCount(0)
  }
  await expect(toasts(page)).toHaveCount(2)
  // The close button is "Dismiss", described by its toast's text.
  const close = toasts(page).first().getByRole('button', { name: 'Dismiss', exact: true })
  await expect(close).toHaveAccessibleDescription('Snoozed until tomorrow')
  await page.keyboard.press('F6')
  await expect(toasts(page).last().getByRole('button', { name: 'Undo', exact: true })).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(toasts(page)).toHaveCount(1)
  await expect(toasts(page).first().getByRole('button', { name: 'Undo', exact: true })).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(toasts(page).first().getByRole('button', { name: 'Dismiss', exact: true })).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(toasts(page)).toHaveCount(0)
  // None left: focus goes back to where F6 came from (here nothing was focused, so the page).
  await expect(page.locator('main')).toBeFocused()
  await page.clock.resume()
})

test('Toasts: hover pauses the countdown, leaving resumes it, and the close button dismisses', async ({ fx, page }) => {
  await start(page, fx)
  await card(page, PO).getByRole('button', { name: 'More' }).click()
  await page.getByRole('menuitem', { name: 'Snooze until tomorrow' }).click()
  const snoozed = toast(page, 'Snoozed until tomorrow')
  await expect(snoozed).toBeVisible()
  await snoozed.hover()
  // Past its 7 s while the pointer is on it: still there, with Undo.
  await page.clock.runFor(9000)
  await expect(snoozed.getByRole('button', { name: 'Undo', exact: true })).toBeVisible()
  await shot(page, 'toasts-hover-paused')
  await page.mouse.move(5, 5)
  await page.clock.runFor(7500)
  await expect(snoozed).toHaveCount(0)

  // Close dismisses at once, and leaves the other toast alone.
  await card(page, STUCK).getByRole('button', { name: 'More' }).click()
  await page.getByRole('menuitem', { name: 'Snooze until tomorrow' }).click()
  await card(page, 'Ridge 30L Pack runs out in 9 days').getByRole('button', { name: 'More' }).click()
  await page.getByRole('menuitem', { name: 'Not a problem' }).click()
  await expect(toasts(page)).toHaveCount(2)
  await toast(page, 'Snoozed until tomorrow').getByRole('button', { name: 'Dismiss' }).click()
  await expect(toast(page, 'Snoozed until tomorrow')).toHaveCount(0)
  await expect(toast(page, "Dismissed. It won't come back today.").getByRole('button', { name: 'Undo', exact: true })).toBeVisible()
  await shot(page, 'toasts-dismissed-one')
  // A mouse Dismiss moves no focus into the stack and leaves nothing paused: the other toast still times out.
  expect(await page.evaluate(() => !!document.activeElement?.closest('[data-toast-stack]'))).toBe(false)
  await page.mouse.move(5, 5)
  await page.clock.runFor(7500)
  await expect(toasts(page)).toHaveCount(0)
})

test('Toasts: when the focused toast leaves on its own, focus goes to the newest toast, not the page', async ({ fx, page }) => {
  await start(page, fx)
  await approveOnCard(page, PO)
  const held = toast(page, HELD)
  await expect(held).toHaveCount(1)
  await page.keyboard.press('F6')
  await expect(held.getByRole('button', { name: 'Undo', exact: true })).toBeFocused()
  // The draft goes out 10 s later: the held toast leaves and focus moves to the sent notice that took its place.
  await page.clock.runFor(10_500)
  await expect(held).toHaveCount(0)
  await expect(toast(page, 'Chase sent to Mei at Kestrel').getByRole('button', { name: 'Dismiss', exact: true })).toBeFocused()
  await shot(page, 'toasts-focus-follows-sent-notice')
})

test.describe('Toasts on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true })

  test('the stack sits above the composer in a chat, and Undo and close are tap-size', async ({ fx, page }) => {
    await start(page, fx, '#/chats/refunds')
    await page.locator('main').getByRole('button', { name: 'More' }).last().click({ force: true })
    await page.getByRole('menuitem', { name: 'Delete' }).click()
    const deleted = toast(page, 'Message deleted')
    await expect(deleted).toBeVisible()
    const composer = page.locator('[data-composer]')
    const t = await deleted.boundingBox()
    const c = await composer.boundingBox()
    expect(t && c && t.y + t.height <= c.y).toBe(true)
    for (const b of [deleted.getByRole('button', { name: 'Undo', exact: true }), deleted.getByRole('button', { name: 'Dismiss' })]) {
      // TAP widens the target with an ::after of at least 44px each way.
      const min = await b.evaluate(el => { const r = getComputedStyle(el, '::after'); return [parseFloat(r.minWidth), parseFloat(r.minHeight)] })
      expect(Math.min(...min)).toBeGreaterThanOrEqual(44)
    }
    await shot(page, 'toasts-phone-above-composer')
  })
})
