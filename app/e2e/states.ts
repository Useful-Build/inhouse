// The UI states the regression suite captures (visual.spec.ts) and scans (a11y.spec.ts).
// Pages and pop-ups follow tour.spec.ts, plus the problem panel, the trace window, a Settings dropdown, the Library and See all,
// and the states only a click reaches: Today handled and all approved, Models' switches, a delete question, Select mode
// in the Library and All chats, the Library's file viewer and an open Help guide.
import { expect } from '@playwright/test'
import type { Page } from '@playwright/test'
import { mockClient, routeReady } from './support/clients/mock.js'
import { openTraceFrom } from './support/steps.js'

export const THEMES = ['light', 'dark'] as const
export type Theme = (typeof THEMES)[number]

export type UiState = {
  name: string
  scenario: string
  hash: string
  /** Text that shows once the state is ready. */
  ready: string
  /** Opens a pop-up after the page loads. */
  act?: (page: Page) => Promise<void>
  /** Part of the a11y scan (main pages and main pop-ups). */
  a11y?: boolean
}

// Opens the sidebar drawer on a phone; on desktop the sidebar is always there.
async function sidebar(page: Page) {
  const menu = page.getByRole('button', { name: 'Menu' })
  if (await menu.isVisible()) await menu.click()
  return page.getByRole('complementary', { name: 'Sidebar' })
}

// The demo has no stages since decision A13 (option B), as the product: the `act-` names are the baselines' from before.
const page_ = (name: string, scenario: string, hash: string, ready: string, a11y = false): UiState =>
  ({ name, scenario, hash, ready, a11y })

export const STATES: UiState[] = [
  page_('act-activity', 'Normal', '#/activity', 'Activity', true),
  page_('act-routines', 'Normal', '#/routines', 'Routines', true),
  page_('act-tools', 'Normal', '#/tools', 'Being connected', true),
  page_('act-tool-shopify', 'Normal', '#/tools/shopify', 'What your Inhouse agent can do with Shopify', true),
  page_('act-tool-disconnected', 'Tool disconnected', '#/tools/gorgias', 'Disconnected'),
  page_('act-skills', 'Normal', '#/skills', 'Suggested for Shopify brands', true),
  page_('act-usage', 'Normal', '#/usage', 'Breakdown', true),
  page_('act-usage-cap', 'Cap reached', '#/usage', '$250.00'),
  page_('act-settings-general', 'Normal', '#/settings/you-general', 'Profile', true),
  page_('act-settings-memory', 'Normal', '#/settings/team-memory', 'Suppliers'),
  page_('act-settings-audit', 'Normal', '#/settings/team-audit', 'Audit log'),
  page_('act-settings-data', 'Normal', '#/settings/team-data', 'Where your data stays'),
  page_('act-first-day', 'First day', '#/today', 'Getting your Inhouse agent ready'),
  page_('act-loading', 'Loading', '#/today', 'Reading your tools'),
  page_('act-cap-today', 'Cap reached', '#/today', 'Spending cap reached.'),
  page_('act-today', 'Normal', '#/today', '3 left to approve today.', true),
  // Stage 1 M3-U: the agent's action cards (the demo's batch and a teammate's refund) sit above the drafts.
  page_('act-approvals', 'Normal', '#/approvals', 'Actions for you', true),
  page_('act-library', 'Normal', '#/library', 'All files', true),
  // PR 6: the Library with nothing in it yet, and while it loads.
  page_('act-library-first-day', 'First day', '#/library', 'No files yet', true),
  page_('act-library-loading', 'Loading', '#/library', 'All files', true),
  page_('act-chat-stuck', 'Normal', '#/chats/stuck', '3 orders · $556', true),
  page_('act-chats-all', 'Normal', '#/chats/all', 'Kestrel delivery times', true),
  // Stage 1 M3-U: a 450-change batch card in its chat, and its full list.
  page_('act-chat-batch', 'Normal', '#/chats/vip-tags', 'and 447 more', true),
  // Stage 1 PR 2 (demo long jobs, helpers and web steps).
  page_('act-chat-job-running', 'Normal', '#/chats/catalog-audit', 'Working on a long job', true),
  page_('act-chat-job-finished', 'Normal', '#/chats/seasonal-restock', 'Ran for 2 h 14 min.', true),
  page_('act-chat-job-budget', 'Normal', '#/chats/ad-spend-audit', 'It reached the most one job may spend', true),
  page_('act-chat-web', 'Normal', '#/chats/competitor-prices', 'Cairn Insulated Bottle sits right in the middle', true),
  {
    name: 'pop-batch-sheet', scenario: 'Normal', hash: '#/chats/vip-tags', ready: 'and 447 more', a11y: true,
    act: async page => {
      // The chat behind the sheet has settled first (no scroller moved for 3 frames), so the shot's background is the same
      // every run; then the sheet opens from the keyboard with a focus that doesn't scroll (a click would scroll the chat
      // by however far the button sits under the composer).
      await page.evaluate(() => new Promise<void>((resolve, reject) => {
        const scrollers = () => [...document.querySelectorAll<HTMLElement>('*')].filter(e => e.scrollHeight > e.clientHeight && /auto|scroll/.test(getComputedStyle(e).overflowY))
        const measure = () => scrollers().map(e => e.scrollTop).join(',')
        let prev = measure()
        let same = 0
        let frames = 0
        const tick = () => {
          const now = measure()
          same = now === prev ? same + 1 : 0
          prev = now
          if (same >= 3) return resolve()
          if (++frames > 240) return reject(new Error(`The chat behind the sheet never settled (last ${now})`))
          requestAnimationFrame(tick)
        }
        requestAnimationFrame(tick)
      }))
      await page.getByRole('button', { name: /^See all 450: / }).evaluate(el => (el as HTMLElement).focus({ preventScroll: true }))
      await page.keyboard.press('Enter')
      const sheet = page.getByRole('dialog', { name: 'Tag 450 orders as VIP' })
      await expect(sheet.locator('[data-item]').first()).toBeVisible()
      await expect(sheet.getByRole('button', { name: 'Approve all 450' })).toBeVisible()
      // The list reads more as it scrolls: wait until the first page is in and nothing is loading.
      await expect(sheet.getByRole('status')).toHaveCount(0)
    },
  },
  {
    name: 'pop-notifications', scenario: 'Normal', hash: '#/today', ready: 'Good morning, Sam.', a11y: true,
    act: async page => {
      await page.getByRole('button', { name: 'Notifications' }).click()
      await expect(page.getByText('Mark all as read')).toBeVisible()
    },
  },
  {
    name: 'pop-account', scenario: 'Normal', hash: '#/today', ready: 'Good morning, Sam.', a11y: true,
    act: async page => {
      await (await sidebar(page)).getByRole('button', { name: 'Settings' }).click()
      await expect(page.getByRole('menu').getByText('sam@northline.example', { exact: true })).toBeVisible()
      await expect(page.getByRole('menu').getByText('Admin', { exact: true })).toBeVisible()
    },
  },
  {
    name: 'pop-team-bug', scenario: 'Normal', hash: '#/today', ready: 'Good morning, Sam.', a11y: true,
    act: async page => {
      // Report a bug left the account menu; the palette keeps it, and the window opens on that type.
      await page.keyboard.press('ControlOrMeta+k')
      await page.getByRole('dialog', { name: 'Search' }).getByRole('option', { name: 'Report a bug' }).click()
      await expect(page.getByText('Your Inhouse team')).toBeVisible()
    },
  },
  {
    name: 'chat-empty', scenario: 'Normal', hash: '#/today', ready: 'Good morning, Sam.',
    act: async page => {
      await (await sidebar(page)).getByRole('button', { name: 'New chat' }).click()
      await expect(page.getByText('What should we look into?')).toBeVisible()
    },
  },
  {
    name: 'pop-problem-panel', scenario: 'Normal', hash: '#/today', ready: 'Good morning, Sam.', a11y: true,
    act: async page => {
      // The payout's post to #ops-alerts in Slack (#726: the Kestrel reorder this showed is a finding now).
      await page.getByRole('article').filter({ hasText: 'Amazon paid out $1,240 less than expected' }).click({ position: { x: 12, y: 12 } })
      await expect(page.getByRole('dialog').getByRole('button', { name: 'Approve and post' })).toBeVisible()
    },
  },
  {
    name: 'pop-trace', scenario: 'Normal', hash: '#/chats/stuck', ready: '3 orders · $556', a11y: true,
    act: async page => {
      await openTraceFrom(page.locator('main').getByRole('button', { name: /6 steps/ }).last())
      await expect(page.getByRole('dialog', { name: /What your Inhouse agent did/ })).toContainText('9.4s')
    },
  },
  {
    // Today once every draft is approved and sent: every card muted (text-done). The approvals are made on the
    // Approvals page under a paused clock, which then runs past the 10-second send hold and its notices, so no toast
    // or "going out" line is left to race the screenshot.
    name: 'act-today-approved', scenario: 'Normal', hash: '#/approvals', ready: 'Waiting for you', a11y: true,
    act: async page => {
      // A fixed, believable stamp on every run: the demo clock reads 8:00 AM plus the time since the demo started
      // (saved at the first load). The page clock is set back to that moment and held, so every approval says
      // "8:00 AM" however long the run took; it moves only by runFor below (the send hold), then runs again.
      const started = await mockClient(page).demoStartedAt()
      expect(typeof started).toBe('number')
      await page.clock.install({ time: started })
      await page.clock.pauseAt(started + 20_000)
      // Low-risk drafts approve in one tap; the others (money, customers) through Review in the panel.
      const drafts = page.locator('main [data-slot=card]').filter({ has: page.getByRole('heading', { level: 2 }) })
      for (let n = await drafts.count(); n > 0; n--) {
        const review = drafts.first().getByRole('button', { name: 'Review draft', exact: true })
        if (await review.count()) {
          await review.click()
          await page.getByRole('dialog').getByRole('button', { name: /^Approve/ }).click()
          await page.keyboard.press('Escape')
          await expect(page.getByRole('dialog')).toHaveCount(0)
        } else await drafts.first().getByRole('button', { name: /^Approve/ }).click()
        await expect(drafts).toHaveCount(n - 1)
      }
      // The pointer leaves the last Approve before the clock runs: the list closes up under it, a "sent" notice can rise
      // under it, and a toast under the pointer pauses every countdown (src/shell/Toasts.tsx), so no notice would ever
      // leave however far the clock ran (run 46020352931: the pointer at 146,688, over a "sent" notice).
      await pointerAway(page)
      await page.clock.runFor(30_000)
      // Each "sent" notice starts its 4-second countdown in an effect once React has rendered it (src/shell/Toasts.tsx),
      // and React renders on a real task the paused clock doesn't step: when runFor above ends before that render, the
      // countdown waits on the paused clock and the notices stay for the shot (run 44956112491). Step on until they've gone.
      await expect.poll(async () => { await page.clock.runFor(1_000); return page.locator('[data-toast]').count() }, { message: 'every toast has left' }).toBe(0)
      await page.evaluate(() => { location.hash = '#/today' })
      // Every draft approved: what's left are the findings, to look at.
      await expect(page.getByRole('heading', { level: 1 })).toContainText('3 things need you today.')
      // No hover or focus left over from the last Approve click on the card now under the pointer.
      await pointerAway(page)
      await page.evaluate(() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur() })
      await atRest(page)
      // Timers run again (axe needs them); the approvals already carry their 8:00 AM stamp.
      await page.clock.resume()
    },
  },
  {
    // Models: one model turned off (an off switch in both themes), and Smart's locked switch with its reason in a
    // tooltip, reached by keyboard and fully shown.
    name: 'act-settings-models', scenario: 'Normal', hash: '#/settings/team-modes', ready: 'Models', a11y: true,
    act: async page => {
      // On a phone team settings are read-only text (D4): the shot is the page as it opens.
      if (await page.getByRole('button', { name: 'Menu' }).isVisible()) return
      const other = page.getByRole('switch', { name: /^(?!Smart:).+: the team can use this model$/ }).last()
      await other.click()
      await expect(other).toHaveAttribute('aria-checked', 'false')
      await pointerAway(page)
      await page.getByRole('combobox', { name: /^How hard it thinks: Smart/ }).focus()
      await page.keyboard.press('Tab')
      await expect(page.getByRole('switch', { name: 'Smart: the team can use this model' })).toBeFocused()
      await expect(page.getByRole('tooltip').filter({ hasText: 'This is the default model' }).first()).toBeVisible()
    },
  },
  {
    // A delete question: the destructive button, from a routine's "···" menu.
    name: 'act-routine-delete', scenario: 'Normal', hash: '#/routines', ready: 'Routines', a11y: true,
    act: async page => {
      await page.locator('main').getByRole('button', { name: /^Actions for / }).first().click()
      await page.getByRole('menuitem', { name: 'Delete' }).click()
      await expect(page.getByRole('dialog', { name: 'Delete routine' }).getByRole('button', { name: 'Delete', exact: true })).toBeVisible()
      // The "···" menu closes when the question opens (it fades out behind the scrim): it must be gone, not left open.
      await expect(page.getByRole('menu')).toHaveCount(0)
    },
  },
  {
    // Select mode in the Library: two files picked, the selection bar with its red Delete.
    name: 'act-library-select', scenario: 'Normal', hash: '#/library', ready: 'All files', a11y: true,
    act: async page => {
      await page.locator('main').getByRole('button', { name: 'Select', exact: true }).click()
      const files = page.locator('main [data-file]')
      await files.nth(0).click()
      await files.nth(1).click()
      await expect(page.getByRole('toolbar', { name: 'Selected files' })).toContainText('2 selected')
    },
  },
  {
    // The Library's file viewer (the lg window, 960px less 40px on a narrow screen), on the first file, with Close on screen.
    name: 'act-library-viewer', scenario: 'Normal', hash: '#/library', ready: 'All files', a11y: true,
    act: async page => {
      await page.locator('main [data-file]').first().click()
      const viewer = page.getByRole('dialog', { name: /^File: / })
      await expect(viewer.getByRole('button', { name: 'Close', exact: true })).toBeInViewport({ ratio: 1 })
      await pointerAway(page)
    },
  },
  {
    // Select mode in All chats: two chats picked (the selected row fill), the selection bar.
    name: 'act-chats-select', scenario: 'Normal', hash: '#/chats/all', ready: 'Kestrel delivery times', a11y: true,
    act: async page => {
      await page.locator('main').getByRole('button', { name: 'Select', exact: true }).click()
      const rows = page.locator('main [data-chat-open]')
      await rows.nth(0).click()
      await rows.nth(1).click()
      await expect(page.getByRole('toolbar', { name: 'Selected chats' })).toContainText('2 selected')
    },
  },
  {
    // Help and guides with the first guide open in the accordion.
    name: 'pop-help-guide', scenario: 'Normal', hash: '#/today', ready: 'Good morning, Sam.', a11y: true,
    act: async page => {
      await (await sidebar(page)).getByRole('button', { name: 'Settings' }).click()
      await page.getByRole('menuitem', { name: 'Help and guides' }).click()
      const help = page.getByRole('dialog', { name: 'Help and guides' })
      await help.locator('[data-slot="accordion-trigger"]').first().click()
      const guide = help.locator('[data-slot="accordion-content"]').first()
      await expect(guide).toBeVisible()
      // The account menu that opened Help closes as Help opens, and the guide opens with a 200ms height animation.
      await expect(page.getByRole('menu')).toHaveCount(0)
      await atRest(page)
      // At rest the open guide shows all of its text: nothing clips it.
      expect(await guide.evaluate(el => el.scrollHeight - el.clientHeight)).toBeLessThanOrEqual(0)
    },
  },
  {
    name: 'pop-settings-dropdown', scenario: 'Normal', hash: '#/settings/you-general', ready: 'Profile', a11y: true,
    act: async page => {
      await page.locator('main [role="combobox"]:not([disabled])').first().click()
      await expect(page.getByRole('listbox')).toBeVisible()
    },
  },
  page_('act-approvals-first-day', 'First day', '#/approvals', 'Nothing to approve yet.', true),
  page_('act-approvals-loading', 'Loading', '#/approvals', 'Waiting for you', true),
  page_('act-channel-slack', 'Normal', '#/tools/slack', 'Connected · Nov 2', true),
  // The demo catch-up's PR 1: the ask cards in their chat (a Needs a check, Allow once and Always allow, Always allow
  // first), and Settings > Always allowed with the seeded permissions.
  page_('act-chat-order-tags', 'Normal', '#/chats/order-tags', 'Post to #ops-alerts in Slack', true),
  page_('act-settings-permissions', 'Normal', '#/settings/you-permissions', 'Done without asking', true),
  // The demo catch-up's PR 3: What the agent can do, the Slack page with its disclosure, the chats for the other write
  // cards (a batch that partly went out, a draft order, a refused stock call with its reduction, an order note).
  // Approvals above now carries the two questions; the member's view is checked in questions-ceiling-demo.spec.ts.
  page_('act-settings-ceiling', 'Normal', '#/settings/team-ceiling', 'Actions in your tools', true),
  page_('act-settings-slack', 'Normal', '#/settings/team-slack', 'Alerts channel', true),
  page_('act-chat-loyalty-tags', 'Normal', '#/chats/loyalty-tags', 'Sent. 447 of 450 went out', true),
  page_('act-chat-draft-orders', 'Normal', '#/chats/draft-orders', 'Create a draft order of 12 items', true),
  page_('act-chat-stock-fixes', 'Normal', '#/chats/stock-fixes', 'Remove 40 units of stock from item 8012', true),
  page_('act-chat-order-note', 'Normal', '#/chats/order-note', 'came from the order, not from you', true),
]

/** Opens a state from a clean demo: a fixed theme, no agent-mark animation, no dot sweep. */
/**
 * Parks the pointer where it hovers nothing: the window's top right corner, over the page's top edge. Not 0,0: on
 * desktop that corner is inside the sidebar, whose rows wake (turn from quiet to ink) while the pointer is in it, so
 * every shot would show the woken sidebar instead of the resting one. A page's own pointer starts at 0,0 too.
 */
export async function pointerAway(page: Page) {
  await page.mouse.move(page.viewportSize()!.width - 1, 0)
}

export async function openState(page: Page, s: UiState, theme: Theme) {
  await page.emulateMedia({ colorScheme: theme })
  const client = mockClient(page)
  await client.seed({ scenario: s.scenario, theme, once: false })
  await client.open(s.hash)
  await expect(page.getByText(s.ready, { exact: false }).first()).toBeVisible()
  await pointerAway(page)
  if (s.act) await s.act(page)
  await routeReady(page)
  await fontsReady(page)
  await atRest(page)
}

/**
 * Every finite animation and transition has ended (a menu's fade-out, a guide's open height, a button's colour change
 * after a pick), so a shot never catches a frame on the way. The screenshot's `animations: 'disabled'` doesn't cover
 * them reliably. Infinite ones (a pulsing dot) are left to the screenshot, which stops them. Scroll-driven ones (ui-base's
 * `scroll-fade` edges run on a ScrollTimeline) follow the scroll position, not time, so they never end: they're skipped,
 * and every other spec's wait for finished animations skips them the same way.
 */
export async function atRest(page: Page) {
  await page.waitForFunction(() => document.getAnimations().every(a =>
    a.playState !== 'running' || !(a.timeline instanceof DocumentTimeline) || a.effect?.getComputedTiming().endTime === Infinity))
}

/** The self-hosted fonts (public/fonts) are loaded: Geist, Geist Mono and Material Symbols, so no shot has fallback glyphs or ligature text. */
const FONTS = ['14px Geist', '12px "Geist Mono"', '20px "Material Symbols Rounded"']
export async function fontsReady(page: Page) {
  await page.evaluate(async fonts => {
    await Promise.all(fonts.map(f => document.fonts.load(f, f.includes('Symbols') ? 'check' : 'Aa')))
    await document.fonts.ready
  }, FONTS)
  await page.waitForFunction(fonts => fonts.every(f => document.fonts.check(f)) && document.fonts.status === 'loaded', FONTS)
}
