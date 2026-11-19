// Proves fx.reset() in a browser: the next load is the clean demo, a seed made after a reset applies, and a reset on one
// tab never stops a seed on another.
import { expect, fxFor, test } from './support/fx.js'

test('reset gives the clean demo, and a seed made after it applies', async ({ page, fx }) => {
  const first = fx.names.chats[0]
  await fx.seedSaved({ stage: 'Run' }, { chatDeleted: { [first.id]: true } })
  await fx.open('#/chats/all')
  await expect(page.getByRole('button', { name: 'Demo switches: Run, Normal' })).toBeVisible()
  await expect(page.getByRole('button', { name: new RegExp(first.title) })).toHaveCount(0)

  await fx.reset()
  await fx.open('#/chats/all')
  await expect(page.getByRole('button', { name: 'Demo switches: Act, Normal' })).toBeVisible()
  await expect(page.getByRole('button', { name: new RegExp(first.title) }).first()).toBeVisible()
  expect((await fx.saved()).demo.chatDeleted ?? {}).toEqual({})

  // A seed after the reset applies (its script is newer than the reset mark).
  await fx.reset()
  await fx.seed({ stage: 'Watch', scenario: 'First day' })
  await fx.open('#/today')
  await expect(page.getByRole('button', { name: 'Demo switches: Watch, First day' })).toBeVisible()
})

test('a reset on one tab does not stop a seed on another tab', async ({ page, context, baseURL, fx }) => {
  await fx.seed({ stage: 'Run' })
  await fx.open('#/today')
  await expect(page.getByRole('button', { name: 'Demo switches: Run, Normal' })).toBeVisible()

  // Tab B is seeded before tab A resets, so its seed script is installed already.
  const tabB = await context.newPage()
  const fxB = fxFor(tabB, baseURL)
  await fxB.seed({ stage: 'Watch' })

  await fx.reset()
  await fxB.open('#/today')
  await expect(tabB.getByRole('button', { name: 'Demo switches: Watch, Normal' })).toBeVisible()

  // And tab A is clean again after its own reset.
  await fx.open('#/today')
  await expect(page.getByRole('button', { name: 'Demo switches: Act, Normal' })).toBeVisible()
})
