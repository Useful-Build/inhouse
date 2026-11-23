// Ship spec for P6a (memory and skills; the plan's browser scenarios S1 to S8) and the brand skills (master plan, standing
// decision 6: S9 and S10), as real people on the TEST BUILD with the scripted model, at stage Watch. Desktop (1440x900) and
// phone (390x844). Each test is titled `S<n>: ...` (the card before its clip).
//
// What runs where. A chat turn runs in a container, which only the sandbox deployment has: each test that asks the agent
// something calls `needsContainer()` (E2E_TEST_BUILD_REMOTE) and skips elsewhere. S6 (the Skills page) and S8 (the Tools
// page's Request) run no turn.
//
// What the agent does is scripted (app/test/scripted-model/scenarios.ts), named in the message (`scenario:<name>`):
// `memory-save-learning`, `memory-save-team-ref`, `memory-recall-team-ref`, `memory-reword-team-ref` and `skill-save`. A team
// fact's words carry a reference the message names in brackets (`[fx0a1b2c3d]`, made fresh by each test), so the desktop and
// the phone run, which share one database, never meet each other's facts.
//
// Left as it was: every test that switches a setting (Learn from my chats, Ask before saving a team rule) puts it back, also
// when it fails, and the brand skill `e2e-weekly-report` is deleted by the test that makes it.
//
// Not covered here: the plan's S5 also wants a routine's team fact to wait while "Ask before saving a team rule" is off. At Watch
// a routine can't be made through the app (`routine_create` needs Act), so only a routine seeded in the local D1 could run
// one, and this spec runs on the deployed test build. That half is proved by the store's tests (server/mcp/tools/memory/toggles.test.ts) and
// the test says so in its annotations.
//
// Run (the ship workflow or the sandbox recording, with the test issuer key it holds):
//   E2E_TEST_BUILD_REMOTE=1 SHIP=1 BASE_URL=... TEST_BUILD_INHOUSE_URL=... TEST_ISSUER_PRIVATE_JWK_FILE=...
//   npx playwright test e2e/ship/memory-skills.spec.ts --project=ship-desktop --project=ship-phone
import type { APIRequestContext, Browser, BrowserContext, Page } from '@playwright/test'
import { needsContainer } from '../api/chat-kit.ts'
import { actor, call, putSetting } from '../api/kit.ts'
import type { Actor } from '../api/kit.ts'
import { originFor, people, signInAs } from '../support/clients/real.js'
import type { Who } from '../support/clients/real.js'
import { expect, test } from '../support/test-build/index.js'
import {
  BRAND_SKILL_SAVED_ANSWER, BRAND_SKILL_SAVE_INPUT, LEARNING_OFF_ANSWER, LEARNING_SAVED_ANSWER, MEMORY_RECALL_NONE, MEMORY_SAVE_TEXT,
  TEAM_FACT_CHANGED_ANSWER, TEAM_FACT_SAVED_ANSWER, memoryRecallAnswer, teamFactReworded, teamFactText,
} from '../../test/scripted-model/scenarios.ts'

const phone = () => test.info().project.name === 'ship-phone'

const main = (page: Page) => page.getByRole('main')
const h1 = (page: Page) => page.getByRole('heading', { level: 1 })
const log = (page: Page) => page.getByRole('log', { name: 'Conversation' })
const side = (page: Page) => page.getByRole('complementary', { name: 'Sidebar' })
const toast = (page: Page, text: string) => page.locator('[data-toast]').filter({ hasText: text })
const teamWindow = (page: Page) => page.getByRole('dialog', { name: 'Your Inhouse team' })
const uid = () => crypto.randomUUID().slice(0, 8)
/** A fresh reference for a team fact: what the scripted memory scenarios read from the message. */
const newRef = () => `fx${crypto.randomUUID().replaceAll('-', '').slice(0, 8)}`

// What the product says, copied (a spec reads no product string by import).
const APPROVED_TOAST = 'Approved. Your Inhouse agent will use this.'
const SKILL = BRAND_SKILL_SAVE_INPUT.name
/** The line the saved skill's body ends with, once its frontmatter is dropped. */
const SKILL_BODY_LINE = 'Read the wholesale orders.'

/** Waits for menus and windows to finish their finite animations, then attaches a screenshot named by the item. */
async function shot(page: Page, name: string) {
  // allSettled: a cancelled animation rejects `finished`, which is not a failure here. The words of an answer fade in on spans.
  await expect(page.locator('.animate-word-in')).toHaveCount(0)
  await page.evaluate(() => Promise.allSettled(document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished)))
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

/** Goes to a screen by its hash, as the sidebar's rows do (on a phone the drawer stays out of the way). */
async function goTo(page: Page, hash: string) {
  await page.evaluate(h => { location.hash = h }, hash)
  await expect(page).toHaveURL(new RegExp(`${hash.replace('/', '\\/')}$`))
}

/** The sidebar (on a phone the drawer behind Menu, opened first). */
async function sidebar(page: Page) {
  if (phone() && !(await side(page).isVisible())) await page.getByRole('button', { name: 'Menu' }).click()
  await expect(side(page)).toBeVisible()
  return side(page)
}

/** An item of the account menu (the sidebar's account button opens it). */
async function accountItem(page: Page, name: string | RegExp) {
  const menu = page.getByRole('menu', { name: 'Account' })
  await (await sidebar(page)).getByRole('button', { name: /, account and settings$/ }).click()
  await expect(menu).toBeVisible()
  await menu.getByRole('menuitem', typeof name === 'string' ? { name, exact: true } : { name }).click()
}

/** The account menu, then a Settings page by its group and label. */
async function settingsPage(page: Page, group: 'Your settings' | 'Team settings', label: string) {
  await accountItem(page, group)
  await page.getByRole('navigation', { name: 'Settings' }).getByRole('button', { name: label, exact: true }).click()
  await expect(h1(page)).toHaveText(label)
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

/** A person starts a chat from Today with a message, on the Fast model, and waits for the answer `says` (the scripted turn's words). */
async function askFromToday(page: Page, text: string, says: string) {
  await goTo(page, '#/today')
  await expect(page.getByRole('textbox', { name: 'Ask Inhouse' })).toBeVisible()
  await page.locator('[data-composer] textarea').fill(text)
  await pickFast(page)
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(page).toHaveURL(/#\/chats\/(?!new$|all$)[^/]+$/, { timeout: 60_000 })
  await expect(log(page).getByText(says, { exact: true })).toBeVisible({ timeout: 150_000 })
}

/** On a phone the drawer stays open over the chat after a navigation: close it, so a screenshot shows the chat. */
async function closeDrawer(page: Page) {
  if (phone() && await side(page).isVisible()) {
    await page.keyboard.press('Escape')
    await expect(side(page)).toBeHidden()
  }
}

/** A person's agent saves a team fact with this reference (waiting for an admin, unless the team turned Ask off). */
const saveTeamFact = (page: Page, ref: string) =>
  askFromToday(page, `scenario:memory-save-team-ref remember we restock on Fridays [${ref}]`, TEAM_FACT_SAVED_ANSWER)

/** A new chat whose agent searches for the team fact with this reference and says it, or that nothing matched. */
const recall = (page: Page, ref: string, says: string, scenario = 'memory-recall-team-ref') =>
  askFromToday(page, `scenario:${scenario} when do we restock? [${ref}]`, says)

/** The settings the tests switch, as the API holds them: the person (the actor) writes their own; "Ask before saving a team rule" is the Admin's. */
const danaActor = actor('memberA')
const adminActor = actor('admin')
async function setSwitch(request: APIRequestContext, who: Actor, scope: 'personal' | 'brand', key: string, value: boolean) {
  const r = await putSetting(request, who, scope, key, value)
  expect(r.status, r.text).toBe(200)
}
async function switchValue(request: APIRequestContext, who: Actor, scope: 'personal' | 'brand', key: string) {
  const r = await call(request, who, 'GET', `/api/settings/${scope}`)
  expect(r.status, r.text).toBe(200)
  return (r.json.items as { key: string; value?: unknown }[]).find(i => i.key === key)?.value
}

/** The team's waiting facts as the admin's page reads them (route 77). */
async function waiting(admin: Page): Promise<{ key: string; text: string; rev: number }[]> {
  const r = await api(admin, 'GET', '/api/memory/waiting')
  expect(r.status).toBe(200)
  return r.json.facts
}

const row = (page: Page, title: string | RegExp) => main(page).locator('div.py-4').filter({ hasText: title })
/** A Settings switch by its name. */
const switchOf = (page: Page, name: string) => main(page).getByRole('switch', { name, exact: true })

// ---------- S1: Learn from my chats ----------

test('S1: Learn from my chats works at Watch: off, a preference isn\'t saved and the chat says why; on again, it is saved and shows in Memory', async ({ context, page, request }) => {
  needsContainer()
  test.setTimeout(420_000)
  // Start clean: the switch on, and no copy of the fact (an earlier run, or the P3 spec, may have saved it).
  await setSwitch(request, danaActor, 'personal', 'm:learn', true)
  await openAs(context, page, 'dana', '#/today')
  const mine = await api(page, 'GET', '/api/memory')
  expect(mine.status).toBe(200)
  for (const line of (mine.json.personal as { key: string; text: string; rev: number }[]).filter(l => l.text === MEMORY_SAVE_TEXT)) {
    expect((await api(page, 'PUT', `/api/memory/personal/${line.key}/forgotten`, { forgotten: true, ifRev: line.rev })).status).toBe(200)
  }
  try {
    await page.reload()
    await ready(page)
    await settingsPage(page, 'Your settings', 'Memory')
    const learn = switchOf(page, 'Learn from my chats')
    // Usable at Watch: it isn't greyed and its row carries no stage tag.
    await expect(learn).toBeEnabled()
    await expect(learn).toBeChecked()
    await expect(row(page, 'Learn from my chats')).not.toContainText(/\b(Act|Run)\b/)
    await shot(page, 'S1-learn-on-at-watch')
    const saved = page.waitForResponse(r => r.request().method() === 'PUT' && decodeURIComponent(r.url()).endsWith('/api/settings/personal/m:learn') && r.status() === 200)
    await learn.click()
    await saved
    await expect(learn).not.toBeChecked()
    // Off: the agent tries to save the preference, the tool refuses, and the chat says why.
    await askFromToday(page, `scenario:memory-save-learning please remember I like order tables sorted by date ${uid()}`, LEARNING_OFF_ANSWER)
    await closeDrawer(page)
    await shot(page, 'S1-not-saved-and-why')
    await page.reload()
    await ready(page)
    await settingsPage(page, 'Your settings', 'Memory')
    await expect(main(page)).not.toContainText(MEMORY_SAVE_TEXT)
    // Back on: the same ask saves it, and it shows on the Memory page.
    const savedOn = page.waitForResponse(r => r.request().method() === 'PUT' && decodeURIComponent(r.url()).endsWith('/api/settings/personal/m:learn') && r.status() === 200)
    await switchOf(page, 'Learn from my chats').click()
    await savedOn
    await expect(switchOf(page, 'Learn from my chats')).toBeChecked()
    await askFromToday(page, `scenario:memory-save-learning please remember I like order tables sorted by date ${uid()}`, LEARNING_SAVED_ANSWER)
    await page.reload()
    await ready(page)
    await settingsPage(page, 'Your settings', 'Memory')
    await expect(main(page)).toContainText(MEMORY_SAVE_TEXT)
    await shot(page, 'S1-saved-in-memory')
  } finally {
    // Put it back as it was found: on, and the fact forgotten.
    await setSwitch(request, danaActor, 'personal', 'm:learn', true)
    const after = await api(page, 'GET', '/api/memory')
    for (const line of ((after.json?.personal ?? []) as { key: string; text: string; rev: number }[]).filter(l => l.text === MEMORY_SAVE_TEXT)) {
      await api(page, 'PUT', `/api/memory/personal/${line.key}/forgotten`, { forgotten: true, ifRev: line.rev })
    }
  }
})

// ---------- S2 to S5: team memory and its approval ----------

test('S2: The agent saves a team fact; a Member doesn\'t see it, an Admin approves it, and a new chat\'s agent finds it', async ({ browser, context, page, request }) => {
  needsContainer()
  test.setTimeout(420_000)
  const ref = newRef()
  const fact = teamFactText(ref)
  await setSwitch(request, adminActor, 'brand', 'm:ask', true)
  const admin = await pageFor(browser, 'admin', '#/today')
  await openAs(context, page, 'dana', '#/today')
  await saveTeamFact(page, ref)
  // The Member's Team memory is read after the save (a reload waits for the server), so the fact's absence is of a loaded list.
  await page.reload()
  await ready(page)
  await settingsPage(page, 'Team settings', 'Team memory')
  await expect(main(page)).not.toContainText(fact)
  await expect(main(page).getByRole('button', { name: /^Approve: / })).toHaveCount(0)
  await shot(page, 'S2-member-sees-no-team-fact')
  // The Admin sees it waiting, with Approve and Reject.
  await settingsPage(admin, 'Team settings', 'Team memory')
  await expect(admin.getByRole('heading', { name: 'Waiting for your OK' })).toBeVisible()
  await expect(row(admin, fact)).toBeVisible()
  await expect(admin.getByRole('button', { name: `Reject: ${fact}`, exact: true })).toBeVisible()
  await shot(admin, 'S2-admin-sees-it-waiting')
  await admin.getByRole('button', { name: `Approve: ${fact}`, exact: true }).click()
  await expect(toast(admin, APPROVED_TOAST)).toBeVisible()
  await expect(row(admin, fact).getByRole('button', { name: `Approve: ${fact}` })).toHaveCount(0)
  await shot(admin, 'S2-admin-approved')
  // A new chat's agent finds it now.
  await recall(page, ref, memoryRecallAnswer(fact))
  await closeDrawer(page)
  await shot(page, 'S2-a-new-chat-finds-it')
})

test('S3: An Admin rejects a waiting fact and it is gone; the audit log shows the approve and the reject by name', async ({ browser, context, page, request }) => {
  needsContainer()
  test.setTimeout(480_000)
  const approvedRef = newRef()
  const rejectedRef = newRef()
  const approvedFact = teamFactText(approvedRef)
  const rejectedFact = teamFactText(rejectedRef)
  await setSwitch(request, adminActor, 'brand', 'm:ask', true)
  const admin = await pageFor(browser, 'admin', '#/today')
  await openAs(context, page, 'dana', '#/today')
  await saveTeamFact(page, approvedRef)
  await saveTeamFact(page, rejectedRef)
  await settingsPage(admin, 'Team settings', 'Team memory')
  await expect(row(admin, approvedFact)).toBeVisible()
  await expect(row(admin, rejectedFact)).toBeVisible()
  await admin.getByRole('button', { name: `Approve: ${approvedFact}`, exact: true }).click()
  await expect(toast(admin, APPROVED_TOAST)).toBeVisible()
  // Reject asks first.
  await admin.getByRole('button', { name: `Reject: ${rejectedFact}`, exact: true }).click()
  const ask = admin.getByRole('dialog', { name: 'Reject this rule?' })
  await expect(ask).toBeVisible()
  await shot(admin, 'S3-reject-asks-first')
  await ask.getByRole('button', { name: 'Reject', exact: true }).click()
  await expect(toast(admin, "Rejected. Your Inhouse agent won't use this.")).toBeVisible()
  await expect(row(admin, rejectedFact)).toHaveCount(0)
  expect((await waiting(admin)).map(f => f.text)).not.toContain(rejectedFact)
  // And not among the team's rules after a reload either.
  await admin.reload()
  await ready(admin)
  await settingsPage(admin, 'Team settings', 'Team memory')
  await expect(main(admin)).not.toContainText(rejectedFact)
  await shot(admin, 'S3-rejected-is-gone')
  // The audit log (read when the app loads, which the reload did) names the Admin on both decisions, newest first.
  await settingsPage(admin, 'Team settings', 'Audit log')
  await expect(row(admin, 'rejected a team memory').first()).toContainText(`${people.admin.name} rejected a team memory`)
  await expect(row(admin, 'approved a team memory').first()).toContainText(`${people.admin.name} approved a team memory`)
  await shot(admin, 'S3-audit-log')
})

test('S4: The agent rewords an approved team fact and it waits again; an approve from the old page is refused with the new wording shown, and approving that works', async ({ browser, context, page, request }) => {
  needsContainer()
  test.setTimeout(480_000)
  const ref = newRef()
  const old = teamFactText(ref)
  const reworded = teamFactReworded(ref)
  await setSwitch(request, adminActor, 'brand', 'm:ask', true)
  const admin = await pageFor(browser, 'admin', '#/today')
  await openAs(context, page, 'dana', '#/today')
  await saveTeamFact(page, ref)
  // The Admin's page, open on the fact as it is now: this is the "old page".
  await settingsPage(admin, 'Team settings', 'Team memory')
  await expect(admin.getByRole('button', { name: `Approve: ${old}`, exact: true })).toBeVisible()
  // Meanwhile it is approved (a second tab, here the API), and the agent rewords it: it is waiting again at a new revision.
  const [first] = (await waiting(admin)).filter(f => f.text === old)
  expect(first, 'the saved fact is waiting').toBeDefined()
  expect((await api(admin, 'PUT', `/api/memory/brand/${first!.key}/approved`, { approved: true, ifRev: first!.rev })).status).toBe(200)
  await askFromToday(page, `scenario:memory-reword-team-ref please change the restock rule [${ref}]`, TEAM_FACT_CHANGED_ANSWER)
  await expect.poll(async () => (await waiting(admin)).map(f => f.text), { message: 'the reworded fact waits again' }).toContain(reworded)
  // The old page's Approve is refused, and says what the fact is now.
  await admin.getByRole('button', { name: `Approve: ${old}`, exact: true }).click()
  await expect(toast(admin, `Someone changed this. It's now "${reworded}".`)).toBeVisible()
  await expect(admin.getByRole('button', { name: `Approve: ${reworded}`, exact: true })).toBeVisible()
  await expect(admin.getByRole('button', { name: `Approve: ${old}`, exact: true })).toHaveCount(0)
  // Still waiting: the refused approve changed nothing, so the agent doesn't find it yet.
  await recall(page, ref, MEMORY_RECALL_NONE, 'memory-recall-team-ref-reworded')
  await shot(admin, 'S4-refused-with-the-new-wording')
  // Approving the new wording works, and then the agent finds it.
  await admin.getByRole('button', { name: `Approve: ${reworded}`, exact: true }).click()
  await expect(toast(admin, APPROVED_TOAST)).toBeVisible()
  await recall(page, ref, memoryRecallAnswer(reworded), 'memory-recall-team-ref-reworded')
  await closeDrawer(page)
  await shot(page, 'S4-the-new-wording-is-found')
})

test('S5: An Admin turns "Ask before saving a team rule" off and the agent\'s next team fact counts at once', async ({ browser, context, page, request }) => {
  needsContainer()
  test.setTimeout(420_000)
  // What this does not show: a routine's team fact still waiting (see the top of this file).
  test.info().annotations.push({ type: 'not-run', description: 'a routine\'s team fact still waits: a routine can\'t be made at Watch through the app; proved by server/mcp/tools/memory/toggles.test.ts' })
  const ref = newRef()
  const fact = teamFactText(ref)
  await setSwitch(request, adminActor, 'brand', 'm:ask', true)
  const admin = await pageFor(browser, 'admin', '#/today')
  try {
    await settingsPage(admin, 'Team settings', 'Team memory')
    const ask = switchOf(admin, 'Ask before saving a team rule')
    await expect(ask).toBeEnabled()
    await expect(ask).toBeChecked()
    await expect(row(admin, 'Ask before saving a team rule')).not.toContainText(/\b(Act|Run)\b/)
    const saved = admin.waitForResponse(r => r.request().method() === 'PUT' && decodeURIComponent(r.url()).endsWith('/api/settings/brand/m:ask') && r.status() === 200)
    await ask.click()
    await saved
    await expect(ask).not.toBeChecked()
    expect(await switchValue(request, adminActor, 'brand', 'm:ask')).toBe(false)
    await shot(admin, 'S5-ask-off')
    // The agent's next team fact is active at once: nothing waits, and a new chat finds it with no approval.
    await openAs(context, page, 'dana', '#/today')
    await saveTeamFact(page, ref)
    expect((await waiting(admin)).map(f => f.text)).not.toContain(fact)
    await recall(page, ref, memoryRecallAnswer(fact))
    await closeDrawer(page)
    await shot(page, 'S5-found-without-approval')
    await admin.reload()
    await ready(admin)
    await settingsPage(admin, 'Team settings', 'Team memory')
    await expect(admin.getByRole('button', { name: `Approve: ${fact}` })).toHaveCount(0)
    await expect(main(admin)).toContainText(fact)
  } finally {
    await setSwitch(request, adminActor, 'brand', 'm:ask', true)
  }
})

// ---------- S6: the skills the agent has ----------

test('S6: The Skills page lists dataviz, PDF, Word and Spreadsheet, none with a stage tag', async ({ context, page }) => {
  await openAs(context, page, 'dana', '#/skills')
  await expect(h1(page)).toHaveText('Skills')
  // The product lists ours by the skill's own name (`GET /api/skills`).
  for (const name of ['dataviz', 'pdf', 'word', 'spreadsheet']) {
    const open = page.getByRole('button', { name, exact: true })
    await expect(open, `${name} is listed`).toBeVisible()
    // The deepest row element holding the name's button is the name line: a locked skill has its stage tag there.
    await expect(main(page).locator('div').filter({ has: open }).last()).toHaveText(name)
  }
  await expect(main(page)).not.toContainText(/\b(Watch|Act|Run)\b/)
  await shot(page, 'S6-ours-no-stage-tag')
})

// ---------- S7 and S8: requests to the Inhouse team ----------

test('S7: Request a skill from the Skills page; it shows in the team window, and once the Inhouse team marks it done the requester sees it closed', async ({ context, page, request }) => {
  await openAs(context, page, 'dana', '#/skills')
  const title = `Skill for wholesale invoices ${uid()}`
  await main(page).getByRole('button', { name: 'Request a skill', exact: true }).click()
  await expect(teamWindow(page)).toBeVisible()
  // It opens on a job.
  await expect(teamWindow(page).getByRole('radio', { name: /New job/ })).toBeChecked()
  await teamWindow(page).getByRole('textbox', { name: 'Title' }).fill(title)
  await teamWindow(page).getByRole('textbox', { name: 'Details' }).fill('Turn a wholesale order into an invoice PDF with our terms.')
  await shot(page, 'S7-the-request')
  await teamWindow(page).getByRole('button', { name: 'Send to the team' }).click()
  await expect(toast(page, 'Request sent to your Inhouse team.')).toBeVisible()
  await expect(teamWindow(page)).toHaveCount(0)
  // It shows in the window's list of your requests, open.
  await accountItem(page, /^Your Inhouse team/)
  await teamWindow(page).getByRole('radio', { name: /^Your requests/ }).click()
  const openList = teamWindow(page).getByRole('list', { name: 'Open requests' })
  await expect(openList.getByRole('listitem').filter({ hasText: title })).toContainText('With the team')
  await shot(page, 'S7-open-in-the-team-window')
  await page.keyboard.press('Escape')
  await expect(teamWindow(page)).toHaveCount(0)
  // The Inhouse team marks it done (route 82, its own app).
  const found = await api(page, 'GET', '/api/team-requests?status=open')
  expect(found.status).toBe(200)
  const mine = (found.json.items as { id: string; text: string; rev: number; mine: boolean }[]).find(r => r.mine && r.text.startsWith(title))
  expect(mine, 'the request is open for its requester').toBeDefined()
  const done = await call(request, actor('inhouse'), 'PUT', `/api/team-requests/${mine!.id}/status`, { json: { status: 'done', ifRev: mine!.rev } })
  expect(done.status, done.text).toBe(200)
  // The requester's window reads the open requests again each time it opens: it is no longer among them, and the server calls it done.
  await accountItem(page, /^Your Inhouse team/)
  await teamWindow(page).getByRole('radio', { name: /^Your requests/ }).click()
  await expect(teamWindow(page).getByRole('list', { name: 'Open requests' }).getByRole('listitem').filter({ hasText: title })).toHaveCount(0)
  const closed = await api(page, 'GET', '/api/team-requests?status=done')
  expect((closed.json.items as { text: string; status: string }[]).find(r => r.text.startsWith(title))?.status).toBe('done')
  await shot(page, 'S7-done-and-no-longer-open')
})

test('S8: Request on a catalogue tool says "Request sent" and stays requested after a reload; Undo withdraws it', async ({ context, page }) => {
  await openAs(context, page, 'dana', '#/tools')
  const requested = main(page).getByRole('button', { name: 'Requested', exact: true })
  const requestable = main(page).getByRole('button', { name: 'Request', exact: true })
  await expect(requestable.first(), 'the Tools page offers a catalogue tool to request').toBeVisible()
  const before = await requested.count()
  try {
    // Request, then Undo: it is withdrawn.
    await requestable.first().click()
    const sent = toast(page, 'Request sent')
    await expect(sent).toBeVisible()
    await expect(requested).toHaveCount(before + 1)
    await shot(page, 'S8-request-sent')
    await sent.getByRole('button', { name: 'Undo', exact: true }).click()
    await expect(requested).toHaveCount(before)
    await page.reload()
    await ready(page)
    await expect(requested).toHaveCount(before)
    // Request again: it stays requested after a reload.
    await expect(requestable.first()).toBeVisible()
    await requestable.first().click()
    await expect(toast(page, 'Request sent')).toBeVisible()
    await expect(requested).toHaveCount(before + 1)
    await page.reload()
    await ready(page)
    await expect(requested).toHaveCount(before + 1)
    await shot(page, 'S8-still-requested-after-a-reload')
  } finally {
    // Leave no open tool request of this person's behind (the team caps open requests at 50 a brand).
    const open = await api(page, 'GET', '/api/team-requests?status=open')
    for (const r of ((open.json?.items ?? []) as { id: string; kind: string; mine: boolean; rev: number }[]).filter(x => x.mine && x.kind === 'tool')) {
      await api(page, 'PUT', `/api/team-requests/${r.id}/withdrawn`, { ifRev: r.rev })
    }
  }
})

// ---------- S9 and S10: brand skills ----------

/** Deletes the spec's skill if it is there (an Admin may delete any), so a test starts without it. */
async function clearSkill(admin: Page) {
  const list = await api(admin, 'GET', '/api/skills')
  expect(list.status).toBe(200)
  for (const s of (list.json as { n: string; id?: string; rev?: number }[]).filter(x => x.n === SKILL && x.id !== undefined)) {
    expect((await api(admin, 'POST', `/api/skills/brand/${s.id}/delete`, { ifRev: s.rev })).status).toBe(200)
  }
}

/** A person asks the agent to save the spec's skill in a chat. */
const saveSkill = (page: Page) => askFromToday(page, `scenario:skill-save please save the weekly report skill ${uid()}`, BRAND_SKILL_SAVED_ANSWER)

/** The skill's row on the Skills page, by its name (the deepest element holding both the name button and who made it). */
const skillRow = (page: Page) => main(page).locator('div').filter({ has: page.getByRole('button', { name: SKILL, exact: true }), hasText: 'Made by' }).last()

test('S9: A Member asks the agent for a skill and it saves it; the Skills page lists it "Made by" them and its page shows the text', async ({ browser, context, page }) => {
  needsContainer()
  test.setTimeout(420_000)
  const admin = await pageFor(browser, 'admin', '#/today')
  await clearSkill(admin)
  try {
    await openAs(context, page, 'dana', '#/today')
    await saveSkill(page)
    await closeDrawer(page)
    await shot(page, 'S9-the-agent-saved-it')
    await goTo(page, '#/skills')
    await expect(main(page).getByRole('button', { name: SKILL, exact: true })).toBeVisible()
    await expect(skillRow(page)).toContainText(`Made by ${people.dana.name}`)
    await shot(page, 'S9-listed-made-by-the-member')
    await main(page).getByRole('button', { name: SKILL, exact: true }).click()
    await expect(page).toHaveURL(/#\/skills\/[^/]+$/)
    await expect(h1(page)).toHaveText(SKILL)
    // Its page shows the instructions as clean text (the frontmatter the agent sent is dropped) and who made it.
    await expect(page.getByRole('article')).toContainText(SKILL_BODY_LINE)
    await expect(page.getByRole('article')).not.toContainText('allowed-tools')
    await expect(page.getByRole('complementary', { name: 'About this skill' })).toContainText(new RegExp(`Made by\\s*${people.dana.name}`))
    await shot(page, 'S9-its-page')
  } finally {
    await clearSkill(admin)
  }
})

test('S10: The maker deletes a skill and it is gone; another Member can\'t delete someone else\'s, but an Admin can', async ({ browser, context, page }) => {
  needsContainer()
  test.setTimeout(480_000)
  const admin = await pageFor(browser, 'admin', '#/today')
  await clearSkill(admin)
  try {
    await openAs(context, page, 'dana', '#/today')
    await saveSkill(page)
    const leo = await pageFor(browser, 'leo', '#/skills')
    await main(leo).getByRole('button', { name: SKILL, exact: true }).click()
    await expect(h1(leo)).toHaveText(SKILL)
    // Another Member sees no way to change it, and the server refuses the delete as well.
    await expect(leo.getByRole('button', { name: `More for ${SKILL}` })).toHaveCount(0)
    await expect(leo.getByRole('button', { name: 'Edit in a chat' })).toHaveCount(0)
    const theirs = (await api(page, 'GET', '/api/skills')).json as { n: string; id: string; rev: number }[]
    const made = theirs.find(s => s.n === SKILL)
    expect(made?.id, 'the maker can see the skill\'s id').toBeDefined()
    expect((await api(leo, 'POST', `/api/skills/brand/${made!.id}/delete`, { ifRev: made!.rev })).status).toBe(403)
    await shot(leo, 'S10-another-member-cannot-delete')
    // The maker deletes it from its page, after a confirmation, and it is gone.
    await goTo(page, '#/skills')
    await main(page).getByRole('button', { name: SKILL, exact: true }).click()
    await expect(h1(page)).toHaveText(SKILL)
    await page.getByRole('button', { name: `More for ${SKILL}` }).click()
    await page.getByRole('menuitem', { name: 'Delete skill' }).click()
    const ask = page.getByRole('dialog', { name: 'Delete skill' })
    await expect(ask).toBeVisible()
    await ask.getByRole('button', { name: 'Delete skill', exact: true }).click()
    await expect(page).toHaveURL(/#\/skills$/)
    await expect(main(page).getByRole('button', { name: SKILL, exact: true })).toHaveCount(0)
    expect((await api(page, 'GET', `/api/skills/${SKILL}`)).status).toBe(404)
    await shot(page, 'S10-the-maker-deleted-it')
    // An Admin can delete a Member's skill.
    await closeDrawer(page)
    await saveSkill(page)
    await goTo(admin, '#/skills')
    await admin.reload()
    await ready(admin)
    await main(admin).getByRole('button', { name: SKILL, exact: true }).click()
    await expect(h1(admin)).toHaveText(SKILL)
    await admin.getByRole('button', { name: `More for ${SKILL}` }).click()
    await admin.getByRole('menuitem', { name: 'Delete skill' }).click()
    await admin.getByRole('dialog', { name: 'Delete skill' }).getByRole('button', { name: 'Delete skill', exact: true }).click()
    await expect(admin).toHaveURL(/#\/skills$/)
    await expect(main(admin).getByRole('button', { name: SKILL, exact: true })).toHaveCount(0)
    expect((await api(page, 'GET', `/api/skills/${SKILL}`)).status).toBe(404)
    await shot(admin, 'S10-an-admin-deleted-it')
  } finally {
    await clearSkill(admin)
  }
})
