// The 30 fps motion check (UI_PLAN_2 PR 5, rewritten for UI_BASE_V2 D1): a new question settles near the top of the view and
// its answer grows under it without moving it; once the answer fills the view, the view follows the live edge; a scroll up
// holds while the answer streams, and Jump to latest goes back and follows again.
// Not part of `npm run test:e2e` or CI's run: the `motion` project exists only with MOTION=1, set by `gh workflow run motion`.
// Every animation frame is sampled in the page (scrollTop, the room below the view, the newest question's place, Message
// Scroller's spacer), saved as JSON next to the video, and checked for a view that jumps.
import { writeFileSync } from 'node:fs'
import { expect, fxFor, test } from './support/fx.js'
import type { Page } from '@playwright/test'

type Frame = { t: number; phase: string; top: number; height: number; client: number; below: number; q: number | null; qText: string; spacer: number }

const MD_Q = "Give me the query for last week's orders by SKU" // text, a code block and a wide table: taller than the view
/** Most the view's top, or the pinned question, may move between two frames without counting as a jump. */
const JUMP_PX = 4
/** Room below the view that still counts as at the live edge. */
const EDGE_PX = 12
/** Frames a change may take to land: Message Scroller measures on the frame after a resize. */
const SETTLE_FRAMES = 3

const composer = (page: Page) => page.getByRole('textbox', { name: 'Message Inhouse' })
const stop = (page: Page) => page.locator('[data-composer]').getByRole('button', { name: 'Stop', exact: true })
const jump = (page: Page) => page.getByRole('button', { name: 'Jump to latest' })
const phase = (page: Page, name: string) => page.evaluate(n => { (window as unknown as { __phase: string }).__phase = n }, name)

async function open(page: Page) {
  await fxFor(page, undefined).seed({ demo: { ambient: 'Always' } })
  await page.goto('/?demo#/chats/refunds')
  await expect(page.getByRole('log', { name: 'Conversation' }).getByText('Refund requests rose').first()).toBeVisible()
}

/** Starts the per-frame sampler in the page. */
const startSampling = (page: Page) => page.evaluate(() => {
  const w = window as unknown as { __frames: unknown[]; __stop: boolean; __phase: string }
  w.__frames = []
  w.__stop = false
  w.__phase = 'open'
  const tick = (t: number) => {
    const log = document.querySelector('[role="log"]')!
    const el = log.closest('.overflow-auto')!
    const view = el.getBoundingClientRect()
    // The newest question: the row Message Scroller pins (only the newest is an anchor).
    const anchor = log.querySelector('[data-scroll-anchor="true"]')
    const spacer = log.querySelector<HTMLElement>('[data-message-scroller-spacer]')
    w.__frames.push({
      t, phase: w.__phase, top: el.scrollTop, height: el.scrollHeight, client: el.clientHeight,
      below: el.scrollHeight - el.scrollTop - el.clientHeight,
      q: anchor ? anchor.getBoundingClientRect().top - view.top : null,
      qText: (anchor?.textContent ?? '').slice(0, 200),
      spacer: spacer && !spacer.hidden ? spacer.offsetHeight : 0,
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
const frameCount = (page: Page) => page.evaluate(() => (window as unknown as { __frames: unknown[] }).__frames.length)
const moreFrames = async (page: Page, n: number) => {
  const have = await frameCount(page)
  await page.waitForFunction(m => (window as unknown as { __frames: unknown[] }).__frames.length >= m, have + n)
}

/** Frame problems: a view that jumps back up, a pinned question that moves, and the live edge lost while following. */
function problemsIn(frames: Frame[]): string[] {
  const out: string[] = []
  const at = (i: number) => `frame ${i} (${frames[i].t.toFixed(0)}ms, ${frames[i].phase})`
  // Runs of frames with room below the view while the view should be at the live edge.
  let off = 0
  for (let i = 1; i < frames.length; i++) {
    const a = frames[i - 1], b = frames[i]
    // The reader's own scroll up is the one move up allowed.
    if (b.phase !== 'held' && a.top - b.top > JUMP_PX) out.push(`${at(i)}: the view jumped up, scrollTop ${a.top.toFixed(1)} -> ${b.top.toFixed(1)}`)
    // Pinned: the same question, the spacer holding it near the top, so the answer grows under it without moving it.
    if (a.qText === b.qText && a.spacer > 0 && b.spacer > 0 && a.q !== null && b.q !== null && Math.abs(b.q - a.q) > JUMP_PX)
      out.push(`${at(i)}: the pinned question moved ${a.q.toFixed(1)} -> ${b.q.toFixed(1)}`)
    // Asking, following and after Jump to latest: at the live edge, give or take a frame for a new part to be measured.
    const following = b.phase === 'asked' || b.phase === 'jumped'
    off = following && b.below > EDGE_PX ? off + 1 : 0
    if (off === SETTLE_FRAMES) out.push(`${at(i)}: ${b.below.toFixed(1)}px below the view for ${SETTLE_FRAMES} frames while at the live edge`)
  }
  return out
}

for (const [name, viewport] of [['desktop', { width: 1440, height: 900 }], ['phone', { width: 390, height: 844 }]] as const) {
  test.describe(name, () => {
    // Video is on for the whole motion project (playwright.config.ts); a describe can only change the viewport.
    test.use({ viewport })

    for (const run of [1, 2, 3]) {
      test(`${name} run ${run}${run === 1 ? ' (cold start)' : ''}: a new question pins near the top, the answer grows under it, Jump to latest follows again`, async ({ page }) => {
        await open(page)
        await startSampling(page)

        // 1. Ask: the question settles near the top, then the answer streams to its end.
        await phase(page, 'asked')
        await composer(page).fill(MD_Q)
        await page.keyboard.press('Enter')
        await expect(stop(page)).toBeVisible()
        await expect(stop(page)).toHaveCount(0, { timeout: 30_000 })
        await moreFrames(page, 30)

        // 2. Ask again and scroll up while it streams: the view holds; Jump to latest goes back and follows to the end.
        await phase(page, 'asked')
        await composer(page).fill(MD_Q)
        await page.keyboard.press('Enter')
        await expect(stop(page)).toBeVisible()
        await phase(page, 'held')
        await page.getByRole('log', { name: 'Conversation' }).hover()
        await page.mouse.wheel(0, -600)
        await expect(jump(page)).toBeVisible()
        await moreFrames(page, SETTLE_FRAMES)
        await phase(page, 'holding')
        await moreFrames(page, 15)
        await phase(page, 'jumped')
        await jump(page).click()
        await expect(jump(page)).toHaveCount(0)
        await expect(stop(page)).toHaveCount(0, { timeout: 30_000 })
        // About half a second of frames after the answer settles.
        await moreFrames(page, 30)
        const frames = await stopSampling(page)
        // The JSON lives next to the video, in the test's own output folder.
        writeFileSync(test.info().outputPath(`frames-${name}-run${run}.json`), JSON.stringify({ viewport, frames }, null, 1))

        // The page ran at animation speed: about 20 frames a second or better over the whole run.
        const seconds = (frames[frames.length - 1].t - frames[0].t) / 1000
        expect(frames.length / seconds, 'frame rate').toBeGreaterThan(20)

        // The new question settles near the top: in the top 40% of the view, a few frames after it shows.
        const first = frames.findIndex(f => f.phase === 'asked' && f.qText.includes(MD_Q))
        expect(first, 'the question shows').toBeGreaterThanOrEqual(0)
        const settled = frames[first + SETTLE_FRAMES]
        expect(settled.q!, 'the question near the top').toBeGreaterThanOrEqual(0)
        expect(settled.q!, 'the question near the top').toBeLessThanOrEqual(settled.client * 0.4)
        // It was pinned for a while (the spacer held it), and the answer then filled the view: the spacer went.
        expect(frames.some(f => f.phase === 'asked' && f.spacer > 0), 'pinned by the spacer').toBe(true)

        // Held: while scrolled up the view doesn't move, however the answer grows below.
        const held = frames.filter(f => f.phase === 'holding')
        expect(held.length).toBeGreaterThan(0)
        expect(held.every(f => Math.abs(f.top - held[0].top) <= 1), 'the view holds while scrolled up').toBe(true)

        expect(problemsIn(frames), 'view jumps').toEqual([])
        // The view ends at the live edge.
        expect(frames[frames.length - 1].below).toBeLessThanOrEqual(1)
      })
    }
  })
}
