// No persona name and no morning email. For every Demo switcher stage and scenario, at 1440 and 390, every route and
// every overlay shows neither "Ava" (a word, any case, since labels are uppercased in CSS) nor "morning email".
// What counts: the visible text, every text node (hidden ones too), field values, placeholders, aria-labels, titles and alts.
// Overlays: bell, account menu, Help (every guide), team window, Needs you panels, Activity (every row, every trace it
// opens, plain and technical), the chat trace windows, Library viewers and the Delete confirm, the chat hover actions
// and "More" menu, the composer menus, every Settings dropdown and the Demo switches panel.
import { expect, test, type Fx } from './support/fx.js'
import type { Locator, Page } from '@playwright/test'
import { everything } from './page-text.js'
import { openTraceFrom } from './support/steps.js'

const STAGES = ['Watch', 'Act', 'Run'] as const
const SCENARIOS = ['Normal', 'First day', 'Loading', 'Tool disconnected', 'Cap reached'] as const
const SIZES = [{ name: '1440', width: 1440, height: 900 }, { name: '390', width: 390, height: 844 }]
type Stage = typeof STAGES[number]
type Scenario = typeof SCENARIOS[number]

const SETTINGS: [string, string][] = [
  ['you-general', 'General'], ['you-notif', 'Notifications'], ['you-memory', 'Memory'], ['team-plan', 'Stage and plan'],
  ['team-agent', 'Inhouse agent'], ['team-modes', 'Models'], ['team-memory', 'Team memory'], ['team-members', 'Members'],
  ['team-approvals', 'Who approves what'], ['team-limits', 'Run limits'], ['team-spend', 'Spending cap'], ['team-data', 'Data and access'],
  ['team-audit', 'Audit log'],
]
/** Each route with the marker that proves that route has rendered (not the page before it). */
const ROUTES: [string, (p: Page) => Locator][] = [
  ['#/today', p => p.getByRole('heading', { level: 1 }).filter({ hasText: /Good morning|Welcome/ })],
  ['#/chats/stuck', p => p.getByRole('main').getByText('Which orders are stuck over 3 days?').first()],
  // The top bar names the chat; on the first day and while loading there are no chats, so the link opens a new chat.
  ['#/chats/refunds', p => p.getByRole('banner').getByText(/^(Why did refunds jump\?|New chat)$/)],
  ['#/chats/all', p => p.getByRole('heading', { level: 1, name: 'All chats' })],
  ['#/library', p => p.getByRole('heading', { level: 1, name: 'All files' })],
  ['#/approvals', p => p.getByRole('heading', { level: 1, name: 'Approvals' })],
  ['#/routines', p => p.getByRole('heading', { level: 1, name: 'Routines' })],
  ['#/activity', p => p.getByRole('heading', { level: 1, name: 'Activity' })],
  ['#/tools', p => p.getByRole('heading', { level: 1, name: 'Tools', exact: true })],
  ['#/tools/shopify', p => p.getByRole('heading', { level: 1, name: 'Shopify' })],
  ['#/skills', p => p.getByRole('heading', { level: 1, name: 'Skills' })],
  ['#/usage', p => p.getByRole('heading', { level: 1, name: 'Usage' })],
  ...SETTINGS.map(([id, title]): [string, (p: Page) => Locator] => [`#/settings/${id}`, p => p.getByRole('heading', { level: 1, name: title, exact: true })]),
]

// These are checked by reading the page, so video and trace add cost and nothing else. Screenshots stay on.
test.use({ video: 'off', trace: 'off', actionTimeout: 10_000 })

/** Call after the thing being checked is on screen: it reads the page as it is, with no wait. */
async function check(page: Page, where: string) {
  const text = await everything(page)
  expect(text, `"Ava" on ${where}`).not.toMatch(/\bAva\b/i)
  expect(text, `"morning email" on ${where}`).not.toMatch(/morning email/i)
}

async function go(page: Page, hash: string) {
  await page.evaluate(h => { location.hash = h }, hash)
}

async function openMenu(page: Page, phone: boolean) {
  if (phone) await page.getByRole('button', { name: 'Menu' }).click()
}

/** Open the account menu from the Sidebar. */
async function accountMenu(page: Page, phone: boolean) {
  await openMenu(page, phone)
  await page.getByRole('complementary', { name: 'Sidebar' }).getByRole('button', { name: /account and settings/i }).click()
  await expect(page.getByRole('menu', { name: 'Account' })).toBeVisible()
}

/** Seed Watch / Normal, then pick the stage and scenario in the ?demo switcher itself, as a person would. */
async function start(page: Page, fx: Fx, size: typeof SIZES[number], stage: Stage, scenario: Scenario) {
  await page.setViewportSize({ width: size.width, height: size.height })
  await fx.seed({ stage: 'Watch', demo: { ambient: 'Always' } })
  await page.goto('/?demo#/today')
  await page.getByRole('button', { name: /^Demo switches:/ }).click()
  const panel = page.getByRole('dialog', { name: 'Demo switches' })
  await expect(panel).toBeVisible()
  // A new scenario must be added to this spec too.
  await expect(panel.locator('button[aria-pressed]')).toHaveCount(SCENARIOS.length)
  await check(page, `${stage} ${size.name} ${scenario} demo switches`)
  await panel.getByRole('radiogroup', { name: 'Stage' }).getByRole('radio', { name: stage, exact: true }).click()
  await panel.getByRole('button', { name: scenario, exact: true }).click()
  await panel.getByRole('button', { name: 'Close demo switches' }).click()
  await expect(page.getByRole('button', { name: `Demo switches: ${stage}, ${scenario}` })).toBeVisible()
}

for (const size of SIZES) {
  for (const stage of STAGES) {
    for (const scenario of SCENARIOS) {
      const phone = size.width < 600
      const label = `${size.name} · ${stage} · ${scenario}`

      test(`${label}: routes and Settings dropdowns show no "Ava" and no "morning email"`, async ({ fx, page }) => {
        test.setTimeout(120_000)
        await start(page, fx, size, stage, scenario)

        for (const [route, marker] of ROUTES) {
          await go(page, route)
          await expect(marker(page).first(), `${route} did not render`).toBeVisible()
          await check(page, `${label} ${route}`)
        }

        // Every dropdown on every Settings page, open.
        for (const [id, title] of SETTINGS) {
          await go(page, `#/settings/${id}`)
          await expect(page.getByRole('heading', { level: 1, name: title, exact: true })).toBeVisible()
          const dropdowns = page.getByRole('main').locator('[role="combobox"]:not([disabled])')
          const n = await dropdowns.count()
          for (let i = 0; i < n; i++) {
            await dropdowns.nth(i).click()
            await expect(page.getByRole('listbox')).toHaveCount(1)
            await check(page, `${label} settings ${id} dropdown ${i}`)
            await page.keyboard.press('Escape')
            await expect(page.getByRole('listbox')).toHaveCount(0)
          }
        }

        // Every button in Settings that opens a window: the team window (each pre-fills different text) and, since P2, the
        // Members page's own Invite window.
        for (const [id, title, button, window] of [
          ['team-plan', 'Stage and plan', 'Book a check-in', 'Your Inhouse team'], ['team-members', 'Members', 'Invite', 'Invite someone'], ['team-data', 'Data and access', 'Ask the team', 'Your Inhouse team'],
        ]) {
          await go(page, `#/settings/${id}`)
          await expect(page.getByRole('heading', { level: 1, name: title, exact: true })).toBeVisible()
          await page.getByRole('main').getByRole('button', { name: button, exact: true }).first().click()
          await expect(page.getByRole('dialog', { name: window })).toBeVisible()
          await check(page, `${label} settings ${id} window`)
          await page.keyboard.press('Escape')
          await expect(page.getByRole('dialog', { name: window })).toHaveCount(0)
        }
      })

      test(`${label}: overlays, Activity, traces, Library, chats and menus show no "Ava" and no "morning email"`, async ({ fx, page }) => {
        test.setTimeout(240_000)
        await start(page, fx, size, stage, scenario)
        const main = page.getByRole('main')
        // On day one and while loading the agent has no notifications and no Library files yet (PR 3, M16).
        const noData = scenario === 'First day' || scenario === 'Loading'

        // Bell.
        await page.getByRole('button', { name: 'Notifications' }).click()
        await expect(page.getByText(noData ? "You're all caught up" : 'Mark all as read')).toBeVisible()
        await check(page, `${label} bell`)
        await page.keyboard.press('Escape')
        await expect(page.getByRole('dialog', { name: 'Notifications' })).toHaveCount(0)

        // Top bar pill, where this stage and size show one: Pause, then Resume.
        const pause = page.getByRole('status').getByRole('button', { name: 'Pause', exact: true })
        if (await pause.count()) {
          await check(page, `${label} running pill`)
          await pause.click()
          await expect(page.getByRole('status').getByRole('button', { name: 'Resume', exact: true })).toBeVisible()
          await check(page, `${label} paused pill and toast`)
          await page.getByRole('status').getByRole('button', { name: 'Resume', exact: true }).click()
          await expect(page.getByRole('status').getByRole('button', { name: 'Pause', exact: true })).toBeVisible()
          await check(page, `${label} resumed toast`)
        }

        // Account menu, Help (every guide), the team window.
        await accountMenu(page, phone)
        await check(page, `${label} account menu`)
        await page.getByRole('menuitem', { name: 'Help and guides' }).click()
        const help = page.getByRole('dialog', { name: 'Help and guides' })
        await expect(help).toBeVisible()
        const guides = help.locator('button[aria-expanded]')
        const nGuides = await guides.count()
        expect(nGuides, 'Help lists guides').toBeGreaterThan(0)
        for (let i = 0; i < nGuides; i++) {
          await guides.nth(i).click()
          await expect(guides.nth(i)).toHaveAttribute('aria-expanded', 'true')
          await check(page, `${label} help guide ${i}`)
        }
        await help.getByRole('button', { name: 'Ask the team' }).click()
        await expect(page.getByRole('dialog', { name: 'Your Inhouse team' })).toBeVisible()
        await check(page, `${label} team window from Help`)
        await page.keyboard.press('Escape')
        await accountMenu(page, phone)
        await page.getByRole('menuitem', { name: /^Your Inhouse team/ }).click()
        await expect(page.getByRole('dialog', { name: 'Your Inhouse team' })).toBeVisible()
        await check(page, `${label} team window`)
        await page.keyboard.press('Escape')

        // Needs you panels, every card, and the composer menus on Today.
        await go(page, '#/today')
        await expect(page.getByRole('heading', { level: 1 }).filter({ hasText: /Good morning|Welcome/ })).toBeVisible()
        const cards = page.getByRole('article')
        const nCards = await cards.count()
        for (let i = 0; i < nCards; i++) {
          await cards.nth(i).click()
          await expect(page.getByRole('dialog').first()).toBeVisible()
          await check(page, `${label} Needs you panel ${i}`)
          await page.keyboard.press('Escape')
          await expect(page.getByRole('dialog')).toHaveCount(0)
        }
        await composerMenus(page, `${label} today`, phone)

        // Activity: every row opens its sheet, with its steps shown.
        await go(page, '#/activity')
        await expect(page.getByRole('heading', { level: 1, name: 'Activity' })).toBeVisible()
        const rows = main.locator('button[data-activity-row]')
        expect(await rows.count() > 0 || scenario === 'First day' || scenario === 'Loading', 'Activity lists rows').toBe(true)
        const nRows = await rows.count()
        for (let i = 0; i < nRows; i++) {
          await rows.nth(i).click()
          const sheet = page.getByRole('dialog')
          await expect(sheet).toBeVisible()
          const how = sheet.getByRole('button', { name: 'How your agent worked it out' })
          if (await how.count()) await how.click()
          await check(page, `${label} activity row ${i}`)
          await page.keyboard.press('Escape')
          await expect(page.getByRole('dialog')).toHaveCount(0)
        }

        // Activity filters: every tab, including the empty states.
        for (const tab of ['Needs you', 'Changes', 'All']) {
          await page.getByRole('radiogroup', { name: 'Filter activity' }).getByRole('radio', { name: tab, exact: true }).click()
          await expect(page.getByRole('radiogroup', { name: 'Filter activity' }).getByRole('radio', { name: tab, exact: true })).toHaveAttribute('aria-checked', 'true')
          await check(page, `${label} activity filter ${tab}`)
        }

        // Library: viewers for files the agent made and one a person uploaded, then the Delete confirm.
        await go(page, '#/library')
        await expect(page.getByRole('heading', { level: 1, name: 'All files' })).toBeVisible()
        const card = (name: string) => page.getByRole('list', { name: 'Files' }).getByRole('listitem').filter({ hasText: name })
        for (const [name, by] of noData ? [] : [
          ['stuck-orders-over-3-days.csv', 'Made by'], ['weekly-ops-report-week-46.pdf', 'Made by'], ['refunds-by-product.png', 'Made by'],
          ['restock-returns.py', 'Made by'], ['warehouse-shelf-b3.jpg', 'Uploaded by'],
        ]) {
          await card(name).click()
          const viewer = page.getByRole('dialog', { name: `File: ${name}` })
          await expect(viewer).toBeVisible()
          await expect(viewer).toContainText(by)
          await check(page, `${label} library viewer ${name}`)
          await page.keyboard.press('Escape')
          await expect(viewer).toHaveCount(0)
        }
        if (!noData) {
          await page.getByRole('button', { name: 'Select', exact: true }).click()
          await card('amazon-payout-check.csv').click()
          await page.getByRole('toolbar', { name: 'Selected files' }).getByRole('button', { name: 'Delete' }).click()
          const ask = page.getByRole('dialog', { name: 'Delete files' })
          await expect(ask).toBeVisible()
          await check(page, `${label} library delete confirm`)
          await page.keyboard.press('Escape')
          await expect(ask).toHaveCount(0)
        }

        // Chat: the trace windows, hover actions, "More" menu, reply bar and composer menus.
        if (!noData) {
          await go(page, '#/chats/stuck')
          await expect(main.getByText('Which orders are stuck over 3 days?').first()).toBeVisible()
          await openTraceFrom(main.getByRole('button', { name: /\d+ steps/ }).last())
          await traceWindow(page, `${label} chat trace (stuck)`, true)

          await go(page, '#/chats/refunds')
          await expect(page.getByRole('banner').getByText('Why did refunds jump?')).toBeVisible()
          const answer = main.locator('[data-chat-msg]').filter({ hasText: 'Refund requests rose' }).last()
          await answer.hover()
          await expect(answer.getByRole('button', { name: 'Copy message', exact: true })).toBeVisible()
          await check(page, `${label} chat hover actions`)
          await answer.getByRole('button', { name: 'More', exact: true }).click()
          await expect(page.getByRole('menu', { name: 'Message actions' })).toBeVisible()
          await check(page, `${label} chat More menu`)
          await page.keyboard.press('Escape')
          await expect(page.getByRole('menu', { name: 'Message actions' })).toHaveCount(0)
          // A phone keeps Reply in "···" (D3).
          const reply = answer.getByRole('button', { name: 'Reply', exact: true })
          if (await reply.count()) { await answer.hover(); await reply.click() }
          else {
            await answer.getByRole('button', { name: 'More', exact: true }).click()
            await page.getByRole('menu', { name: 'Message actions' }).getByRole('menuitem', { name: 'Reply' }).click()
          }
          await expect(page.getByRole('button', { name: 'Stop replying' })).toBeVisible()
          await check(page, `${label} chat reply bar`)
          await page.getByRole('button', { name: 'Stop replying' }).click()
          await composerMenus(page, `${label} chat`, phone)
          const generic = main.getByRole('button', { name: /\d+ steps/ })
          if (await generic.count()) {
            await openTraceFrom(generic.last())
            await traceWindow(page, `${label} chat trace (generic)`, true)
          }
        } else {
          // No chats yet: a new chat and its composer menus.
          await go(page, '#/chats/new')
          await expect(main.getByRole('heading', { name: 'What do you want to know?' })).toBeVisible()
          await check(page, `${label} new chat`)
          await composerMenus(page, `${label} new chat`, phone)
        }

        // The routine trace is reached by asking for a routine. On the first day the agent answers with the setup note instead.
        if (scenario !== 'First day') {
          // While loading there are no chats yet: the routine is asked in a new chat.
          await go(page, noData ? '#/chats/new' : '#/chats/stuck')
          await expect(main.getByText('Which orders are stuck over 3 days?').first()).toBeVisible()
          const before = await main.getByRole('button', { name: /\d+ steps/ }).count()
          await page.getByRole('textbox', { name: 'Message your Inhouse agent' }).fill('Every Monday at 7, check which products have under 3 weeks of stock')
          // Send by button: on a phone width Enter adds a line instead of sending.
          await page.locator('[data-composer]').getByRole('button', { name: 'Send' }).click()
          if (scenario === 'Cap reached') {
            // Chats stop at the cap (decision L-A8): the question is refused with the cap notice, so there is no new trace.
            await expect(main.getByText("Your team has reached its spending cap, so this answer didn't run.").last()).toBeVisible({ timeout: 30_000 })
            await expect(main.getByRole('button', { name: /\d+ steps/ })).toHaveCount(before)
            await check(page, `${label} routine refused at the cap`)
          } else {
            await expect(main.getByRole('button', { name: /\d+ steps/ })).toHaveCount(before + 1, { timeout: 30_000 })
            await check(page, `${label} routine answer`)
            await openTraceFrom(main.getByRole('button', { name: /\d+ steps/ }).last())
            await traceWindow(page, `${label} chat trace (routine)`, true)
          }
        }
      })
    }
  }
}

/** Open the three composer menus (+, tools, model) and check each. A phone's box, Today's and a chat's, has only "+":
 *  the tools and the model are in it, and their buttons aren't in the row (M27). */
async function composerMenus(page: Page, where: string, phone: boolean) {
  const box = page.locator('[data-composer]')
  for (const name of [/^Tools read/, /^Model/, /^Dictate/]) await expect(box.getByRole('button', { name })).toHaveCount(phone ? 0 : 1)
  for (const name of phone ? [/^Attach/] : [/^Attach/, /^Tools read/, /^Model/]) {
    await box.getByRole('button', { name }).click()
    const menu = page.getByRole('menu')
    await expect(menu).toHaveCount(1)
    if (phone) {
      await expect(menu.getByText('Tools read in this chat')).toBeVisible()
      await expect(menu.getByRole('menuitem', { name: /Manage tools/ })).toBeAttached()
      await expect(menu.getByRole('group', { name: 'Model' }).getByRole('menuitemradio')).not.toHaveCount(0)
    }
    await check(page, `${where} composer menu ${name}`)
    await page.keyboard.press('Escape')
    await page.mouse.click(5, 5)
    await expect(menu).toHaveCount(0)
  }
}

/** The trace window just opened: plain view, then the technical view (and each of its steps when `steps`), then close. */
async function traceWindow(page: Page, where: string, steps: boolean) {
  const plain = page.getByRole('dialog', { name: /What your Inhouse agent did/ })
  await expect(plain).toBeVisible()
  await check(page, `${where} plain`)
  await plain.getByRole('radio', { name: 'Technical' }).click()
  const tech = page.getByRole('dialog', { name: /What your Inhouse agent did/ })
  await expect(tech.getByRole('button', { name: 'Replay', exact: true })).toBeVisible()
  await check(page, `${where} technical`)
  if (steps) {
    const rows = tech.getByTestId('trace-row')
    const n = await rows.count()
    for (let i = 0; i < n; i++) {
      await rows.nth(i).click()
      await expect(rows.nth(i)).toHaveAttribute('aria-pressed', 'true')
      await check(page, `${where} technical step ${i}`)
    }
  }
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog', { name: /What your Inhouse agent did/ })).toHaveCount(0)
}
