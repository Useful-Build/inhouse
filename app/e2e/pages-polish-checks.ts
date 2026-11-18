// The checks of PR 7 (Pages and windows), shared by the desktop spec (pages-polish.spec.ts) and the phone spec
// (pages-polish-phone.spec.ts): the same scenarios at 1440 and at 390.
import { expect } from '@playwright/test'
import type { Page, TestType } from '@playwright/test'

async function start(page: Page, stage: string, scenario: string, hash: string) {
  await page.addInitScript(([s, sc]) => {
    if (sessionStorage.getItem('e2e-seeded')) return
    localStorage.clear()
    localStorage.setItem('inhouse.demo.switches.v1', JSON.stringify({ stage: s, scenario: sc, ambient: 'Off', animateMark: false }))
    sessionStorage.setItem('e2e-seeded', '1')
  }, [stage, scenario])
  await page.goto('/?demo' + hash)
}
const go = (page: Page, h: string) => page.evaluate(x => { location.hash = x }, h)
const noSideways = (page: Page) => page.evaluate(() => [document.documentElement, document.querySelector('main')!].every(e => e.scrollWidth - e.clientWidth <= 1))
const shot = async (page: Page, name: string) => { await page.waitForTimeout(300); await page.screenshot({ path: `${process.env.VERIFY_DIR ?? 'e2e-artifacts'}/${name}.png`, fullPage: true }) }
const ability = (page: Page, key: 'read' | 'draft' | 'run') => page.locator(`[data-ability="${key}"]`)
const detail = (page: Page, key: string) => page.locator('main dt', { hasText: new RegExp(`^${key}$`) }).locator('xpath=..')

export function pagesPolish(test: TestType<{ page: Page }, object>, size: 'desktop' | 'phone') {
  test(`Tool page (${size}): pausing a tool changes Read, Draft, Access and the suggestions, and Resume brings them back`, async ({ page }) => {
    await start(page, 'Act', 'Normal', '#/tools/shopify')
    await expect(ability(page, 'read')).toContainText('On')
    await expect(ability(page, 'draft')).toContainText('On')
    await expect(detail(page, 'Access')).toContainText('Read, plus drafts you approve')
    // The suggested questions are plain rows: no tool chip in front of each.
    const example = page.locator('[data-tool-example]').first()
    await expect(example).toBeVisible()
    expect((await example.innerText()).trim().startsWith('Shopify')).toBe(false)
    await page.getByRole('button', { name: 'Pause access' }).click()
    await expect(page.locator('main')).toContainText('Access paused')
    await expect(ability(page, 'read')).toContainText('Paused')
    await expect(ability(page, 'draft')).toContainText('Paused')
    await expect(detail(page, 'Access')).toContainText('None. A person paused it.')
    await expect(page.locator('[data-tool-example]')).toHaveCount(0)
    await expect(page.getByText('Access is paused. Resume it and you can ask about Shopify again.')).toBeVisible()
    expect(await noSideways(page)).toBe(true)
    await shot(page, `pages-polish-${size}-tool-paused`)
    // The list agrees, then Resume restores the page.
    await go(page, '#/tools')
    await expect(page.locator('[data-tool-row]').filter({ hasText: 'Shopify' })).toContainText('Access paused')
    await go(page, '#/tools/shopify')
    await page.getByRole('button', { name: 'Resume access' }).click()
    await expect(ability(page, 'read')).toContainText('On')
    await expect(detail(page, 'Access')).toContainText('Read, plus drafts you approve')
    await expect(page.locator('[data-tool-example]').first()).toBeVisible()
  })

  test(`Tool disconnected (${size}): Access no longer claims the stage's access`, async ({ page }) => {
    await start(page, 'Act', 'Tool disconnected', '#/tools/gorgias')
    await expect(ability(page, 'read')).toContainText('Off')
    await expect(detail(page, 'Access')).toContainText('None until the login is renewed.')
    await expect(detail(page, 'Access')).not.toContainText('Read, plus drafts')
  })

  for (const scenario of ['First day', 'Loading']) {
    test(`${scenario} (${size}): Routines, Skills, Tools, Usage, Activity and the audit log each show a real state`, async ({ page }) => {
      const errors: string[] = []
      page.on('console', m => { if (m.type() === 'error') errors.push(m.text()) })
      page.on('pageerror', e => errors.push(e.message))
      const firstDay = scenario === 'First day'
      await start(page, 'Act', scenario, '#/routines')
      const main = page.locator('main')
      // Routines: the team's own on day one (none run yet), a waiting note while loading.
      if (firstDay) {
        await expect(page.getByRole('button', { name: 'Morning check', exact: true })).toBeVisible()
        await expect(main).toContainText('Not run yet')
      } else {
        await expect(main).toContainText('Still reading your tools. Your routines show here in a moment.')
        await expect(page.getByRole('switch')).toHaveCount(0)
      }
      await shot(page, `pages-polish-${size}-routines-${firstDay ? 'first-day' : 'loading'}`)
      // Skills: no "Suggested" heading over nothing.
      await go(page, '#/skills')
      await expect(page.getByRole('heading', { level: 1, name: 'Skills' })).toBeVisible()
      if (firstDay) await expect(main).toContainText('Suggested for Shopify brands')
      else {
        await expect(main).toContainText('Still reading your tools. Your skills show here in a moment.')
        await expect(page.getByRole('heading', { name: 'Suggested for Shopify brands' })).toHaveCount(0)
      }
      await shot(page, `pages-polish-${size}-skills-${firstDay ? 'first-day' : 'loading'}`)
      // Tools: the list opens with its headings, never an empty frame.
      await go(page, '#/tools')
      await expect(page.getByRole('heading', { name: firstDay ? /^Being connected/ : /^Connected/ })).toBeVisible()
      await expect(page.getByRole('button', { name: 'Request a tool' })).toBeVisible()
      // Usage: nothing spent, and the breakdown says so instead of an empty table.
      await go(page, '#/usage')
      await expect(main).toContainText('$0.00')
      await expect(main).toContainText(firstDay ? 'Nothing spent yet. Costs show here once your Inhouse agent starts working.' : 'Still reading your tools. Costs show here once your Inhouse agent has worked.')
      // Activity.
      await go(page, '#/activity')
      await expect(main).toContainText(firstDay ? 'Nothing yet. Lines show here once your Inhouse agent starts working.' : 'Still reading your tools. What your Inhouse agent does shows here.')
      // The audit log.
      await go(page, '#/settings/team-audit')
      await expect(page.getByRole('heading', { level: 1, name: 'Audit log' })).toBeVisible()
      await expect(page.locator('main')).toContainText('Nothing changed yet')
      expect(await noSideways(page)).toBe(true)
      expect(errors, errors.join('\n')).toEqual([])
    })
  }

  test(`Routines (${size}): a run from Run now lands in Last runs with its result, for two routines, and survives a reload`, async ({ page }) => {
    await start(page, 'Act', 'Normal', '#/routines')
    await expect(page.getByRole('heading', { level: 1, name: 'Routines' })).toBeVisible()
    // The last run sits on its own line under the chips, and the row fits the screen.
    const row = page.getByRole('listitem').filter({ has: page.getByRole('button', { name: 'Morning check', exact: true }) })
    await expect(row).toContainText('Last run today at 6:00 AM · found 6 things')
    expect(await noSideways(page)).toBe(true)
    expect(await row.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true)
    await shot(page, `pages-polish-${size}-routines`)

    for (const [name, result] of [['Morning check', 'found 6 things'], ['Amazon payout check', 'found a $1,240 gap']] as const) {
      await page.getByRole('button', { name, exact: true }).click()
      const sheet = page.getByRole('dialog', { name })
      await expect(sheet).toBeVisible()
      const runs = sheet.getByRole('list', { name: 'Last runs' })
      const before = await runs.getByRole('listitem').count()
      await sheet.getByRole('button', { name: 'Run now' }).click()
      await expect(runs.getByRole('listitem')).toHaveCount(before + 1)
      await expect(runs.getByRole('listitem').first()).toContainText(`Run now · ${result}`)
      await shot(page, `pages-polish-${size}-routine-run-${name.split(' ')[0].toLowerCase()}`)
      await page.keyboard.press('Escape')
      await expect(sheet).toHaveCount(0)
    }
    await page.reload()
    await page.getByRole('button', { name: 'Amazon payout check', exact: true }).click()
    await expect(page.getByRole('dialog', { name: 'Amazon payout check' }).getByRole('list', { name: 'Last runs' }).getByRole('listitem').first()).toContainText('Run now · found a $1,240 gap')
  })
}
