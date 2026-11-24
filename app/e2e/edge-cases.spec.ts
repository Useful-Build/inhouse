// Modals sit above the Sidebar, a chat's additions survive a stale link, a failed save and a failed
// photo are told, a removed approver is flagged on the rules that still name them. Screenshots go to VERIFY_DIR (or e2e-artifacts/).
import { expect, fxFor, test } from './support/fx.js'
import type { Page } from '@playwright/test'
import path from 'node:path'
import { atRest } from './states.js'

const out = process.env.VERIFY_DIR ?? 'e2e-artifacts'
const FIXTURE = path.join(import.meta.dirname, 'fixtures', 'photo.png')

async function start(page: Page, hash: string, scenario = 'Normal') {
  await fxFor(page, undefined).seed({ stage: 'Act', scenario, demo: { ambient: 'Always' } })
  await page.goto('/?demo' + hash)
  await expect(page.getByRole('heading', { level: 1 }).or(page.getByRole('banner')).first()).toBeVisible()
}
const keep = async (page: Page, name: string, fullPage = false) => { await atRest(page); await page.screenshot({ path: `${out}/${name}.png`, fullPage }) }
const side = (page: Page) => page.getByRole('complementary', { name: 'Sidebar' })
const main = (page: Page) => page.locator('main')
const hash = (page: Page) => page.evaluate(() => location.hash)

/** What is on top at the middle of a Sidebar item, and whether clicking there leaves the page alone. */
async function sidebarIsCovered(page: Page, expectedHash: string) {
  // The modal window hides the page behind it from the accessibility tree, so look for the item among hidden ones too.
  const item = page.getByRole('complementary', { name: 'Sidebar', includeHidden: true }).getByRole('navigation', { name: 'Main', includeHidden: true }).getByRole('button', { name: 'Approvals', includeHidden: true })
  const box = (await item.boundingBox())!
  const x = box.x + box.width / 2, y = box.y + box.height / 2
  const top = await page.evaluate(([px, py]) => {
    const el = document.elementFromPoint(px, py)
    return { scrim: !!el?.matches('.click-away, [data-slot="dialog-overlay"]'), insideSidebar: !!el?.closest('aside') }
  }, [x, y])
  expect(top.scrim, 'the scrim is on top of the Sidebar').toBe(true)
  expect(top.insideSidebar, 'the Sidebar is not on top').toBe(false)
  await page.mouse.click(x, y)
  expect(await hash(page), 'clicking the Sidebar behind the modal does not navigate').toBe(expectedHash)
}

test('Library: the file viewer and the Delete confirm cover the Sidebar (1440)', async ({ page }) => {
  await start(page, '#/library')
  const card = (name: string) => page.getByRole('list', { name: 'Files' }).getByRole('listitem').filter({ hasText: name })

  await card('stuck-orders-over-3-days.csv').click()
  const viewer = page.getByRole('dialog', { name: 'File: stuck-orders-over-3-days.csv' })
  await expect(viewer).toBeVisible()
  await keep(page, 'library-viewer-over-sidebar-1440')
  await sidebarIsCovered(page, '#/library')
  await expect(viewer).toHaveCount(0) // the click on the scrim closed it

  await page.getByRole('button', { name: 'Select', exact: true }).click()
  await card('amazon-payout-check.csv').click()
  await page.getByRole('toolbar', { name: 'Selected files' }).getByRole('button', { name: 'Delete' }).click()
  const ask = page.getByRole('dialog', { name: 'Delete files' })
  await expect(ask).toBeVisible()
  await keep(page, 'library-delete-confirm-1440')
  await sidebarIsCovered(page, '#/library')
  await expect(ask).toHaveCount(0)
})

test('A stale chat link in the middle of a session keeps what was added to the newest chat', async ({ page }) => {
  await start(page, '#/chats')
  await expect(page.getByRole('banner')).toContainText('Stuck orders over 3 days')
  await page.getByRole('textbox', { name: 'Message Inhouse' }).fill('Which one is oldest?')
  await page.keyboard.press('Enter')
  await expect(main(page).locator('[data-chat-msg]').getByText('Which one is oldest?', { exact: true })).toBeVisible()
  await side(page).getByRole('button', { name: 'Amazon payout gap', exact: true }).click()
  await expect(page.getByRole('banner')).toContainText('Amazon payout gap')
  await page.evaluate(() => { location.hash = '#/chats/bogus' })
  await expect(page.getByRole('banner')).toContainText('Stuck orders over 3 days')
  await expect.poll(() => hash(page)).toBe('#/chats/stuck')
  await expect(main(page).locator('[data-chat-msg]').getByText('Which one is oldest?', { exact: true })).toBeVisible()
})

test('A photo that cannot be saved is told and reverted, and a failure that is not a bad image says so', async ({ page }) => {
  await start(page, '#/settings/you-general')
  const sidebarImg = side(page).getByRole('button', { name: /account and settings/i }).locator('img')
  await expect(sidebarImg).toHaveAttribute('src', '/avatars/sam.svg')
  const file = page.locator('input[type=file]')

  // Storage is full: the toast shows and the photo is not kept.
  await page.evaluate(() => {
    const set = Storage.prototype.setItem
    ;(window as unknown as { full: boolean }).full = true
    Storage.prototype.setItem = function (k: string, v: string) {
      if ((window as unknown as { full: boolean }).full) throw new DOMException('full', 'QuotaExceededError')
      return set.call(this, k, v)
    }
  })
  await file.setInputFiles(FIXTURE)
  await expect(page.getByRole('status').filter({ hasText: "Couldn't save. Your browser storage is full." })).toBeVisible()
  await expect(sidebarImg).toHaveAttribute('src', '/avatars/sam.svg')
  await page.evaluate(() => { (window as unknown as { full: boolean }).full = false })

  // A fault that is not a decode error gets the generic toast, not "isn't a readable image".
  await page.evaluate(() => { HTMLCanvasElement.prototype.getContext = () => null })
  await file.setInputFiles(FIXTURE)
  const generic = page.getByRole('status').filter({ hasText: "Couldn't add the photo." })
  await expect(generic).toBeVisible()
  await expect(page.getByText("That file isn't a readable image.")).toHaveCount(0)
  await keep(page, 'photo-generic-failure-1440')
})

test('A removed member stays on the rules that name them, with a Removed tag', async ({ page, fx }) => {
  // Call 3 (P2): approving is a job per rule, not a role, so the page can't demote Dana; a removed member is the one a rule can't keep.
  await fx.seedSaved({ stage: 'Act', scenario: 'Normal', demo: { ambient: 'Always' } }, { server: { removed: { m_dana: true } } })
  await fx.open('#/settings/team-approvals')
  const rule = page.getByRole('combobox', { name: 'Orders over $5,000: Dana Kim' })
  await expect(rule).toBeVisible()
  await expect(page.getByText('Removed', { exact: true })).toHaveCount(1)
  await expect(page.getByText('Removed', { exact: true }).locator('xpath=following-sibling::*').first()).toBeVisible()
  await keep(page, 'settings-removed-approver-1440')
  // Naming someone who is still on the team clears the tag.
  await rule.click()
  await page.getByRole('option', { name: 'Sam Mercer' }).click()
  await expect(page.getByText('Removed', { exact: true })).toHaveCount(0)
})

test('Members: Invite adds a person, Remove asks first and names them, and says nothing about approval rules', async ({ page }) => {
  await start(page, '#/settings/team-members')
  await main(page).getByRole('button', { name: 'Invite', exact: true }).click()
  const invite = page.getByRole('dialog', { name: 'Invite someone' })
  await invite.getByRole('textbox', { name: 'Name' }).fill('Robin Lee')
  await invite.getByRole('textbox', { name: 'Work email' }).fill('robin@example.test')
  await invite.getByRole('button', { name: 'Invite', exact: true }).click()
  await expect(invite).toHaveCount(0)
  await expect(page.getByRole('combobox', { name: 'Robin Lee: Member' })).toBeVisible()
  // The same email again is refused, with a plain line.
  await main(page).getByRole('button', { name: 'Invite', exact: true }).click()
  await invite.getByRole('textbox', { name: 'Name' }).fill('Robin Again')
  await invite.getByRole('textbox', { name: 'Work email' }).fill('Robin@Example.test')
  await invite.getByRole('button', { name: 'Invite', exact: true }).click()
  await expect(invite.getByRole('alert')).toHaveText('That email is already on the team.')
  await invite.getByRole('button', { name: 'Cancel' }).click()
  await expect(invite).toHaveCount(0)

  // Remove names the person; Cancel keeps them.
  await main(page).getByRole('button', { name: 'Remove Robin Lee' }).click()
  const ask = page.getByRole('dialog', { name: 'Remove Robin Lee?' })
  await expect(ask).toBeVisible()
  await ask.getByRole('button', { name: 'Cancel' }).click()
  await expect(page.getByRole('combobox', { name: 'Robin Lee: Member' })).toBeVisible()
  await main(page).getByRole('button', { name: 'Remove Robin Lee' }).click()
  await ask.getByRole('button', { name: 'Remove', exact: true }).click()
  await expect(page.getByRole('combobox', { name: 'Robin Lee: Member' })).toHaveCount(0)

  // Dana is named on an approval rule: removing her says nothing about it (no note, no toast), and the rule keeps her name with a tag.
  await main(page).getByRole('button', { name: 'Remove Dana Kim' }).click()
  await expect(page.getByRole('dialog', { name: 'Remove Dana Kim?' })).toContainText('Dana loses access to Inhouse. The audit log keeps what Dana did.')
  await expect(page.getByRole('dialog', { name: 'Remove Dana Kim?' })).not.toContainText(/approval rule|approver/i)
  await page.getByRole('dialog', { name: 'Remove Dana Kim?' }).getByRole('button', { name: 'Remove', exact: true }).click()
  await expect(page.getByRole('combobox', { name: 'Dana Kim: Member' })).toHaveCount(0)
  await expect(page.getByRole('status').filter({ hasText: /still named on/ })).toHaveCount(0)
  await page.goto('/?demo#/settings/team-approvals')
  await expect(page.getByText('Removed', { exact: true })).toHaveCount(1)
})

test("Usage: a saved cap below this month's spend shows the capped state, and there's no month picker", async ({ page }) => {
  await start(page, '#/settings/team-spend')
  await page.getByRole('textbox', { name: 'Monthly cap' }).fill('$50')
  await page.getByRole('textbox', { name: 'Monthly cap' }).blur()
  await page.goto('/?demo#/usage')
  await expect(page.getByText('$78.40 of $50', { exact: true })).toBeVisible()
  await expect(page.getByText('Cap reached with 14 days of the month left')).toBeVisible()
  await expect(page.getByText('Cap reached today. Chats, routines and jobs are paused until next month or until an admin raises the cap.')).toBeVisible()
  await keep(page, 'usage-low-cap-1440', true)
  // November is the first month with spend (the first tool was connected on Nov 2), the only one: no month picker.
  await expect(page.getByRole('combobox', { name: /^Month/ })).toHaveCount(0)
})
