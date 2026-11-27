// Stage 1 M3-C (N26, N27) on the test build: Settings > What the agent can do, and the Slack notices page's disclosure,
// on desktop and phone. It would fail if:
//  - the Inhouse team couldn't switch an operation on and set its limits from the page (the test build turns editing on),
//    the page didn't show the new values after the save, or lowering a limit didn't warn that Always allow ends;
//  - an admin got a Change button (the page is read-only for them), or a member found the page in the menu;
//  - marking a channel for alerts while posting is on didn't say, before the save, that it lets the agent post there
//    without asking up to the effective daily limit, or the alerts channel's row didn't then say a standing permission
//    exists, with a way to Always allowed where it is removed;
//  - any of these screens failed axe (WCAG 2.1 A and AA) in light or dark, or scrolled sideways.
// The refusal while editing is off in a deployable build is proven in server/api/ceiling.test.ts.
import AxeBuilder from '@axe-core/playwright'
import type { APIRequestContext, Page } from '@playwright/test'
import { expect, test } from '../support/test-build/index.js'
import { open, signInAs } from '../support/clients/real.js'
import type { Who } from '../support/clients/real.js'
import { actor, call } from '../api/kit.ts'
import { CHANNEL, ensureDisconnected, fakeReset, freshConnect, hook, setListedChannels } from '../api/fakes-kit.ts'

const OP = 'shopify.draft_order.create'
const TITLE = 'Create draft orders'
const POST = 'slack.channel.post'

const phone = (page: Page) => (page.viewportSize()?.width ?? 1440) < 600
const main = (page: Page) => page.getByRole('main')
const rowOf = (page: Page, op: string) => main(page).locator(`[data-ceiling="${op}"]`)

async function ceiling(request: APIRequestContext, operation: string, enabled: boolean, perDayMax = 50) {
  const r = await hook(request, { op: 'ceiling', operation, enabled, perDayMax })
  expect(r.status, r.text).toBe(200)
}

/** axe on the page as it is, then the same in dark; a named screenshot of each for the run's artifacts. */
async function checkBothThemes(page: Page, name: string) {
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme })
    if (scheme === 'dark') await expect(page.locator('html')).toHaveClass(/\bdark\b/)
    else await expect(page.locator('html')).not.toHaveClass(/\bdark\b/)
    // Radix and the toasts animate in; axe reads colours mid-animation as low contrast (as a11y.spec.ts waits).
    await page.waitForFunction(() => document.getAnimations().every(a => a.playState !== 'running' || !(a.timeline instanceof DocumentTimeline) || a.effect?.getTiming().iterations === Infinity))
    const { violations } = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze()
    expect(violations.map(v => `${v.id}: ${v.nodes.map(n => n.target.join(' ')).join(', ')}`), `${name} ${scheme}`).toEqual([])
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), `${name} ${scheme} scrolls sideways`).toBe(true)
    await page.screenshot({ path: test.info().outputPath(`${name}-${scheme}.png`), fullPage: true })
  }
  await page.emulateMedia({ colorScheme: 'light' })
}

async function signedIn(page: Page, context: Parameters<typeof signInAs>[0], who: Who, hash: string) {
  await signInAs(context, who)
  await open(page, who, hash)
}

test.describe('What the agent can do', () => {
  test.beforeEach(async ({ request }) => { await ceiling(request, OP, false) })
  test.afterEach(async ({ request }) => { await ceiling(request, OP, false) })

  test('the Inhouse team switches an operation on with its limits, and lowering one warns first', async ({ page, context }) => {
    await signedIn(page, context, 'inhouse', '#/settings/team-ceiling')
    await expect(page.getByRole('heading', { level: 1, name: 'What the agent can do', exact: true })).toBeVisible()
    const row = rowOf(page, OP)
    await expect(row).toContainText(TITLE)
    await expect(row).toContainText("Off. Your Inhouse agent can't do this.")
    await checkBothThemes(page, 'ceiling-inhouse')

    await row.getByRole('button', { name: `Change: ${TITLE}` }).click()
    const win = page.getByRole('dialog', { name: `Change: ${TITLE}` })
    await expect(win.getByRole('button', { name: 'Save changes' })).toBeDisabled()
    await win.getByRole('switch', { name: 'Let your Inhouse agent do this' }).click()
    await win.getByRole('textbox', { name: 'Most draft orders a day for each Always allow' }).fill('20')
    await checkBothThemes(page, 'ceiling-change')
    await win.getByRole('button', { name: 'Save changes' }).click()
    await expect(page.locator('[data-toast]').filter({ hasText: `Saved. ${TITLE} is on.` })).toBeVisible()
    await expect(win).toHaveCount(0)
    await expect(row).toContainText('Shopify · On')
    await expect(row).toContainText('Up to 20 draft orders a day for each Always allow')

    // Lowering: the window says what it ends before the save.
    await row.getByRole('button', { name: `Change: ${TITLE}` }).click()
    await win.getByRole('textbox', { name: 'Most draft orders a day for each Always allow' }).fill('10')
    await expect(win.getByRole('note')).toHaveText('Lowering a limit or switching this off ends every Always allow for it. People are asked again.')
    await win.getByRole('button', { name: 'Save changes' }).click()
    await expect(row).toContainText('Up to 10 draft orders a day for each Always allow')
  })

  test('an admin reads it with no way to change it', async ({ page, context, request }) => {
    await ceiling(request, OP, true, 30)
    await signedIn(page, context, 'admin', '#/settings/team-ceiling')
    await expect(page.getByRole('heading', { level: 1, name: 'What the agent can do', exact: true })).toBeVisible()
    await expect(main(page).getByRole('note')).toHaveText('The Inhouse team sets these.')
    await expect(rowOf(page, OP)).toContainText('Up to 30 draft orders a day for each Always allow')
    await expect(main(page).getByRole('button', { name: /^Change: / })).toHaveCount(0)
    await checkBothThemes(page, 'ceiling-admin')
  })

  test('a member has no such page in the menu, and a link to it says why it is empty', async ({ page, context }) => {
    await signedIn(page, context, 'dana', '#/settings/team-ceiling')
    await expect(main(page).getByRole('note')).toHaveText('Only admins and the Inhouse team can see this.')
    await open(page, 'dana', '#/settings/you-general')
    if (phone(page)) await page.getByRole('button', { name: 'Back to settings' }).click()
    const nav = page.getByRole('navigation', { name: 'Settings' })
    await expect(nav.getByRole('button', { name: 'Models', exact: true })).toBeVisible()
    await expect(nav.getByRole('button', { name: 'What the agent can do', exact: true })).toHaveCount(0)
  })
})

test.describe('Slack notices: what marking a channel for alerts gives', () => {
  test.beforeAll(async ({ request }) => {
    await fakeReset(request)
    await freshConnect(request)
    await setListedChannels(request, [CHANNEL.opsAlerts, CHANNEL.general])
  })
  test.afterAll(async ({ request }) => {
    await ceiling(request, POST, false)
    // Taking the channels off the list ends the alerts channel's permission too (channel_unlisted).
    await setListedChannels(request, [])
    await ensureDisconnected(request)
    await fakeReset(request)
  })
  test.beforeEach(async ({ request }) => { await setListedChannels(request, [CHANNEL.opsAlerts, CHANNEL.general]) })

  test('while posting is off it says "once posting is switched on" and shows no limit', async ({ page, context, request }) => {
    await ceiling(request, POST, false)
    await signedIn(page, context, 'admin', '#/settings/team-slack')
    await expect(page.getByRole('heading', { level: 1, name: 'Slack notices', exact: true })).toBeVisible()
    if (!phone(page)) {
      await expect(main(page).getByText('Approvals, questions and problems post here. Once posting is switched on, marking a channel lets the agent post there without asking.', { exact: true })).toBeVisible()
    }
    await expect(main(page)).not.toContainText(/\d+ posts a day/)
    await checkBothThemes(page, 'slack-posting-off')
  })

  test('an admin is told before the mark that it lets the agent post without asking, and the row then shows the standing permission', async ({ page, context, request }) => {
    // Settings is read-only on a phone (a team setting is changed on a computer), so the phone reads the result only.
    await ceiling(request, POST, true, 30)
    const disclosure = 'Marking this channel lets the agent post here without asking, up to 30 posts a day. Approvals, questions and problems post here too.'
    await signedIn(page, context, 'admin', '#/settings/team-slack')
    if (!phone(page)) {
      await expect(main(page).getByText(disclosure, { exact: true })).toBeVisible()
      await main(page).getByRole('combobox', { name: 'Alerts channel: None', exact: true }).click()
      await page.getByRole('option', { name: '#ops-alerts', exact: true }).click()
      const ask = page.getByRole('dialog', { name: 'Mark #ops-alerts for alerts?' })
      await expect(ask).toContainText(disclosure)
      await checkBothThemes(page, 'slack-mark-ask')
      await ask.getByRole('button', { name: 'Mark for alerts' }).click()
    } else {
      // The same mark, saved as an admin would on a computer (route 75).
      const cur = await call(request, actor('admin'), 'GET', '/api/notify/channels')
      const r = await call(request, actor('admin'), 'PUT', '/api/notify/channels', { json: { channelIds: [CHANNEL.opsAlerts, CHANNEL.general], alertsChannelId: CHANNEL.opsAlerts, ifRev: cur.json.rev } })
      expect(r.status, r.text).toBe(200)
      await page.reload()
    }
    await expect(main(page).getByText('The alerts channel. Standing permission: the agent posts here without asking, up to 30 posts a day. Approvals, questions and problems post here too.', { exact: true })).toBeVisible()
    const go = main(page).getByRole('button', { name: 'Open Always allowed to remove the standing permission' })
    await expect(go).toBeVisible()
    await checkBothThemes(page, 'slack-standing-permission')
    await go.click()
    await expect(page.getByRole('heading', { level: 1, name: 'Always allowed', exact: true })).toBeVisible()
    await expect(main(page).locator('[data-permission]').filter({ hasText: 'Post messages to a channel' })).toContainText('#ops-alerts')
  })
})
