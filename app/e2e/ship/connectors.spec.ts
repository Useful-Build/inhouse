// Ship spec for P5 Connectors (the plan's browser scenarios S1 to S7, docs/plans/2026-11-19-p5-connectors.md): connecting Slack, a
// question that needs Slack and Shopify, a question over the whole store answered by a code mode script, an alert at Act and at
// Watch, pausing, disconnecting, and the Admin's read-only Tools page, as real people on the TEST BUILD with the hub, the fake
// Slack and the recorded Shopify. Desktop (1440x900) and phone (390x844). Each test is titled `S<n>: ...` (the card before its clip).
//
// What runs where. S2, S3 and S4 run turns in a container, which only the sandbox deployment has: they call `needsContainer()`
// (E2E_TEST_BUILD_REMOTE) and skip elsewhere. A turn plays the scripted model's scenario named in its message
// (`scenario:connectors-supplier`, `-codemode`, `-notice`, `-notice-unlisted`; test/scripted-model/scenarios.ts), so every answer
// is fixed and each test proves the PATH: the tool calls reached the fakes (the test-fakes hook's state and logs), and the answer
// the person reads is on screen. The hook is the test build's `POST /api/ops/test-fakes` (release token).
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
  CHANNEL, connectSlack, ensureDisconnected, fakeReset, fakeState, hubCall, hubToolNames, logMark, readTools, setListedChannels, setStage, SLACK_ACCOUNT,
  turnPrompt, workerLogs,
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
const UNLISTED_ANSWER = "I couldn't send that: #design isn't one of the channels your admin listed."
const NOTICE_TEXT = 'The Fern mug is almost out. Restock it this week.'
const CONNECTED_TOAST = 'The tool is connected.'
const ADMIN_LINE = 'Your Inhouse team manages tools.'
/** The hub's APP_ORIGIN in the test config (wrangler.hub.test.jsonc): what a notice's "Open in Inhouse" link starts with. */
const APP_ORIGIN = 'https://inhouse.example.com'
const FOUR_PARAMS = ['channel', 'text', 'unfurl_links', 'unfurl_media']

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

/** Goes to a screen by its hash, as the sidebar's rows do (on a phone the drawer stays out of the way). */
async function goTo(page: Page, hash: string) {
  await page.evaluate(h => { location.hash = h }, hash)
  await expect(page).toHaveURL(new RegExp(`${hash.replace('/', '\\/')}$`))
}

const toast = (page: Page, text: string) => page.locator('[data-toast]').filter({ hasText: text })

/** Slack connected, by the routes a person's connect uses (no browser): a test that needs it starts here, and S1 starts from none. */
async function ensureConnected(request: APIRequestContext) {
  if ((await readTools(request)).connected.includes('slack')) return
  const c = await connectSlack(request)
  expect(c.location, 'Slack connected for the test').toBe('/tools/slack?connected=1')
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
  await expect(page.getByRole('textbox', { name: 'Ask your Inhouse agent' })).toBeVisible()
  await page.locator('[data-composer] textarea').fill(text)
  await pickFast(page)
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(page).toHaveURL(/#\/chats\/(?!new$|all$)[^/]+$/, { timeout: 60_000 })
  return /#\/chats\/([^/]+)$/.exec(page.url())![1]!
}

/** Dana asks (a scenario by name) and waits for the fixed answer; returns the fakes' view of what happened as an attachment too. */
async function askAndRead(page: Page, request: APIRequestContext, scenario: string, question: string, answer: string, name: string) {
  await ensureFastDefault(request)
  await askFromToday(page, `scenario:${scenario} ${question} ${uid()}`)
  await expect(log(page).getByText(answer, { exact: true })).toBeVisible({ timeout: 150_000 })
  const state = await fakeState(request)
  await attachJson(`${name}-fakes`, { slackToolCalls: state.mcp.toolCalls.map(t => t.name), shopifyRequests: state.shopify.requests.length, posts: state.web.posts })
  return state
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
  const row = main(page).locator('div').filter({ has: page.getByRole('button', { name: 'Connect', exact: true }) }).filter({ hasText: 'Slack' }).last()
  await expect(row, 'Slack is offered with a Connect button').toBeVisible()
  await shot(page, 'S1-slack-not-connected')
  await row.getByRole('button', { name: 'Connect', exact: true }).click()
  // Back from the sign-in: the tool's page, with the connected line once.
  await expect(page).toHaveURL(/#\/tools\/slack$/, { timeout: 60_000 })
  await expect(toast(page, CONNECTED_TOAST)).toHaveCount(1)
  await expect(main(page)).toContainText('Slack')
  await expect(main(page).getByRole('button', { name: 'Pause access' })).toBeVisible()
  await shot(page, 'S1-slack-connected')
  await goTo(page, '#/tools')
  await expect(main(page).getByText('Connected', { exact: true }).first()).toBeVisible()
  expect((await readTools(request)).connected, 'the server lists Slack as connected').toContain('slack')
  await shot(page, 'S1-tools-list')
})

// ---------- S2 and S3: questions that need the connectors ----------

test('S2: Ask about a supplier delay and the orders it holds up and the answer cites Slack and Shopify', async ({ context, page, request }) => {
  needsContainer()
  test.setTimeout(300_000)
  await ensureConnected(request)
  await fakeReset(request)
  await openAs(context, page, 'dana', '#/today')
  const state = await askAndRead(page, request, 'connectors-supplier', 'what is the supplier delay and which orders does it hold up?', SUPPLIER_ANSWER, 'S2')
  await shot(page, 'S2-answer-with-both-sources')
  // The path, not only the text: the agent read Slack and the store through the hub.
  expect(state.mcp.toolCalls.map(t => t.name), 'the agent searched Slack').toContain('slack_search_public')
  expect(state.shopify.requests.length, 'the agent read the store').toBeGreaterThan(0)
  await expect(log(page).getByText('Sources: Slack #suppliers, Shopify orders.')).toBeVisible()
})

test('S3: Ask over the whole store and the answer comes from a code mode script and stays short', async ({ context, page, request }) => {
  needsContainer()
  test.setTimeout(300_000)
  await ensureConnected(request)
  await fakeReset(request)
  await openAs(context, page, 'dana', '#/today')
  const mark = await logMark(request)
  const state = await askAndRead(page, request, 'connectors-codemode', 'across all the products which are lowest on stock?', CODE_MODE_ANSWER, 'S3')
  await shot(page, 'S3-codemode-answer')
  expect(CODE_MODE_ANSWER.length, 'a short answer').toBeLessThan(300)
  expect(state.shopify.requests.length, 'the script paged the store').toBeGreaterThan(0)
  // The hub logs one line per script run (its code hash and outcome, never the code or its data).
  const lines = (await workerLogs(request, mark)).filter(l => l.includes('hub_codemode'))
  await attachJson('S3-hub-codemode-lines', lines)
  expect(lines.length, 'the hub ran a code mode script for this question').toBeGreaterThan(0)
})

// ---------- S4: alerts at Act and Watch ----------

test('S4: At Act an alert reaches a listed Slack channel with no link preview, an unlisted channel is refused, and at Watch the alert reaches the bell only', async ({ context, page, request }) => {
  needsContainer()
  test.setTimeout(480_000)
  await ensureConnected(request)
  await fakeReset(request)
  await setListedChannels(request, [CHANNEL.opsAlerts], true)
  await openAs(context, page, 'dana', '#/today')
  try {
    // At Act: the alert posts once, to the listed channel, with the app link and no preview.
    await setStage(request, 'Act')
    const before = (await fakeState(request)).web.posts.length
    await askAndRead(page, request, 'connectors-notice', 'send the stock alert', NOTICE_ANSWER, 'S4-act')
    const act = await fakeState(request)
    expect(act.web.posts.length, 'one post at Act').toBe(before + 1)
    const post = act.web.posts.at(-1)!
    expect(post.channel).toBe(CHANNEL.opsAlerts)
    expect(Object.keys(post).sort(), 'only the four parameters').toEqual(FOUR_PARAMS)
    expect(post.unfurl_links, 'no link preview').toBe('false')
    expect(post.unfurl_media, 'no media preview').toBe('false')
    expect(post.text).toContain(NOTICE_TEXT)
    // The notice links to the app's own address (the hub's APP_ORIGIN in the test config) and nowhere else.
    for (const u of post.text.match(/https?:\/\/[^\s>|]+/g) ?? []) expect(u.startsWith(APP_ORIGIN), `${u} is the app's own address`).toBe(true)
    expect(act.web.violations).toEqual([])
    await shot(page, 'S4-act-sent')

    // An unlisted channel: refused, nothing posted, and the person reads the refusal.
    await askAndRead(page, request, 'connectors-notice-unlisted', 'send it to the design channel', UNLISTED_ANSWER, 'S4-unlisted')
    expect((await fakeState(request)).web.posts.length, 'an unlisted channel got no post').toBe(before + 1)
    await shot(page, 'S4-unlisted-refused')

    // At Watch: the same alert reaches the bell of the person who asked, and Slack gets nothing.
    await setStage(request, 'Watch')
    const known = new Set((((await api(page, 'GET', '/api/notifications')).json?.items ?? []) as { id: string }[]).map(i => i.id))
    await askAndRead(page, request, 'connectors-notice', 'send the stock alert', NOTICE_ANSWER, 'S4-watch')
    expect((await fakeState(request)).web.posts.length, 'no Slack post at Watch').toBe(before + 1)
    await expect.poll(async () => (((await api(page, 'GET', '/api/notifications')).json?.items ?? []) as { id: string; body?: string }[]).filter(i => !known.has(i.id) && i.body?.includes(NOTICE_TEXT)).length,
      { timeout: 60_000, message: "the person's bell holds the new alert" }).toBe(1)
    await goTo(page, '#/chats')
    const bell = page.getByRole('button', { name: /^Notifications, \d+ unread$/ })
    await expect(bell).toBeVisible()
    await bell.click()
    await expect(page.getByRole('dialog', { name: 'Notifications' }).getByText(NOTICE_TEXT).first()).toBeVisible()
    await shot(page, 'S4-watch-bell')
  } finally {
    await setStage(request, 'Watch')
  }
})

// ---------- S5 and S6: pause and disconnect ----------

test('S5: Pause the tool and the agent no longer uses it, then unpause', async ({ context, page, request }) => {
  test.setTimeout(240_000)
  await ensureConnected(request)
  await openAs(context, page, 'inhouse', '#/tools/slack')
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
})

test('S6: Disconnect the tool and the agent is told it is not connected and what is', async ({ context, page, request }) => {
  test.setTimeout(240_000)
  await ensureConnected(request)
  await openAs(context, page, 'inhouse', '#/tools/slack')
  await main(page).getByRole('button', { name: 'Disconnect' }).click()
  const confirm = page.locator('[role="dialog"], [role="alertdialog"]').filter({ hasText: 'Disconnect Slack?' })
  await expect(confirm).toBeVisible()
  await shot(page, 'S6-confirm')
  await confirm.getByRole('button', { name: 'Disconnect', exact: true }).click()
  await expect(toast(page, 'Slack is disconnected.')).toBeVisible()
  await expect(main(page).getByRole('button', { name: 'Connect' })).toBeVisible()
  await shot(page, 'S6-disconnected')
  // What the agent sees: no Slack tool, a refused call, and a prompt that offers exactly what is connected.
  expect(await hubToolNames(request)).not.toContain('slack_search_public')
  expect(await hubCall(request, 'callTool', 'slack_search_public', { keywords: ['supplier'] })).toMatchObject({ ok: false, error: { code: 'not_configured' } })
  const prompt = await turnPrompt(request)
  const still = namedApps(prompt)
  expect(still, 'a disconnected app is not named').not.toContain('Slack')
  const tools = await readTools(request)
  await attachJson('S6-prompt-and-tools', { apps: still, connected: tools.connected })
  expect(still.map(n => n.toLowerCase()).sort(), 'the prompt names exactly the apps still usable').toEqual(tools.connected.filter(k => !tools.connection[k] && !tools.details[k]?.paused).sort())
  // Left connected for the specs that run after this one.
  const again = await connectSlack(request)
  expect(again.location).toBe('/tools/slack?connected=1')
})

// ---------- S7: the Admin's read-only Tools ----------

test('S7: As an Admin the Tools page is read-only', async ({ context, page, request }) => {
  test.setTimeout(180_000)
  await ensureConnected(request)
  await openAs(context, page, 'admin', '#/tools')
  await expect(main(page).getByRole('button', { name: 'Connect', exact: true })).toHaveCount(0)
  await shot(page, 'S7-admin-tools-list')
  await goTo(page, '#/tools/slack')
  await expect(main(page)).toContainText('Slack')
  await expect(main(page).getByText(ADMIN_LINE)).toBeVisible()
  for (const name of ['Pause access', 'Resume access', 'Disconnect', 'Connect', 'Reconnect']) {
    await expect(main(page).getByRole('button', { name, exact: true }), `no "${name}" button for an Admin`).toHaveCount(0)
  }
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
