// Ship spec for the sections sidebar, the team entry in the account menu and the lighter page (PR #226). Recorded at
// 1440x900 and 390x844. Every page is opened through the UI, as a person would (on a phone the sidebar is the drawer
// behind Menu).
import { expect, test, type Fx } from '../support/fx.js'
import type { Page } from '@playwright/test'

const phone = () => test.info().project.name === 'ship-phone'
const side = (page: Page) => page.getByRole('complementary', { name: 'Sidebar' })
const account = (page: Page) => page.getByRole('menu', { name: 'Account' })
const team = (page: Page) => page.getByRole('dialog', { name: 'Your Inhouse team' })

async function start(page: Page, fx: Fx, stage: 'Watch' | 'Act' = 'Act', theme: 'light' | 'dark' = 'light') {
  await fx.seed({ stage, theme })
  await page.emulateMedia({ colorScheme: theme })
  await page.goto('/?demo#/today')
  await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible()
}

async function openSidebar(page: Page) {
  if (phone()) await page.getByRole('button', { name: 'Menu' }).click()
  await expect(side(page)).toBeVisible()
}

async function openAccount(page: Page) {
  await openSidebar(page)
  await side(page).getByRole('button', { name: /account and settings/i }).click()
  await expect(account(page)).toBeVisible()
}

test('S1: The sidebar has two sections: the day (Today, Approvals, Activity) and "Your agent" (Routines, Skills, Tools, Library)', async ({ fx, page }) => {
  await start(page, fx)
  await openSidebar(page)
  const nav = side(page).getByRole('navigation', { name: 'Main' })
  for (const name of ['Today', 'Approvals', 'Activity']) await expect(nav.getByRole('button', { name: new RegExp(`^${name}`) }).first()).toBeVisible()
  const agent = nav.getByRole('group', { name: 'Your agent' })
  for (const name of ['Routines', 'Skills', 'Tools', 'Library']) await expect(agent.getByRole('button', { name })).toBeVisible()
  await expect(side(page).getByRole('button', { name: 'Usage' })).toHaveCount(0)
  await expect(side(page).getByRole('button', { name: /Message the team/ })).toHaveCount(0)
  await agent.getByRole('button', { name: 'Skills' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Skills' })).toBeVisible()
})

test('S2: The account menu holds Usage and one entry for the team, with its open requests counted', async ({ fx, page }) => {
  await start(page, fx)
  await openAccount(page)
  await expect(account(page).getByRole('menuitem', { name: 'Report a bug' })).toHaveCount(0)
  await account(page).getByRole('menuitem', { name: 'Usage', exact: true }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Usage' })).toBeVisible()

  await openAccount(page)
  const item = account(page).getByRole('menuitem', { name: /^Your Inhouse team/ })
  await expect(item).toHaveAccessibleName('Your Inhouse team 2 open')
  await item.click()
  await expect(team(page)).toBeVisible()
  await expect(team(page)).toContainText('Connect Klaviyo')
  await expect(team(page)).toContainText('Weekly wholesale stock report')
  await team(page).getByRole('radio', { name: /Report a bug/ }).click()
  await expect(team(page).getByRole('radio', { name: /Report a bug/ })).toBeChecked()
  await page.keyboard.press('Escape')
  await expect(team(page)).toHaveCount(0)
})

test('S3: In Watch, Approvals and Routines show their locks; in dark the page keeps its near-black ground', async ({ fx, page }) => {
  await start(page, fx, 'Watch')
  await openSidebar(page)
  const nav = side(page).getByRole('navigation', { name: 'Main' })
  await expect(nav.getByRole('button', { name: /^Approvals/ })).toContainText('Act')
  await expect(nav.getByRole('group', { name: 'Your agent' }).getByRole('button', { name: /^Routines/ })).toContainText('Act')
  if (phone()) await page.keyboard.press('Escape')

  await fx.setTheme('dark')
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.reload()
  await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible()
  await openSidebar(page)
  await expect(side(page).getByRole('navigation', { name: 'Main' }).getByRole('group', { name: 'Your agent' })).toBeVisible()
})
