// Ship spec for P5 Connectors (the plan's browser scenarios S1 to S7, docs/plans/2026-11-19-p5-connectors.md): connecting Slack, a
// question that needs Slack and Shopify, a question over the whole store answered by a code mode script, an alert at Act and at
// Watch, pausing, disconnecting, and the Admin's read-only Tools page, as real people on the TEST BUILD with the hub, the fake
// Slack and the recorded Shopify. Desktop (1440x900) and phone (390x844). Each test is titled `S<n>: ...` (the card before its clip).
//
// What runs where. S2, S3 and S4 run turns in a container, which only the sandbox deployment has: they call `needsContainer()`
// (E2E_TEST_BUILD_REMOTE) and skip elsewhere. A turn plays the scripted model's scenario named in its message
// (`scenario:connectors-supplier`, `-codemode`, `-notice`, `-notice-unlisted`; test/scripted-model/scenarios.ts), so every answer
// is fixed and each test proves the PATH: the run's own record shows the named tool calls (the owner's trace: each tool step's detail
// is the tool's name) and, for alerts, the audit lines; and the answer the person reads is on screen. The fakes' own logs are NOT read
// here: "no link preview" and "only the app link" in a Slack post (four parameters, `unfurl_links` and `unfurl_media` false) are proved by
// e2e/api/notify-slack.spec.ts, not by this recording; S4 proves that the right alert reached Slack, the bell or nothing, and said so.
// The hook (`POST /api/ops/test-fakes`, release token) is used for what the product itself decides: the hub's tool list, the prompt.
//
// What the scripted model cannot prove, and who does. S5 and S6 say "the agent no longer uses it" and "asking again says it's not
// connected": a scripted answer would only repeat our own text, so these tests prove the agent's side from what decides it, the
// hub's tool list, the refusal of a call, and the system prompt's apps line (which the model reads); the model's own wording is
// the orchestrator's real-model live check and the release smoke.
//
// Sign-in at Slack. The recording never drives a live third-party login: the browser's navigation to Slack's authorize address
// is answered by the test (a redirect to the callback with a code minted for the pre-consented test user, `mintTestCode`).
//
// Run (the ship workflow or the sandbox recording, with the test issuer key it holds):
//   E2E_TEST_BUILD_REMOTE=1 SHIP=1 BASE_URL=... TEST_BUILD_INHOUSE_URL=... TEST_ISSUER_PRIVATE_JWK_FILE=...
//   npx playwright test e2e/ship/connectors.spec.ts --project=ship-desktop --project=ship-phone
import type { APIRequestContext, Page } from '@playwright/test'
import { mintTestCode } from '../../test/upstreams/mcp/server.ts'
import { needsContainer } from '../api/chat-kit.ts'
import {
  CHANNEL, connectSlack, ensureDisconnected, fakeReset, hubCall, hubToolNames, readTools, setListedChannels, setStage, SLACK_ACCOUNT, turnPrompt,
} from '../api/fakes-kit.ts'
import { actor, call, endLiveGrants, expectError, putSetting } from '../api/kit.ts'
import { originFor, signInAs } from '../support/clients/real.js'
import type { Who } from '../support/clients/real.js'
import { expect, test } from '../support/test-build/index.js'

const phone = () => test.info().project.name === 'ship-phone'

const main = (page: Page) => page.getByRole('main')
const log = (page: Page) => page.getByRole('log', { name: 'Conversation' })
const uid = () => crypto.randomUUID().slice(0, 8)

// What the product and the scripted model say, copied (a spec reads no product string by import).
const SUPPLIER_ANSWER = 'Kestrel Mills says the November restock of the Fern mug ships 2 weeks late. Sources: Slack #suppliers, Shopify orders.'
const CODE_MODE_ANSWER = 'I counted every product in the store with a script: the five lowest on stock and how many sell for over $150. Source: Shopify, all products.'
const NOTICE_ANSWER = 'I sent the stock alert to #ops-alerts.'
const WATCH_ANSWER = 'I sent the stock alert to your bell. It reaches Slack from the Act stage.'
const UNLISTED_ANSWER = "I couldn't send that: #design isn't one of the channels your admin listed."
const NOTIFY_TOOL = 'mcp__inhouse__notification_send'
const NOTICE_TEXT = 'The Fern mug is almost out. Restock it this week.'
const CONNECTED_TOAST = 'The tool is connected.'
const ADMIN_LINE = 'Your Inhouse team manages tools.'

/** Waits for menus and windows to finish their finite animations, then attaches a screenshot named by the item. */
async function shot(page: Page, name: string) {
  // allSettled: a cancelled animation rejects `finished`, which is not a failure here.
  await page.evaluate(() => Promise.allSettled(document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished)))
  await test.info().attach(name, { body: await page.screenshot(), contentType: 'image/png' })
}

/** Attaches a JSON value to the test report under a name. */
const attachJson = (name: string, value: unknown) => test.info().attach(name, { body: JSON.stringify(value, null, 2), contentType: 'application/json' })

async function ready(page: Page) {
  if (phone()) await expect(page.getByRole('button', { name: 'Menu' })).toBeVisible()
  else await expect(page.getByRole('button', { name: /, account and settings$/ })).toBeVisible()
}

async function openAs(context: Parameters<typeof signInAs>[0], page: Page, who: Who, hash = '') {
  await signInAs(context, who)
  await page.goto(`${originFor(who)}/${hash}`)
  await ready(page)
}

/** A request from inside the page: same origin, so it carries the page's sign-in and Origin. */
async function api(page: Page, method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  return page.evaluate(async ([m, p, b]) => {
    const res = await fetch(p as string, { method: m as string, ...(b === null ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }) })
    return { status: res.status, json: await res.json().catch(() => null) }
  }, [method, path, body ?? null] as const)
}

/** A read that feeds an assertion: it must answer 200 with a JSON body, so a failed read can't pass as an empty one. */
async function apiOk(page: Page, path: string): Promise<any> {
  const r = await api(page, 'GET', path)
  expect(r.status, `GET ${path} answered ${r.status}`).toBe(200)
  expect(r.json, `GET ${path} answered a JSON body`).not.toBeNull()
  return r.json
}

/** Goes to a screen by its hash, as the sidebar's rows do (on a phone the drawer stays out of the way). */
async function goTo(page: Page, hash: string) {
  await page.evaluate(h => { location.hash = h }, hash)
  await expect(page).toHaveURL(new RegExp(`${hash.replace('/', '\\/')}$`))
}

/** A toast with this text in the toast stack. A same-key toast replaces the one on screen, so a count of 1 can't tell one showing from two; tools-return.spec.ts counts each showing. */
const toast = (page: Page, text: string) => page.locator('[data-toast-stack] [data-toast]').filter({ hasText: text })

/** Slack connected, by the routes a person's connect uses (no browser): a test that needs it starts here, and S1 starts from none. */
async function ensureConnected(request: APIRequestContext) {
  if ((await readTools(request)).connected.includes('slack')) return
  const c = await connectSlack(request)
  expect(c.location, 'Slack connected for the test').toBe('/tools/slack?connected=1')
}

/**
 * Shopify usable the way a brand's is: its account is active once the hub has read the store (it has no sign-in of its own), so a
 * hub read through the hook makes it so, and the Tools read must then list it as connected (recording 5 cited Shopify while the page
 * said it wasn't connected).
 */
async function ensureShopifyConnected(request: APIRequestContext) {
  const read = await hubCall(request, 'callTool', 'orders_search', { first: 1 })
  expect(read.ok, `the store answers a read: ${JSON.stringify(read.error ?? null)}`).toBe(true)
  expect((await readTools(request)).connected, 'Shopify shows as connected').toContain('shopify')
}

/** The apps a prompt's "Connected apps:" line names (empty: no such line). */
function namedApps(prompt: string): string[] {
  const m = /Connected apps: (.+?)\. Search for their tools/.exec(prompt)
  return m ? m[1]!.split(/, | and /) : []
}

/**
 * The brand's Default model must be Fast (Sonnet) before any run: the scripted model answers only claude-sonnet-5-5, and an Opus
 * request is a 400 miss. Technical settings are written by the Inhouse team, under a live grant the Admin gives: the Admin grants,
 * the Inhouse team writes g:mode at its current rev, the grant ends (also when a step fails), and the setting is read back as a
 * Member. Left as is, by design: g:mode stays Fast on the sandbox brand. `endLiveGrants` ends every live grant on the brand.
 */
let defaultModelFast = false
async function ensureFastDefault(request: APIRequestContext) {
  if (defaultModelFast) return
  const read = async () => {
    const r = await call(request, actor('memberA'), 'GET', '/api/settings/technical')
    expect(r.status, r.text).toBe(200)
    return (r.json.items as { key: string; value?: unknown }[]).find(i => i.key === 'g:mode')?.value
  }
  if ((await read()) !== 'Fast') {
    await endLiveGrants(request)
    try {
      const grant = await call(request, actor('admin'), 'POST', '/api/grants', { json: { hours: 1 } })
      expect(grant.status, grant.text).toBe(201)
      const put = await putSetting(request, actor('inhouse'), 'technical', 'g:mode', 'Fast')
      expect(put.status, `setting the default model to Fast: ${put.text}`).toBe(200)
    } finally {
      await endLiveGrants(request)
    }
  }
  expect(await read(), 'the default model reads back as Fast').toBe('Fast')
  defaultModelFast = true
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
  await expect(page.getByRole('textbox', { name: 'Ask Inhouse' })).toBeVisible()
  await page.locator('[data-composer] textarea').fill(text)
  await pickFast(page)
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(page).toHaveURL(/#\/chats\/(?!new$|all$)[^/]+$/, { timeout: 60_000 })
  return /#\/chats\/([^/]+)$/.exec(page.url())![1]!
}

/** Dana asks (a scenario by name) and waits for the fixed answer; returns the run's tool steps as the person's trace shows them. */
async function askAndRead(page: Page, request: APIRequestContext, scenario: string, question: string, answer: string, name: string, tools: string[]) {
  await ensureFastDefault(request)
  const chat = await askFromToday(page, `scenario:${scenario} ${question} ${uid()}`)
  await expect(log(page).getByText(answer, { exact: true })).toBeVisible({ timeout: 150_000 })
  // The run's tool steps, by the owner's trace route. The answer is on screen from the socket before its messages are stored (a turn's
  // are written in one batch when it ends), so the turn id is read from the chat's stored messages by condition: the user's message
  // carries it from the send, the agent's once stored. The trace is polled the same way until it holds the steps the scenario makes.
  let turnId: string | undefined
  await expect.poll(async () => {
    const messages = (await apiOk(page, `/api/chats/${chat}`)).messages as { turnId?: string }[]
    turnId = messages.find(m => m.turnId)?.turnId
    return turnId
  }, { timeout: 60_000, message: 'the chat holds the turn of this question' }).toBeTruthy()
  // A tool step's `detail` is the tool's own name (recording 4); a step carries no status, so a failed call is told by the answer.
  let steps: { kind: string; label: string; detail: string }[] = []
  await expect.poll(async () => {
    steps = ((await apiOk(page, `/api/traces/${turnId}`)).steps as { kind: string; label: string; detail: string }[]).filter(x => x.kind === 'tool')
    return steps.map(x => x.detail)
  }, { timeout: 60_000, message: `the run's trace shows the tool steps ${tools.join(', ')}` }).toEqual(tools)
  await attachJson(`${name}-tool-steps`, steps)
  return steps
}

/** The audit lines newer than `after` (the Admin reads the brand's log: the product's own record of what a notice did). */
async function auditSince(request: APIRequestContext, after: number) {
  const r = await call(request, actor('admin'), 'GET', '/api/audit?limit=100')
  expect(r.status, r.text).toBe(200)
  expect(Array.isArray(r.json?.items), 'the audit answer lists items').toBe(true)
  return (r.json.items as { id: number; what: string; detail: string }[]).filter(l => l.id > after)
}
const auditMark = async (request: APIRequestContext) => {
  const r = await call(request, actor('admin'), 'GET', '/api/audit?limit=1')
  expect(r.status, r.text).toBe(200)
  return (r.json.items as { id: number }[])[0]?.id ?? 0
}

// ---------- S1: connect Slack ----------

test('S1: As the Inhouse team, connect Slack with the pre-consented test user and Tools shows it connected', async ({ context, page, request }) => {
  test.setTimeout(180_000)
  await ensureDisconnected(request)
  // The browser's trip to Slack's sign-in page is answered here: a redirect back with a code for the pre-consented test user.
  await page.route(/^https:\/\/slack\.com\/oauth\//, async route => {
    const minted = await mintTestCode(route.request().url())
    const back = new URL(minted.callbackUrl)
    await route.fulfill({ status: 302, headers: { Location: `${originFor('inhouse')}${back.pathname}${back.search}` } })
  })
  await openAs(context, page, 'inhouse', '#/tools')
  // The Connect buttons are in the catalog's order (the server's list); Slack's is the one at its index.
  const offered = (await readTools(request)).catalog.filter(c => c.accountId)
  const at = offered.findIndex(c => c.k === 'slack')
  expect(at, `Slack is in the catalog of tools to connect: ${JSON.stringify(offered)}`).toBeGreaterThanOrEqual(0)
  const connects = main(page).getByRole('button', { name: 'Connect', exact: true })
  await expect(connects, 'one Connect button per tool offered').toHaveCount(offered.length)
  await shot(page, 'S1-slack-not-connected')
  await connects.nth(at).click()
  // Back from the sign-in: the tool's page, with the connected line (a same-key toast replaces itself, so "once" is tools-return.spec.ts's).
  await expect(page).toHaveURL(/#\/tools\/slack$/, { timeout: 60_000 })
  await expect(toast(page, CONNECTED_TOAST)).toHaveCount(1)
  await expect(main(page)).toContainText('Slack')
  await expect(main(page).getByRole('button', { name: 'Pause access' })).toBeVisible()
  await shot(page, 'S1-slack-connected')
  await goTo(page, '#/tools')
  await expect(main(page).getByRole('heading', { level: 2, name: /^Connected/ })).toBeVisible()
  await expect(main(page).getByRole('button', { name: /^Slack Team conversations/ }), 'Slack is in the Connected list').toBeVisible()
  expect((await readTools(request)).connected, 'the server lists Slack as connected').toContain('slack')
  await shot(page, 'S1-tools-list')
})

// ---------- S2 and S3: questions that need the connectors ----------

test('S2: Ask about a supplier delay and the orders it holds up and the answer cites Slack and Shopify', async ({ context, page, request }) => {
  needsContainer()
  test.setTimeout(300_000)
  await ensureConnected(request)
  await ensureShopifyConnected(request)
  await openAs(context, page, 'dana', '#/today')
  await askAndRead(page, request, 'connectors-supplier', 'what is the supplier delay and which orders does it hold up?', SUPPLIER_ANSWER, 'S2', ['mcp__apps__slack_search_public', 'mcp__apps__orders_search'])
  await shot(page, 'S2-answer-with-both-sources')
  // The path, not only the text: the run's trace records the Slack search, then the store's orders (asserted by name in askAndRead).
  await expect(log(page).getByText('Sources: Slack #suppliers, Shopify orders.')).toBeVisible()
})

test('S3: Ask over the whole store and the answer comes from a code mode script and stays short', async ({ context, page, request }) => {
  needsContainer()
  test.setTimeout(300_000)
  await ensureConnected(request)
  await ensureShopifyConnected(request)
  await openAs(context, page, 'dana', '#/today')
  // The script is the measured "lowest stock" one over every product (hub/codemode/measure/scripts.ts). One tool step, the script
  // (asserted by name in askAndRead), however many pages it read: the answer comes from a script, not a chain of reads. That the answer is
  // SHORT is the real model's property (it writes the answer from the script's small result): the scripted answer is fixed text, so
  // "short" is the real-model smoke's check, not this recording's.
  await askAndRead(page, request, 'connectors-codemode', 'across all the products which are lowest on stock?', CODE_MODE_ANSWER, 'S3', ['mcp__apps__shopify_script_run'])
  await shot(page, 'S3-codemode-answer')
})

// ---------- S4: alerts at Act and Watch ----------

test('S4: At Act an alert reaches a listed Slack channel, an unlisted channel is refused, and at Watch the alert reaches the bell only', async ({ context, page, request }) => {
  needsContainer()
  test.setTimeout(480_000)
  await ensureConnected(request)
  // What the brand had (the stage and the listed channels) is read first and put back after: the test changes both.
  const had = await readNoticeSetup(request)
  await fakeReset(request)
  await setListedChannels(request, [CHANNEL.opsAlerts], true)
  await openAs(context, page, 'dana', '#/today')
  const POSTED = 'posted a notice to Slack'
  const REFUSED = 'a notice didn’t go out'
  const TO_BELL = 'sent a notice to the bell'
  try {
    // At Act: the alert posts once to Slack. The product's record is its audit line: "posted a notice to Slack", detail "Slack" (the
    // audit text names where, never the channel or the text; the channel is in the answer the person reads). The post's own parameters
    // (four, no preview, only the app link) are asserted by e2e/api/notify-slack.spec.ts.
    await setStage(request, 'Act')
    let mark = await auditMark(request)
    await askAndRead(page, request, 'connectors-notice', 'send the stock alert', NOTICE_ANSWER, 'S4-act', [NOTIFY_TOOL])
    const act = await auditSince(request, mark)
    await attachJson('S4-act-audit', act)
    const posted = act.filter(l => l.what === POSTED)
    expect(posted.length, 'one post to Slack at Act').toBe(1)
    expect(posted[0]!.detail, 'the audit line says where it went').toBe('Slack')
    await shot(page, 'S4-act-sent')

    // An unlisted channel: refused with the audit line's own reason, nothing posted, and the person reads the refusal.
    mark = await auditMark(request)
    await askAndRead(page, request, 'connectors-notice-unlisted', 'send it to the design channel', UNLISTED_ANSWER, 'S4-unlisted', [NOTIFY_TOOL])
    const unlisted = await auditSince(request, mark)
    await attachJson('S4-unlisted-audit', unlisted)
    const refused = unlisted.filter(l => l.what === REFUSED)
    expect(refused.length, 'the unlisted channel was refused and audited').toBe(1)
    expect(refused[0]!.detail, 'the refusal says why').toBe('Slack: a channel that isn’t listed')
    expect(unlisted.filter(l => l.what === POSTED).length, 'nothing was posted to an unlisted channel').toBe(0)
    await shot(page, 'S4-unlisted-refused')

    // At Watch: the same alert reaches the bell of the person who asked, and Slack gets nothing.
    await setStage(request, 'Watch')
    const known = new Set(((await apiOk(page, '/api/notifications')).items as { id: string }[]).map(i => i.id))
    mark = await auditMark(request)
    await askAndRead(page, request, 'connectors-notice-watch', 'send the stock alert', WATCH_ANSWER, 'S4-watch', [NOTIFY_TOOL])
    const watch = await auditSince(request, mark)
    await attachJson('S4-watch-audit', watch)
    const toBell = watch.filter(l => l.what === TO_BELL)
    expect(toBell.length, 'the alert went to the bell').toBe(1)
    expect(toBell[0]!.detail, 'the bell line says why it is not Slack').toMatch(/: sent to the bell until the Act stage$/)
    expect(watch.filter(l => l.what === POSTED).length, 'no Slack post at Watch').toBe(0)
    await expect.poll(async () => ((await apiOk(page, '/api/notifications')).items as { id: string; body?: string }[]).filter(i => !known.has(i.id) && i.body?.includes(NOTICE_TEXT)).length,
      { timeout: 60_000, message: "the person's bell holds the new alert" }).toBe(1)
    // What the person sees. The bell reads its notices when the app starts and on a page change; the alert came from the agent's own tool,
    // not from a notice the bell was told about, so the person goes to another page as they would, and the product's own page-change read
    // brings it in. The popup's row is the notice's headline, "Message from your Inhouse agent", on both desktop and phone; the body is
    // read through the API above, not in the popup.
    const unread = ((await apiOk(page, '/api/notifications')).items as { unread: boolean }[]).filter(i => i.unread).length
    expect(unread, 'the new alert is unread').toBeGreaterThan(0)
    await goTo(page, '#/today')
    const bell = page.getByRole('button', { name: /^Notifications, \d+ unread$/ })
    await expect(bell, 'the bell shows an unread count after a page change').toBeVisible({ timeout: 30_000 })
    await expect(bell, 'the bell counts what the server holds').toHaveAccessibleName(`Notifications, ${unread} unread`)
    await bell.click()
    await expect(page.getByRole('dialog', { name: 'Notifications' }).getByRole('button', { name: /^Message from your Inhouse agent/ }).first()).toBeVisible()
    await shot(page, 'S4-watch-bell')
  } finally {
    // Put back what the brand had; a failure here is attached, never thrown over the test's own error.
    await quietly('S4-restore', async () => {
      await setStage(request, had.stage)
      await setListedChannels(request, had.channelIds, had.alerts)
    })
  }
})

/** The brand's stage (a brand with none reads as Watch) and the channels listed for notices, alerts channel first. */
async function readNoticeSetup(request: APIRequestContext): Promise<{ stage: 'Watch' | 'Act' | 'Run'; channelIds: string[]; alerts: boolean }> {
  const settings = await call(request, actor('inhouse'), 'GET', '/api/settings/technical')
  expect(settings.status, settings.text).toBe(200)
  const stage = (settings.json.items as { key: string; value?: unknown }[]).find(i => i.key === 'stage')?.value
  const listed = await call(request, actor('inhouse'), 'GET', '/api/notify/channels')
  expect(listed.status, listed.text).toBe(200)
  const channels = listed.json.channels as { channelId: string; alerts?: boolean }[]
  const alertsFirst = [...channels].sort((a, b) => Number(!!b.alerts) - Number(!!a.alerts))
  return { stage: stage === 'Act' || stage === 'Run' ? stage : 'Watch', channelIds: alertsFirst.map(c => c.channelId), alerts: alertsFirst[0]?.alerts === true }
}

/** Runs a cleanup step and attaches how it went: never an assertion, so it can't mask the error that sent the test here. */
async function quietly(name: string, step: () => Promise<void>) {
  try {
    await step()
    await attachJson(name, { ok: true })
  } catch (e) {
    await attachJson(name, { ok: false, error: e instanceof Error ? e.message : String(e) })
  }
}

// ---------- S5 and S6: pause and disconnect ----------

test('S5: Pause the tool and the agent no longer uses it, then unpause', async ({ context, page, request }) => {
  test.setTimeout(240_000)
  await ensureConnected(request)
  await openAs(context, page, 'inhouse', '#/tools/slack')
  try {
    await pauseAndResume(page, request)
  } finally {
    // Whatever failed above, Slack is left unpaused: the tests after this one (and the next run) need it usable.
    await quietly('S5-unpause', async () => {
      const back = await call(request, actor('inhouse'), 'PUT', `/api/tools/${encodeURIComponent(SLACK_ACCOUNT)}/paused`, { json: { paused: false } })
      await attachJson('S5-unpause-answer', { status: back.status, body: back.text })
    })
  }
})

async function pauseAndResume(page: Page, request: APIRequestContext) {
  expect(await hubToolNames(request), 'Slack tools are listed while connected').toContain('slack_search_public')
  expect(namedApps(await turnPrompt(request))).toContain('Slack')
  await main(page).getByRole('button', { name: 'Pause access' }).click()
  await expect(toast(page, 'Access paused. Your Inhouse agent has stopped reading Slack.')).toBeVisible()
  await expect(main(page).getByRole('button', { name: 'Resume access' })).toBeVisible()
  await expect(main(page)).toContainText('Access is paused. Resume it and you can ask about Slack again.')
  await shot(page, 'S5-paused')
  // What the agent sees: no Slack tool, a refused call, and a prompt that doesn't name Slack.
  await expect.poll(async () => (await hubToolNames(request)).filter(n => n.startsWith('slack_')), { message: 'the hub lists no Slack tool while paused' }).toEqual([])
  expect(await hubCall(request, 'callTool', 'slack_search_public', { keywords: ['supplier'] })).toMatchObject({ ok: false, error: { code: 'paused' } })
  expect(namedApps(await turnPrompt(request)), 'the prompt does not name a paused app').not.toContain('Slack')
  await main(page).getByRole('button', { name: 'Resume access' }).click()
  await expect(toast(page, 'Your Inhouse agent can read Slack again')).toBeVisible()
  await expect(main(page).getByRole('button', { name: 'Pause access' })).toBeVisible()
  await expect.poll(async () => (await hubToolNames(request)).filter(n => n.startsWith('slack_')).length, { message: 'the Slack tools are back' }).toBeGreaterThan(0)
  expect(namedApps(await turnPrompt(request))).toContain('Slack')
  await shot(page, 'S5-resumed')
}

test('S6: Disconnect the tool and the agent is told it is not connected and what is', async ({ context, page, request }) => {
  test.setTimeout(240_000)
  await ensureConnected(request)
  // Shopify is made usable first, whatever ran before: the prompt must then still offer it.
  await ensureShopifyConnected(request)
  await openAs(context, page, 'inhouse', '#/tools/slack')
  try {
    await main(page).getByRole('button', { name: 'Disconnect' }).click()
    const confirm = page.locator('[role="dialog"], [role="alertdialog"]').filter({ hasText: 'Disconnect Slack?' })
    await expect(confirm).toBeVisible()
    await shot(page, 'S6-confirm')
    await confirm.getByRole('button', { name: 'Disconnect', exact: true }).click()
    await expect(toast(page, 'Slack is disconnected.')).toBeVisible()
    await expect(main(page).getByRole('button', { name: 'Connect', exact: true })).toBeVisible()
    await shot(page, 'S6-disconnected')
    // What the agent sees: no Slack tool, a refused call, and a prompt that offers exactly what is connected.
    await expect.poll(async () => (await hubToolNames(request)).filter(n => n.startsWith('slack_')), { message: 'the hub lists no Slack tool once disconnected' }).toEqual([])
    expect(await hubCall(request, 'callTool', 'slack_search_public', { keywords: ['supplier'] })).toMatchObject({ ok: false, error: { code: 'not_configured' } })
    const still = namedApps(await turnPrompt(request))
    expect(still, 'a disconnected app is not named').not.toContain('Slack')
    expect(still, 'the prompt still offers what is connected').toContain('Shopify')
    const tools = await readTools(request)
    await attachJson('S6-prompt-and-tools', { apps: still, connected: tools.connected })
    expect(still.map(n => n.toLowerCase()).sort(), 'the prompt names exactly the apps still usable').toEqual(tools.connected.filter(k => !tools.connection[k] && !tools.details[k]?.paused).sort())
  } finally {
    // Left connected for the specs that run after this one, whatever failed above (attached, never thrown over the test's own error).
    await quietly('S6-reconnect', async () => {
      const again = await connectSlack(request)
      await attachJson('S6-reconnect-location', again.location)
    })
  }
})

// ---------- S7: the Admin's read-only Tools ----------

test('S7: As an Admin the Tools page is read-only', async ({ context, page, request }) => {
  test.setTimeout(180_000)
  await ensureConnected(request)
  await openAs(context, page, 'admin', '#/tools')
  // A positive first: the list has loaded and shows Slack connected, so "no Connect button" below isn't an unloaded page.
  await expect(main(page).getByRole('heading', { level: 2, name: /^Connected/ })).toBeVisible()
  await expect(main(page).getByRole('button', { name: /^Slack Team conversations/ })).toBeVisible()
  await expect(main(page).getByRole('button', { name: 'Connect', exact: true })).toHaveCount(0)
  await shot(page, 'S7-admin-tools-list')
  await goTo(page, '#/tools/slack')
  await expect(main(page)).toContainText('Slack')
  await expect(main(page).getByText(ADMIN_LINE)).toBeVisible()
  for (const name of ['Pause access', 'Resume access', 'Disconnect', 'Connect', 'Reconnect']) {
    await expect(main(page).getByRole('button', { name, exact: true }), `no "${name}" button for an Admin`).toHaveCount(0)
  }
  // The Connection card is below the fold on a phone: bring it (its Admin line) into view so the shot shows the missing buttons.
  await main(page).getByText(ADMIN_LINE).scrollIntoViewIfNeeded()
  await shot(page, 'S7-admin-slack-read-only')
  // And the server agrees: an Admin's write is refused, and nothing changed.
  const refused = await api(page, 'PUT', `/api/tools/${encodeURIComponent(SLACK_ACCOUNT)}/paused`, { paused: true })
  expect(refused.status).toBe(403)
  expect(refused.json).toEqual({ error: { code: 'forbidden', reason: 'admin_read_only' } })
  const gone = await api(page, 'POST', `/api/tools/${encodeURIComponent(SLACK_ACCOUNT)}/disconnect`, {})
  expect(gone.status).toBe(403)
  const t = await readTools(request)
  expect(t.connected).toContain('slack')
  expect(t.details.slack?.paused).toBe(false)
  expectError(await call(request, actor('admin'), 'POST', `/api/connect/${encodeURIComponent(SLACK_ACCOUNT)}/start`, { json: {} }), 403, 'forbidden', 'admin_read_only')
})
