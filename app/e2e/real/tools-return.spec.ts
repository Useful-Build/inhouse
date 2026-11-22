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
async function holdToolsRead(page: Page): Promise<() => void> {
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  await page.route('**/api/tools', async route => { await gate; await route.continue() })
  return release
}

type Page = import('@playwright/test').Page
/** The toasts on screen that carry `text`: the stack (`[data-toast-stack]`) is the one live region, so its children are what is counted, never the region. */
const toasts = (page: Page, text: string) => page.locator('[data-toast-stack] [data-toast]').filter({ hasText: text })

/**
 * Records every toast the page ever drew, by its own id, from before the app boots: `shown(text)` is how many distinct toasts
 * carried that text. A same-key toast replaces the one on screen, so a count of what is visible can't tell one showing from two;
 * this can (each showing is a toast with its own id).
 */
async function recordToasts(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const seen: Record<string, string> = {}
    ;(window as unknown as { __toastsSeen: Record<string, string> }).__toastsSeen = seen
    const scan = () => { for (const el of document.querySelectorAll('[data-toast]')) seen[el.getAttribute('data-toast') ?? ''] = el.textContent ?? '' }
    new MutationObserver(scan).observe(document, { childList: true, subtree: true, characterData: true })
  })
}
const shown = (page: Page, text: string): Promise<number> =>
  page.evaluate(t => Object.values((window as unknown as { __toastsSeen: Record<string, string> }).__toastsSeen).filter(x => x.includes(t)).length, text)
const historyLength = (page: Page): Promise<number> => page.evaluate(() => history.length)

test('the return from a sign-in, with the tools read slow, waits, then lands on the tool page with one toast', async ({ page, context }) => {
  await signInAs(context, 'inhouse')
  await recordToasts(page)
  const release = await holdToolsRead(page)
  await page.goto(`${originFor('inhouse')}/tools/slack?connected=1`)
  await expect(page.getByText('Loading your tools.')).toBeVisible()
  await expect(toasts(page, NOT_FOUND), 'no not-found toast while it waits').toHaveCount(0)
  release()
  await expect(page.getByText('Loading your tools.')).toHaveCount(0)
  await expect(page.getByRole('main')).toContainText('Slack')
  await expect(toasts(page, 'The tool is connected.')).toHaveCount(1)
  expect(await shown(page, 'The tool is connected.'), 'the return was announced once').toBe(1)
  expect(await shown(page, NOT_FOUND), 'no not-found toast was ever drawn').toBe(0)
  expect(new URL(page.url()).search, 'the query is dropped from the address').toBe('')
})

test('a deep link to the tool, with the read slow, waits and lands on the tool page with no not-found toast', async ({ page, context }) => {
  await signInAs(context, 'inhouse')
  await recordToasts(page)
  const release = await holdToolsRead(page)
  await open(page, 'inhouse', '#/tools/slack')
  await expect(page.getByText('Loading your tools.')).toBeVisible()
  release()
  await expect(page.getByRole('main')).toContainText('Slack')
  expect(await shown(page, NOT_FOUND), 'no not-found toast was ever drawn').toBe(0)
  expect(page.url()).toContain('#/tools/slack')
})

test('a connect error lands on the tool page with the fixed copy, once, and the success line is not shown', async ({ page, context }) => {
  await signInAs(context, 'inhouse')
  await recordToasts(page)
  const release = await holdToolsRead(page)
  await page.goto(`${originFor('inhouse')}/tools/slack?connect_error=state_invalid`)
  await expect(page.getByText('Loading your tools.')).toBeVisible()
  release()
  await expect(page.getByRole('main')).toContainText('Slack')
  await expect(toasts(page, 'That sign-in link has expired. Start the connection again.')).toHaveCount(1)
  expect(await shown(page, 'That sign-in link has expired. Start the connection again.')).toBe(1)
  expect(await shown(page, 'The tool is connected.'), 'a connect error never shows the success line').toBe(0)
  expect(await shown(page, NOT_FOUND)).toBe(0)
})

test('a code outside the closed list shows the fallback line, never its own text', async ({ page, context }) => {
  await signInAs(context, 'inhouse')
  await page.goto(`${originFor('inhouse')}/tools/slack?connect_error=totally_made_up_code`)
  await expect(toasts(page, "We couldn't connect the tool. Try again.")).toHaveCount(1)
  await expect(page.getByText('totally_made_up_code')).toHaveCount(0)
})

test('an unknown key bounces once to Tools, after the read answers, replacing the entry rather than adding one', async ({ page, context }) => {
  await signInAs(context, 'inhouse')
  await recordToasts(page)
  const release = await holdToolsRead(page)
  await page.goto(`${originFor('inhouse')}/tools/no-such-tool?connected=1`)
  await expect(page.getByText('Loading your tools.')).toBeVisible()
  expect(await shown(page, NOT_FOUND), 'it waits for the read before judging the key').toBe(0)
  const before = await historyLength(page)
  release()
  await expect(toasts(page, NOT_FOUND)).toHaveCount(1)
  await expect.poll(() => page.url()).toMatch(/#\/tools\/?$/)
  // Once: one not-found toast was ever drawn, and the bounce replaced the history entry (a repeat or a push would show here).
  expect(await shown(page, NOT_FOUND)).toBe(1)
  expect(await historyLength(page), 'the bounce added no history entry').toBe(before)
})
