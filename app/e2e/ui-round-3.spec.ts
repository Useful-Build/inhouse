// UI plan 3 at 1440, the flows no older spec walks: the review window's queue stepping, an Activity line's Review the
// draft, the team window's Withdraw (Closed tab, Undo, the account menu's count), a skill page's Try in a chat and its
// Versions, the Settings menu's five sections, the account menu's role badge and the sidebar's collapse button in its
// bottom row. The member's lock on Settings is in real/settings-lock.spec.ts (the demo has no member).
import { expect, test, type Fx } from './support/fx.js'
import type { Page } from '@playwright/test'

async function start(page: Page, fx: Fx, hash: string) {
  await fx.seed({ stage: 'Act', demo: { ambient: 'Always' } })
  await page.goto('/?demo' + hash)
  await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible()
}
const side = (page: Page) => page.getByRole('complementary', { name: 'Sidebar' })
const toast = (page: Page, text: string) => page.locator('[data-toast]').filter({ hasText: text })
const team = (page: Page) => page.getByRole('dialog', { name: 'Your Inhouse team' })

async function accountItem(page: Page, name: string | RegExp) {
  const menu = page.getByRole('menu', { name: 'Account' })
  await expect(menu).toHaveCount(0)
  await side(page).getByRole('button', { name: /account and settings/i }).click()
  await expect(menu).toBeVisible()
  await menu.getByRole('menuitem', typeof name === 'string' ? { name, exact: true } : { name }).click()
}

test('Review window: Previous and Next step through the cards that need you, in the order Today shows them', async ({ fx, page }) => {
  await start(page, fx, '#/today')
  const cards = page.getByRole('main').getByRole('article')
  const titles = await cards.evaluateAll(els => els.map(e => e.getAttribute('aria-label') ?? ''))
  expect(titles.length, 'Act has several cards waiting').toBeGreaterThan(2)
  await cards.first().getByRole('button', { name: /^Review/ }).first().click()
  const win = page.getByRole('dialog')
  const title = win.getByRole('heading', { level: 2 })
  await expect(title).toHaveText(titles[0])
  await expect(win).toContainText(`1 of ${titles.length}`)
  await expect(win.getByRole('button', { name: 'Previous' })).toBeDisabled()
  await win.getByRole('button', { name: 'Next' }).click()
  await expect(title).toHaveText(titles[1])
  await expect(win).toContainText(`2 of ${titles.length}`)
  await win.getByRole('button', { name: 'Previous' }).click()
  await expect(title).toHaveText(titles[0])

  // The window sits in the room right of the sidebar and never covers it.
  // The sidebar is hidden from the accessibility tree behind the modal, so it's found by its id here.
  const sidebar = (await page.locator('#sidebar').boundingBox())!
  const box = (await win.boundingBox())!
  expect(box.x).toBeGreaterThanOrEqual(sidebar.x + sidebar.width)
  const room = 1440 - (sidebar.x + sidebar.width)
  expect(Math.abs(box.x + box.width / 2 - (sidebar.x + sidebar.width + room / 2)), 'centred in that room').toBeLessThanOrEqual(12)

  // Escape on the window's More menu closes the menu only; the next Escape closes the window.
  await win.getByRole('button', { name: 'More', exact: true }).click()
  const more = page.getByRole('menu', { name: 'More actions' })
  await expect(more).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(more).toHaveCount(0)
  await expect(win).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)
})

test('At 800 wide with the sidebar open, the review window stacks its brief over the draft and the team window keeps clear of the sidebar', async ({ fx, page }) => {
  await page.setViewportSize({ width: 800, height: 900 })
  await start(page, fx, '#/today')
  const sidebarRight = async () => { const b = (await page.locator('#sidebar').boundingBox())!; return b.x + b.width }
  await page.getByRole('main').getByRole('article').first().getByRole('button', { name: /^Review/ }).first().click()
  const win = page.getByRole('dialog')
  const draft = win.getByRole('article', { name: /draft$/ })
  await expect(draft).toBeVisible()
  const w = (await win.boundingBox())!, d = (await draft.boundingBox())!, h = (await win.getByRole('heading', { level: 2 }).boundingBox())!
  expect(w.x, 'the window sits right of the sidebar').toBeGreaterThanOrEqual(await sidebarRight())
  // One column: the draft sits under the title and takes the window's width less its padding, never a sliver beside it.
  expect(d.y).toBeGreaterThan(h.y + h.height)
  expect(d.width).toBeGreaterThan(w.width * 0.75)
  await page.keyboard.press('Escape')
  await expect(win).toHaveCount(0)

  await accountItem(page, /^Your Inhouse team/)
  const t = (await team(page).boundingBox())!
  expect(t.x, 'the team window sits right of the sidebar').toBeGreaterThanOrEqual(await sidebarRight())
  expect(t.x + t.width).toBeLessThanOrEqual(800)
})

test("Activity: a line that needs you opens a side sheet whose Review the draft opens that draft's review window", async ({ fx, page }) => {
  await start(page, fx, '#/activity')
  await page.getByRole('radiogroup', { name: 'Filter activity' }).getByRole('radio', { name: 'Needs you', exact: true }).click()
  const row = page.locator('button[data-activity-row]').first()
  await row.click()
  const sheet = page.getByRole('dialog')
  await expect(sheet).toBeVisible()
  // The open row is the selected one.
  await expect(row).toHaveClass(/bg-fill-hover/)
  await expect(sheet).toContainText('Needs you')
  await expect(sheet).not.toContainText(/trace|\bms\b|\$0\.\d/i)
  await sheet.getByRole('button', { name: 'Review the draft', exact: true }).click()
  // The sheet closes and the review window takes its place: one dialog, with the window's More.
  await expect(page.getByRole('dialog')).toHaveCount(1)
  await expect(page.getByRole('button', { name: 'Review the draft', exact: true })).toHaveCount(0)
  const win = page.getByRole('dialog')
  await expect(win.getByRole('heading', { level: 2 })).toBeVisible()
  await expect(win.getByRole('button', { name: 'More', exact: true })).toBeVisible()
  // Closing the review window gives focus back to the Activity line the sheet was opened from.
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(row).toBeFocused()
})

test('Team window: Withdraw moves your open request to Closed with an Undo, and the account menu counts it', async ({ fx, page }) => {
  await start(page, fx, '#/today')
  const subject = 'Connect our Faire wholesale account'
  await accountItem(page, /^Your Inhouse team/)
  await team(page).getByRole('textbox', { name: 'Title' }).fill(subject)
  await team(page).getByRole('button', { name: 'Send to the team' }).click()
  await expect(team(page)).toHaveCount(0)
  await expect(toast(page, 'Request sent. Your Inhouse team replies within one working day.')).toBeVisible()

  await accountItem(page, /^Your Inhouse team/)
  await team(page).getByRole('radio', { name: /^Your requests/ }).click()
  const openList = team(page).getByRole('list', { name: 'Open requests' })
  const openCount = await openList.getByRole('listitem').count()
  const mine = openList.getByRole('listitem').filter({ hasText: subject })
  await mine.getByRole('button', { name: new RegExp(subject) }).click()
  await mine.getByRole('button', { name: 'Withdraw request', exact: true }).click()
  await expect(toast(page, 'Request withdrawn.')).toBeVisible()
  await expect(openList.getByRole('listitem')).toHaveCount(openCount - 1)
  await team(page).getByRole('radio', { name: /^Closed/ }).click()
  const closed = team(page).getByRole('list', { name: 'Closed requests' }).getByRole('listitem').filter({ hasText: subject })
  await expect(closed).toContainText('Withdrawn')

  // Undo puts it back among the open ones.
  await toast(page, 'Request withdrawn.').getByRole('button', { name: 'Undo', exact: true }).click()
  await expect(closed).toHaveCount(0)
  await team(page).getByRole('radio', { name: /^Open/ }).click()
  await expect(openList.getByRole('listitem').filter({ hasText: subject })).toHaveCount(1)
  await page.keyboard.press('Escape')
  await side(page).getByRole('button', { name: /account and settings/i }).click()
  await expect(page.getByRole('menu', { name: 'Account' }).getByRole('menuitem', { name: /^Your Inhouse team/ })).toContainText(`${openCount} open`)
})

test("A skill's page: Try in a chat starts a chat holding the skill, and Versions' Restore says it isn't connected", async ({ fx, page }) => {
  await start(page, fx, '#/skills/reorder-drafting')
  await expect(page.getByRole('heading', { level: 1, name: 'Reorder drafting' })).toBeVisible()
  // Skills stays the selected sidebar row on a skill's page.
  await expect(side(page).getByRole('button', { name: 'Skills', exact: true })).toHaveAttribute('aria-current', 'page')
  await expect(page.getByRole('article', { name: 'Instructions' })).toContainText('When to use')
  const rail = page.getByRole('complementary', { name: 'About this skill' })
  await rail.getByRole('button', { name: 'Restore the Inhouse version' }).click()
  await expect(toast(page, "Restoring a version isn't connected in this demo.")).toBeVisible()

  await page.getByRole('button', { name: 'Try in a chat', exact: true }).click()
  await expect(page).toHaveURL(/#\/chats\/new$/)
  await expect(page.getByRole('textbox', { name: 'Message Inhouse' })).toHaveValue('Use the "Reorder drafting" skill: ')
})

test('Settings: five sections in order, each announced, and no lock for an Admin', async ({ fx, page }) => {
  await start(page, fx, '#/settings/you-general')
  const nav = page.getByRole('navigation', { name: 'Settings' })
  const groups = nav.getByRole('group')
  await expect(groups).toHaveCount(5)
  const sections: [string, string[]][] = [
    ['You', ['General', 'Notifications', 'Memory']],
    ['Agent', ['Inhouse agent', 'Models', 'Team memory']],
    ['Approvals and limits', ['Who approves what', 'Run limits', 'Spending cap']],
    ['Team', ['Members']],
    ['Workspace', ['Stage and plan', 'Data and access', 'Audit log']],
  ]
  for (const [i, [label, pages]] of sections.entries()) {
    const group = groups.nth(i)
    await expect(group).toHaveAccessibleName(label)
    const rows = group.getByRole('button')
    await expect(rows).toHaveCount(pages.length)
    for (const [j, p] of pages.entries()) await expect(rows.nth(j)).toHaveAccessibleName(p)
  }
  await expect(nav.getByRole('button', { name: 'Admins change these' })).toHaveCount(0)
})

test("Account menu and sidebar: the role is a badge beside the name; the collapse button sits in the sidebar's bottom row", async ({ fx, page }) => {
  await start(page, fx, '#/today')
  // No sidebar button in the top bar any more: the one button is in the sidebar.
  await expect(page.getByRole('button', { name: 'Sidebar', exact: true })).toHaveCount(1)
  const toggle = side(page).getByRole('button', { name: 'Sidebar', exact: true })
  const account = side(page).getByRole('button', { name: /account and settings/i })
  const t = (await toggle.boundingBox())!, a = (await account.boundingBox())!
  expect(Math.abs((t.y + t.height / 2) - (a.y + a.height / 2)), 'beside the account row').toBeLessThanOrEqual(4)
  expect(t.x).toBeGreaterThan(a.x + a.width - 1)
  // A click keeps focus on the button, now on the rail above the avatar.
  await toggle.click()
  const railToggle = side(page).getByRole('button', { name: 'Sidebar', exact: true })
  await expect(railToggle).toHaveAttribute('aria-expanded', 'false')
  await expect(railToggle).toBeFocused()
  const rt = (await railToggle.boundingBox())!, ra = (await account.boundingBox())!
  expect(rt.y + rt.height).toBeLessThanOrEqual(ra.y)
  await railToggle.click()
  await expect(side(page).getByRole('button', { name: 'Sidebar', exact: true })).toHaveAttribute('aria-expanded', 'true')

  await account.click()
  const label = page.getByRole('menu', { name: 'Account' }).locator('[data-slot="dropdown-menu-label"]')
  const badge = label.locator('[data-slot="badge"]')
  await expect(badge).toHaveText('Admin')
  // Measure once the menu's open animation (a fade and a small zoom) has finished, not mid-zoom.
  await label.evaluate(el => Promise.all(el.closest('[role="menu"]')!.getAnimations({ subtree: true }).map(a => a.finished)))
  const name = label.getByText('Sam Mercer', { exact: true })
  const b = (await badge.boundingBox())!, n = (await name.boundingBox())!
  expect(Math.abs((b.y + b.height / 2) - (n.y + n.height / 2)), 'the badge sits on the name line').toBeLessThanOrEqual(3)
  await expect(label).not.toContainText('·')
})

test('Sidebar: the Inhouse team button sits between the account row and the collapse button and opens the team window', async ({ fx, page }) => {
  await start(page, fx, '#/today')
  const team = side(page).getByRole('button', { name: 'Your Inhouse team', exact: true })
  const account = side(page).getByRole('button', { name: /account and settings/i })
  const toggle = side(page).getByRole('button', { name: 'Sidebar', exact: true })
  const t = (await team.boundingBox())!, a = (await account.boundingBox())!, g = (await toggle.boundingBox())!
  expect(Math.abs((t.y + t.height / 2) - (a.y + a.height / 2)), 'beside the account row').toBeLessThanOrEqual(4)
  expect(t.x).toBeGreaterThan(a.x + a.width - 1)
  expect(g.x).toBeGreaterThan(t.x + t.width - 1)
  await team.click()
  const dialog = page.getByRole('dialog', { name: 'Your Inhouse team' })
  await expect(dialog).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  await expect(team).toBeFocused()
})
