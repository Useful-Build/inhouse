// New chat keeps its layout across a reload and on a direct load: the heading above the composer, the composer in the
// middle band (never docked at the bottom), and the three suggestion cards plus the Routine row below it, never
// flickering away once shown. A frame sampler (requestAnimationFrame) records every frame from page start.
import { expect, fxFor, test } from './support/fx.js'
import type { Page } from '@playwright/test'

type Frame = {
  hash: string
  composerTop: number | null
  docked: boolean
  headingTop: number | null
  bento: boolean
  cards: number
  routine: number
  vh: number
}

// Runs on every document load (so also after a reload). Samples each frame until the bento has shown for a moment
// (so a later disappearance is caught) or 3 s pass, then sets window.__layoutDone.
const SAMPLER = `(() => {
  const frames = []
  const t0 = performance.now()
  let seenAt = null
  const tick = () => {
    const now = performance.now()
    const composer = document.querySelector('[data-composer]')
    const heading = [...document.querySelectorAll('h2')].find(e => (e.textContent || '').includes('What do you want to know?'))
    const bento = document.querySelector('[data-prompt-bento]')
    frames.push({
      hash: location.hash,
      composerTop: composer ? composer.getBoundingClientRect().top : null,
      docked: !!document.querySelector('[data-bottom-dock]'),
      headingTop: heading ? heading.getBoundingClientRect().top : null,
      bento: !!bento,
      cards: document.querySelectorAll('[data-prompt-card]').length,
      routine: document.querySelectorAll('[data-prompt-routine]').length,
      vh: innerHeight,
    })
    if (bento && seenAt === null) seenAt = now
    if ((seenAt !== null && now - seenAt > 500) || now - t0 > 3000) { window.__layoutFrames = frames; window.__layoutDone = true }
    else requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
})()`

async function sampled(page: Page): Promise<Frame[]> {
  await page.waitForFunction(() => (window as unknown as { __layoutDone?: boolean }).__layoutDone === true)
  return page.evaluate(() => (window as unknown as { __layoutFrames: Frame[] }).__layoutFrames)
}

function assertLayout(frames: Frame[]) {
  const onNew = frames.filter(f => f.hash === '#/chats/new')
  const withComposer = onNew.filter(f => f.composerTop !== null)
  expect(withComposer.length, 'the composer shows on #/chats/new').toBeGreaterThan(0)

  for (const f of withComposer) {
    expect(f.docked, 'blank New chat never docks the composer at the bottom').toBe(false)
    expect(f.composerTop!, `composer top stays in the middle band (viewport ${f.vh})`).toBeLessThan(0.6 * f.vh)
    if (f.headingTop !== null) expect(f.headingTop, 'the heading is above the composer').toBeLessThan(f.composerTop!)
  }

  const first = onNew.findIndex(f => f.bento)
  expect(first, 'the suggestion cards show').toBeGreaterThanOrEqual(0)
  expect(onNew.slice(first).every(f => f.bento), 'the cards never disappear once shown').toBe(true)

  const last = onNew[onNew.length - 1]
  expect(last.cards, 'three suggestion cards').toBe(3)
  expect(last.routine, 'the Routine row').toBe(1)
}

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  test.describe(`New chat layout at ${viewport.width}x${viewport.height}`, () => {
    test.use({ viewport })

    test.beforeEach(async ({ page }) => {
      await fxFor(page, undefined).seed({ stage: 'Act' })
      await page.addInitScript(SAMPLER)
    })

    test('after a reload of #/chats/new', async ({ page }) => {
      await page.goto('/?demo#/chats/new')
      await expect(page.getByRole('heading', { name: 'What do you want to know?' })).toBeVisible()
      await page.reload()
      assertLayout(await sampled(page))
    })

    test('on a direct load of #/chats/new', async ({ page }) => {
      await page.goto('/?demo#/chats/new')
      assertLayout(await sampled(page))
    })
  })
}
