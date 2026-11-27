// Page actions (PR 6): Approvals edit, don't send, approve all low-risk and sort; Today snooze and dismiss with counts that
// agree everywhere, survive a reload and clear on Reset demo; approving a set-aside problem anywhere clears it, and Activity logs
// each set-aside; Tools requests open the team window; Usage bars by keyboard.
import { expect, test, type Fx } from './support/fx.js'
import type { Page } from '@playwright/test'

async function start(page: Page, fx: Fx, stage: 'Watch' | 'Act' | 'Run', scenario = 'Normal', hash = '#/today') {
  await fx.seed({ stage, scenario, demo: { ambient: 'Always', animateMark: true } })
  await page.goto('/?demo' + hash)
}

const shot = (page: Page, name: string) => page.screenshot({ path: test.info().outputPath(`${name}.png`), fullPage: true })
const badge = (page: Page) => page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: /Approvals/ })
/** Stage 1 M3-U: the demo's three agent cards (two batches and a teammate's refund) wait on Sam too, beside the drafts. */
const ASKS = 3
const card = (page: Page, title: string) => page.getByRole('article').filter({ hasText: title })
const toast = (page: Page, text: string | RegExp) => page.locator('[data-toast]').filter({ hasText: text })
const waiting = (page: Page) => page.getByRole('heading', { level: 2, name: /^Waiting for you/ })
const moreItem = async (page: Page, title: string, item: string) => {
  await draft(page, title).getByRole('button', { name: 'More' }).click()
  await page.getByRole('menu', { name: 'Draft actions' }).getByRole('menuitem', { name: item, exact: true }).click()
}
/** Approve a draft from its card: low-risk ones in one tap, the rest through Review in the panel. */
const approveDraft = async (page: Page, title: string) => {
  const d = draft(page, title)
  if (await d.getByRole('button', { name: 'Review draft', exact: true }).count()) {
    await d.getByRole('button', { name: 'Review draft', exact: true }).click()
    await page.getByRole('dialog').getByRole('button', { name: /^Approve/ }).click()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog')).toHaveCount(0)
  } else await d.getByRole('button', { name: /^Approve/ }).click()
}
const draft = (page: Page, title: string) => page.locator('[data-slot=card]').filter({ has: page.getByRole('heading', { level: 2, name: title, exact: true }) })

const D = {
  oversell: 'Pause the variant and email 5 customers',
  stock: 'Reorder 600 Ridge 30L Packs',
  payout: 'Open a reimbursement case',
  po: 'Chase Kestrel for a new ship date',
  returns: 'Restock 11 units on Shopify',
  stuck: "Ask ShipBob why #4821 hasn't shipped",
}
const ALL = Object.values(D)
/** The draft titles on Approvals, top to bottom. */
const draftOrder = async (page: Page) => (await page.getByRole('heading', { level: 2 }).allInnerTexts()).filter(t => ALL.includes(t))

test('Approvals: edit then approve and Undo, Don\'t send and Undo, approve all low-risk with one Undo, and sort', async ({ fx, page }) => {
  await start(page, fx, 'Act', 'Normal', '#/approvals')
  await expect(waiting(page)).toHaveText(/·\s6$/)
  await expect(badge(page)).toContainText(String(6 + ASKS))

  // Each draft shows the time it was made, from the data.
  await expect(draft(page, D.payout)).toContainText('· 6:06 AM')
  await expect(draft(page, D.stock)).toContainText('· 6:08 AM')

  // Edit opens the panel with the draft's text ready to change; the change survives approving and undoing.
  await moreItem(page, D.oversell, 'Edit')
  const panel = page.getByRole('dialog')
  const text = panel.getByRole('textbox', { name: 'Email to customers, in your tone' })
  await expect(text).toBeVisible()
  await text.fill('Hi Jamie, your Trail Shell ships on Tue 9 Dec. Edited in the e2e run.')
  await shot(page, 'approvals-editing')
  await panel.getByRole('button', { name: 'Approve and send 5 emails' }).click()
  const held = toast(page, 'Approved. It goes out in 10 seconds.')
  await expect(held).toBeVisible()
  // The open panel hides the page from the accessibility tree, so the badge is read once it closes.
  await page.keyboard.press('Escape')
  await expect(panel).toHaveCount(0)
  await expect(badge(page)).toContainText(String(5 + ASKS))
  await held.getByRole('button', { name: 'Undo', exact: true }).click()
  await expect(waiting(page)).toHaveText(/·\s6$/)
  await expect(badge(page)).toContainText(String(6 + ASKS))
  await expect(draft(page, D.oversell)).toContainText('Edited in the e2e run.')

  // Don't send takes the draft out of Waiting; Undo in the toast brings it back.
  await moreItem(page, D.returns, "Don't send")
  await expect(draft(page, D.returns)).toHaveCount(0)
  await expect(waiting(page)).toHaveText(/·\s5$/)
  await expect(badge(page)).toContainText(String(5 + ASKS))
  await toast(page, 'Not sent.').getByRole('button', { name: 'Undo', exact: true }).click()
  await expect(draft(page, D.returns)).toBeVisible()
  await expect(badge(page)).toContainText(String(6 + ASKS))

  // Approve all low-risk approves exactly the drafts with no money and no customers, and one Undo takes them all back.
  await page.getByRole('button', { name: 'Approve all low-risk' }).click()
  await expect(waiting(page)).toHaveText(/·\s3$/)
  expect((await draftOrder(page)).sort()).toEqual([D.oversell, D.payout, D.stock].sort())
  const approved = page.getByRole('region', { name: 'Approved today' })
  await expect(approved.getByRole('button', { name: 'Undo', exact: true })).toHaveCount(3)
  await expect(badge(page)).toContainText(String(3 + ASKS))
  await expect(page.getByRole('button', { name: 'Approve all low-risk' })).toHaveCount(0)
  await shot(page, 'approvals-approved-all-low-risk')
  await toast(page, 'Approved 3 drafts.').getByRole('button', { name: 'Undo', exact: true }).click()
  await expect(waiting(page)).toHaveText(/·\s6$/)
  await expect(approved).toHaveCount(0)
  await expect(badge(page)).toContainText(String(6 + ASKS))

  // The sort is real: oldest, newest and most at stake each give their own order (same-minute drafts keep the agent's order).
  expect(await draftOrder(page)).toEqual([D.payout, D.oversell, D.po, D.stock, D.returns, D.stuck])
  const sort = page.getByRole('combobox', { name: /^Sort drafts/ })
  await sort.click()
  await page.getByRole('option', { name: 'Most at stake' }).click()
  await expect(sort).toHaveAccessibleName('Sort drafts: Most at stake')
  expect(await draftOrder(page)).toEqual([D.stock, D.po, D.payout, D.oversell, D.returns, D.stuck])
  await sort.click()
  await page.getByRole('option', { name: 'Newest first' }).click()
  expect(await draftOrder(page)).toEqual([D.stock, D.returns, D.stuck, D.oversell, D.po, D.payout])
  await shot(page, 'approvals-newest-first')
})

test('Today: snooze one card and dismiss another; Today, Approvals and the badge agree, after a reload too, until Reset demo', async ({ fx, page }) => {
  await start(page, fx, 'Act')
  const h1 = page.getByRole('heading', { level: 1 })
  await expect(h1).toContainText('6 things need you. Drafts are ready.')
  await expect(page.getByRole('article')).toHaveCount(6)

  // The menu doesn't open the card's panel.
  await card(page, 'Order #4821 is stuck for 4 days').getByRole('button', { name: 'More' }).click()
  const menu = page.getByRole('menu', { name: 'Card actions' })
  await expect(menu.getByRole('menuitem')).toHaveCount(3)
  for (const name of ['Ask Inhouse', 'Snooze until tomorrow', 'Not a problem']) await expect(menu.getByRole('menuitem', { name, exact: true })).toBeVisible()
  await shot(page, 'today-card-menu')
  await menu.getByRole('menuitem', { name: 'Snooze until tomorrow' }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(card(page, 'Order #4821 is stuck for 4 days')).toHaveCount(0)

  // Undo in the toast brings the card back; snooze it again for real.
  await toast(page, 'Snoozed until tomorrow').getByRole('button', { name: 'Undo', exact: true }).click()
  await expect(card(page, 'Order #4821 is stuck for 4 days')).toBeVisible()
  await card(page, 'Order #4821 is stuck for 4 days').getByRole('button', { name: 'More' }).click()
  await page.getByRole('menu', { name: 'Card actions' }).getByRole('menuitem', { name: 'Snooze until tomorrow' }).click()

  await card(page, 'Amazon paid out $1,240 less than expected').getByRole('button', { name: 'More' }).click()
  await page.getByRole('menu', { name: 'Card actions' }).getByRole('menuitem', { name: 'Not a problem' }).click()
  await expect(toast(page, 'Dismissed.')).toBeVisible()

  const agree = async () => {
    await expect(page.getByRole('article')).toHaveCount(4)
    await expect(h1).toContainText('4 left to approve today.')
    await expect(page.getByRole('heading', { level: 2, name: /^Needs you/ })).toContainText('4 drafted and waiting')
    await expect(badge(page)).toContainText(String(4 + ASKS))
    await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: /Approvals/ }).click()
    await expect(waiting(page)).toHaveText(/·\s4$/)
    await expect(draft(page, D.stuck)).toHaveCount(0)
    await expect(draft(page, D.payout)).toHaveCount(0)
    await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: /Today/ }).click()
  }
  await agree()
  await shot(page, 'today-snoozed-dismissed')

  // A one-tap Approve on a low-risk card shows the toast with Undo, and the counts move together.
  await card(page, '11 returns are not restocked').getByRole('button', { name: 'Approve and restock', exact: true }).click()
  await expect(badge(page)).toContainText(String(3 + ASKS))
  await toast(page, '11 units restocked on Shopify').getByRole('button', { name: 'Undo', exact: true }).click()
  await expect(badge(page)).toContainText(String(4 + ASKS))

  await page.reload()
  await agree()

  await page.getByRole('button', { name: /Demo switches/ }).click()
  await page.getByRole('button', { name: 'Reset demo', exact: true }).click()
  await expect(page.getByRole('article')).toHaveCount(6)
  await expect(h1).toContainText('6 things need you. Drafts are ready.')
  await expect(badge(page)).toContainText(String(6 + ASKS))
})

test('Tools: Request a tool opens the team window; a disconnected tool has its own Reconnect; Pause access has Undo', async ({ fx, page }) => {
  await start(page, fx, 'Act', 'Tool disconnected', '#/tools')
  await page.getByRole('button', { name: 'Request a tool' }).click()
  const team = page.getByRole('dialog', { name: /Your Inhouse team/ })
  await expect(team).toBeVisible()
  await shot(page, 'tools-request-team-window')
  await page.keyboard.press('Escape')
  await expect(team).toHaveCount(0)
  // One way to ask for a tool: there is no second "Ask the team" button on the page.
  await expect(page.getByRole('button', { name: /Ask the team/ })).toHaveCount(0)

  await page.goto('/?demo#/tools/gorgias')
  // The page's own Reconnect sits beside Pause access, apart from the one in the disconnected banner.
  const pause = page.getByRole('button', { name: 'Pause access' })
  await expect(page.getByRole('alert').getByRole('button', { name: 'Reconnect', exact: true })).toBeVisible()
  await expect(pause.locator('..').getByRole('button', { name: 'Reconnect', exact: true })).toBeVisible()
  await pause.click()
  const paused = toast(page, 'Access paused.')
  await expect(paused).toBeVisible()
  await expect(page.getByRole('button', { name: 'Resume access' })).toBeVisible()
  await paused.getByRole('button', { name: 'Undo', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Pause access' })).toBeVisible()
})

test('Usage: the daily bars are one tab stop; arrows, Home and End move between days with the tooltip', async ({ fx, page }) => {
  await start(page, fx, 'Act', 'Normal', '#/usage')
  const bars = page.getByRole('grid', { name: 'Daily cost' }).getByRole('gridcell')
  // Usage loads on first visit (its own chunk): count once its bars are in.
  await expect(bars.first()).toBeVisible()
  const n = await bars.count()
  expect(n).toBeGreaterThan(10)
  // Tab from the top of the page reaches the first bar; only one bar is in the tab order.
  await page.locator('main').focus()
  for (let i = 0; i < 10 && !await bars.first().evaluate(el => el === document.activeElement); i++) await page.keyboard.press('Tab')
  await expect(bars.first()).toBeFocused()
  expect(await bars.evaluateAll(els => els.filter(e => e.getAttribute('tabindex') === '0').length)).toBe(1)
  await expect(page.getByRole('tooltip').filter({ hasText: /^Nov 1: \$\d+\.\d\d$/ })).toHaveCount(1)
  await page.keyboard.press('ArrowRight')
  await expect(bars.nth(1)).toBeFocused()
  await expect(page.getByRole('tooltip').filter({ hasText: /^Nov 2: \$\d+\.\d\d$/ })).toHaveCount(1)
  await page.keyboard.press('End')
  await expect(bars.nth(n - 1)).toBeFocused()
  await expect(page.getByRole('tooltip').filter({ hasText: new RegExp(`^Nov ${n}: \\$\\d+\\.\\d\\d$`) })).toHaveCount(1)
  await page.keyboard.press('ArrowRight')
  await expect(bars.nth(n - 1)).toBeFocused()
  await page.keyboard.press('Home')
  await expect(bars.first()).toBeFocused()
  await page.keyboard.press('ArrowLeft')
  await expect(bars.first()).toBeFocused()
  // Tab leaves the bars in one step, and Shift+Tab comes back to the last one focused.
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('Tab')
  await expect(bars.nth(1)).not.toBeFocused()
  expect(await bars.evaluateAll(els => els.some(e => e === document.activeElement))).toBe(false)
  await page.keyboard.press('Shift+Tab')
  await expect(bars.nth(1)).toBeFocused()
  await shot(page, 'usage-bar-tooltip')
})

const go = (page: Page, hash: string) => page.evaluate(h => { location.hash = h }, hash)
const actRow = (page: Page, text: string | RegExp) => page.locator('button[data-activity-row]').filter({ hasText: text })

test('A set-aside problem approved from the chat card or the Library\'s approval link is a normal approval everywhere; Activity logs each set-aside with Undo', async ({ fx, page }) => {
  await start(page, fx, 'Act', 'Normal', '#/approvals')

  // Don't send the ShipBob draft: Activity logs it, and its detail is searchable.
  await moreItem(page, D.stuck, "Don't send")
  await expect(waiting(page)).toHaveText(/·\s5$/)
  await go(page, '#/activity')
  const notSent = actRow(page, `Not sent: ask ShipBob why #4821 hasn't shipped`)
  await expect(notSent).toBeVisible()
  await page.getByRole('searchbox', { name: 'Search activity' }).fill('left Approvals')
  await expect(page.locator('button[data-activity-row]')).toHaveCount(1)
  // A time typed with a plain space finds the row, whose time carries a no-break space.
  await page.getByRole('searchbox', { name: 'Search activity' }).fill('every Friday at 4:00 PM')
  await expect(page.locator('button[data-activity-row]')).toHaveCount(1)
  await expect(actRow(page, 'Saved the weekly numbers report')).toBeVisible()
  await page.getByRole('searchbox', { name: 'Search activity' }).fill('')
  await notSent.click()
  // The line opens as a sheet that says who did it, with its one action.
  await expect(page.getByRole('dialog')).toContainText('Sam')
  await expect(page.getByRole('dialog').getByRole('button', { name: 'Undo', exact: true })).toBeVisible()
  await shot(page, 'activity-not-sent-line')

  // The chat still offers its approval card; approving there clears the set-aside.
  await go(page, '#/chats/stuck')
  await page.getByRole('button', { name: 'Approve and send to ShipBob' }).click()
  await expect(toast(page, 'Approved. It goes out in 10 seconds.')).toBeVisible()
  await expect(badge(page)).toContainText(String(5 + ASKS))
  await go(page, '#/approvals')
  await expect(waiting(page)).toHaveText(/·\s5$/)
  await expect(page.getByRole('region', { name: 'Approved today' })).toContainText("ask ShipBob why #4821 hasn't shipped")
  await go(page, '#/today')
  await expect(card(page, 'Order #4821 is stuck for 4 days')).toContainText('Approved by Sam at')
  await expect(page.getByRole('heading', { level: 2, name: /^Needs you/ })).toContainText('5 drafted and waiting')
  await go(page, '#/activity')
  await expect(actRow(page, 'Not sent:')).toHaveCount(0)
  await expect(actRow(page, `Approved: ask ShipBob why #4821 hasn't shipped`)).toBeVisible()

  // Snooze the Kestrel card on Today, then approve it from its file's "Open the approval" in the Library (the panel).
  await go(page, '#/today')
  await card(page, 'PO-1187 from Kestrel is 6 days late').getByRole('button', { name: 'More' }).click()
  await page.getByRole('menu', { name: 'Card actions' }).getByRole('menuitem', { name: 'Snooze until tomorrow' }).click()
  await expect(card(page, 'PO-1187 from Kestrel is 6 days late')).toHaveCount(0)
  await expect(badge(page)).toContainText(String(4 + ASKS))
  await go(page, '#/activity')
  await expect(actRow(page, 'Snoozed: PO-1187 from Kestrel is 6 days late')).toBeVisible()
  await go(page, '#/library')
  const file = page.getByRole('list', { name: 'Files' }).getByRole('listitem').filter({ hasText: 'PO-1187-kestrel-summit-fleece.pdf' })
  await file.hover()
  await file.getByRole('button', { name: 'Actions for PO-1187-kestrel-summit-fleece.pdf' }).click()
  await page.getByRole('menu', { name: 'File actions' }).getByRole('menuitem', { name: 'Open the approval' }).click()
  const panel = page.getByRole('dialog')
  await panel.getByRole('button', { name: 'Approve and send to Mei' }).click()
  await page.keyboard.press('Escape')
  await expect(panel).toHaveCount(0)
  await expect(badge(page)).toContainText(String(4 + ASKS))
  await go(page, '#/today')
  await expect(card(page, 'PO-1187 from Kestrel is 6 days late')).toContainText('Approved by Sam at')
  await go(page, '#/activity')
  await expect(actRow(page, 'Snoozed:')).toHaveCount(0)

  // Dismiss a card; Activity's Undo brings it back to Today.
  await go(page, '#/today')
  await card(page, '11 returns are not restocked').getByRole('button', { name: 'More' }).click()
  await page.getByRole('menu', { name: 'Card actions' }).getByRole('menuitem', { name: 'Not a problem' }).click()
  await expect(card(page, '11 returns are not restocked')).toHaveCount(0)
  await go(page, '#/activity')
  await actRow(page, 'Dismissed: 11 returns are not restocked').click()
  await page.getByRole('dialog').getByRole('button', { name: 'Undo', exact: true }).click()
  await expect(actRow(page, 'Dismissed:')).toHaveCount(0)
  await go(page, '#/today')
  await expect(card(page, '11 returns are not restocked')).toBeVisible()
  await expect(badge(page)).toContainText(String(4 + ASKS))
})

test('Counts leave set-aside problems out: Watch notifications and Approvals, an empty Today, and Act once every draft is approved or set aside', async ({ fx, page }) => {
  await start(page, fx, 'Watch')
  const h1 = page.getByRole('heading', { level: 1 })
  const snooze = async (title: string) => {
    await card(page, title).getByRole('button', { name: 'More' }).click()
    await page.getByRole('menu', { name: 'Card actions' }).getByRole('menuitem', { name: 'Snooze until tomorrow' }).click()
    await expect(card(page, title)).toHaveCount(0)
  }
  const titles = await page.getByRole('article').evaluateAll(els => els.map(e => e.getAttribute('aria-label')!))
  expect(titles).toHaveLength(6)
  await snooze(titles[0])
  await snooze(titles[1])
  await expect(h1).toContainText('4 things need you today.')
  await page.getByRole('button', { name: 'Notifications' }).click()
  await expect(page.getByText('Today has 4 things that need you.')).toBeVisible()
  await page.keyboard.press('Escape')
  await go(page, '#/approvals')
  await expect(page.getByText("In Act, today's 4 fixes would be waiting here")).toBeVisible()
  // The Watch block's list (the agent's action cards above it have rows of their own).
  await expect(page.locator('[data-watch-block]').getByRole('listitem')).toHaveCount(4)

  await go(page, '#/today')
  for (const t of titles.slice(2)) await snooze(t)
  await expect(h1).toContainText("You're all caught up.")
  await expect(page.getByRole('status').filter({ hasText: 'Every card is set aside for today.' })).toBeVisible()
  await shot(page, 'today-all-set-aside')
  await page.getByRole('button', { name: 'Notifications' }).click()
  await expect(page.getByText(/Today has \d+ things? that needs? you/)).toHaveCount(0)
  await page.keyboard.press('Escape')

  // Act: one draft not sent and the rest approved says so, not "all approved".
  await page.getByRole('button', { name: /Demo switches/ }).click()
  const demo = page.getByRole('dialog', { name: 'Demo switches' })
  await demo.getByRole('button', { name: 'Reset demo', exact: true }).click()
  await demo.getByRole('radiogroup', { name: 'Stage' }).getByRole('radio', { name: 'Act', exact: true }).click()
  await demo.getByRole('button', { name: 'Close demo switches' }).click()
  await go(page, '#/approvals')
  await moreItem(page, D.stuck, "Don't send")
  for (const t of ALL.filter(x => x !== D.stuck)) {
    await approveDraft(page, t)
    await expect(draft(page, t)).toHaveCount(0)
  }
  await go(page, '#/today')
  await expect(page.getByRole('heading', { level: 2, name: /^Nothing waiting/ })).toContainText('5 approved, 1 set aside')
})
