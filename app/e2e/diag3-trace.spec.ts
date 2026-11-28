// TEMPORARY diagnostic for #607 (never merged), run 2. Passive: nothing here forces style between frames. A ResizeObserver
// on the steps list logs its height each time a frame changes it, with the opening animation's state, so a list that
// stands at full height before it animates shows as a height that goes down (0, 231, 31, ...).
import { fxFor, test } from './support/fx.js'

test.afterEach(async ({ page }) => { await page.clock.resume() })

for (const copy of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]) test(`diag3 passive ${copy}`, async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.clock.install()
  await page.addInitScript(() => {
    const real = () => new Event('x').timeStamp
    const r1 = (n: unknown) => (n === null || n === undefined ? null : Math.round(Number(n) * 10) / 10)
    const content = () => document.querySelector<HTMLElement>('[data-answer] [data-steps] > [data-slot=trace-collapsible-content]')
    const d = { t0: 0, ro: [] as unknown[], ev: [] as unknown[] }
    ;(window as unknown as { __d3: typeof d }).__d3 = d
    const anim = (c: HTMLElement) => { const a = c.getAnimations()[0]; return a ? [a.pending ? 'P' : a.playState[0], r1(a.currentTime), r1(a.startTime)] : ['-'] }
    let ro: ResizeObserver | undefined
    window.addEventListener('click', e => {
      if (d.t0 || !(e.target as Element).closest?.('[data-slot=trace-collapsible-trigger]')) return
      d.t0 = real()
      const c = content()!
      // Inside the callback layout is clean, so reading the box and the animation forces nothing.
      ro = new ResizeObserver(entries => { d.ro.push([r1(real() - d.t0), r1(document.timeline.currentTime), Math.round(entries[0].contentRect.height), ...anim(c)]) })
      ro.observe(c)
    }, true)
    for (const type of ['animationstart', 'animationcancel', 'animationend']) document.addEventListener(type, e => {
      if (e.target === content()) d.ev.push([type.slice(9), r1(real() - d.t0), r1(document.timeline.currentTime)])
    }, true)
    // The press on Details: its time only (no layout read, the ResizeObserver has the heights).
    for (const type of ['pointerdown', 'pointerup']) window.addEventListener(type, e => {
      if (d.t0 && (e.target as Element).closest?.('[data-steps]')) d.ev.push([type.slice(7), r1(real() - d.t0), r1(document.timeline.currentTime), (e.target as Element).closest?.('button')?.textContent?.slice(0, 7) ?? (e.target as Element).tagName])
    }, true)
    new MutationObserver(records => {
      for (const r of records) for (const n of r.addedNodes) if (d.t0 && n instanceof HTMLElement && n.closest('[data-answer]') && n.tagName === 'DIV' && n.querySelector(':scope > p')) d.ev.push(['md', r1(real() - d.t0), r1(document.timeline.currentTime)])
    }).observe(document, { subtree: true, childList: true })
  })
  await fxFor(page, undefined).seed({ stage: 'Act', scenario: 'Normal', demo: { ambient: 'Always' } })
  await page.goto('/?demo#/chats/stuck')
  const first = page.getByRole('log', { name: 'Conversation' }).locator('[data-answer]').first()
  await first.getByRole('button', { name: /\d+ steps/ }).click()
  await first.getByRole('button', { name: 'Details', exact: true }).click()
  const ok = await page.getByRole('dialog', { name: 'What your Inhouse agent did' }).waitFor({ state: 'visible', timeout: 3000 }).then(() => true, () => false)
  console.log(`DIAG3 passive ${ok ? 'ok' : 'FAIL'} ${JSON.stringify(await page.evaluate(() => (window as unknown as { __d3: unknown }).__d3))}`)
})
