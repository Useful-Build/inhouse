// A chat while it writes (FEATURE_MAP gap "Chat while it writes"): the live steps build up one row at a time (the newest
// running with the agent mark and a shimmer, the earlier ones done), the answer's words show a few at a time with no fade,
// the answer's text runs to about 620px and your message to about 520px, and an answer that cites nothing has no Sources pill.
// Driven on the page clock, paused, so each step is exact: the demo agent emits a step every 800 ms (mock.ts
// THINKING_STEP_MS) and the off-script answer's text arrives at 2.6 s (chat-script.json fallback.delayMs), then the reveal
// shows a few more words every 50 ms (screens/chat/reveal.ts).
import { expect, fxFor, test } from './support/fx.js'
import type { Locator, Page } from '@playwright/test'

// Off-script (no tool answers it) and long enough to wrap in its bubble.
const QUESTION = 'What is the weather like in Lisbon right now, and would light rain change how many people stop at an outdoor pop-up stand near the river?'
const STEP_MS = 800

const log = (page: Page) => page.getByRole('log', { name: 'Conversation' })
const thinking = (page: Page) => log(page).locator('[data-thinking]')
const lines = (page: Page) => thinking(page).locator('[data-slot=trace-line]')
/** The answer card's text box (Parts.tsx: the text's measure). */
const answerText = (answer: Locator) => answer.locator('.max-w-answer-measure').first()

test('Chat while it writes: the steps build up row by row, the words show a few at a time, then the measures and no Sources pill', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.clock.install()
  await fxFor(page, undefined).seed({ stage: 'Act', scenario: 'Normal', demo: { ambient: 'Always' } })
  await page.goto('/?demo#/today')
  const field = page.getByRole('textbox', { name: 'Ask Inhouse' })
  await expect(field).toBeVisible()
  // From here the page clock moves only when the test moves it.
  await page.clock.pauseAt(await page.evaluate(() => Date.now()) + 1000)
  await field.fill(QUESTION)
  await page.keyboard.press('Enter')
  await page.clock.runFor(1)

  // First step: one row, running (the agent mark in place of its icon, the title shimmering).
  await expect(lines(page)).toHaveCount(1)
  await expect(lines(page).first()).toHaveAttribute('data-status', 'running')
  await expect(lines(page).first()).toContainText('Reading your question')
  const shimmering = (line: Locator) => line.locator('[data-slot=trace-title]').evaluate(el => getComputedStyle(el).animationName !== 'none')
  expect(await shimmering(lines(page).first())).toBe(true)

  // Each step adds a row: the newest runs, every earlier one is done (no status, no shimmer).
  for (const n of [2, 3]) {
    await page.clock.runFor(STEP_MS)
    await expect(lines(page)).toHaveCount(n)
    await expect(thinking(page).locator('[data-slot=trace-line][data-status="running"]')).toHaveCount(1)
    await expect(lines(page).last()).toHaveAttribute('data-status', 'running')
    for (let i = 0; i < n - 1; i++) {
      await expect(lines(page).nth(i)).not.toHaveAttribute('data-status', /.+/)
      expect(await shimmering(lines(page).nth(i))).toBe(false)
    }
  }

  // The text arrives, then shows a few words at a time: it grows on each 50 ms step, never all at once, and the words
  // don't fade in (nothing animates in the text box).
  await page.clock.runFor(STEP_MS * 2)
  const answer = log(page).locator('[data-answer]').last()
  const box = answerText(answer)
  await expect(box).toBeVisible()
  await expect(log(page)).toHaveAttribute('aria-busy', 'true')
  const words = async () => ((await box.innerText()).match(/\S+/g) ?? []).length
  const seen = [await words()]
  for (let i = 0; i < 4; i++) {
    await page.clock.runFor(50)
    await expect.poll(words).toBeGreaterThan(seen.at(-1)!)
    seen.push(await words())
    expect(await box.evaluate(el => el.getAnimations({ subtree: true }).length)).toBe(0)
  }
  // A few words per step (at least three, screens/chat/reveal.ts MIN_WORDS), and the answer isn't all there yet.
  for (let i = 1; i < seen.length; i++) expect(seen[i] - seen[i - 1]).toBeGreaterThanOrEqual(3)
  await expect(log(page)).toHaveAttribute('aria-busy', 'true')

  // Then all of it.
  await page.clock.runFor(5000)
  await expect(log(page)).not.toHaveAttribute('aria-busy', 'true')
  await expect(answer).toContainText("can't answer that from your tools yet")
  expect(await words()).toBeGreaterThan(seen.at(-1)!)
  await expect(thinking(page)).toHaveCount(0)

  // The measures at 1440: the answer's text about 620px wide (it wraps), your message's bubble about 520px.
  const answerWidth = (await box.boundingBox())!.width
  expect(answerWidth).toBeGreaterThan(610)
  expect(answerWidth).toBeLessThanOrEqual(620.5)
  const mine = log(page).locator('[data-chat-msg]').filter({ hasText: 'outdoor pop-up stand' }).locator('[data-slot=bubble-content]')
  const mineWidth = (await mine.boundingBox())!.width
  expect(mineWidth).toBeGreaterThan(500)
  expect(mineWidth).toBeLessThanOrEqual(520.5)

  // It cites nothing: its steps line is there, its Sources pill is not.
  await expect(answer.getByRole('button', { name: /\d+ steps/ })).toBeVisible()
  await expect(answer.locator('[data-sources]')).toHaveCount(0)
  await expect(answer.getByRole('button', { name: /\d+ sources?/ })).toHaveCount(0)
})
