// Ship spec for P4 Watch (the plan's browser scenarios S1 to S8): the morning check, Today and its problem panel, a chat answer
// with a table and its sources, Activity, the bell, the Library and the routine's next run, as real people on the TEST BUILD
// with the hub, the recorded Shopify upstream and the scripted model. Desktop (1440x900) and phone (390x844). Each test is
// titled `S<n>: ...` (the card before its clip).
//
// What runs where. Everything here runs a turn in a container (the morning check, a chat answer), which only the sandbox
// deployment has: each test calls `needsContainer()` (E2E_TEST_BUILD_REMOTE) and skips elsewhere, except S7 (the next run is
// computed by the server, no turn). The system routine's turn plays the scripted `morning-check` scenario by the routing
// of #273; a chat plays the scenario named in its message (`scenario:late-orders`, `scenario:write-output`).
//
// Each test that needs the morning check's output runs it itself from the Routines page ("Run now") and waits on the
// routine's last run moving, so no test depends on another's leftovers and none waits on time. The desktop and the phone project
// share one database: nothing counts what an earlier run left (files are counted before and after, orders are named).
//
// Run (the ship workflow or the sandbox recording, with the test issuer key it holds):
//   E2E_TEST_BUILD_REMOTE=1 SHIP=1 BASE_URL=... TEST_BUILD_INHOUSE_URL=... TEST_ISSUER_PRIVATE_JWK_FILE=...
//   npx playwright test e2e/ship/watch.spec.ts --project=ship-desktop --project=ship-phone
import { readFile } from 'node:fs/promises'
import type { Browser, BrowserContext, Page } from '@playwright/test'
import { needsContainer } from '../api/chat-kit.ts'
import { originFor, people, signInAs } from '../support/clients/real.js'
import type { Who } from '../support/clients/real.js'
import { expect, test } from '../support/test-build/index.js'

const phone = () => test.info().project.name === 'ship-phone'

const main = (page: Page) => page.getByRole('main')
const log = (page: Page) => page.getByRole('log', { name: 'Conversation' })
const uid = () => crypto.randomUUID().slice(0, 8)

// What the product and the scripted model say, copied (a spec reads no product string by import).
const MORNING_CHECK = 'routine-morning-check'
const CARD_TITLE = 'Orders waiting to ship'
const ORDER = '#1001'
const ORDER_TEXT = 'Lite Trekking Poles'
const RAN_LINE = 'Ran the morning check and found 1 thing'
const NOTICE = 'The morning check found 1 thing'
const LATE_INTRO = 'These orders are late (the 3 oldest, not all of them):'
const LATE_SOURCES = 'Sources: Shopify orders, the 3 oldest unfulfilled.'
const LATE_BOUND = 3
const SAVED = 'Saved outputs/table.csv.'
const FILE = 'table.csv'
const FILE_BODY = 'sku,qty\nA1,3\n'
/** The brand's time zone as the test build runs (the default, `g:tz` unset). */
const BRAND_TZ = 'America/New_York'
/** A zone far from the brand's, so a page that showed the browser's clock would show another time. */
const BROWSER_TZ = 'Pacific/Auckland'

/** Waits for menus and windows to finish their finite animations, then attaches a screenshot named by the item. */
async function shot(page: Page, name: string) {
  await page.evaluate(() => Promise.all(document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished)))
  await test.info().attach(name, { body: await page.screenshot(), contentType: 'image/png' })
}

async function ready(page: Page) {
  if (phone()) await expect(page.getByRole('button', { name: 'Menu' })).toBeVisible()
  else await expect(page.getByRole('button', { name: /, account and settings$/ })).toBeVisible()
}

// One browser context per person, so a second person's tab never shares the first one's sign-in header. The test's own
// `context` and `page` are the first person; the others close after the test.
const opened: BrowserContext[] = []
test.afterEach(async () => { for (const c of opened.splice(0)) await c.close() })

async function newContext(browser: Browser, timezoneId?: string): Promise<BrowserContext> {
  const { viewport, hasTouch, isMobile, userAgent, deviceScaleFactor } = test.info().project.use
  const context = await browser.newContext({ viewport, hasTouch, isMobile, userAgent, deviceScaleFactor, ...(timezoneId ? { timezoneId } : {}) })
  opened.push(context)
  return context
}

async function openAs(context: BrowserContext, page: Page, who: Who, hash = '') {
  await signInAs(context, who)
  await page.goto(`${originFor(who)}/${hash}`)
  await ready(page)
}

/** A new tab for someone, loaded. */
async function pageFor(browser: Browser, who: Who, hash = '', timezoneId?: string): Promise<Page> {
  const context = await newContext(browser, timezoneId)
  const page = await context.newPage()
  await openAs(context, page, who, hash)
  return page
}

/** A request from inside the page: same origin, so it carries the page's sign-in and Origin. */
async function api(page: Page, method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  return page.evaluate(async ([m, p, b]) => {
    const res = await fetch(p as string, { method: m as string, ...(b === null ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }) })
    return { status: res.status, json: await res.json().catch(() => null) }
  }, [method, path, body ?? null] as const)
}

/** Goes to a screen by its hash, as the sidebar's rows do (on a phone the drawer stays out of the way). */
async function goTo(page: Page, hash: string) {
  await page.evaluate(h => { location.hash = h }, hash)
  await expect(page).toHaveURL(new RegExp(`${hash.replace('/', '\\/')}$`))
}

/** The morning check's routine as the server lists it. */
async function morningCheck(page: Page): Promise<{ name: string; next: { ms: number }; time: { hour: number; minute: number }; last?: { at: { ms: number } } }> {
  const r = await api(page, 'GET', '/api/routines')
  expect(r.status).toBe(200)
  const def = (r.json.routines as { id: string }[]).find(x => x.id === MORNING_CHECK)
  expect(def, 'the morning check is listed').toBeDefined()
  return def as never
}

/**
 * Runs the morning check as a person does: Routines, the routine's details, Run now. Waits on the routine's last run moving
 * (the run ended and saved), then leaves the page on Routines.
 */
async function runMorningCheck(page: Page) {
  const before = (await morningCheck(page)).last?.at.ms ?? 0
  await goTo(page, '#/routines')
  await page.locator(`[data-routine-open="${MORNING_CHECK}"]`).click()
  const sheet = page.getByRole('dialog')
  await sheet.getByRole('button', { name: 'Run now' }).click()
  await expect(page.locator('[data-toast]').filter({ hasText: 'is running now' })).toBeVisible()
  await expect.poll(async () => (await morningCheck(page)).last?.at.ms ?? 0, { timeout: 240_000, message: 'the morning check run to end' }).toBeGreaterThan(before)
  await page.keyboard.press('Escape')
  await expect(sheet).toBeHidden()
}

/** Chooses the Fast model (Sonnet): the composer's default is Opus, and the scripted model answers only for Sonnet. */
async function pickFast(page: Page) {
  const modelMenu = page.getByRole('button', { name: /^Model:/ })
  const plusMenu = page.getByRole('button', { name: 'Attach, tools and model' })
  await expect(modelMenu.or(plusMenu), 'the composer shows neither a "Model: ..." button nor an "Attach, tools and model" button').toBeVisible({ timeout: 60_000 })
  if (await modelMenu.isVisible()) await modelMenu.click()
  else await plusMenu.click()
  await page.getByRole('menuitemradio', { name: /^Fast/ }).click()
  await page.keyboard.press('Escape')
}

/** A person starts a chat from Today with a question, on the Fast model; returns the new chat's id. */
async function askFromToday(page: Page, text: string): Promise<string> {
  await goTo(page, '#/today')
  await expect(page.getByRole('textbox', { name: 'Ask your Inhouse agent' })).toBeVisible()
  await page.locator('[data-composer] textarea').fill(text)
  await pickFast(page)
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(page).toHaveURL(/#\/chats\/(?!new$|all$)[^/]+$/, { timeout: 60_000 })
  return /#\/chats\/([^/]+)$/.exec(page.url())![1]!
}

/** Dana asks the agent to make a file and waits for the answer that says it is saved. Returns the chat's id. */
async function makeFile(page: Page): Promise<string> {
  const id = await askFromToday(page, `scenario:write-output make the table ${uid()}`)
  await expect(log(page).getByText(SAVED, { exact: true })).toBeVisible({ timeout: 150_000 })
  // The file reaches the Library when the run's outputs are saved, which can be just after the answer: wait on the list, not the clock.
  await expect.poll(async () => {
    const r = await api(page, 'GET', '/api/library?limit=100')
    return (r.json?.items as { name: string; link?: { id: string } }[] | undefined)?.some(f => f.name === FILE && f.link?.id === id) ?? false
  }, { timeout: 60_000, message: `the Library lists ${FILE} from chat ${id}` }).toBe(true)
  return id
}

/** A file's menu button in the Library, by the file name. Several runs leave several files of one name: the newest is first. */
const fileMenu = (page: Page) => main(page).getByRole('button', { name: `Actions for ${FILE}` })

/** Plain spaces: the app writes a time with a narrow no-break space. */
const plain = (s: string) => s.replace(/[\u00a0\u202f]/g, ' ')

// ---------- S1 to S2: the morning check fills Today ----------

test('S1: Run the morning check from Routines and Today fills with the store\'s items and the right count', async ({ context, page }) => {
  needsContainer()
  test.setTimeout(360_000)
  await openAs(context, page, 'dana', '#/today')
  await runMorningCheck(page)
  await shot(page, 'S1-routines-after-the-run')
  await goTo(page, '#/today')
  await expect(page.getByRole('article', { name: CARD_TITLE })).toBeVisible()
  await expect(page.getByRole('heading', { level: 1 })).toContainText('1 thing needs you')
  await expect(main(page).getByText('1 to look at', { exact: true })).toBeVisible()
  await shot(page, 'S1-today-filled')
})

test('S2: Open an item and the problem panel shows the orders behind it from the store', async ({ context, page }) => {
  needsContainer()
  test.setTimeout(360_000)
  await openAs(context, page, 'dana', '#/today')
  await runMorningCheck(page)
  await goTo(page, '#/today')
  await page.getByRole('article', { name: CARD_TITLE }).getByRole('button', { name: CARD_TITLE }).click()
  const panel = page.getByRole('dialog')
  await expect(panel).toBeVisible()
  await expect(panel).toContainText(CARD_TITLE)
  await expect(panel).toContainText(ORDER)
  await expect(panel).toContainText(ORDER_TEXT)
  await shot(page, 'S2-problem-panel')
})

// ---------- S3: a chat answer with a bounded table and its sources ----------

test('S3: Ask which orders are late and the answer shows with a bounded table and its sources', async ({ context, page }) => {
  needsContainer()
  test.setTimeout(240_000)
  await openAs(context, page, 'dana', '#/today')
  await askFromToday(page, `scenario:late-orders which orders are late? ${uid()}`)
  await expect(log(page).getByText(LATE_INTRO, { exact: true })).toBeVisible({ timeout: 150_000 })
  const table = log(page).locator('[data-md-table]')
  await expect(table).toHaveCount(1)
  await expect(table.locator('tbody tr')).toHaveCount(LATE_BOUND)
  await expect(table).toContainText(ORDER)
  await expect(log(page).getByText(LATE_SOURCES, { exact: true })).toBeVisible()
  await shot(page, 'S3-late-orders-table')
})

// ---------- S4 and S5: Activity and the bell ----------

test('S4: Activity shows the morning check\'s run with its time', async ({ context, page }) => {
  needsContainer()
  test.setTimeout(360_000)
  await openAs(context, page, 'dana', '#/today')
  await runMorningCheck(page)
  await goTo(page, '#/activity')
  const line = main(page).locator('[data-activity-row]').filter({ hasText: RAN_LINE }).first()
  await expect(line).toBeVisible()
  // The time sits beside the line on a desktop and under it on a phone.
  expect(plain(await line.innerText())).toMatch(/\b\d{1,2}:\d{2}\b/)
  await shot(page, 'S4-activity-run')
})

test('S5: The bell shows the new notice and marking it read clears the dot after a reload', async ({ context, page }) => {
  needsContainer()
  test.setTimeout(360_000)
  await openAs(context, page, 'dana', '#/today')
  await runMorningCheck(page)
  await page.reload()
  await ready(page)
  const bell = page.getByRole('button', { name: /^Notifications, \d+ unread$/ })
  await expect(bell).toBeVisible()
  await bell.click()
  const popup = page.getByRole('dialog', { name: 'Notifications' })
  await expect(popup.getByText(NOTICE).first()).toBeVisible()
  await shot(page, 'S5-bell-with-notice')
  const saved = page.waitForResponse(r => r.url().endsWith('/api/notifications/read') && r.request().method() === 'POST' && r.status() === 200)
  await popup.getByRole('button', { name: 'Mark all as read' }).click()
  await saved
  await page.reload()
  await ready(page)
  await expect(page.getByRole('button', { name: 'Notifications', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: /^Notifications, \d+ unread$/ })).toHaveCount(0)
  await shot(page, 'S5-bell-cleared')
})

// ---------- S6 and S8: the Library ----------

test('S6: Library shows a file the agent made, it downloads, and deleting and restoring it works', async ({ context, page }) => {
  needsContainer()
  test.setTimeout(360_000)
  await openAs(context, page, 'dana', '#/today')
  await makeFile(page)
  await goTo(page, '#/library')
  await expect(fileMenu(page).first()).toBeVisible()
  const n = await fileMenu(page).count()
  await shot(page, 'S6-library-with-the-file')

  await fileMenu(page).first().click()
  const [saved, served] = await Promise.all([
    page.waitForEvent('download'),
    page.waitForResponse(r => /\/api\/library\/[^/]+\/download$/.test(r.url())),
    page.getByRole('menuitem', { name: 'Download', exact: true }).click(),
  ])
  expect(served.status(), `the download answered: ${await served.text().catch(() => '')}`).toBe(200)
  expect(saved.suggestedFilename()).toBe(FILE)
  expect(await readFile(await saved.path(), 'utf8')).toBe(FILE_BODY)

  await fileMenu(page).first().click()
  await page.getByRole('menuitem', { name: 'Delete', exact: true }).click()
  const toast = page.locator('[data-toast]').filter({ hasText: 'Deleted 1 file' })
  await expect(toast).toBeVisible()
  await expect(fileMenu(page)).toHaveCount(n - 1)
  await shot(page, 'S6-deleted')
  await toast.getByRole('button', { name: 'Undo' }).click()
  await expect(fileMenu(page)).toHaveCount(n)
  // The server kept it too: a reload still lists the restored file.
  await page.reload()
  await ready(page)
  await expect(fileMenu(page)).toHaveCount(n)
  await shot(page, 'S6-restored')
})

test('S7: Routines shows the morning check\'s next run on the brand\'s time zone', async ({ browser, context, page }) => {
  await openAs(context, page, 'dana', '#/today')
  const { next } = await morningCheck(page)
  // The same person in a browser far from the brand's zone: a page that used the browser's clock would show another hour.
  const other = await pageFor(browser, 'dana', '#/routines', BROWSER_TZ)
  const clock = (tz: string) => plain(new Date(next.ms).toLocaleTimeString('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' }))
  expect(clock(BRAND_TZ), 'the two zones show different times').not.toBe(clock(BROWSER_TZ))
  const row = other.locator('li').filter({ has: other.locator(`[data-routine-open="${MORNING_CHECK}"]`) })
  await expect(row).toBeVisible()
  const text = plain(await row.innerText())
  // Only the time after "Next run" ("Tue, Nov 17 at 7:00 AM"): the row also holds the last run's time.
  const shown = /Next run\s+[^\n]*?\bat (\d{1,2}:\d{2} [AP]M)/.exec(text)?.[1]
  expect(shown, `the row's Next run in: ${text}`).toBe(clock(BRAND_TZ))
  await shot(other, 'S7-next-run')
})

test('S8: A second Member sees that file in the Library but can\'t open the chat it came from', async ({ browser, context, page }) => {
  needsContainer()
  test.setTimeout(360_000)
  await openAs(context, page, 'dana', '#/today')
  const chat = await makeFile(page)
  const other = await pageFor(browser, 'leo', '#/library')
  await expect(fileMenu(other).first()).toBeVisible()
  // Leo reads who made it, not which chat: no title, no link.
  const from = main(other).locator('[data-file]').filter({ hasText: FILE }).filter({ hasText: `From a chat by ${people.dana.name}` })
  await expect(from.first()).toBeVisible()
  await fileMenu(other).first().click()
  const menu = other.getByRole('menu', { name: 'File actions' })
  await expect(menu.getByRole('menuitem', { name: 'Open', exact: true })).toBeVisible()
  await expect(menu.getByRole('menuitem', { name: /chat/i })).toHaveCount(0)
  await shot(other, 'S8-leo-library-menu')
  await other.keyboard.press('Escape')
  // Not by its id either: the server answers as if there were no such chat.
  expect((await api(other, 'GET', `/api/chats/${chat}`)).status).toBe(404)
  await goTo(other, `#/chats/${chat}`)
  await expect(other.locator('[data-toast]').filter({ hasText: "That chat isn't available" })).toBeVisible()
  await expect(log(other).getByText('make the table')).toHaveCount(0)
  await shot(other, 'S8-leo-cannot-open-the-chat')
})
