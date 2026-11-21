// The product build (npm run build:product, served by the `product` project): no sample data, no demo switches, no demo
// clock. Its client has no data yet, so one "Not connected yet" screen stands in for every page.
// The demo clock's absence is not checked here: that screen shows no date or time to read it from. It is proved by
// scripts/check-product-build.mjs (the product bundle holds no demo clock). Each URL below is a real first load.
import { expect, test } from '../support/fx.js'
import type { Page } from '@playwright/test'

const heading = (page: Page) => page.getByRole('heading', { level: 1, name: 'Not connected yet', exact: true })
const bodyText = (page: Page) => page.evaluate(() => document.body.innerText)
/** A fresh load of a URL: from a blank page, so a hash-only change is never mistaken for one. */
async function load(page: Page, url: string) {
  await page.goto('about:blank')
  await page.goto(url)
}

test('The product build shows the Not connected yet screen in place of every page', async ({ page }) => {
  for (const hash of ['', '#/today', '#/chats', '#/chats/all', '#/library', '#/usage', '#/activity', '#/settings']) {
    await load(page, '/' + hash)
    await expect(heading(page), hash).toBeVisible()
    await expect(page.getByText("Inhouse isn't connected to your agent yet. Check back soon."), hash).toBeVisible()
    await expect(page, hash).toHaveTitle('Not connected yet · Inhouse')
    // The screen stands alone: no sidebar and no navigation.
    await expect(page.getByRole('complementary', { name: 'Sidebar' }), hash).toHaveCount(0)
    await expect(page.getByRole('navigation'), hash).toHaveCount(0)
  }
})

test('No sample name appears, with or without ?demo', async ({ fx, page }) => {
  const { brand, user, people, tools, chats } = fx.names
  const sample = [brand, user.name, user.email, ...people.map(p => p.name), ...tools.catalog.map(t => t.name), ...chats.map(c => c.title)]
  expect(sample.length).toBeGreaterThan(5)
  for (const url of ['/', '/?demo', '/?demo=1', '/?demo=Run', '/?demo=true#/today']) {
    await load(page, url)
    await expect(heading(page), url).toBeVisible()
    const text = (await bodyText(page)) + '\n' + (await page.title())
    for (const name of sample) expect(text, `${url} shows the sample name "${name}"`).not.toContain(name)
  }
})

test('No demo switches: the switcher, Reset demo and the tour\'s demo steps are absent, and ?demo is ignored', async ({ page }) => {
  for (const url of ['/', '/?demo', '/?demo=1', '/?demo=Run#/today']) {
    await load(page, url)
    await expect(heading(page), url).toBeVisible()
    await expect(page.getByRole('button', { name: /Demo switches/ }), url).toHaveCount(0)
    await expect(page.getByRole('dialog', { name: 'Demo switches' }), url).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Reset demo' }), url).toHaveCount(0)
    await expect(page.getByText('Demo reset. Every change is cleared.'), url).toHaveCount(0)
    // The command palette's demo entries have nothing to open from: the screen has no palette to reach.
    await page.keyboard.press('ControlOrMeta+K')
    await expect(page.getByRole('dialog'), url).toHaveCount(0)
    await expect(page.getByRole('option'), url).toHaveCount(0)
  }
})
