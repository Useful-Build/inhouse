// An answer's steps line sits above its card, collapsed ("Checked Shopify and ShipBob · 3 steps"). Opening it lists the
// steps in place; its Details link opens the trace window.
import { expect, type Locator } from '@playwright/test'

/** Opens the answer's step list from its steps line, then follows Details into the trace window. */
export async function openTraceFrom(line: Locator): Promise<void> {
  await line.click()
  await expect(line).toHaveAttribute('aria-expanded', 'true')
  const details = line.locator('xpath=..').getByRole('button', { name: 'Details', exact: true })
  // The list opens with a height animation: click Details once it has settled, so the conversation's scroll and the
  // pointer left over the trace window (the pop-trace screenshot) are the same every run.
  await details.evaluate(el => Promise.all(el.closest('[data-slot="trace-collapsible-content"]')!.getAnimations({ subtree: true }).map(a => a.finished.catch(() => undefined))))
  await details.click()
}
