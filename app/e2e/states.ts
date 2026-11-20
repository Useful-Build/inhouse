// The UI states the regression suite captures (visual.spec.ts) and scans (a11y.spec.ts).
// Pages and pop-ups follow tour.spec.ts, plus the problem panel, the trace window, a Settings dropdown, the Library and See all,
// and the states only a click reaches: Today handled and all approved, Models' switches, a delete question, Select mode
// in the Library and All chats, the Library's file viewer and an open Help guide.
import { expect } from '@playwright/test'
import type { Page } from '@playwright/test'
import { mockClient } from './support/clients/mock.js'

export const THEMES = ['light', 'dark'] as const
export type Theme = (typeof THEMES)[number]

export type UiState = {
  name: string
  stage: 'Watch' | 'Act' | 'Run'
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

const page_ = (name: string, stage: UiState['stage'], scenario: string, hash: string, ready: string, a11y = false): UiState =>
  ({ name, stage, scenario, hash, ready, a11y })

export const STATES: UiState[] = [
  page_('watch-today', 'Watch', 'Normal', '#/today', '6 things need you today.'),
  page_('watch-approvals', 'Watch', 'Normal', '#/approvals', "In Act, today's 6 fixes would be waiting here"),
  page_('watch-chats', 'Watch', 'Normal', '#/chats', 'Approvals and routines start in Act'),
  page_('act-activity', 'Act', 'Normal', '#/activity', 'Activity', true),
  page_('run-activity', 'Run', 'Normal', '#/activity', 'Activity'),
  page_('act-routines', 'Act', 'Normal', '#/routines', 'Routines', true),
  page_('act-tools', 'Act', 'Normal', '#/tools', 'Being connected', true),
  page_('act-tool-shopify', 'Act', 'Normal', '#/tools/shopify', 'What your Inhouse agent can do with Shopify', true),
  page_('act-tool-disconnected', 'Act', 'Tool disconnected', '#/tools/gorgias', 'Disconnected'),
  page_('act-skills', 'Act', 'Normal', '#/skills', 'Suggested for Shopify brands', true),
  page_('act-usage', 'Act', 'Normal', '#/usage', 'Breakdown', true),
  page_('act-usage-cap', 'Act', 'Cap reached', '#/usage', '$250.00'),
  page_('act-settings-general', 'Act', 'Normal', '#/settings/you-general', 'Profile', true),
  page_('act-settings-notif', 'Act', 'Normal', '#/settings/you-notif', 'Alerts'),
  page_('act-settings-memory', 'Act', 'Normal', '#/settings/team-memory', 'Suppliers'),
  page_('run-settings-limits', 'Run', 'Normal', '#/settings/team-limits', 'Jobs your Inhouse agent may finish by itself'),
  page_('act-settings-audit', 'Act', 'Normal', '#/settings/team-audit', 'Audit log'),
  page_('act-settings-data', 'Act', 'Normal', '#/settings/team-data', 'Where your data stays'),
  page_('act-first-day', 'Act', 'First day', '#/today', 'Getting your Inhouse agent ready'),
  page_('act-loading', 'Act', 'Loading', '#/today', 'Reading your tools'),
  page_('act-cap-today', 'Act', 'Cap reached', '#/today', 'Spending cap reached.'),
  page_('act-today', 'Act', 'Normal', '#/today', '6 things need you. A fix is drafted for each.', true),
  page_('act-approvals', 'Act', 'Normal', '#/approvals', 'Waiting for you', true),
  page_('act-library', 'Act', 'Normal', '#/library', 'All files', true),
  // PR 6: the Library with nothing in it yet, and while it loads.
  page_('act-library-first-day', 'Act', 'First day', '#/library', 'No files yet', true),
  page_('act-library-loading', 'Act', 'Loading', '#/library', 'All files', true),
  page_('act-chat-stuck', 'Act', 'Normal', '#/chats/stuck', '3 orders · $556', true),
  page_('act-chats-all', 'Act', 'Normal', '#/chats/all', 'Kestrel delivery times', true),
  {
    name: 'pop-notifications', stage: 'Act', scenario: 'Normal', hash: '#/today', ready: '6 things need you', a11y: true,
    act: async page => {
      await page.getByRole('button', { name: 'Notifications' }).click()
      await expect(page.getByText('Mark all as read')).toBeVisible()
    },
  },
  {
    name: 'pop-account', stage: 'Act', scenario: 'Normal', hash: '#/today', ready: '6 things need you', a11y: true,
    act: async page => {
      await (await sidebar(page)).getByRole('button', { name: 'Settings' }).click()
      await expect(page.getByText('sam@northline.example · Admin')).toBeVisible()
    },
  },
  {
    name: 'pop-team-bug', stage: 'Act', scenario: 'Normal', hash: '#/today', ready: '6 things need you', a11y: true,
    act: async page => {
      await (await sidebar(page)).getByRole('button', { name: 'Settings' }).click()
      await page.getByRole('menuitem', { name: 'Report a bug' }).click()
      await expect(page.getByText('Your Inhouse team')).toBeVisible()
    },
  },
  {
    name: 'chat-empty', stage: 'Act', scenario: 'Normal', hash: '#/today', ready: '6 things need you',
    act: async page => {
      await (await sidebar(page)).getByRole('button', { name: 'New chat' }).click()
      await expect(page.getByText('What do you want to know?')).toBeVisible()
    },
  },
  {
    name: 'pop-problem-panel', stage: 'Act', scenario: 'Normal', hash: '#/today', ready: '6 things need you', a11y: true,
    act: async page => {
      await page.getByRole('article').filter({ hasText: 'Ridge 30L Pack runs out in 9 days' }).getByRole('button', { name: 'Review' }).click()
      await expect(page.getByRole('dialog')).toContainText('Remembered: Kestrel ships in 14 days')
    },
  },
  {
    name: 'pop-trace', stage: 'Act', scenario: 'Normal', hash: '#/chats/stuck', ready: '3 orders · $556', a11y: true,
    act: async page => {
      await page.locator('main').getByRole('button', { name: /6 steps/ }).last().click()
      await expect(page.getByRole('dialog', { name: /What your Inhouse agent did/ })).toContainText('9.4s')
    },
  },
  // Today in Run: the cards the agent handled, muted with the done token.
  page_('run-today', 'Run', 'Normal', '#/today', 'handled before you woke up', true),
  {
    // Today once every draft is approved and sent: every card muted (text-done). The approvals are made on the
    // Approvals page under a paused clock, which then runs past the 10-second send hold and its notices, so no toast
    // or "going out" line is left to race the screenshot.
    name: 'act-today-approved', stage: 'Act', scenario: 'Normal', hash: '#/approvals', ready: 'Waiting for you', a11y: true,
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
        const review = drafts.first().getByRole('button', { name: 'Review', exact: true })
        if (await review.count()) {
          await review.click()
          await page.getByRole('dialog').getByRole('button', { name: /^Approve/ }).click()
          await page.keyboard.press('Escape')
          await expect(page.getByRole('dialog')).toHaveCount(0)
        } else await drafts.first().getByRole('button', { name: /^Approve/ }).click()
        await expect(drafts).toHaveCount(n - 1)
      }
      await page.clock.runFor(30_000)
      await page.evaluate(() => { location.hash = '#/today' })
      await expect(page.getByText('All 6 approved. Nothing is waiting on you.')).toBeVisible()
      // No hover or focus left over from the last Approve click on the card now under the pointer.
      await page.mouse.move(0, 0)
      await page.evaluate(() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur() })
      await atRest(page)
      // Timers run again (axe needs them); the approvals already carry their 8:00 AM stamp.
      await page.clock.resume()
    },
  },
  {
    // Models: one model turned off (an off switch in both themes), and Smart's locked switch with its reason in a
    // tooltip, reached by keyboard and fully shown.
    name: 'act-settings-models', stage: 'Act', scenario: 'Normal', hash: '#/settings/team-modes', ready: 'Models', a11y: true,
    act: async page => {
      // On a phone team settings are read-only text (D4): the shot is the page as it opens.
      if (await page.getByRole('button', { name: 'Menu' }).isVisible()) return
      const other = page.getByRole('switch', { name: /^(?!Smart:).+: the team can use this model$/ }).last()
      await other.click()
      await expect(other).toHaveAttribute('aria-checked', 'false')
      await page.mouse.move(0, 0)
      await page.getByRole('combobox', { name: /^How hard it thinks: Smart/ }).focus()
      await page.keyboard.press('Tab')
      await expect(page.getByRole('switch', { name: 'Smart: the team can use this model' })).toBeFocused()
      await expect(page.getByRole('tooltip').filter({ hasText: 'This is the default model' }).first()).toBeVisible()
    },
  },
  {
    // A delete question: the destructive button, from a routine's "···" menu.
    name: 'act-routine-delete', stage: 'Act', scenario: 'Normal', hash: '#/routines', ready: 'Routines', a11y: true,
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
    name: 'act-library-select', stage: 'Act', scenario: 'Normal', hash: '#/library', ready: 'All files', a11y: true,
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
    name: 'act-library-viewer', stage: 'Act', scenario: 'Normal', hash: '#/library', ready: 'All files', a11y: true,
    act: async page => {
      await page.locator('main [data-file]').first().click()
      const viewer = page.getByRole('dialog', { name: /^File: / })
      await expect(viewer.getByRole('button', { name: 'Close', exact: true })).toBeInViewport({ ratio: 1 })
      await page.mouse.move(0, 0)
    },
  },
  {
    // Select mode in All chats: two chats picked (the selected row fill), the selection bar.
    name: 'act-chats-select', stage: 'Act', scenario: 'Normal', hash: '#/chats/all', ready: 'Kestrel delivery times', a11y: true,
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
    name: 'pop-help-guide', stage: 'Act', scenario: 'Normal', hash: '#/today', ready: '6 things need you', a11y: true,
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
    name: 'pop-settings-dropdown', stage: 'Act', scenario: 'Normal', hash: '#/settings/you-general', ready: 'Profile', a11y: true,
    act: async page => {
      await page.locator('main [role="combobox"]:not([disabled])').first().click()
      await expect(page.getByRole('listbox')).toBeVisible()
    },
  },
  page_('act-approvals-first-day', 'Act', 'First day', '#/approvals', 'Nothing to approve yet.', true),
  page_('act-approvals-loading', 'Act', 'Loading', '#/approvals', 'Waiting for you', true),
  page_('act-channel-slack', 'Act', 'Normal', '#/tools/slack', 'Connected · Nov 2', true),
  page_('watch-channel-slack', 'Watch', 'Normal', '#/tools/slack', 'Included from Act'),
]

/** Opens a state from a clean demo: a fixed theme, no agent-mark animation, no dot sweep. */
export async function openState(page: Page, s: UiState, theme: Theme) {
  await page.emulateMedia({ colorScheme: theme })
  const client = mockClient(page)
  await client.seed({ stage: s.stage, scenario: s.scenario, theme, once: false })
  await client.open(s.hash)
  await expect(page.getByText(s.ready, { exact: false }).first()).toBeVisible()
  if (s.act) await s.act(page)
  await fontsReady(page)
  await atRest(page)
}

/**
 * Every finite animation and transition has ended (a menu's fade-out, a guide's open height, a button's colour change
 * after a pick), so a shot never catches a frame on the way. The screenshot's `animations: 'disabled'` doesn't cover
 * them reliably. Infinite ones (a pulsing dot) are left to the screenshot, which stops them.
 */
export async function atRest(page: Page) {
  await page.waitForFunction(() => document.getAnimations().every(a =>
    a.playState !== 'running' || a.effect?.getComputedTiming().endTime === Infinity))
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
