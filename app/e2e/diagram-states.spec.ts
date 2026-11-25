// A ```mermaid fence's other states in the browser (FEATURE_MAP "Chat: answer actions", gaps from the ui-base v2 round):
// a diagram Mermaid can't parse shows "Couldn't draw this diagram." over its source, and a drawn diagram draws again in the
// new theme's colours when the theme changes, keeping its card. The parse failure and the theme redraw are unit-tested too
// (diagram.test.ts, diagram-engine.test.ts); these check them with the real Mermaid chunk under the app's CSP.
import { expect, fxFor, test } from './support/fx.js'
import type { Page } from '@playwright/test'

const DIAGRAM_Q = 'Show me a diagram of how a refund moves through the team'
// mock-script.ts BROKEN_DIAGRAM_ANSWER: an arrow with nothing after it (mock-diagrams.test.ts pins that it fails to parse).
const ROUGH_DIAGRAM_Q = 'Show me a rough diagram of the returns queue'

async function ask(page: Page, question: string) {
  await fxFor(page, undefined).seed({ stage: 'Act', scenario: 'Normal', theme: 'light', demo: { ambient: 'Always' } })
  await page.goto('/?demo#/today')
  await page.getByRole('textbox', { name: 'Ask Inhouse' }).fill(question)
  await page.keyboard.press('Enter')
}
const log = (page: Page) => page.getByRole('log', { name: 'Conversation' })
const palette = (page: Page) => page.getByRole('dialog', { name: 'Search' })

test("Diagram: a fence Mermaid can't parse shows that it couldn't be drawn, over its source, and logs why", async ({ page }) => {
  const logged: string[] = []
  page.on('console', m => { if (m.type() === 'error') logged.push(m.text()) })
  await ask(page, ROUGH_DIAGRAM_Q)
  // Mermaid loads with the first diagram, so allow for its chunk.
  const diagram = log(page).locator('[data-md-diagram]')
  await expect(diagram).toHaveAttribute('data-state', 'failed', { timeout: 30_000 })
  await expect(diagram).toContainText("Couldn't draw this diagram.")
  // No figure and no half-drawn card: the source as a code block, with its own Copy.
  await expect(diagram.locator('svg')).toHaveCount(0)
  await expect(diagram.locator('[data-md-code]')).toContainText('flowchart LR')
  await expect(diagram.getByRole('region', { name: 'Diagram 1 source' })).toBeVisible()
  await expect(diagram.getByRole('button', { name: 'Copy diagram 1 source code' })).toBeVisible()
  await expect(log(page).getByText('Drawing diagram…')).toHaveCount(0)
  // The answer around it still reads in full, and the failure stays after the answer ends.
  await expect(log(page)).not.toHaveAttribute('aria-busy', 'true')
  await expect(log(page).getByText("Here's a rough sketch of the returns queue:")).toBeVisible()
  await expect(diagram).toHaveAttribute('data-state', 'failed')
  // It failed for the parse, not for the address check (which never hands a diagram to Mermaid).
  expect(logged.some(t => t.includes('could not draw diagram 1'))).toBe(true)
  expect(logged.some(t => t.includes('names an address'))).toBe(false)
})

test('Diagram: a theme change draws the figure again in the new colours, in the same card', async ({ page }) => {
  await ask(page, DIAGRAM_Q)
  const diagram = log(page).locator('[data-md-diagram]')
  await expect(diagram).toHaveAttribute('data-state', 'ready', { timeout: 30_000 })
  await expect(log(page)).not.toHaveAttribute('aria-busy', 'true')
  /** The figure's id (a new one per draw) and a node's fill as the page paints it. */
  const figure = () => diagram.locator('svg[role="img"]').evaluate(svg => ({
    id: svg.id,
    fill: getComputedStyle(svg.querySelector('g.node rect, g.node polygon, g.node path')!).fill,
  }))
  const light = await figure()
  expect(light.fill).not.toBe('')
  // Every state the card shows from here, so a flash of the loading line or the source between the figures is caught:
  // the old figure stays up while the new one draws (diagram.tsx). The card is one element throughout (checked below).
  const card = await diagram.elementHandle()
  await diagram.evaluate(el => {
    const w = window as unknown as { diagramStates: string[] }
    w.diagramStates = []
    new MutationObserver(() => {
      w.diagramStates.push(`${el.getAttribute('data-state')}${el.textContent?.includes('Drawing diagram') ? ' drawing' : ''}${el.querySelector('svg') ? '' : ' no-figure'}`)
    }).observe(el, { attributes: true, childList: true, subtree: true, characterData: true })
  })

  await page.keyboard.press('ControlOrMeta+k')
  await palette(page).getByRole('option', { name: 'Switch to dark theme' }).click()
  await expect(palette(page)).toHaveCount(0)
  await expect(page.locator('html')).toHaveClass(/\bdark\b/)

  // Drawn again (a new figure), in other colours, and the card never fell back to its loading line or the source.
  await expect.poll(async () => {
    const now = await figure()
    return now.id !== light.id && now.fill !== light.fill
  }, { message: 'the figure is drawn again in the dark colours', timeout: 30_000 }).toBe(true)
  await expect(diagram).toHaveAttribute('data-state', 'ready')
  await expect(diagram).toHaveCount(1)
  await expect(diagram.locator('svg[role="img"]')).toHaveAttribute('aria-label', 'Diagram 1')
  expect(await card!.evaluate(el => el.isConnected)).toBe(true)
  const states = await page.evaluate(() => (window as unknown as { diagramStates: string[] }).diagramStates)
  expect(states.length).toBeGreaterThan(0)
  expect(states.filter(s => s !== 'ready')).toEqual([])

  // And back: light draws its light colours again (from the cache of figures already drawn, at once).
  await page.keyboard.press('ControlOrMeta+k')
  await palette(page).getByRole('option', { name: 'Switch to light theme' }).click()
  await expect(page.locator('html')).not.toHaveClass(/\bdark\b/)
  await expect.poll(async () => (await figure()).fill, { timeout: 30_000 }).toBe(light.fill)
  await expect(diagram).toHaveAttribute('data-state', 'ready')
})
