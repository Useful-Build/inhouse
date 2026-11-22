// The Tools sign-in return (P5 W3 #264's `toolRoute`, no DOM unit test covers the wiring): the browser comes back from Slack to
// `/tools/slack?connected=1` (or `?connect_error=<code>`) before the tools have been read. While the read is slow the page waits
// ("Loading your tools."), then lands on the tool page with ONE toast, never "That page doesn't exist". An unknown key bounces once,
// after the read answers. The read is held by a gate this spec opens, never by a timer. Ways it can fail, written first:
//  1. the link is judged on the app's empty starting list, so a known tool bounces with the not-found toast;
//  2. the return's toast shows twice (the hash rewrite re-runs the boot), or not at all;
//  3. a code outside the closed list shows its text, or a connect_error page shows the success line;
//  4. an unknown key stays on a blank page, or bounces more than once.
import { expect, test } from '../support/test-build/index.js'
import { open, originFor, signInAs } from '../support/clients/real.js'
import { ensureDisconnected, fakeReset, freshConnect } from '../api/fakes-kit.ts'

test.describe.configure({ mode: 'serial' })

test.beforeAll(async ({ request }) => { await fakeReset(request); await freshConnect(request) })
test.afterAll(async ({ request }) => { await fakeReset(request); await ensureDisconnected(request) })

const NOT_FOUND = "That page doesn't exist"

/** Holds the tools read until `release()`: the page sees "loading" for as long as the spec wants, with no timer. */
async function holdToolsRead(page: import('@playwright/test').Page): Promise<() => void> {
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  await page.route('**/api/tools', async route => { await gate; await route.continue() })
  return release
}

const toasts = (page: import('@playwright/test').Page, text: string) => page.getByRole('status').filter({ hasText: text })

test('the return from a sign-in, with the tools read slow, waits, then lands on the tool page with one toast', async ({ page, context }) => {
  await signInAs(context, 'inhouse')
  const release = await holdToolsRead(page)
  await page.goto(`${originFor('inhouse')}/tools/slack?connected=1`)
  await expect(page.getByText('Loading your tools.')).toBeVisible()
  await expect(toasts(page, NOT_FOUND), 'no not-found toast while it waits').toHaveCount(0)
  release()
  await expect(page.getByText('Loading your tools.')).toHaveCount(0)
  await expect(page.getByRole('main')).toContainText('Slack')
  await expect(toasts(page, 'The tool is connected.')).toHaveCount(1)
  await expect(toasts(page, NOT_FOUND)).toHaveCount(0)
  expect(new URL(page.url()).search, 'the query is dropped from the address').toBe('')
})

test('a deep link to the tool, with the read slow, waits and lands on the tool page with no not-found toast', async ({ page, context }) => {
  await signInAs(context, 'inhouse')
  const release = await holdToolsRead(page)
  await open(page, 'inhouse', '#/tools/slack')
  await expect(page.getByText('Loading your tools.')).toBeVisible()
  release()
  await expect(page.getByRole('main')).toContainText('Slack')
  await expect(toasts(page, NOT_FOUND)).toHaveCount(0)
  expect(page.url()).toContain('#/tools/slack')
})

test('a connect error lands on the tool page with the fixed copy, once, and the success line is not shown', async ({ page, context }) => {
  await signInAs(context, 'inhouse')
  const release = await holdToolsRead(page)
  await page.goto(`${originFor('inhouse')}/tools/slack?connect_error=state_invalid`)
  await expect(page.getByText('Loading your tools.')).toBeVisible()
  release()
  await expect(page.getByRole('main')).toContainText('Slack')
  await expect(toasts(page, 'That sign-in link has expired. Start the connection again.')).toHaveCount(1)
  await expect(toasts(page, 'The tool is connected.')).toHaveCount(0)
  await expect(toasts(page, NOT_FOUND)).toHaveCount(0)
})

test('a code outside the closed list shows the fallback line, never its own text', async ({ page, context }) => {
  await signInAs(context, 'inhouse')
  await page.goto(`${originFor('inhouse')}/tools/slack?connect_error=totally_made_up_code`)
  await expect(toasts(page, "We couldn't connect the tool. Try again.")).toHaveCount(1)
  await expect(page.getByText('totally_made_up_code')).toHaveCount(0)
})

test('an unknown key bounces once to Tools, after the read answers', async ({ page, context }) => {
  await signInAs(context, 'inhouse')
  const release = await holdToolsRead(page)
  await page.goto(`${originFor('inhouse')}/tools/no-such-tool?connected=1`)
  await expect(page.getByText('Loading your tools.')).toBeVisible()
  await expect(toasts(page, NOT_FOUND), 'it waits for the read before judging the key').toHaveCount(0)
  release()
  await expect(toasts(page, NOT_FOUND)).toHaveCount(1)
  expect(page.url()).toMatch(/#\/tools\/?$/)
  // Once: nothing bounces it a second time.
  await expect(toasts(page, NOT_FOUND)).toHaveCount(1)
})
