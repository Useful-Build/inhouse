// TEMPORARY diagnostic for #607 (never merged): what each pointer event hits around the Details click, when the steps
// list's open animation starts, and when the answers' markdown renderer replaces the plain fallback.
import { fxFor, test } from './support/fx.js'

test.afterEach(async ({ page }) => { await page.clock.resume() })

for (const copy of [1]) test(`diag: Details click ${copy}`, async ({ page }) => {
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
        watch()
        log.push({ t: Math.round(e.timeStamp), type, dy: details() ? Math.round(details()!.getBoundingClientRect().y) : null, target: desc(e.target), at: desc(document.elementFromPoint(m.clientX, m.clientY)), y: m.clientY, h: h(), anim: content()?.getAnimations().map(a => `${(a as CSSAnimation).animationName}@${Math.round(Number(a.currentTime))}`) })
      }, true)
    }
    const details = () => [...document.querySelectorAll('[data-answer] [data-steps] button')].find(b => b.textContent?.startsWith('Details')) as HTMLElement | undefined
    let ro: ResizeObserver | undefined
    const watch = () => {
      const c = content()
      if (!c || ro) return
      ro = new ResizeObserver(() => { const d = details()?.getBoundingClientRect(); log.push({ t: now(), type: 'resize', h: h(), dy: d ? Math.round(d.y) : null, anims: document.getAnimations().filter(a => (a as CSSAnimation).animationName?.startsWith('accordion')).map(a => `${(a as CSSAnimation).animationName}:${a.playState}@${Math.round(Number(a.currentTime))}`) }) })
      ro.observe(c)
    }
    document.addEventListener('scroll', e => { const el = e.target as Element; log.push({ t: now(), type: 'scroll', who: el.getAttribute?.('data-slot') ?? el.nodeName, top: Math.round((el as Element).scrollTop ?? -1) }) }, true)
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
      for (const r of records) if (r.type === 'attributes' && r.attributeName === 'style' && (r.target as HTMLElement).getAttribute('style')?.includes('display: none')) log.push({ t: now(), type: 'display-none', el: `${(r.target as HTMLElement).tagName}.${(r.target as HTMLElement).className?.toString().slice(0, 40)}` })
      for (const r of records) if (r.type === 'attributes' && r.target === content()) log.push({ t: now(), type: `attr ${r.attributeName}`, v: (r.target as HTMLElement).getAttribute(r.attributeName!)?.slice(0, 240), h: h() })
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
    const failed = test.info().errors.length > 0 || !(log as { type: string }[]).some(e => e.type === 'dialog-added')
    console.log(failed ? `DIAGFAIL ${test.info().title} ${test.info().repeatEachIndex} ${JSON.stringify(log)}` : `DIAGOK ${JSON.stringify((log as { type: string; t: number; h?: number; target?: string }[]).filter(e => !e.type.startsWith('attr') && e.type !== 'resize' && e.type !== 'scroll').map(e => `${e.type}@${e.t}${e.h !== undefined ? `|h${e.h}` : ''}`))}`)
  }
})
