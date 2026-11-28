// Proves fx.reset() in a browser: the next load is the clean demo, a seed made after a reset applies, a reset works from
// a page that is not on the app, and across two tabs it never stops the other tab's seed while it wipes what both saved.
// A seed's scenario marks which seed applied (the demo has no stages since decision A13; it used to be the stage).
import { expect, fxFor, test } from './support/fx.js'

test('reset gives the clean demo, and a seed made after it applies', async ({ page, fx }) => {
  const first = fx.names.chats[0]
  await fx.seedSaved({ scenario: 'Cap reached' }, { chatDeleted: { [first.id]: true } })
  await fx.open('#/chats/all')
  await expect(page.getByRole('button', { name: 'Demo switches: Cap reached' })).toBeVisible()
  await expect(page.getByRole('button', { name: new RegExp(first.title) })).toHaveCount(0)

  await fx.reset()
  await fx.open('#/chats/all')
  await expect(page.getByRole('button', { name: 'Demo switches: Normal' })).toBeVisible()
  await expect(page.getByRole('button', { name: new RegExp(first.title) }).first()).toBeVisible()
  expect((await fx.saved()).demo.chatDeleted ?? {}).toEqual({})

  // A seed after the reset applies (its script is newer than the reset mark).
  await fx.reset()
  await fx.seed({ scenario: 'First day' })
  await fx.open('#/today')
  await expect(page.getByRole('button', { name: 'Demo switches: First day' })).toBeVisible()
})

test('reset from a page that is not on the app clears the app at the project baseURL', async ({ page, fx }) => {
  await fx.seed({ scenario: 'Cap reached' })
  await fx.open('#/today')
  await expect(page.getByRole('button', { name: 'Demo switches: Cap reached' })).toBeVisible()

  // The page leaves the app: what the seed saved stays behind, and the page's own URL no longer names the app.
  await page.goto('about:blank')
  // With no baseURL either there is nothing to clear, and reset says so instead of returning quietly.
  await expect(fxFor(page, undefined).reset()).rejects.toThrow('no baseURL')

  // The baseURL names the app. Still showing Cap reached here would mean the saved state was kept, or the seed applied again.
  await fx.reset()
  await fx.open('#/today')
  await expect(page.getByRole('button', { name: 'Demo switches: Normal' })).toBeVisible()
})

test('a reset on one tab does not stop a seed on another tab, and it wipes what both tabs saved', async ({ page, context, baseURL, fx }) => {
  await fx.seed({ scenario: 'Cap reached' })
  await fx.open('#/today')
  await expect(page.getByRole('button', { name: 'Demo switches: Cap reached' })).toBeVisible()

  // Tab B is seeded before tab A resets, so its seed script is installed already.
  const tabB = await context.newPage()
  const fxB = fxFor(tabB, baseURL)
  await fxB.seed({ scenario: 'Tool disconnected' })

  await fx.reset()
  await fxB.open('#/today')
  await expect(tabB.getByRole('button', { name: 'Demo switches: Tool disconnected' })).toBeVisible()

  // The two tabs share one saved state, so tab A now loads what B's seed saved, not the clean demo. A's own seed (Cap reached)
  // stays off: the reset mark is per tab, the saved state is not.
  await fx.open('#/today')
  await expect(page.getByRole('button', { name: 'Demo switches: Tool disconnected' })).toBeVisible()

  // A second reset from tab A takes tab B off the app and wipes what both saved. Both then load the clean demo: B's seed
  // has applied already (once per tab), so it doesn't come back.
  await fx.reset()
  expect(tabB.url()).toBe('about:blank')
  await fx.open('#/today')
  await expect(page.getByRole('button', { name: 'Demo switches: Normal' })).toBeVisible()
  await fxB.open('#/today')
  await expect(tabB.getByRole('button', { name: 'Demo switches: Normal' })).toBeVisible()
})
