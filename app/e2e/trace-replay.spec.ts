// The trace window's replay (FEATURE_MAP "Trace window" gap): Replay plays the recorded steps from the start, Pause replay
// holds the playhead, the speed button steps 1×, 2×, 5×, the replay ends on the full result, Restart starts again, and Stop
// and show everything shows the whole trace. Driven on the page clock, paused, so each step of the playhead is exact.
import { expect, fxFor, test } from './support/fx.js'
import type { Locator, Page } from '@playwright/test'

const trace = (page: Page) => page.getByRole('dialog', { name: 'What your Inhouse agent did' })
/** A stat's value under its label in the window's stat row. */
const stat = (dialog: Locator, label: string) => dialog.getByText(label, { exact: true }).locator('xpath=following-sibling::div[1]')
const notReached = (dialog: Locator) => dialog.getByRole('list', { name: 'Steps' }).getByText('Not reached yet', { exact: true })

test('Trace window: Replay, Pause replay, the speed, the replay result, Restart and Stop and show everything', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.clock.install()
  await fxFor(page, undefined).seed({ stage: 'Act', scenario: 'Normal', demo: { ambient: 'Always' } })
  await page.goto('/?demo#/chats/stuck')
  const first = page.getByRole('log', { name: 'Conversation' }).locator('[data-answer]').first()
  await first.getByRole('button', { name: /\d+ steps/ }).click()
  await first.getByRole('button', { name: 'Details', exact: true }).click()
  const dialog = trace(page)
  await expect(dialog).toBeVisible()
  // From here the page clock moves only when the test moves it.
  await page.clock.pauseAt(await page.evaluate(() => Date.now()) + 1000)

  // Before a replay: the whole trace, its slowest step marked, and no Stop.
  const timeTaken = stat(dialog, 'Time taken')
  const toolsUsed = stat(dialog, 'Tools used')
  const fullTime = (await timeTaken.innerText()).trim()
  const fullTools = (await toolsUsed.innerText()).trim()
  expect(Number(fullTools)).toBeGreaterThan(0)
  await expect(notReached(dialog)).toHaveCount(0)
  await expect(dialog.getByText('Slowest', { exact: true })).toBeVisible()
  const stop = dialog.getByRole('button', { name: 'Stop and show everything' })
  await expect(stop).toHaveCount(0)

  // Replay: from the start, nothing reached yet past the first step, no tool used, no Slowest mark mid-replay.
  await dialog.getByRole('button', { name: 'Replay', exact: true }).click()
  const pause = dialog.getByRole('button', { name: 'Pause replay' })
  await expect(pause).toBeVisible()
  await expect(stop).toBeVisible()
  await expect(toolsUsed).toHaveText('0')
  await expect(timeTaken).not.toHaveText(fullTime)
  const atStart = (await timeTaken.innerText()).trim()
  expect(await notReached(dialog).count()).toBeGreaterThan(0)
  await expect(dialog.getByText('Slowest', { exact: true })).toHaveCount(0)

  // The playhead moves with the clock.
  await page.clock.runFor(1000)
  await expect(timeTaken).not.toHaveText(atStart)

  // Pause replay holds it: the clock moves, the playhead doesn't.
  await pause.click()
  await expect(dialog.getByRole('button', { name: 'Replay', exact: true })).toBeVisible()
  const held = (await timeTaken.innerText()).trim()
  await page.clock.runFor(2000)
  await expect(timeTaken).toHaveText(held)
  await expect(stop).toBeVisible()

  // The speed steps 1×, 2×, 5× and round again.
  const speed = dialog.getByRole('button', { name: /^Replay speed/ })
  await expect(speed).toHaveAccessibleName('Replay speed 1×. Change speed')
  await speed.click()
  await expect(speed).toHaveAccessibleName('Replay speed 2×. Change speed')
  await speed.click()
  await expect(speed).toHaveAccessibleName('Replay speed 5×. Change speed')
  await speed.click()
  await expect(speed).toHaveAccessibleName('Replay speed 1×. Change speed')
  await speed.click()
  await speed.click()
  await expect(speed).toHaveAccessibleName('Replay speed 5×. Change speed')

  // Replay goes on from where it was held and, at 5×, reaches the end: the full result, every step reached, and it stops
  // by itself (Replay again, Stop still there until it is pressed).
  await dialog.getByRole('button', { name: 'Replay', exact: true }).click()
  await expect(pause).toBeVisible()
  await page.clock.runFor(60_000)
  await expect(dialog.getByRole('button', { name: 'Replay', exact: true })).toBeVisible()
  await expect(timeTaken).toHaveText(fullTime)
  await expect(toolsUsed).toHaveText(fullTools)
  await expect(notReached(dialog)).toHaveCount(0)
  await expect(stop).toBeVisible()

  // Restart plays from the start again.
  await dialog.getByRole('button', { name: 'Restart' }).click()
  await expect(pause).toBeVisible()
  await expect(toolsUsed).toHaveText('0')
  await expect(timeTaken).toHaveText(atStart)

  // Stop and show everything: the whole trace at once, Stop gone, the Slowest mark back.
  await stop.click()
  await expect(stop).toHaveCount(0)
  await expect(dialog.getByRole('button', { name: 'Replay', exact: true })).toBeVisible()
  await expect(timeTaken).toHaveText(fullTime)
  await expect(toolsUsed).toHaveText(fullTools)
  await expect(notReached(dialog)).toHaveCount(0)
  await expect(dialog.getByText('Slowest', { exact: true })).toBeVisible()
})
