// Buttons that nothing sits behind yet each say so in a toast, in the same sentence: "<What> isn't connected in this
// demo." Google Drive (composer's Attach menu), Slack (an answer's "Send to Slack") and Dictation (composer's Dictate).
// The approver's "Ask Leo" button is checked in `sample-data.spec.ts`.
//
// Dictation: the model for it is connected later. When it lands this check changes: the button then records, and the
// "isn't connected" test is replaced by one that drives the real thing.
import { expect, test, type Fx } from './support/fx.js'
import type { Page } from '@playwright/test'

async function start(page: Page, fx: Fx, hash: string, ready: (page: Page) => Promise<void>) {
  await fx.seed({ stage: 'Act', demo: { ambient: 'Always' } })
  await page.goto('/?demo' + hash)
  await ready(page)
}

/** A page with a title: Today. A chat has none, so it waits for its own answer. */
const titled = (page: Page) => expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible()

const toast = (page: Page, text: string) => page.locator('[data-toast]').filter({ hasText: text })
const composer = (page: Page) => page.locator('[data-composer]')

test('Composer: "From Google Drive" says Google Drive isn\'t connected and attaches nothing', async ({ fx, page }) => {
  await start(page, fx, '#/today', titled)
  const field = page.getByRole('textbox', { name: 'Ask your Inhouse agent' })
  await composer(page).getByRole('button', { name: 'Attach', exact: true }).click()
  const menu = page.getByRole('menu')
  await expect(menu.getByRole('menuitem', { name: /From Google Drive/ })).toBeVisible()
  await menu.getByRole('menuitem', { name: /From Google Drive/ }).click()
  await expect(toast(page, "Google Drive isn't connected in this demo.")).toBeVisible()
  // Nothing was attached: Send stays off while the field is empty.
  await expect(field).toHaveValue('')
  await expect(composer(page).getByRole('button', { name: 'Send', exact: true })).toBeDisabled()
})

test('Composer: Dictate says Dictation isn\'t connected and leaves the field alone', async ({ fx, page }) => {
  await start(page, fx, '#/today', titled)
  const field = page.getByRole('textbox', { name: 'Ask your Inhouse agent' })
  await field.fill('Draft I keep')
  await composer(page).getByRole('button', { name: 'Dictate' }).click()
  await expect(toast(page, "Dictation isn't connected in this demo.")).toBeVisible()
  await expect(field).toHaveValue('Draft I keep')
})

test('Answer menu: "Send to Slack" says Slack isn\'t connected', async ({ fx, page }) => {
  const answer = page.getByRole('log', { name: 'Conversation' }).locator('[data-chat-msg]').filter({ hasText: 'Refund requests rose from 14 last week to 31 this week' })
  await start(page, fx, '#/chats/refunds', () => expect(answer).toBeVisible())
  await answer.getByRole('button', { name: 'More', exact: true }).click()
  await page.getByRole('menu', { name: 'Message actions' }).getByRole('menuitem', { name: 'Send to Slack' }).click()
  await expect(toast(page, "Send to Slack isn't connected in this demo.")).toBeVisible()
})
