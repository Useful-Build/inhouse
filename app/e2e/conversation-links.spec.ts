// An answer's external links follow the brand's WebFetch setting ("Websites it may open", `t:webfetch`), in the browser. A link to
// a host the setting lists becomes clickable only once the answer has finished streaming; a host it doesn't list (or lists only
// as a parent domain) stays text. The demo's markdown answer (MD_Q) ends with `[Amazon orders](https://orders.example.test/)`.
// The setting is seeded into the demo's own saved state (`fx.seedSaved`), so nothing outside the test's browser is written and
// nothing needs putting back. Parser and host-matching rules are the unit and property tests'
// (markdown-links.test.ts, markdown-links.property.test.ts); this proves they reach the page, at the right time. Ways it can fail:
//  1. a listed link is plain text for good, or its anchor lacks the new-tab and noreferrer attributes;
//  2. the anchor appears while the answer is still arriving (a half-streamed address could name another site);
//  3. an unlisted host, or a parent or sibling of a listed one, becomes a link.
import { expect, test } from './support/fx.js'
import type { Fx } from './support/fx.js'
import type { Page } from '@playwright/test'

const MD_Q = "Give me the query for last week's orders by SKU"
const LAST_WORDS = "aren't in this query."
const SOURCE = 'https://orders.example.test/'

const log = (page: Page) => page.getByRole('log', { name: 'Conversation' })

/** Records each external anchor the first time it is in the conversation, and whether the answer's last sentence was already there. */
async function recordExternalLinks(page: Page): Promise<void> {
  await page.addInitScript(last => {
    const seen: { href: string; complete: boolean }[] = []
    ;(window as unknown as { __externalLinks: typeof seen }).__externalLinks = seen
    const scan = () => {
      for (const a of document.querySelectorAll('[role="log"] a[target="_blank"]')) {
        const href = a.getAttribute('href') ?? ''
        if (seen.some(l => l.href === href)) continue
        seen.push({ href, complete: (a.closest('[role="log"]')?.textContent ?? '').includes(last) })
      }
    }
    new MutationObserver(scan).observe(document, { childList: true, subtree: true })
  }, LAST_WORDS)
}
const externalLinks = (page: Page) => page.evaluate(() => (window as unknown as { __externalLinks: { href: string; complete: boolean }[] }).__externalLinks)

/** Opens the demo with the WebFetch setting at `hosts` (one host per line), asks the markdown question and waits for the finished answer. */
async function answered(page: Page, fx: Fx, hosts: string): Promise<void> {
  await recordExternalLinks(page)
  await fx.seedSaved({ stage: 'Act', scenario: 'Normal', demo: { ambient: 'Always' } }, { settings: { 't:webfetch': hosts } })
  await page.goto('/?demo#/today')
  await page.getByRole('textbox', { name: 'Ask Inhouse' }).fill(MD_Q)
  await page.keyboard.press('Enter')
  await expect(log(page).locator('blockquote')).toContainText(`Amazon orders ${LAST_WORDS}`, { timeout: 15_000 })
  await expect(log(page)).not.toHaveAttribute('aria-busy', 'true')
}

test('a listed WebFetch host\'s link becomes clickable once the answer has finished, with new-tab and noreferrer', async ({ page, fx }) => {
  await answered(page, fx, 'docs.example.test\norders.example.test')
  const link = log(page).getByRole('link', { name: 'Amazon orders' })
  await expect(link).toHaveAttribute('href', SOURCE)
  await expect(link).toHaveAttribute('target', '_blank')
  await expect(link).toHaveAttribute('rel', 'noreferrer')
  // The anchor was never in the page before the answer's last sentence was: no half-streamed address was ever a link.
  expect((await externalLinks(page)).filter(l => l.href === SOURCE)).toEqual([{ href: SOURCE, complete: true }])
  // The in-app link in the same answer is as clickable as before.
  await expect(log(page).getByRole('link', { name: 'Shopify' })).toHaveAttribute('href', '#/tools/shopify')
})

test('an unlisted host stays text after the answer has finished, also when only its parent or a sibling host is listed', async ({ page, fx }) => {
  await answered(page, fx, 'example.test\ndocs.example.test')
  await expect(log(page).locator('blockquote')).toContainText('Amazon orders')
  await expect(log(page).getByRole('link', { name: 'Amazon orders' })).toHaveCount(0)
  await expect(log(page).locator('a[href^="https://orders.example.test"]')).toHaveCount(0)
  expect((await externalLinks(page)).filter(l => l.href === SOURCE)).toEqual([])
})
