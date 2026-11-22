// UI polish A at 390 px: dots behind the cards, a clean Today, and no logo row in its box (the tools are in "+").
import { expect, fxFor, test } from './support/fx.js'
import type { Page } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { atRest } from './states.js'

async function start(page: Page, hash: string) {
  await fxFor(page, undefined).seed({ stage: 'Act', demo: { ambient: 'Always' } })
  await page.goto('/?demo' + hash)
}

async function shot(page: Page, name: string) {
  await atRest(page)
  const dir = process.env.POLISH_SHOTS
  if (dir) mkdirSync(dir, { recursive: true })
  await page.screenshot({ path: dir ? join(dir, `${name}.png`) : test.info().outputPath(`${name}.png`), fullPage: true })
}

async function skyspaceBehind(page: Page, mode: 'hero' | 'subtle', selectors: string[]) {
  const tops = await page.evaluate(({ m, sels }) => {
    const bg = document.querySelector(`[data-skyspace="${m}"]`) as HTMLElement | null
    if (!bg) return null
    bg.style.pointerEvents = 'auto'
    const out = sels.map(sel => {
      const el = document.querySelector(sel)
      if (!el) return `${sel}: missing`
      const r = el.getBoundingClientRect()
      const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
      return top && bg.contains(top) ? `${sel}: skyspace on top` : 'ok'
    })
    bg.style.pointerEvents = 'none'
    return out
  }, { m: mode, sels: selectors })
  expect(tops, `skyspace (${mode}) layer exists`).not.toBeNull()
  expect(tops).toEqual(selectors.map(() => 'ok'))
}

test('Phone: All chats has the plain background, Today has full-shell Skyspace and no logo row, started chat dims Skyspace', async ({ page }) => {
  await start(page, '#/chats/all')
  await expect(page.getByRole('heading', { name: 'All chats' })).toBeVisible()
  await expect(page.locator('[data-skyspace]')).toHaveCount(0)
  await shot(page, 'all-chats-390')

  await page.goto('/?demo#/today')
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Good morning, Sam.')
  await expect(page.getByText(/Nothing goes out until you approve it/)).toHaveCount(0)
  await expect(page.getByText(/Inhouse agent checked your 6 tools/)).toHaveCount(0)
  await skyspaceBehind(page, 'hero', ['.today-card', '[data-composer]'])
  // A phone's box has no logo stack: the tools are in "+" (M27).
  await expect(page.getByRole('button', { name: /Tools read in this chat/ })).toHaveCount(0)
  await shot(page, 'today-390')

  // A chat with messages dims Skyspace softly behind messages.
  await page.goto('/?demo#/chats')
  await expect(page.getByRole('textbox', { name: 'Message your Inhouse agent' })).toBeVisible()
  await expect(page.locator('[data-chat-msg]').first()).toBeVisible()
  await skyspaceBehind(page, 'subtle', ['[data-chat-msg]', '[data-composer]'])
  await shot(page, 'chat-390')

  // An empty new chat keeps the hero Skyspace.
  await page.goto('/?demo#/chats/new')
  await expect(page.getByRole('heading', { name: 'What do you want to know?' })).toBeVisible()
  await skyspaceBehind(page, 'hero', ['[data-composer]'])
})

test('Phone pages: every other page has no Skyspace layer, so nothing can sit under a card', async ({ page }) => {
  for (const [name, hash] of [['library', '#/library'], ['approvals', '#/approvals'], ['routines', '#/routines'], ['activity', '#/activity'], ['tools', '#/tools'], ['skills', '#/skills'], ['usage', '#/usage'], ['settings', '#/settings/you-general']]) {
    await page.goto('/?demo' + hash)
    await expect(page.locator('main')).toBeVisible()
    await expect(page.locator('[data-skyspace]')).toHaveCount(0)
    await shot(page, `${name}-390`)
  }
})
