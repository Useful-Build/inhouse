// TEMPORARY diagnostic for #607 (never merged): what each pointer event hits around the Details click, when the steps
// list's open animation starts, and when the answers' markdown renderer replaces the plain fallback.
import { fxFor, test } from './support/fx.js'

test.afterEach(async ({ page }) => { await page.clock.resume() })

test('diag: Details click', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.clock.install()
  await page.addInitScript(() => {
    const log: unknown[] = []
    ;(window as unknown as { __diag: unknown[] }).__diag = log
    const now = () => Math.round(Number(document.timeline.currentTime))
    const content = () => document.querySelector('[data-answer] [data-steps] > [data-slot=trace-collapsible-content]')
    const h = () => { const c = content(); return c ? Math.round(c.getBoundingClientRect().height) : -1 }
    const desc = (el: EventTarget | null) => {
      if (!(el instanceof Element)) return String(el)
      const b = el.closest('button')
      return `${el.tagName}${b ? ` in button "${(b.getAttribute('aria-label') ?? b.textContent ?? '').slice(0, 24)}"` : ''}`
    }
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
      window.addEventListener(type, e => {
        const m = e as MouseEvent
        log.push({ t: Math.round(e.timeStamp), type, target: desc(e.target), at: desc(document.elementFromPoint(m.clientX, m.clientY)), y: m.clientY, h: h(), anim: content()?.getAnimations().map(a => `${(a as CSSAnimation).animationName}@${Math.round(Number(a.currentTime))}`) })
      }, true)
    }
    for (const type of ['animationstart', 'animationcancel', 'animationend']) {
      document.addEventListener(type, e => {
        if (e.target !== content()) return
        log.push({ t: now(), type, name: (e as AnimationEvent).animationName, h: h() })
      }, true)
    }
    new MutationObserver(records => {
      for (const r of records) for (const n of r.addedNodes) {
        if (n instanceof HTMLElement && n.closest('[data-answer]') && n.tagName === 'DIV' && n.querySelector(':scope > p')) log.push({ t: now(), type: 'markdown-commit', h: h() })
        if (n instanceof HTMLElement && n.getAttribute('role') === 'dialog') log.push({ t: now(), type: 'dialog-added' })
      }
      for (const r of records) if (r.type === 'attributes' && r.target === content()) log.push({ t: now(), type: `attr ${r.attributeName}`, v: (r.target as HTMLElement).getAttribute(r.attributeName!)?.slice(0, 80), h: h() })
    }).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['style', 'data-state', 'hidden'] })
  })
  await fxFor(page, undefined).seed({ stage: 'Act', scenario: 'Normal', demo: { ambient: 'Always' } })
  await page.goto('/?demo#/chats/stuck')
  const first = page.getByRole('log', { name: 'Conversation' }).locator('[data-answer]').first()
  try {
    await first.getByRole('button', { name: /\d+ steps/ }).click()
    await page.evaluate(() => (window as unknown as { __diag: unknown[] }).__diag.push({ t: Math.round(Number(document.timeline.currentTime)), type: 'steps-click-done' }))
    await first.getByRole('button', { name: 'Details', exact: true }).click()
    await page.evaluate(() => (window as unknown as { __diag: unknown[] }).__diag.push({ t: Math.round(Number(document.timeline.currentTime)), type: 'details-click-done' }))
    await page.getByRole('dialog', { name: 'What your Inhouse agent did' }).waitFor({ state: 'visible', timeout: 5000 })
  } finally {
    const log = await page.evaluate(() => (window as unknown as { __diag: unknown[] }).__diag)
    console.log(`DIAG ${test.info().repeatEachIndex} ${JSON.stringify(log)}`)
  }
})
