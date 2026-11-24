// An answer's external links follow the brand's WebFetch setting ("Websites it may open", `t:webfetch`), in the browser. A link to
// a host the setting lists becomes clickable; a host it doesn't list (or lists only as a parent domain) stays text. The demo's
// markdown answer (MD_Q) ends with `[Amazon orders](https://orders.example.test/)`. The setting is seeded into the demo's own
// saved state (`fx.seedSaved`), so nothing outside the test's browser is written and nothing needs putting back. Parser and
// host-matching rules are the unit and property tests' (markdown-links.test.ts, markdown-links.property.test.ts); this proves they
// reach the page. Ways it can fail:
//  1. a listed link is plain text for good, or its anchor lacks the new-tab and noreferrer attributes;
//  2. an unlisted host, or a parent or sibling of a listed one, becomes a link.
// NOT covered here: that a link waits for the finished answer (Parts.tsx's `streaming || !done` gate). The demo answer is one part
// and the turn ends as it lands; the reveal (reveal.ts) shows it in 8 steps and its last takes everything after "Shopify" (the
// link and the last words together), so the link and the last words always arrive in one render and deleting the gate could not
// fail a spec here. parts.test.ts holds the `streaming` half; the mid-reveal half has no test until the demo has an answer with
// text after a listed link or a part that keeps streaming.
import { expect, test } from './support/fx.js'
import type { Fx } from './support/fx.js'
import type { Page } from '@playwright/test'

const MD_Q = "Give me the query for last week's orders by SKU"
const LAST_WORDS = "aren't in this query."
const SOURCE = 'https://orders.example.test/'

const log = (page: Page) => page.getByRole('log', { name: 'Conversation' })

/** Opens the demo with the WebFetch setting at `hosts` (one host per line), asks the markdown question and waits for the finished answer. */
async function answered(page: Page, fx: Fx, hosts: string): Promise<void> {
  await fx.seedSaved({ stage: 'Act', scenario: 'Normal', demo: { ambient: 'Always' } }, { settings: { 't:webfetch': hosts } })
  await page.goto('/?demo#/today')
  await page.getByRole('textbox', { name: 'Ask Inhouse' }).fill(MD_Q)
  await page.keyboard.press('Enter')
  await expect(log(page).locator('blockquote')).toContainText(`Amazon orders ${LAST_WORDS}`, { timeout: 15_000 })
  await expect(log(page)).not.toHaveAttribute('aria-busy', 'true')
}

test('a listed WebFetch host\'s link is clickable in the finished answer, with new-tab and noreferrer', async ({ page, fx }) => {
  await answered(page, fx, 'docs.example.test\norders.example.test')
  const link = log(page).getByRole('link', { name: 'Amazon orders' })
  await expect(link).toHaveAttribute('href', SOURCE)
  await expect(link).toHaveAttribute('target', '_blank')
  await expect(link).toHaveAttribute('rel', 'noreferrer')
  // The in-app link in the same answer is as clickable as before.
  await expect(log(page).getByRole('link', { name: 'Shopify' })).toHaveAttribute('href', '#/tools/shopify')
})

test('an unlisted host stays text after the answer has finished, also when only its parent or a sibling host is listed', async ({ page, fx }) => {
  await answered(page, fx, 'example.test\ndocs.example.test')
  await expect(log(page).locator('blockquote')).toContainText('Amazon orders')
  await expect(log(page).getByRole('link', { name: 'Amazon orders' })).toHaveCount(0)
  await expect(log(page).locator('a[href^="https://orders.example.test"]')).toHaveCount(0)
})
