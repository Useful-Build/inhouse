// The 30 fps motion check for PR 5 (UI_PLAN_2): sending, streaming and finishing an answer must not jump the view.
// Not part of `npm run test:e2e` or CI's run: the `motion` project exists only with MOTION=1, set by `gh workflow run motion`.
// Every animation frame is sampled in the page (scrollTop, scrollHeight, the last message's bottom), saved as JSON
// next to the video, and checked for a view that jumps up or a bottom gap that jumps.
import { writeFileSync } from 'node:fs'
import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'

type Frame = { t: number; top: number; height: number; client: number; msgs: number; gap: number }

const MD_Q = "Give me the query for last week's orders by SKU" // text, a code block and a wide table
const NEXT_Q = 'Why did refunds jump?'
/** The app keeps the view stuck to the bottom within 80px of it. */
const NEAR_BOTTOM_PX = 80
/** Most the view's top may fall, and the bottom gap may change, between two frames. */
const JUMP_PX = 4
const GAP_PX = 12

const composer = (page: Page) => page.getByRole('textbox', { name: 'Message your Inhouse agent' })
const stop = (page: Page) => page.locator('[data-composer]').getByRole('button', { name: 'Stop', exact: true })

async function open(page: Page) {
  await page.addInitScript(() => {
    if (sessionStorage.getItem('e2e-seeded')) return
    localStorage.clear()
    localStorage.setItem('inhouse.demo.switches.v1', JSON.stringify({ stage: 'Act', scenario: 'Normal', ambient: 'Always', animateMark: false }))
    sessionStorage.setItem('e2e-seeded', '1')
  })
  await page.goto('/?demo#/chats/refunds')
  await expect(page.getByRole('log', { name: 'Conversation' }).getByText('Refund requests rose').first()).toBeVisible()
  await page.evaluate(() => {
    const el = document.querySelector('[role="log"]')!.closest('.overflow-auto')!
    el.scrollTop = el.scrollHeight
  })
}

/** Starts the per-frame sampler in the page. */
const startSampling = (page: Page) => page.evaluate(() => {
  const w = window as unknown as { __frames: unknown[]; __stop: boolean }
  w.__frames = []
  w.__stop = false
  const tick = (t: number) => {
    const el = document.querySelector('[role="log"]')!.closest('.overflow-auto')!
    const msgs = document.querySelectorAll('[role="log"] [data-chat-msg]')
    const last = msgs[msgs.length - 1]
    w.__frames.push({
      t, top: el.scrollTop, height: el.scrollHeight, client: el.clientHeight, msgs: msgs.length,
      gap: last ? last.getBoundingClientRect().bottom - el.getBoundingClientRect().bottom : 0,
    })
    if (!w.__stop) requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
})

const stopSampling = (page: Page) => page.evaluate(() => {
  const w = window as unknown as { __frames: Frame[]; __stop: boolean }
  w.__stop = true
  return w.__frames
})

async function ask(page: Page, q: string) {
  await composer(page).fill(q)
  await page.keyboard.press('Enter')
  await expect(stop(page)).toBeVisible()
  await expect(stop(page)).toHaveCount(0, { timeout: 30_000 })
}

for (const [name, viewport] of [['desktop', { width: 1440, height: 900 }], ['phone', { width: 390, height: 844 }]] as const) {
  test.describe(name, () => {
    // Video is on for the whole motion project (playwright.config.ts); a describe can only change the viewport.
    test.use({ viewport })

    for (const run of [1, 2, 3]) {
      test(`${name} run ${run}${run === 1 ? ' (cold start)' : ''}: sending, streaming and finishing don't jump the view`, async ({ page }) => {
        await open(page)
        await startSampling(page)
        await ask(page, MD_Q)
        await ask(page, NEXT_Q)
        // About half a second of frames after the answer settles: wait for 30 more sampled frames.
        const sampled = await page.evaluate(() => (window as unknown as { __frames: unknown[] }).__frames.length)
        await page.waitForFunction(n => (window as unknown as { __frames: unknown[] }).__frames.length >= n + 30, sampled)
        const frames = await stopSampling(page)
        // The JSON lives next to the video, in the test's own output folder.
        writeFileSync(test.info().outputPath(`frames-${name}-run${run}.json`), JSON.stringify({ viewport, frames }, null, 1))

        // The page ran at animation speed: about 20 frames a second or better over the whole run.
        const seconds = (frames[frames.length - 1].t - frames[0].t) / 1000
        expect(frames.length / seconds, 'frame rate').toBeGreaterThan(20)

        const problems: string[] = []
        for (let i = 1; i < frames.length; i++) {
          const a = frames[i - 1], b = frames[i]
          const stuck = a.height - a.top - a.client <= NEAR_BOTTOM_PX
          if (!stuck) continue
          if (a.top - b.top > JUMP_PX) problems.push(`frame ${i} (${b.t.toFixed(0)}ms): scrollTop ${a.top.toFixed(1)} -> ${b.top.toFixed(1)}`)
          // A new message changes which one is last, so its first frame is skipped.
          if (a.msgs === b.msgs && Math.abs(b.gap - a.gap) > GAP_PX) problems.push(`frame ${i} (${b.t.toFixed(0)}ms): bottom gap ${a.gap.toFixed(1)} -> ${b.gap.toFixed(1)}`)
        }
        expect(problems, 'view jumps while stuck to the bottom').toEqual([])
        // The view ends at the bottom.
        const end = frames[frames.length - 1]
        expect(end.height - end.top - end.client).toBeLessThanOrEqual(NEAR_BOTTOM_PX)
      })
    }
  })
}
