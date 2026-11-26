// Stage 1 M2-H on the test build: action cards seeded through the test-fakes hook (the outbox's own `request` as a
// seeded person, `ask_only`, so each is a card) and answered from the screens, on desktop and phone. It would fail if:
//  - Approvals didn't list a waiting card, the sidebar's badge didn't count it (or still did once answered), offered a button the viewer's `can` doesn't allow (an admin answering a
//    member's card, N15), or the card's answer didn't reach the server;
//  - Allow once showed no hold, or Undo in the hold didn't take it back;
//  - Always allow left nothing under Settings > Always allowed, Remove there (after asking) didn't take it away, or
//    Activity's "Stop allowing this" didn't;
//  - a send whose result is unclear didn't come back as "Needs a check" with both answers, or the answer didn't land;
//  - any of these screens failed axe (WCAG 2.1 A and AA) in light or dark, or scrolled sideways.
// Writes stay off in deployable builds: only the test build's hook turns the operation on (N2). A question needs a
// container turn to be asked, so the Questions section is proven by component tests and the sandbox (FEATURE_MAP Gaps).
import AxeBuilder from '@axe-core/playwright'
import type { APIRequestContext, Page } from '@playwright/test'
import { expect, test } from '../support/test-build/index.js'
import { open, signInAs } from '../support/clients/real.js'
import type { Who } from '../support/clients/real.js'
import { actor, call, me } from '../api/kit.ts'
import { hook, hubCall, requestAction, setCeiling } from '../api/fakes-kit.ts'
import { SHOPIFY_READ } from '../support/test-build/shopify-read.ts'

const OPERATION = 'shopify.order.tag_add'
/** One of the fake write store's orders (test/upstreams/shopify/write/server.ts). */
const ORDER = 'gid://shopify/Order/9002'
const TITLE = 'Add a tag to order 9002'

const phone = (page: Page) => (page.viewportSize()?.width ?? 1440) < 600

/** One action waiting on `who`'s answer, with a tag of its own (its card says "Tag: <tag>"); answers the tag. */
async function seed(request: APIRequestContext, who: 'admin' | 'memberA'): Promise<string> {
  const { memberId } = await me(request, actor(who))
  await setCeiling(request, OPERATION, true)
  const tag = `e2e-${test.info().project.name}-${Date.now().toString(36)}`
  const result = await requestAction(request, { memberId }, OPERATION, { orderId: ORDER, tags: [tag] }, { mode: 'ask_only' })
  expect(result?.outcome, JSON.stringify(result)).toBe('waiting')
  return tag
}

/** The fake write store's answer to the next tag write (the hook's `set` op, hub/testing/fakes.ts). */
async function writeFault(request: APIRequestContext, fault: 'succeed' | 'broken_body') {
  const r = await hook(request, { op: 'set', shopifyWrite: { faults: { [OPERATION]: fault } } })
  expect(r.status, r.text).toBe(200)
}

/** No permission left that the Admin may remove (theirs, or any other's: an admin sees and removes every one). */
async function removePermissions(request: APIRequestContext) {
  const admin = actor('admin')
  const list = await call(request, admin, 'GET', '/api/permissions')
  expect(list.status, list.text).toBe(200)
  for (const p of list.json.items as { id: string; rev: number; can: { remove: boolean } }[]) {
    if (!p.can.remove) continue
    const r = await call(request, admin, 'POST', `/api/permissions/${p.id}/remove`, { json: { ifRev: p.rev } })
    expect([200, 404], r.text).toContain(r.status)
  }
}

// The hub's Shopify account answers a read first (its client-credentials grant gives it its connect date), and M2-D's
// sync copies that date into D1 on the first request (N9: an action's generation is that date).
test.beforeAll(async ({ request }) => {
  expect((await hubCall(request, SHOPIFY_READ.method, SHOPIFY_READ.name, SHOPIFY_READ.args)).ok).toBe(true)
})
test.afterAll(async ({ request }) => { await setCeiling(request, OPERATION, false) })

test.beforeEach(async ({ request }) => { await removePermissions(request) })
// The test build's server is shared: each case's operation is turned off again (seed() turns it on), the store's fault
// cleared and no permission left behind.
test.afterEach(async ({ request }) => { await setCeiling(request, OPERATION, false); await writeFault(request, 'succeed'); await removePermissions(request) })

const cardOf = (page: Page, tag: string) => page.locator('[data-action-card]').filter({ hasText: `Tag: ${tag}` })
/** The card's answers (its Open link, for a chat the viewer may open, sits apart). */
const answers = (card: ReturnType<typeof cardOf>) => card.locator('[data-card-actions] button')

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

test('Allow once starts the hold on the server clock, and Undo in the hold takes it back', async ({ page, context, request }) => {
  const tag = await seed(request, 'admin')
  await signedIn(page, context, 'admin', '#/approvals')
  await expect(page.getByRole('heading', { name: 'Actions for you' })).toBeVisible()
  const card = cardOf(page, tag)
  await expect(card.getByRole('heading', { name: TITLE })).toBeVisible()
  await expect(card).toContainText('Your Inhouse agent asks first')
  await expect(answers(card)).toHaveText(['Allow once', 'Always allow', 'No'])
  await checkBothThemes(page, 'approvals-waiting')
  // The sidebar's Approvals badge counts the card (on a phone the sidebar is a closed drawer, so desktop only).
  const badge = page.getByRole('complementary', { name: 'Sidebar' }).getByRole('button', { name: /^Approvals/ }).locator('[aria-label$=" waiting"]')
  // Read in one step: a count, then a text read, races the badge going away between the two (the text read then waits
  // for a badge that never comes back, and the poll times out).
  const waiting = () => badge.evaluateAll(els => (els.length > 0 ? Number(els[0]!.textContent) : 0))
  const before = phone(page) ? 0 : await expect.poll(waiting).toBeGreaterThanOrEqual(1).then(waiting)

  await card.getByRole('button', { name: 'Allow once' }).click()
  await expect(page.locator('[data-toast]').filter({ hasText: 'Allowed once. It goes out in a few seconds.' })).toBeVisible()
  // Answered, it no longer waits on this person: the badge reads one less.
  if (!phone(page)) await expect.poll(waiting).toBe(before - 1)
  await expect(card.getByRole('timer')).toHaveText(/^Goes out in \d+ seconds?$/)
  await card.getByRole('button', { name: `Undo: ${TITLE}` }).click()
  await expect(card).toContainText('You took it back. Nothing went out.')
  await expect(answers(card)).toHaveCount(0)
})

test('No: nothing goes out and the card offers nothing more', async ({ page, context, request }) => {
  const tag = await seed(request, 'admin')
  await signedIn(page, context, 'admin', '#/approvals')
  const card = cardOf(page, tag)
  await card.getByRole('button', { name: 'No', exact: true }).click()
  await expect(card).toContainText('You said no. Nothing went out.')
  await expect(answers(card)).toHaveCount(0)
})

test("An admin sees a member's card with its facts but no button to answer it (N15)", async ({ page, context, request }) => {
  const tag = await seed(request, 'memberA')
  await signedIn(page, context, 'admin', '#/approvals')
  // Listed apart from the admin's own, saying whose it is.
  await expect(page.getByRole('heading', { name: 'Waiting on your team' })).toBeVisible()
  const card = cardOf(page, tag)
  await expect(card.getByRole('heading', { name: TITLE })).toBeVisible()
  await expect(card).toContainText('Waiting for Dana Kim')
  await expect(card).toContainText('Shopify')
  // No answer, and no way into the member's chat.
  await expect(card.getByRole('button')).toHaveCount(0)
})

test('Always allow lists the permission under Settings > Always allowed, and Remove there takes it away', async ({ page, context, request }) => {
  const tag = await seed(request, 'admin')
  await signedIn(page, context, 'admin', '#/approvals')
  const card = cardOf(page, tag)
  await card.getByRole('button', { name: 'Always allow' }).click()
  await expect(page.locator('[data-toast]').filter({ hasText: "Allowed. Your Inhouse agent won't ask next time." })).toBeVisible()
  // Taken back in the hold: the permission stays (the card and the toast say so), and nothing is sent.
  await card.getByRole('button', { name: `Undo: ${TITLE}` }).click()
  await expect(card).toContainText('You took it back. Nothing went out.')
  await expect(card).toContainText('Always allow stays on. Remove it in Settings, Always allowed.')
  await expect(page.locator('[data-toast]').filter({ hasText: 'Taken back. Nothing went out. Always allow stays on.' })).toBeVisible()

  await open(page, 'admin', '#/settings/you-permissions')
  await expect(page.getByRole('heading', { level: 1, name: 'Always allowed' })).toBeVisible()
  const rows = page.locator('[data-permission]')
  await expect(rows).toHaveCount(1)
  await expect(rows.first()).toContainText('Shopify')
  await expect(rows.first()).toContainText('a day')
  await checkBothThemes(page, 'settings-always-allowed')
  await rows.first().getByRole('button', { name: /^Remove: / }).click()
  const ask = page.getByRole('dialog', { name: 'Stop allowing this?' }).or(page.getByRole('alertdialog', { name: 'Stop allowing this?' }))
  await expect(ask).toContainText('Your Inhouse agent will ask before it does this again.')
  await ask.getByRole('button', { name: 'Remove', exact: true }).click()
  await expect(page.locator('[data-toast]').filter({ hasText: 'Removed. Your Inhouse agent will ask first from now on.' })).toBeVisible()
  await expect(rows).toHaveCount(0)
  await expect(page.getByText('Nothing yet. When you choose Always allow on an action, it shows here.')).toBeVisible()
})

test('Activity lists the action, and "Stop allowing this" removes the permission behind it', async ({ page, context, request }) => {
  const tag = await seed(request, 'admin')
  await signedIn(page, context, 'admin', '#/approvals')
  const card = cardOf(page, tag)
  await card.getByRole('button', { name: 'Always allow' }).click()
  await card.getByRole('button', { name: `Undo: ${TITLE}` }).click()
  await expect(card).toContainText('You took it back. Nothing went out.')

  await open(page, 'admin', '#/activity')
  await expect(page.getByRole('heading', { name: 'Actions', exact: true })).toBeVisible()
  const row = page.locator('[data-activity-action]').filter({ hasText: `${TITLE}. You took it back. Nothing went out.` }).first()
  await expect(row).toBeVisible()
  await checkBothThemes(page, 'activity-actions')
  await row.getByRole('button', { name: `Stop allowing this: ${TITLE}` }).click()
  const ask = page.getByRole('dialog', { name: 'Stop allowing this?' }).or(page.getByRole('alertdialog', { name: 'Stop allowing this?' }))
  await ask.getByRole('button', { name: 'Remove', exact: true }).click()
  await expect(page.locator('[data-toast]').filter({ hasText: 'Removed. Your Inhouse agent will ask first from now on.' })).toBeVisible()
  await expect(page.getByRole('button', { name: /^Stop allowing this: / })).toHaveCount(0)
})

test('A send whose result is unclear comes back as "Needs a check", and "It didn\'t go out" settles it', async ({ page, context, request }) => {
  // The hold (10 s), the send and the card's own re-reads (every 2 s) take longer than a usual case.
  test.setTimeout(90_000)
  const tag = await seed(request, 'admin')
  // The fake store answers the write with a body that can't be read: the dispatcher can't tell, so it needs a check (N11).
  // The afterEach puts the store back to answering normally.
  await writeFault(request, 'broken_body')
  await signedIn(page, context, 'admin', '#/approvals')
  const card = cardOf(page, tag)
  await card.getByRole('button', { name: 'Allow once' }).click()
  // The hold (10 s) ends and the send runs on the server's clock; the card reads itself until it settles.
  await expect(card).toHaveAttribute('data-action-card', 'needs_check', { timeout: 45_000 })
  await expect(card).toContainText('Needs a check')
  await expect(answers(card)).toHaveText(['It went out', "It didn't go out"])
  await checkBothThemes(page, 'approvals-needs-check')
  await card.getByRole('button', { name: `It didn't go out: ${TITLE}` }).click()
  await expect(card).toHaveAttribute('data-action-card', 'failed')
  await expect(page.locator('[data-toast]').filter({ hasText: 'Marked as not sent.' })).toBeVisible()
  await expect(answers(card)).toHaveCount(0)
})

test('On a phone the card fits: no sideways scroll, and the buttons wrap', async ({ page, context, request }) => {
  test.skip(!phone(page), 'the phone project only')
  const tag = await seed(request, 'admin')
  await signedIn(page, context, 'admin', '#/approvals')
  const card = cardOf(page, tag)
  await expect(card).toBeVisible()
  const box = await card.boundingBox()
  expect(box!.x).toBeGreaterThanOrEqual(0)
  expect(box!.x + box!.width).toBeLessThanOrEqual(page.viewportSize()!.width)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true)
})
