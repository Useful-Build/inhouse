// Ship spec for the chat redesign: the one working line while the agent works, the answer revealed a few words at a time,
// the "Checked … · N steps" line that opens the step list and the trace, the sources pill, a draft in its own card, and no
// dots behind a conversation. Recorded at 1440x900 and 390x844. Pages are opened through the UI, as a person would.
import { expect, test, type Fx } from '../support/fx.js'
import type { Page } from '@playwright/test'

const phone = () => test.info().project.name === 'ship-phone'
const log = (page: Page) => page.getByRole('log', { name: 'Conversation' })
const stepsButtons = (page: Page) => log(page).getByRole('button', { name: /\d+ steps/ })

// As the sample agent answers it (src/agent/sample-data/chat-script.json): copied, since a spec reads sample data only
// through `fx`.
const REFUNDS_Q = 'Why did refunds jump?'
const REFUNDS_A = 'Refund requests rose from 14 last week to 31 this week'

async function start(page: Page, fx: Fx) {
  await fx.seed({ stage: 'Act', demo: { ambient: 'Always' } })
  await page.goto('/?demo#/today')
  await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible()
}

test('S1: Ask from Today: one working line, the answer fades in, and "Checked … · N steps" opens what the agent did', async ({ fx, page }) => {
  await start(page, fx)
  await page.getByRole('textbox', { name: 'Ask your Inhouse agent' }).fill(REFUNDS_Q)
  await page.keyboard.press('Enter')
  // While it works: one line, with the agent's mark.
  await expect(page.locator('[data-thinking]')).toBeVisible({ timeout: 15_000 })
  await expect(page.locator('[data-thinking]')).toHaveCount(1)
  // The answer arrives in one card.
  await expect(log(page)).toContainText(REFUNDS_A, { timeout: 20_000 })
  await expect(page.locator('[data-thinking]')).toHaveCount(0)
  // The steps line names the tools it read; it opens the step list, and Details opens the full trace.
  const steps = stepsButtons(page).last()
  await expect(steps).toContainText(/Checked Gorgias and Shopify · \d+ steps/)
  await expect(steps).toHaveAttribute('aria-expanded', 'false')
  await steps.click()
  await expect(steps).toHaveAttribute('aria-expanded', 'true')
  const details = log(page).getByRole('button', { name: 'Details' }).last()
  await details.scrollIntoViewIfNeeded()
  await details.click()
  await expect(page.getByRole('dialog', { name: 'What your Inhouse agent did' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog', { name: 'What your Inhouse agent did' })).toHaveCount(0)
  await steps.click()
  await expect(steps).toHaveAttribute('aria-expanded', 'false')
})

test('S2: A saved chat: the sources are one pill that opens a clean list, and the draft to approve is its own card', async ({ fx, page }) => {
  await start(page, fx)
  if (phone()) await page.getByRole('button', { name: 'Menu' }).click()
  await page.getByRole('complementary', { name: 'Sidebar' }).getByRole('button', { name: 'Stuck orders over 3 days' }).click()
  await expect(log(page)).toContainText('3 orders are stuck over 3 days')
  const first = log(page).locator('[data-answer]').first()
  const pill = first.locator('[data-sources]').getByRole('button')
  await expect(pill).toContainText('2 sources')
  await pill.click()
  await expect(pill).toHaveAttribute('aria-expanded', 'true')
  await expect(first.locator('[data-sources] li')).toHaveText([/Orders.*Shopify/s, /Shipments.*ShipBob/s])
  // No numbered citation chips anywhere in the answer.
  await expect(first.locator('[data-sources] li').first()).not.toContainText(/^\s*1\b/)
  // The draft sits after the answer card, in its own card.
  const draft = log(page).locator('[data-approval]').first()
  await draft.scrollIntoViewIfNeeded()
  await expect(draft).toContainText("Ask ShipBob why #4821 hasn't shipped")
  await expect(draft.getByRole('button', { name: /^Approve and send to ShipBob/ })).toBeVisible()
})
