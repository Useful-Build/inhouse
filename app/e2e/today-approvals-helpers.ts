// Shared by today-approvals.spec.ts and today-approvals-phone.spec.ts: start at a stage, and find any text a card cuts.
import { expect } from '@playwright/test'
import type { Page } from '@playwright/test'

export type Stage = 'Watch' | 'Act' | 'Run'
export const STAGES: Stage[] = ['Watch', 'Act', 'Run']

export async function start(page: Page, stage: Stage, hash: string) {
  await page.addInitScript(([s]) => {
    if (sessionStorage.getItem('e2e-seeded')) return
    localStorage.clear()
    localStorage.setItem('inhouse.demo.switches.v1', JSON.stringify({ stage: s, scenario: 'Normal', ambient: 'Off', animateMark: false }))
    sessionStorage.setItem('e2e-seeded', '1')
  }, [stage])
  await page.goto('/?demo' + hash)
}

/** Every text element inside a Today card or an Approvals card that is wider than its box (cut, clipped or ellipsized), and any sideways scroll of the page. */
export async function cutText(page: Page) {
  return page.evaluate(() => {
    const cut: string[] = []
    for (const el of document.querySelectorAll<HTMLElement>('main article *, main [data-slot=card] *')) {
      const hasText = Array.from(el.childNodes).some(n => n.nodeType === Node.TEXT_NODE && (n.textContent ?? '').trim() !== '')
      if (hasText && el.scrollWidth > el.clientWidth + 1) cut.push(`<${el.tagName.toLowerCase()}> "${(el.textContent ?? '').trim().slice(0, 48)}" scrollWidth ${el.scrollWidth} > clientWidth ${el.clientWidth}`)
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
