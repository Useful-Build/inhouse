// Shared by today-approvals.spec.ts and today-approvals-phone.spec.ts: start at a stage, and find any text a card cuts.
import { expect } from '@playwright/test'
import type { Page } from '@playwright/test'

export type Stage = 'Watch' | 'Act' | 'Run'
export const STAGES: Stage[] = ['Watch', 'Act', 'Run']

export async function start(page: Page, stage: Stage, hash: string, scenario = 'Normal') {
  await page.addInitScript(([s, sc]) => {
    if (sessionStorage.getItem('e2e-seeded')) return
    localStorage.clear()
    localStorage.setItem('inhouse.demo.switches.v1', JSON.stringify({ stage: s, scenario: sc, ambient: 'Off', animateMark: false }))
    sessionStorage.setItem('e2e-seeded', '1')
  }, [stage, scenario])
  await page.goto('/?demo' + hash)
}

/**
 * Text a card cuts, in a Today card, an Approvals card or Approvals' Watch block: any element whose own box clips its content
 * sideways or down (overflow not visible), and any text element whose box sticks out of the card or out of a clipping parent.
 * Hidden skeletons and icon spans are skipped. Also any sideways scroll of the page.
 */
export async function cutText(page: Page) {
  await page.evaluate(() => document.fonts.ready)
  return page.evaluate(() => {
    const cut: string[] = []
    const label = (el: Element) => `<${el.tagName.toLowerCase()}> "${(el.textContent ?? '').trim().slice(0, 48)}"`
    const skip = (el: Element) => !!el.closest('[aria-hidden=true]') || el.classList.contains('ms')
    const clips = (el: Element) => { const s = getComputedStyle(el); return s.overflowX !== 'visible' || s.overflowY !== 'visible' }
    for (const root of document.querySelectorAll<HTMLElement>('main article, main [data-slot=card], main [data-watch-block]')) {
      if (skip(root)) continue
      for (const el of root.querySelectorAll<HTMLElement>('*')) {
        if (skip(el)) continue
        const own = Array.from(el.childNodes).some(n => n.nodeType === Node.TEXT_NODE && (n.textContent ?? '').trim() !== '')
        if (clips(el) && (el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1)) cut.push(`${label(el)} clipped by its own box: scroll ${el.scrollWidth}x${el.scrollHeight}, client ${el.clientWidth}x${el.clientHeight}`)
        if (!own) continue
        const r = el.getBoundingClientRect()
        if (r.width === 0 || r.height === 0) continue
        const bounds = [root]
        for (let p = el.parentElement; p && p !== root; p = p.parentElement) if (clips(p)) bounds.push(p)
        for (const b of bounds) {
          const c = b.getBoundingClientRect()
          if (r.left < c.left - 1 || r.right > c.right + 1 || r.top < c.top - 1 || r.bottom > c.bottom + 1) { cut.push(`${label(el)} sticks out of ${b === root ? 'its card' : `a clipping <${b.tagName.toLowerCase()}>`}`); break }
        }
      }
    }
    const side = [document.documentElement, document.querySelector('main')!].map(e => e.scrollWidth - e.clientWidth)
    if (side.some(px => px > 1)) cut.push(`page scrolls sideways by ${side}`)
    return cut
  })
}

/** Today's cards, then Approvals' cards, at one stage: nothing is cut on either page. */
export async function expectNothingCut(page: Page, stage: Stage) {
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Good morning, Sam.')
  await expect(page.getByRole('article').first()).toBeVisible()
  expect(await cutText(page), `Today at ${stage}`).toEqual([])
  await page.evaluate(() => { location.hash = '#/approvals' })
  await expect(page.getByRole('heading', { level: 1, name: 'Approvals' })).toBeVisible()
  await expect(page.getByRole('main')).toContainText(stage === 'Watch' ? 'would be waiting here' : 'Waiting for you')
  expect(await cutText(page), `Approvals at ${stage}`).toEqual([])
}
