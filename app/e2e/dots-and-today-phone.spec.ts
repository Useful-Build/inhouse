// UI polish A at 390 px: dots behind the cards, a clean Today, and no logo row in its box (the tools are in "+").
import { expect, test } from './csp.js'
import type { Page } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { atRest } from './states.js'

async function start(page: Page, hash: string) {
  await page.addInitScript(() => {
    if (sessionStorage.getItem('e2e-seeded')) return
    localStorage.clear()
    localStorage.setItem('inhouse.demo.switches.v1', JSON.stringify({ stage: 'Act', scenario: 'Normal', ambient: 'Always', animateMark: false }))
    sessionStorage.setItem('e2e-seeded', '1')
  })
  await page.goto('/?demo' + hash)
}

async function shot(page: Page, name: string) {
  await atRest(page)
  const dir = process.env.POLISH_SHOTS
  if (dir) mkdirSync(dir, { recursive: true })
  await page.screenshot({ path: dir ? join(dir, `${name}.png`) : test.info().outputPath(`${name}.png`), fullPage: true })
}

async function dotsBehind(page: Page, selectors: string[]) {
  const tops = await page.evaluate(sels => {
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

test('Phone: All chats has the plain background, Today has no sub line and no logo row', async ({ page }) => {
  await start(page, '#/chats/all')
  await expect(page.getByRole('heading', { name: 'All chats' })).toBeVisible()
  await expect(page.locator('div:has(> main) > div[aria-hidden="true"]')).toHaveCount(0)
  await shot(page, 'all-chats-390')

  await page.goto('/?demo#/today')
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Good morning, Sam.')
  await expect(page.getByText(/Nothing goes out until you approve it/)).toHaveCount(0)
  await expect(page.getByText(/Inhouse agent checked your 6 tools/)).toHaveCount(0)
  await dotsBehind(page, ['.today-card', '[data-composer]'])
  // A phone's box has no logo stack: the tools are in "+" (M27).
  await expect(page.getByRole('button', { name: /Tools read in this chat/ })).toHaveCount(0)
  await shot(page, 'today-390')

  await page.goto('/?demo#/chats')
  await expect(page.getByRole('textbox', { name: 'Message your Inhouse agent' })).toBeVisible()
  await dotsBehind(page, ['[data-composer]', '[data-chat-msg]'])
  await shot(page, 'chat-390')
})

test('Phone pages: every other page has no dots layer, so nothing can sit under a card', async ({ page }) => {
  for (const [name, hash] of [['library', '#/library'], ['approvals', '#/approvals'], ['routines', '#/routines'], ['activity', '#/activity'], ['tools', '#/tools'], ['skills', '#/skills'], ['usage', '#/usage'], ['settings', '#/settings/you-general']]) {
    await page.goto('/?demo' + hash)
    await expect(page.locator('main')).toBeVisible()
    await expect(page.locator('div:has(> main) > div[aria-hidden="true"]')).toHaveCount(0)
    await shot(page, `${name}-390`)
  }
})
