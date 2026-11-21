// Ship spec for the P3 agent chat (the plan's browser scenarios S1 to S10): a real person's flows on the TEST BUILD with the
// scripted model, desktop (1440x900) and phone (390x844). Each test is titled `S<n>: ...` (the card before its clip) and attaches
// a screenshot named by its item (`S<n>-<what>`), taken after the assertions of that step.
//
// What runs where. The container-free items run on any test build, as backend-core's do: S5 (the server's chats, rename and pin
// across a reload), S6 (a second Member can't see the chat), S8's refusal while paused, S9's cap refusal. Everything that needs an
// answer to stream needs a container, which only the Q2 sandbox has: those tests call `needsContainer()` (E2E_TEST_BUILD_REMOTE)
// and skip elsewhere, so the ops specs job records them. The scripted model plays the scenario named in a message's text
// (`scenario:hello ...`, app/test/scripted-model/scenarios.ts); `slow-bash` keeps an answer live for 20 s.
//
// Honest limits (also in the PR body): the test build's seeded stage is Watch, where the top bar shows the Pause pill only while
// paused, so an Admin pauses through the API and the spec drives the UI from there (the pill, its Resume button, the refusal).
// The Memory pages list active facts only, so S7 can show the person's own fact and the team fact's absence, not the agent
// "relying" on a fact (a scripted model can't); the waiting save itself is covered by tools.test.ts. S9 sets the smallest cap
// ($0.01): the server judges the cap reached once less than a start hold ($0.25) is left, so Usage reads at the cap without any
// spending. S10's download test attaches a real file through the composer (uploaded to route 39 when the message is sent) and
// downloads it and the file the agent made through the chats' Download buttons (route 41).
//
// Run (the Q2 specs job, with the test issuer key it holds):
//   E2E_TEST_BUILD_REMOTE=1 SHIP=1 BASE_URL=... TEST_BUILD_INHOUSE_URL=... TEST_ISSUER_PRIVATE_JWK_FILE=...
//   npx playwright test e2e/ship/agent-chat.spec.ts --project=ship-desktop --project=ship-phone
// Container-free only (any test build, as ship.yml serves it): the same without E2E_TEST_BUILD_REMOTE; the container tests skip.
import { readFile } from 'node:fs/promises'
import type { Browser, BrowserContext, Page } from '@playwright/test'
import { needsContainer } from '../api/chat-kit.ts'
import { originFor, signInAs } from '../support/clients/real.js'
import type { Who } from '../support/clients/real.js'
import { expect, test } from '../support/test-build/index.js'

const phone = () => test.info().project.name === 'ship-phone'

const main = (page: Page) => page.getByRole('main')
const h1 = (page: Page) => page.getByRole('heading', { level: 1 })
const log = (page: Page) => page.getByRole('log', { name: 'Conversation' })
const side = (page: Page) => page.getByRole('complementary', { name: 'Sidebar' })

// The words the product says (src/screens/chat/notes.ts and turn-text.ts), copied: a spec reads no product string by import.
const STOPPED_NOTE = 'You stopped your Inhouse agent. Nothing was changed.'
const PAUSED_NOTICE = "Your Inhouse agent is paused, so it can't answer questions until an Admin resumes it."
const CAP_REFUSED = /Your team has reached its spending cap/
// What the scripted scenarios say (app/test/scripted-model/scenarios.ts).
const HELLO = 'Hello from the scripted model.'
const WAITING = 'Waiting a while.'
const DONE_WAITING = 'Done waiting.'
const MEMORY_PERSON = 'Likes the weekly stock report as a table.'
const MEMORY_TEAM = 'We restock on Fridays.'

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

async function newContext(browser: Browser): Promise<BrowserContext> {
  const { viewport, hasTouch, isMobile, userAgent, deviceScaleFactor } = test.info().project.use
  const context = await browser.newContext({ viewport, hasTouch, isMobile, userAgent, deviceScaleFactor })
  opened.push(context)
  return context
}

async function openAs(context: BrowserContext, page: Page, who: Who, hash = '') {
  await signInAs(context, who)
  await page.goto(`${originFor(who)}/${hash}`)
  await ready(page)
}

/** A new tab for someone, loaded. */
async function pageFor(browser: Browser, who: Who, hash = ''): Promise<Page> {
  const context = await newContext(browser)
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

/** The sidebar (on a phone the drawer behind Menu, opened first). */
async function sidebar(page: Page) {
  if (phone() && !(await side(page).isVisible())) await page.getByRole('button', { name: 'Menu' }).click()
  await expect(side(page)).toBeVisible()
  return side(page)
}

async function goTo(page: Page, name: string) {
  await (await sidebar(page)).getByRole('button', { name, exact: true }).click()
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

/** Types a message into the open composer (Today's or a chat's), picks the Fast model and sends it; `queue` sends it into a running answer. */
async function ask(page: Page, text: string, queue = false) {
  await page.locator('[data-composer] textarea').fill(text)
  await pickFast(page)
  await page.getByRole('button', { name: queue ? 'Queue message' : 'Send', exact: true }).click()
}

/** A person starts a chat from Today with a question. */
async function askFromToday(page: Page, text: string) {
  await goTo(page, 'Today')
  await expect(page.getByRole('textbox', { name: 'Ask your Inhouse agent' })).toBeVisible()
  await ask(page, text)
}

/** Account menu, then a Settings page by its group and label. */
async function settingsPage(page: Page, group: 'Your settings' | 'Team settings', label: string) {
  if (phone()) await page.getByRole('button', { name: 'Menu' }).click()
  await side(page).getByRole('button', { name: /, account and settings$/ }).click()
  await page.getByRole('menu', { name: 'Account' }).getByRole('menuitem', { name: group, exact: true }).click()
  await page.getByRole('navigation', { name: 'Settings' }).getByRole('button', { name: label, exact: true }).click()
  await expect(h1(page)).toHaveText(label)
}

const uid = () => crypto.randomUUID().slice(0, 8)
const makeChat = async (page: Page, title: string) => {
  const id = `ship-${uid()}${uid()}`
  const r = await api(page, 'POST', '/api/chats', { id, title })
  expect(r.status).toBe(200)
  return id
}

/** The All chats page (See all in the sidebar). */
async function seeAll(page: Page) {
  await (await sidebar(page)).getByRole('button', { name: 'See all' }).click()
  await expect(h1(page)).toHaveText('All chats')
}
const chatRow = (page: Page, title: string) => main(page).locator('[data-chat-row]').filter({ has: page.getByRole('button', { name: title, exact: true }) })
async function rowMenu(page: Page, title: string, item: string) {
  const r = chatRow(page, title)
  await r.hover()
  await r.getByRole('button', { name: 'Chat actions' }).click()
  await page.getByRole('menu', { name: 'Chat actions' }).getByRole('menuitem', { name: item, exact: true }).click()
}

// ---------- S1 to S4: a running answer (a container) ----------

test('S1: Ask a question on Today and watch the answer stream into a new chat', async ({ context, page }) => {
  needsContainer()
  test.setTimeout(240_000)
  await openAs(context, page, 'dana', '#/today')
  const question = `scenario:hello what is up ${uid()}?`
  await askFromToday(page, question)
  // A new chat opens with the question and the answer streams into it.
  await expect(log(page).getByText(question, { exact: true })).toBeVisible({ timeout: 60_000 })
  await expect(log(page).getByText(HELLO, { exact: true })).toBeVisible({ timeout: 150_000 })
  await expect(side(page).locator('[data-chat-row]').filter({ hasText: question }).first()).toBeAttached()
  await shot(page, 'S1-answer-in-a-new-chat')
})

test('S2: Reload mid-answer and the chat picks up where it was, with no lost or doubled part', async ({ context, page }) => {
  needsContainer()
  test.setTimeout(240_000)
  await openAs(context, page, 'dana', '#/today')
  await askFromToday(page, 'scenario:slow-bash wait for me')
  await expect(log(page).getByText(WAITING, { exact: true })).toBeVisible({ timeout: 150_000 })
  await shot(page, 'S2-before-the-reload')
  await page.reload()
  await ready(page)
  // The history and the stream are back: the part said so far once, and the rest arrives once.
  await expect(log(page).getByText(WAITING, { exact: true })).toBeVisible({ timeout: 60_000 })
  await expect(log(page).getByText(DONE_WAITING, { exact: true })).toBeVisible({ timeout: 150_000 })
  await expect(log(page).getByText(WAITING, { exact: true })).toHaveCount(1)
  await expect(log(page).getByText(DONE_WAITING, { exact: true })).toHaveCount(1)
  await shot(page, 'S2-after-the-reload')
})

test('S3: A second tab on the same chat shows the same stream, and a message sent from it joins the same run', async ({ browser, context, page }) => {
  needsContainer()
  test.setTimeout(240_000)
  await openAs(context, page, 'dana', '#/today')
  await askFromToday(page, 'scenario:slow-bash from tab one')
  await expect(log(page).getByText(WAITING, { exact: true })).toBeVisible({ timeout: 150_000 })
  const chatHash = new URL(page.url()).hash
  expect(chatHash).toMatch(/^#\/chats\//)
  const second = await pageFor(browser, 'dana', chatHash)
  await expect(log(second).getByText(WAITING, { exact: true })).toBeVisible({ timeout: 60_000 })
  await shot(second, 'S3-second-tab-same-stream')
  // A message from the second tab queues behind the running answer, in the same chat; both tabs end with both answers, once each.
  await ask(second, 'scenario:hello from tab two', true)
  for (const p of [page, second]) {
    await expect(log(p).getByText(DONE_WAITING, { exact: true })).toBeVisible({ timeout: 150_000 })
    await expect(log(p).getByText(HELLO, { exact: true })).toBeVisible({ timeout: 150_000 })
    await expect(log(p).getByText(WAITING, { exact: true })).toHaveCount(1)
    await expect(log(p).getByText(HELLO, { exact: true })).toHaveCount(1)
  }
  await shot(page, 'S3-both-tabs-both-answers')
})

test('S4: Stop mid-answer stops that turn only, and a follow-up sent while it runs is answered', async ({ context, page }) => {
  needsContainer()
  test.setTimeout(240_000)
  await openAs(context, page, 'dana', '#/today')
  await askFromToday(page, 'scenario:slow-bash stop me')
  await expect(log(page).getByText(WAITING, { exact: true })).toBeVisible({ timeout: 150_000 })
  // The follow-up waits behind the running answer; Stop acts on the running turn, not the waiting one.
  await ask(page, 'scenario:hello after the stop', true)
  await expect(page.getByRole('list', { name: 'Queued messages' })).toContainText('after the stop')
  await page.getByRole('button', { name: 'Stop', exact: true }).click()
  await expect(page.getByText(STOPPED_NOTE)).toBeVisible({ timeout: 60_000 })
  await expect(log(page).getByText(HELLO, { exact: true })).toBeVisible({ timeout: 150_000 })
  await expect(log(page).getByText(DONE_WAITING, { exact: true })).toHaveCount(0)
  await shot(page, 'S4-stopped-and-followed-up')
})

// ---------- S5 and S6: the server's chats (no container) ----------

test('S5: All chats lists the server\'s chats; rename and pin survive a reload', async ({ context, page }) => {
  await openAs(context, page, 'dana', '#/today')
  const a = `Ship S5 ${uid()} orders`
  const b = `Ship S5 ${uid()} stock`
  await makeChat(page, a)
  await makeChat(page, b)
  await page.reload()
  await ready(page)
  await seeAll(page)
  await expect(chatRow(page, a)).toBeVisible()
  await expect(chatRow(page, b)).toBeVisible()
  const renamed = `Ship S5 ${uid()} renamed`
  // Each change is saved by the server before the reload: wait for its answer.
  const renameSaved = page.waitForResponse(r => r.request().method() === 'PUT' && r.url().endsWith('/title') && r.status() === 200)
  await rowMenu(page, a, 'Rename')
  const field = main(page).getByRole('textbox', { name: 'Chat title' })
  await field.fill(renamed)
  await field.press('Enter')
  await renameSaved
  const pinSaved = page.waitForResponse(r => r.request().method() === 'PUT' && r.url().endsWith('/pin') && r.status() === 200)
  await rowMenu(page, b, 'Pin')
  await pinSaved
  await expect(chatRow(page, renamed)).toBeVisible()
  await shot(page, 'S5-renamed-and-pinned')
  await page.reload()
  await ready(page)
  await seeAll(page)
  await expect(chatRow(page, renamed)).toBeVisible()
  await expect(chatRow(page, a)).toHaveCount(0)
  const pinned = chatRow(page, b)
  await pinned.hover()
  await pinned.getByRole('button', { name: 'Chat actions' }).click()
  await expect(page.getByRole('menu', { name: 'Chat actions' }).getByRole('menuitem', { name: 'Unpin', exact: true })).toBeVisible()
  await page.keyboard.press('Escape')
  // The renamed chat opens after the reload, under its new title. (Its full history after a reload is S1's and S2's, in a container.)
  await chatRow(page, renamed).getByRole('button', { name: renamed, exact: true }).click()
  await expect(page.getByRole('banner')).toContainText(renamed)
  await shot(page, 'S5-after-the-reload')
})

test('S6: A second Member can\'t see the first person\'s chat', async ({ browser, context, page }) => {
  await openAs(context, page, 'dana', '#/today')
  const title = `Ship S6 ${uid()} private`
  const id = await makeChat(page, title)
  await page.reload()
  await ready(page)
  await seeAll(page)
  await expect(chatRow(page, title)).toBeVisible()
  const other = await pageFor(browser, 'leo', '#/today')
  // Leo has a chat of his own, so the list he reads is loaded and not empty; Dana's isn't in it.
  const own = `Ship S6 ${uid()} leo's own`
  await makeChat(other, own)
  await other.reload()
  await ready(other)
  await seeAll(other)
  await expect(chatRow(other, own)).toBeVisible()
  await expect(chatRow(other, title)).toHaveCount(0)
  await expect(other.getByText(title)).toHaveCount(0)
  // Not by its id either: the server answers as if there were no such chat.
  expect((await api(other, 'GET', `/api/chats/${id}`)).status).toBe(404)
  await shot(other, 'S6-the-other-member-sees-nothing')
})

// ---------- S7: memory (a container) ----------

test('S7: A fact the agent saves for you shows in your Memory; a team fact waits for an admin and no page lists it', async ({ browser, context, page }) => {
  needsContainer()
  test.setTimeout(240_000)
  await openAs(context, page, 'dana', '#/today')
  // Start without the fact: a run before this one may have saved it, so forget any copy through the API first.
  const mine = await api(page, 'GET', '/api/memory')
  expect(mine.status).toBe(200)
  for (const line of (mine.json.personal as { key: string; text: string; rev: number }[]).filter(l => l.text === MEMORY_PERSON)) {
    expect((await api(page, 'PUT', `/api/memory/personal/${line.key}/forgotten`, { forgotten: true, ifRev: line.rev })).status).toBe(200)
  }
  await page.reload()
  await ready(page)
  await settingsPage(page, 'Your settings', 'Memory')
  await expect(main(page)).not.toContainText(MEMORY_PERSON)
  await askFromToday(page, 'scenario:memory-save remember I like order tables sorted by date')
  await expect(log(page).getByText('Saved.', { exact: true })).toBeVisible({ timeout: 150_000 })
  await settingsPage(page, 'Your settings', 'Memory')
  await expect(main(page)).toContainText(MEMORY_PERSON)
  await shot(page, 'S7-your-memory-has-the-fact')
  // A team fact: saved, but waiting for an admin, so the Admin's Team memory doesn't list it.
  const admin = await pageFor(browser, 'admin', '#/today')
  await askFromToday(admin, 'scenario:memory-save-team remember we restock on Fridays')
  await expect(log(admin).getByText('Saved for the team.', { exact: true })).toBeVisible({ timeout: 150_000 })
  // The list is read after the save (a reload waits for the server's answer), so its absence is of a loaded list.
  const read = admin.waitForResponse(r => r.request().method() === 'GET' && new URL(r.url()).pathname === '/api/memory' && r.status() === 200)
  await admin.reload()
  await ready(admin)
  const loaded = await (await read).json() as { team: { lines: { text: string }[] }[] }
  expect(loaded.team.flatMap(g => g.lines.map(l => l.text))).not.toContain(MEMORY_TEAM)
  await settingsPage(admin, 'Team settings', 'Team memory')
  await expect(main(admin)).not.toContainText(MEMORY_TEAM)
  await shot(admin, 'S7-team-fact-waits-for-an-admin')
})

// ---------- S8: pause ----------

/** Pauses or resumes the brand as the Admin through the API: the seeded Watch stage shows the top bar's pill only while paused. */
const setPaused = async (admin: Page, paused: boolean) => expect((await api(admin, 'POST', paused ? '/api/pause' : '/api/resume', {})).status).toBe(200)

test('S8: Pause the agent; a new question is refused with a notice; resume', async ({ browser, context, page }) => {
  await openAs(context, page, 'admin', '#/today')
  const member = await pageFor(browser, 'dana', '#/today')
  try {
    await setPaused(page, true)
    await page.reload()
    await ready(page)
    const pill = page.getByRole('status', { name: 'Inhouse agent is paused' })
    await expect(pill).toBeVisible()
    await expect(pill).toContainText(phone() ? 'Paused' : 'Inhouse agent is paused')
    await shot(page, 'S8-the-agent-is-paused')
    await member.reload()
    await ready(member)
    await askFromToday(member, 'scenario:hello are you there?')
    await expect(member.getByText(PAUSED_NOTICE)).toBeVisible({ timeout: 60_000 })
    await shot(member, 'S8-a-question-is-refused')
    // Resume from the pill, as the Admin does.
    await pill.getByRole('button', { name: 'Resume', exact: true }).click()
    await expect(page.getByRole('status', { name: 'Inhouse agent is paused' })).toHaveCount(0)
    expect((await api(page, 'GET', '/api/pause')).json.paused).toBe(false)
  } finally {
    await setPaused(page, false)
  }
})

test('S8: A live answer stops when the agent is paused, and resuming starts nothing', async ({ browser, context, page }) => {
  needsContainer()
  test.setTimeout(240_000)
  await openAs(context, page, 'dana', '#/today')
  const admin = await pageFor(browser, 'admin', '#/today')
  try {
    await askFromToday(page, 'scenario:slow-bash pause me')
    await expect(log(page).getByText(WAITING, { exact: true })).toBeVisible({ timeout: 150_000 })
    await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeVisible()
    await setPaused(admin, true)
    // The answer is no longer running: its Stop button goes, and the rest of it never arrives.
    await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0, { timeout: 60_000 })
    await expect(page.getByText(PAUSED_NOTICE)).toBeVisible({ timeout: 60_000 })
    await shot(page, 'S8-live-answer-stopped-by-the-pause')
    await setPaused(admin, false)
    // Resuming starts nothing by itself: a fresh question gets its own answer, and the stopped one never finishes.
    await expect(log(page).getByText(DONE_WAITING, { exact: true })).toHaveCount(0)
    await ask(page, 'scenario:hello after the resume')
    await expect(log(page).getByText(HELLO, { exact: true })).toBeVisible({ timeout: 150_000 })
    await expect(log(page).getByText(HELLO, { exact: true })).toHaveCount(1)
    await expect(log(page).getByText(DONE_WAITING, { exact: true })).toHaveCount(0)
  } finally {
    await setPaused(admin, false)
  }
})

// ---------- S9: the cap ----------

test('S9: At the cap a new question gets the cap notice, and Usage shows the cap', async ({ browser, context, page }) => {
  await openAs(context, page, 'admin', '#/today')
  const read = async () => {
    const r = await api(page, 'GET', '/api/settings/brand')
    expect(r.status).toBe(200)
    return (r.json.items as { key: string; value: unknown; rev: number }[]).find(s => s.key === 's:cap')
  }
  const before = await read()
  const setCap = async (value: string | null) => {
    const current = await read()
    expect((await api(page, 'PUT', '/api/settings/brand/s:cap', { value, ifRev: current?.rev ?? 0 })).status).toBe(200)
  }
  try {
    await setCap('$0.01')
    const member = await pageFor(browser, 'dana', '#/today')
    await askFromToday(member, 'scenario:hello are we over the cap?')
    await expect(member.getByText(CAP_REFUSED).first()).toBeVisible({ timeout: 150_000 })
    await shot(member, 'S9-the-cap-notice')
    await goTo(member, 'Usage')
    await expect(h1(member)).toHaveText('Usage')
    await expect(main(member).getByRole('progressbar', { name: 'Spending cap used' })).toBeVisible()
    await expect(main(member)).toContainText('$0.01')
    // At the cap (the server reads it so once less than a start hold is left): Usage says so in the words of usageSummary.
    await expect(main(member)).toContainText(/Cap reached with \d+ days of the month left/)
    await expect(main(member)).toContainText('Cap reached today. Routines and jobs are paused until an admin raises it.')
    await shot(member, 'S9-usage-shows-the-cap')
  } finally {
    await setCap((before?.value as string | null | undefined) ?? null)
  }
})

// ---------- S10: a file (a container) ----------

test('S10: Attach a file to a question; the agent makes a spreadsheet from it; the file shows in the chat', async ({ context, page }) => {
  needsContainer()
  test.setTimeout(240_000)
  await openAs(context, page, 'dana', '#/today')
  await goTo(page, 'Today')
  await page.locator('[data-composer] input[type=file]').setInputFiles({ name: 'stock-list.csv', mimeType: 'text/csv', buffer: Buffer.from('sku,qty\nmug,12\n') })
  await expect(page.locator('[data-composer]').getByText('stock-list.csv').first()).toBeVisible()
  await ask(page, 'scenario:write-output make a spreadsheet from the attached list')
  // The question shows its attachment; the agent's two parts arrive (the one before its Bash call, then the answer).
  await expect(log(page).getByText('stock-list.csv').first()).toBeVisible({ timeout: 60_000 })
  await expect(log(page).getByText('Saved outputs/table.csv.', { exact: true })).toBeVisible({ timeout: 150_000 })
  // The file the agent made is in the chat's files (route 40), as an output named table.csv.
  const chat = new URL(page.url()).hash.replace(/^#\/chats\//, '')
  const files = await api(page, 'GET', `/api/chats/${chat}/files`)
  expect(files.status).toBe(200)
  expect(files.json.items).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'output', name: 'table.csv' }), expect.objectContaining({ kind: 'input', name: 'stock-list.csv' })]))
  await shot(page, 'S10-attached-and-made')
})

test('S10: The attached file and the file the agent made download from the chat', async ({ context, page }) => {
  needsContainer()
  test.setTimeout(240_000)
  await openAs(context, page, 'dana', '#/today')
  // The file goes up when the message is sent (route 39), so the chip's button names a file the server holds.
  await page.locator('[data-composer] input[type=file]').setInputFiles({ name: 'stock-list.csv', mimeType: 'text/csv', buffer: Buffer.from('sku,qty\nmug,12\n') })
  await expect(page.locator('[data-composer]').getByText('stock-list.csv').first()).toBeVisible()
  await askFromToday(page, 'scenario:write-output make the table')
  await expect(log(page).getByText('Saved outputs/table.csv.', { exact: true })).toBeVisible({ timeout: 150_000 })
  // Each button saves its own file, named as the chip is.
  const made = page.waitForEvent('download')
  await log(page).getByRole('button', { name: 'Download table.csv' }).click()
  const output = await made
  expect(output.suggestedFilename()).toBe('table.csv')
  expect(await readFile(await output.path(), 'utf8')).toBe('sku,qty\nA1,3\n')
  const attached = page.waitForEvent('download')
  await log(page).getByRole('button', { name: 'Download stock-list.csv' }).click()
  const input = await attached
  expect(input.suggestedFilename()).toBe('stock-list.csv')
  expect(await readFile(await input.path(), 'utf8')).toBe('sku,qty\nmug,12\n')
  await shot(page, 'S10-downloaded')
})
