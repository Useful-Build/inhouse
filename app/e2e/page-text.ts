import type { Page } from '@playwright/test'

/** Everything a person could read: the title, the visible text, every text node (hidden ones too), field values, placeholders, aria-labels, titles and alts. */
export async function everything(page: Page) {
  return page.evaluate(() => {
    const parts: string[] = [document.title, document.body.innerText]
    const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
      const tag = n.parentElement?.tagName
      if (tag !== 'STYLE' && tag !== 'SCRIPT') parts.push(n.textContent ?? '')
    }
    document.querySelectorAll('[placeholder],[aria-label],[title],[alt],input,textarea').forEach(e => {
      for (const a of ['placeholder', 'aria-label', 'title', 'alt']) { const v = e.getAttribute(a); if (v) parts.push(v) }
      const v = (e as HTMLInputElement).value
      if (v) parts.push(v)
    })
    return parts.join('\n')
  })
}
