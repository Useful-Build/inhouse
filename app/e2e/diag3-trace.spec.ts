// TEMPORARY diagnostic for #607 (never merged). Hypothesis: the steps list's opening animation (accordion-down, on the main
// thread) gets its start time from the compositor (it starts in the same frame as the chevron's rotate transition), and
// while that start time is ahead of the page's animation clock the animation is in its "before" phase: with fill-mode
// none it has no effect, so the list is laid out at full height (Details can be hit) until the clock catches up and the
// list then animates from zero. `natural` samples the animation's times around the click; `forced` puts the animation in
// the before phase on purpose (startTime in the future) and clicks Details like the real spec.
import { fxFor, test } from './support/fx.js'
import type { Page } from '@playwright/test'

test.afterEach(async ({ page }) => { await page.clock.resume() })

type Jank = 'none' | 'A' | 'B' | 'C'

async function open(page: Page, jank: Jank) {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.clock.install()
  await page.addInitScript((jank: Jank) => {
    const real = () => new Event('x').timeStamp
    const r1 = (n: number | null | undefined) => (n === null || n === undefined ? null : Math.round(Number(n) * 10) / 10)
    const content = () => document.querySelector<HTMLElement>('[data-answer] [data-steps] > [data-slot=trace-collapsible-content]')
    const details = () => [...document.querySelectorAll<HTMLElement>('[data-answer] [data-steps] button')].find(b => b.textContent?.startsWith('Details'))
    const spin = (ms: number) => { const end = real() + ms; while (real() < end) { /* busy */ } }
    const d = { samples: 0, t0: 0, created: null as number | null, startedAt: null as number | null, st: null as number | null, tlAtStart: null as number | null,
      neg: [] as unknown[], negMs: 0, negMin: 0, pendMs: 0, starts: 0, cancels: 0, events: [] as unknown[], fill: '' }
    ;(window as unknown as { __d3: typeof d }).__d3 = d
    const hit = () => { const b = details(); if (!b) return null; const r = b.getBoundingClientRect(); const el = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); return !!el && b.contains(el) }
    for (const type of ['animationstart', 'animationcancel', 'animationend']) document.addEventListener(type, e => {
      if (e.target !== content()) return
      if (type === 'animationstart') d.starts++
      if (type === 'animationcancel') d.cancels++
      d.events.push([type, r1(real() - d.t0), r1(document.timeline.currentTime as number), Math.round(content()!.getBoundingClientRect().height)])
    }, true)
    for (const type of ['pointerdown', 'pointerup', 'click']) window.addEventListener(type, e => {
      if (!d.t0) return
      const c = content(); const a = c?.getAnimations()[0]
      d.events.push([type, r1(real() - d.t0), r1(document.timeline.currentTime as number), c ? Math.round(c.getBoundingClientRect().height) : -1, a ? r1(a.currentTime as number | null) : 'none', (e.target as Element).closest?.('button')?.textContent?.slice(0, 8) ?? (e.target as Element).tagName])
    }, true)
    let lastNeg: number | null = null, lastPend: number | null = null, didB = false
    const ch = new MessageChannel()
    const tick = () => {
      const rt = real() - d.t0
      if (rt > 400) return
      d.samples++
      const c = content()
      const a = c?.getAnimations()[0] as CSSAnimation | undefined
      if (a) {
        if (d.created === null) { d.created = r1(rt); d.fill = getComputedStyle(c!).animationFillMode }
        const ct = a.currentTime as number | null
        if (a.pending) { if (lastPend !== null) d.pendMs += rt - lastPend; lastPend = rt } else lastPend = null
        if (!a.pending && d.startedAt === null) { d.startedAt = r1(rt); d.st = r1(a.startTime as number | null); d.tlAtStart = r1(document.timeline.currentTime as number) }
        if (ct !== null && ct < 0) {
          if (lastNeg !== null) d.negMs += rt - lastNeg
          lastNeg = rt
          d.negMin = Math.min(d.negMin, ct)
          if (d.neg.length < 6) d.neg.push({ rt: r1(rt), ct: r1(ct), st: r1(a.startTime as number | null), tl: r1(document.timeline.currentTime as number), h: Math.round(c!.getBoundingClientRect().height), hit: hit(), pend: a.pending })
        } else lastNeg = null
      }
      if (jank === 'A' && d.samples === 1) spin(60)
      if (jank === 'B' && !didB && rt > 20) { didB = true; spin(60) }
      if (jank === 'C' && rt < 220) spin(12)
      ch.port2.postMessage(0)
    }
    ch.port1.onmessage = tick
    window.addEventListener('click', e => {
      if (d.t0 || !(e.target as Element).closest?.('[data-slot=trace-collapsible-trigger]')) return
      d.t0 = real(); d.pendMs = 0; d.negMs = 0
      ch.port2.postMessage(0)
    }, true)
  }, jank)
  await fxFor(page, undefined).seed({ stage: 'Act', scenario: 'Normal', demo: { ambient: 'Always' } })
  await page.goto('/?demo#/chats/stuck')
  return page.getByRole('log', { name: 'Conversation' }).locator('[data-answer]').first()
}

const fillBackwards = (page: Page) => page.evaluate(() => {
  document.querySelector<HTMLElement>('[data-answer] [data-steps] > [data-slot=trace-collapsible-content]')!.style.animationFillMode = 'backwards'
})
const dialogOpens = (page: Page, timeout: number) => page.getByRole('dialog', { name: 'What your Inhouse agent did' }).waitFor({ state: 'visible', timeout }).then(() => true, () => false)
const read = (page: Page) => page.evaluate(() => (window as unknown as { __d3: unknown }).__d3)

// What Chrome does by itself: the same steps as trace-replay.spec.ts, the animation's times sampled.
for (const [jank, fill] of [['none', false], ['A', false], ['B', false], ['C', false], ['B', true], ['C', true]] as const) test(`diag3 natural jank=${jank} fill=${fill}`, async ({ page }) => {
  const first = await open(page, jank)
  const steps = first.getByRole('button', { name: /\d+ steps/ })
  if (fill) { await steps.waitFor(); await fillBackwards(page) }
  await steps.click()
  await first.getByRole('button', { name: 'Details', exact: true }).click()
  const ok = await dialogOpens(page, 3000)
  console.log(`DIAG3 natural jank=${jank} fill=${fill} ${ok ? 'ok' : 'FAIL'} ${JSON.stringify(await read(page))}`)
})

// The before phase on purpose: the animation's start time moved `ahead` ms past the animation clock right after the list opens.
for (const ahead of [30, 45, 60, 80, 5000]) for (const fill of [false, true]) test(`diag3 forced ahead=${ahead} fill=${fill}`, async ({ page }) => {
  const first = await open(page, 'none')
  const steps = first.getByRole('button', { name: /\d+ steps/ })
  if (fill) { await steps.waitFor(); await fillBackwards(page) }
  await steps.click()
  const at = await page.evaluate(ahead => {
    const c = document.querySelector<HTMLElement>('[data-answer] [data-steps] > [data-slot=trace-collapsible-content]')!
    const a = c.getAnimations()[0]
    if (!a) return { none: true }
    const before = { ct: a.currentTime, pend: a.pending, h: Math.round(c.getBoundingClientRect().height) }
    a.startTime = Number(document.timeline.currentTime) + ahead
    const b = [...c.querySelectorAll('button')].find(x => x.textContent?.startsWith('Details'))!
    const r = b.getBoundingClientRect()
    const el = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)
    return { before, ct: a.currentTime, h: Math.round(c.getBoundingClientRect().height), hit: !!el && b.contains(el), fill: getComputedStyle(c).animationFillMode }
  }, ahead)
  const clicked = await first.getByRole('button', { name: 'Details', exact: true }).click({ timeout: ahead === 5000 ? 1500 : 10_000 }).then(() => true, () => false)
  const ok = clicked && await dialogOpens(page, 3000)
  const d = await read(page) as { events: unknown[] }
  console.log(`DIAG3 forced ahead=${ahead} fill=${fill} ${ok ? 'ok' : clicked ? 'FAIL' : 'noclick'} ${JSON.stringify({ at, events: d.events })}`)
})
