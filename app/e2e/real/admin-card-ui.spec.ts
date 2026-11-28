// Stage 1 M3-U (N25) on the test build: an admins card (a member's refund, which only an admin may approve), seeded
// through the test-fakes hook as Dana (a member) and answered from the screens, on desktop and phone, in both themes. It
// would fail if:
//  - Dana's card didn't say it waits for an admin, offered her an answer, or offered no Withdraw (and Withdraw didn't take
//    it back);
//  - the admin didn't see Dana's card under "Actions for you", saying who asked, with Approve and No and no way into
//    Dana's chat; or Approve didn't start the hold, or Undo in it didn't take it back (said as "It was taken back");
//  - any screen failed axe (WCAG 2.1 A and AA) in light or dark, or scrolled sideways.
// The refund's ceiling row is set only through the hook and turned off again after (and before, in case a killed run left
// it on). Nothing is sent: the one approval is undone in its hold.
import AxeBuilder from '@axe-core/playwright'
import type { APIRequestContext, Page } from '@playwright/test'
import { expect, test } from '../support/test-build/index.js'
import { open, signInAs } from '../support/clients/real.js'
import { actor, call, me } from '../api/kit.ts'
import { createChat } from '../api/chat-kit.ts'
import { hook, hubCall } from '../api/fakes-kit.ts'
import { SHOPIFY_READ } from '../support/test-build/shopify-read.ts'

const REFUND = 'shopify.refund.create'
const dana = actor('memberA')
const TITLE = 'Refund $5.00 (USD) on order 9001'
const phone = (page: Page) => (page.viewportSize()?.width ?? 1440) < 600

let danaId = ''
let chatId = ''

const ceiling = async (request: APIRequestContext, enabled: boolean) => {
  const r = await hook(request, { op: 'ceiling', operation: REFUND, enabled, perDayMax: 1000, unitsMax: 50_000 })
  expect(r.status, r.text).toBe(200)
}
/** Dana's refund, as the agent asks for it in her chat: a waiting admins card. Answers its id. */
async function memberRefund(request: APIRequestContext): Promise<string> {
  const r = await hook(request, {
    op: 'action', as: { memberId: danaId, chatId }, operation: REFUND,
    args: { orderId: 'gid://shopify/Order/9001', lines: [{ lineItemId: 'gid://shopify/LineItem/90012', quantity: 1 }], amount: { minor: 500, currency: 'USD' }, restock: false, notifyCustomer: false },
  })
  expect(r.status, r.text).toBe(200)
  expect(r.json.result).toMatchObject({ outcome: 'waiting', action: { approver_kind: 'admins' } })
  return r.json.result.action.id as string
}

test.beforeAll(async ({ request }) => {
  danaId = (await me(request, dana)).memberId
  await ceiling(request, false)
  expect((await hubCall(request, SHOPIFY_READ.method, SHOPIFY_READ.name, SHOPIFY_READ.args)).ok).toBe(true)
  await ceiling(request, true)
  chatId = await createChat(request, dana)
})
test.afterAll(async ({ request }) => {
  // Anything still waiting is withdrawn by its asker, so no later spec finds it.
  const r = await call(request, dana, 'GET', `/api/actions?states=waiting&chatId=${chatId}`)
  for (const c of r.json.items as { id: string; rev: number }[]) await call(request, dana, 'POST', `/api/actions/${c.id}/withdraw`, { json: { ifRev: c.rev } })
  await ceiling(request, false)
})

async function checkBothThemes(page: Page, name: string) {
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme })
    if (scheme === 'dark') await expect(page.locator('html')).toHaveClass(/\bdark\b/)
    else await expect(page.locator('html')).not.toHaveClass(/\bdark\b/)
    await page.waitForFunction(() => document.getAnimations().every(a => a.playState !== 'running' || !(a.timeline instanceof DocumentTimeline) || a.effect?.getTiming().iterations === Infinity))
    const { violations } = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze()
    expect(violations.map(v => `${v.id}: ${v.nodes.map(n => n.target.join(' ')).join(', ')}`), `${name} ${scheme}`).toEqual([])
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), `${name} ${scheme} scrolls sideways`).toBe(true)
    await page.screenshot({ path: test.info().outputPath(`${name}-${scheme}.png`) })
  }
  await page.emulateMedia({ colorScheme: 'light' })
}

const cardOf = (page: Page, id: string) => page.locator(`[data-action-id="${id}"]`)

test('Dana sees her refund waiting for an admin, with Withdraw and no answer; Withdraw takes it back', async ({ page, context, request }) => {
  const id = await memberRefund(request)
  await signInAs(context, 'dana')
  await open(page, 'dana', '#/approvals')
  const card = cardOf(page, id)
  await expect(card.getByRole('heading', { name: TITLE })).toBeVisible()
  await expect(card).toContainText('Waiting for an admin')
  await expect(card).toContainText('Moves money')
  await expect(card.locator('[data-card-actions] button')).toHaveText(['Withdraw'])
  await card.scrollIntoViewIfNeeded()
  await checkBothThemes(page, `admin-card-member-${phone(page) ? 'phone' : 'desktop'}`)
  await card.getByRole('button', { name: `Withdraw: ${TITLE}` }).click()
  await expect(page.locator('[data-toast]').filter({ hasText: 'Withdrawn. Nothing goes out.' })).toBeVisible()
  await expect(card).toHaveAttribute('data-action-card', 'withdrawn')
  await expect(card.locator('[data-card-actions] button')).toHaveCount(0)
})

test("An admin answers Dana's refund from Approvals: who asked, Approve starts the hold and Undo takes it back", async ({ page, context, request }) => {
  const id = await memberRefund(request)
  await signInAs(context, 'admin')
  await open(page, 'admin', '#/approvals')
  const mine = page.locator('section[aria-labelledby="agent-actions"]')
  const card = mine.locator(`[data-action-id="${id}"]`)
  await expect(card.getByRole('heading', { name: TITLE })).toBeVisible()
  await expect(card).toContainText('Dana Kim asks an admin')
  await expect(card.locator('[data-card-actions] button')).toHaveText(['Approve', 'No'])
  // No way into Dana's chat.
  await expect(card.getByRole('button', { name: /^Open the chat/ })).toHaveCount(0)
  await card.scrollIntoViewIfNeeded()
  await checkBothThemes(page, `admin-card-admin-${phone(page) ? 'phone' : 'desktop'}`)
  await card.getByRole('button', { name: 'Approve', exact: true }).click()
  await expect(card.getByRole('timer')).toHaveText(/^Goes out in \d+ seconds?$/)
  await card.getByRole('button', { name: `Undo: ${TITLE}` }).click()
  await expect(card).toContainText('It was taken back. Nothing went out.')
  expect((await call(request, actor('admin'), 'GET', `/api/actions/${id}`)).json.state).toBe('undone')
})
