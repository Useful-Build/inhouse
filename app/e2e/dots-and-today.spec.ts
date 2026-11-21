// UI polish A: the dotted background sits behind every card, Today shows only the title, the composer and the
// Needs you cards, and the composer's logo row stops at 3 logos plus a "+N" chip.
import { expect, fxFor, test } from './support/fx.js'
import type { Page } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { atRest } from './states.js'

async function start(page: Page, hash: string, stage: 'Watch' | 'Act' | 'Run' = 'Act', scenario = 'Normal') {
  await fxFor(page, undefined).seed({ stage, scenario, demo: { ambient: 'Always' } })
  await page.goto('/?demo' + hash)
}

/** Screenshots go to POLISH_SHOTS when set (a verify folder), else to the test's output folder. */
async function shot(page: Page, name: string) {
  await atRest(page)
  const dir = process.env.POLISH_SHOTS
  if (dir) mkdirSync(dir, { recursive: true })
  await page.screenshot({ path: dir ? join(dir, `${name}.png`) : test.info().outputPath(`${name}.png`), fullPage: true })
}

/** The element on top at the middle of each target, with the dots layer made hit-testable. It must never be the dots layer. */
async function dotsBehind(page: Page, selectors: string[]) {
  const tops = await page.evaluate(sels => {
    // The dots layer sits in main's column, behind the top bar and main.
    const dots = document.querySelector('div:has(> main) > div[aria-hidden="true"]') as HTMLElement | null
    if (!dots) return null
    dots.style.pointerEvents = 'auto'
    const out = sels.map(sel => {
      const el = document.querySelector(sel)
      if (!el) return `${sel}: missing`
      const r = el.getBoundingClientRect()
      const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
      return top && dots.contains(top) ? `${sel}: dots on top` : 'ok'
    })
    dots.style.pointerEvents = 'none'
    return out
  }, selectors)
  expect(tops, 'dots layer exists').not.toBeNull()
  expect(tops).toEqual(selectors.map(() => 'ok'))
}

test('All chats has the plain background; dots sit behind the cards on Today and in a chat', async ({ page }) => {
  await start(page, '#/chats/all')
  await expect(page.getByRole('heading', { name: 'All chats' })).toBeVisible()
  await expect(page.locator('div:has(> main) > div[aria-hidden="true"]')).toHaveCount(0)
  await shot(page, 'all-chats-1440')

  await page.goto('/?demo#/today')
  await expect(page.getByRole('heading', { level: 1 })).toContainText('things need you')
  await dotsBehind(page, ['.today-card', '[data-composer]'])

  await page.goto('/?demo#/chats')
  await expect(page.getByRole('textbox', { name: 'Message your Inhouse agent' })).toBeVisible()
  await dotsBehind(page, ['[data-composer]', '[data-chat-msg]'])
  await shot(page, 'chat-1440')
})

test('Today shows only the title, the composer and the Needs you cards, at every stage', async ({ page }) => {
  for (const stage of ['Watch', 'Act', 'Run'] as const) {
    await page.goto('about:blank')
    await page.context().clearCookies()
    await fxFor(page, undefined).restage({ stage, demo: { ambient: 'Always' } })
    await page.goto('/?demo#/today')
    const h1 = page.getByRole('heading', { level: 1 })
    await expect(h1).toContainText('Good morning, Sam.')
    await expect(page.getByText('Needs you')).toBeVisible()
    // No line under the title: the next thing after the heading's block is the composer.
    await expect(page.getByText(/Nothing goes out until you approve it/)).toHaveCount(0)
    await expect(page.getByText(/always wait for a person/)).toHaveCount(0)
    await expect(page.getByText(/changed nothing/)).toHaveCount(0)
    await expect(page.getByText(/Inhouse agent checked your 6 tools/)).toHaveCount(0)
    await expect(page.getByText(/Last job done at 6:10\sAM/)).toHaveCount(0)
    const gap = await page.evaluate(() => {
      const h = document.querySelector('h1')!.getBoundingClientRect()
      const c = document.querySelector('[data-composer]')!.getBoundingClientRect()
      return c.top - h.bottom
    })
    expect(gap, `title to composer gap at ${stage}`).toBeLessThan(50)
    await expect(page.getByRole('button', { name: 'Notifications' })).toBeVisible()
    if (stage === 'Act') await shot(page, 'today-1440')
  }
  // A page with its own heading doesn't repeat it in the top bar.
  await page.goto('/?demo#/chats/all')
  await expect(page.getByRole('heading', { level: 1, name: 'All chats' })).toBeVisible()
  await expect(page.locator('header').getByText('All chats')).toHaveCount(0)
})

test('Composer logo row: 3 logos, a +N chip for the rest, and the real count', async ({ page }) => {
  await start(page, '#/today')
  const chip = page.getByRole('button', { name: /Tools read in this chat/ })
  const logos = chip.locator('img')
  const more = chip.getByTestId('tools-more')

  // The sample has 6 tools.
  await expect(chip).toContainText('6 tools connected')
  await expect(logos).toHaveCount(3)
  await expect(more).toHaveText('+3')
  await shot(page, 'today-logo-row-1440')

  // Turning tools off in the menu: the count drops and so does +N, until 3 or fewer show them all with no chip.
  await chip.click()
  const menu = page.getByRole('menu')
  await menu.getByRole('menuitemcheckbox', { name: /Shopify/ }).click()
  await expect(chip).toContainText('5 of 6 tools on in this chat')
  await expect(more).toHaveText('+2')
  await menu.getByRole('menuitemcheckbox', { name: /Amazon/ }).click()
  await menu.getByRole('menuitemcheckbox', { name: /ShipBob/ }).click()
  await expect(chip).toContainText('3 of 6 tools on in this chat')
  await expect(logos).toHaveCount(3)
  await expect(more).toHaveCount(0)
  await menu.getByRole('menuitemcheckbox', { name: /Xero/ }).click()
  await expect(chip).toContainText('2 of 6 tools on in this chat')
  await expect(logos).toHaveCount(2)
  await expect(more).toHaveCount(0)
  await page.keyboard.press('Escape')

  // Chat and a tool page use the same row.
  await page.goto('/?demo#/chats')
  const chatChip = page.getByRole('button', { name: /Tools read in this chat/ })
  await expect(chatChip.locator('img')).toHaveCount(2)
})

test('Composer logo row with a longer list: +N and the count match', async ({ page }) => {
  // Test-only fixture: add a 7th connected tool to the built sample data.
  // Every script is read, and only the chunk that holds the data is changed (the demo agent's lazy chunks load beside it).
  let applied = false
  await page.route('**/assets/*.js', async route => {
    const res = await route.fetch()
    const body = await res.text()
    const next = body.replace('connected:[`shopify`,`amazon`,`shipbob`,`xero`,`gorgias`,`meta-ads`]', 'connected:[`shopify`,`amazon`,`shipbob`,`xero`,`gorgias`,`meta-ads`,`klaviyo`]')
    if (next !== body) applied = true
    await route.fulfill({ response: res, body: next })
  })
  await start(page, '#/today')
  expect(applied, 'fixture applied to the bundle').toBe(true)
  // Klaviyo is still being connected (its tool details say so), so the agent reads six of the seven: the row, the
  // count and the menu all say six (M17).
  const chip = page.getByRole('button', { name: /Tools read in this chat/ })
  await expect(chip).toContainText('6 of 7 tools connected')
  await expect(chip.locator('img')).toHaveCount(3)
  await expect(chip.getByTestId('tools-more')).toHaveText('+3')
  await chip.click()
  await expect(page.getByRole('menuitemcheckbox')).toHaveCount(6)
  await shot(page, 'today-logo-row-7-tools-1440')
})

test('Pages: every other page has no dots layer, so nothing can sit under a card', async ({ page }) => {
  for (const [name, hash] of [['library', '#/library'], ['approvals', '#/approvals'], ['routines', '#/routines'], ['activity', '#/activity'], ['tools', '#/tools'], ['skills', '#/skills'], ['usage', '#/usage'], ['settings', '#/settings/you-general']]) {
    await page.goto('/?demo' + hash)
    await expect(page.locator('main')).toBeVisible()
    await expect(page.locator('div:has(> main) > div[aria-hidden="true"]')).toHaveCount(0)
    await shot(page, `${name}-1440`)
  }
})
