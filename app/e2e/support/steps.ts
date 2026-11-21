// An answer's steps line sits above its card, collapsed ("Checked Shopify and ShipBob · 3 steps"). Opening it lists the
// steps in place; its Details link opens the trace window.
import type { Locator } from '@playwright/test'

/** Opens the answer's step list from its steps line, then follows Details into the trace window. */
export async function openTraceFrom(line: Locator): Promise<void> {
  await line.click()
  await line.locator('xpath=..').getByRole('button', { name: 'Details', exact: true }).click()
}
