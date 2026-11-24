// The Tools page's catalogue and a Member's Request on it, on the test build (P5's catalogue, route 70, with P6a's team
// requests, routes 81 and 83). The page lists what `GET /api/tools` says the brand can still add; a Member's "Request" on one
// files a tool request ("Connect <tool>", route 81), says so in a toast once the server has it, and the button reads
// "Requested" (and stays so after a reload, from the server's own open request). The toast's Undo withdraws it (route 83).
// Slack is the tool requested here: the spec disconnects it first (the Inhouse team's disconnect, as the other P5 specs do),
// so it is in the catalogue and a Member, who can't connect, is offered Request on it. Slack need not be the only catalogue tool
// (Shopify is on a fresh database until a hub read): the button counts follow the catalogue `GET /api/tools` returns. Ways it can fail, written first:
//  1. the catalogue isn't shown, or a Member is offered Connect (which only the Inhouse team may use) instead of Request;
//  2. Request files nothing, or files it with other words than "Connect Slack" or as another kind;
//  3. the toast is shown before the server has the request (the spec holds route 81's request at the browser and looks for the
//     toast while it is held), or "Requested" is lost on a reload (the mark was only local);
//  4. Undo leaves the request open on the server, or the button stays "Requested" after it.
// The person's own open tool requests are withdrawn before and after each test, also when it fails (the team caps open requests
// at 50 a brand). No timers: every wait is on the page's own state or on the response the click causes.
import type { APIRequestContext, BrowserContext, Page } from '@playwright/test'
import { actor, call } from '../api/kit.ts'
import { ensureDisconnected, readTools } from '../api/fakes-kit.ts'
import { open, signInAs } from '../support/clients/real.js'
import { expect, test } from '../support/test-build/index.js'

test.describe.configure({ mode: 'serial' })

const dana = actor('memberA')
const main = (page: Page) => page.getByRole('main')
const toast = (page: Page, text: string) => page.locator('[data-toast]').filter({ hasText: text })
const SENT = 'Request sent to your Inhouse team: connect Slack'

interface OpenRequest { id: string; kind: string; subject: string | null; text: string; mine: boolean; rev: number }
const openRequests = async (request: APIRequestContext): Promise<OpenRequest[]> => {
  const r = await call(request, dana, 'GET', '/api/team-requests?status=open')
  expect(r.status, r.text).toBe(200)
  return r.json.items as OpenRequest[]
}
/** Withdraws every open tool request of Dana's own, so each test starts and ends with none of hers open. */
async function withdrawMine(request: APIRequestContext): Promise<void> {
  for (const r of (await openRequests(request)).filter(x => x.mine && x.kind === 'tool')) {
    const done = await call(request, dana, 'PUT', `/api/team-requests/${r.id}/withdrawn`, { json: { ifRev: r.rev } })
    expect(done.status, done.text).toBe(200)
  }
}
const slackRequests = async (request: APIRequestContext): Promise<OpenRequest[]> =>
  (await openRequests(request)).filter(x => x.mine && x.kind === 'tool' && x.subject === 'slack')

test.beforeAll(async ({ request }) => { await ensureDisconnected(request) })
test.beforeEach(async ({ request }) => { await withdrawMine(request) })
test.afterEach(async ({ request }) => { await withdrawMine(request) })

/** Opens Tools as Dana and returns Slack's Request button (the Request buttons are in the catalogue's order, the server's list) and how many tools the catalogue has. */
async function openCatalogue(page: Page, context: BrowserContext, request: APIRequestContext) {
  await signInAs(context, 'dana')
  await open(page, 'dana', '#/tools')
  const { catalog } = await readTools(request, dana)
  const at = catalog.findIndex(c => c.k === 'slack')
  expect(at, `Slack is in the catalogue once it is disconnected: ${JSON.stringify(catalog)}`).toBeGreaterThanOrEqual(0)
  await expect(main(page).getByRole('heading', { name: 'Add a tool' })).toBeVisible()
  // A Member is offered Request on every catalogue tool and never Connect (the Inhouse team's button).
  await expect(main(page).getByRole('button', { name: 'Connect', exact: true })).toHaveCount(0)
  const requests = main(page).getByRole('button', { name: 'Request', exact: true })
  await expect(requests).toHaveCount(catalog.length)
  return { ask: requests.nth(at), catalogued: catalog.length }
}

const posted = (page: Page) => page.waitForResponse(r => new URL(r.url()).pathname === '/api/team-requests' && r.request().method() === 'POST')

test('a Member requests a catalogue tool: route 81 files "Connect Slack", the toast says so, it reads Requested and stays so after a reload', async ({ page, context, request }) => {
  const { ask, catalogued } = await openCatalogue(page, context, request)
  // Route 81's request is held at the browser until the toast has been looked for: the server has not got it, so no toast yet.
  let atServer!: () => void
  let release!: () => void
  const reached = new Promise<void>(r => { atServer = r })
  const held = new Promise<void>(r => { release = r })
  await page.route(url => url.pathname === '/api/team-requests', async route => {
    if (route.request().method() !== 'POST') return route.fallback()
    atServer()
    await held
    await route.continue()
  })
  const filed = posted(page)
  await ask.click()
  await reached
  // Two animation frames: anything the click would render has rendered (a frame is the page's own signal, not a timer).
  await page.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))))
  await expect(toast(page, SENT), 'no toast while the server has not got the request').toHaveCount(0)
  release()
  const response = await filed
  expect(response.status(), await response.text()).toBe(201)
  expect(response.request().postDataJSON()).toEqual({ kind: 'tool', subject: 'slack', text: 'Connect Slack' })
  await expect(toast(page, SENT)).toBeVisible()
  const requested = main(page).getByRole('button', { name: 'Requested', exact: true })
  await expect(requested).toHaveCount(1)
  await expect(requested).toBeDisabled()
  // The other catalogue tools are still offered Request.
  await expect(main(page).getByRole('button', { name: 'Request', exact: true })).toHaveCount(catalogued - 1)

  // The server has it: Dana's own open tool request about Slack, in the words the window would show.
  expect((await slackRequests(request)).map(r => r.text)).toEqual(['Connect Slack'])

  await page.reload()
  await expect(main(page).getByRole('heading', { name: 'Add a tool' })).toBeVisible()
  await expect(main(page).getByRole('button', { name: 'Requested', exact: true })).toBeDisabled()
  await expect(main(page).getByRole('button', { name: 'Request', exact: true })).toHaveCount(catalogued - 1)
})

test('Undo in the toast withdraws the request (route 83): the button reads Request again, the server has no open request, and a reload agrees', async ({ page, context, request }) => {
  const { ask, catalogued } = await openCatalogue(page, context, request)
  const filed = posted(page)
  await ask.click()
  expect((await filed).status()).toBe(201)
  await expect(main(page).getByRole('button', { name: 'Requested', exact: true })).toBeDisabled()
  expect(await slackRequests(request)).toHaveLength(1)

  const withdrawn = page.waitForResponse(r => /^\/api\/team-requests\/[^/]+\/withdrawn$/.test(new URL(r.url()).pathname) && r.request().method() === 'PUT')
  await toast(page, SENT).getByRole('button', { name: 'Undo', exact: true }).click()
  const answer = await withdrawn
  expect(answer.status(), await answer.text()).toBe(200)
  await expect(main(page).getByRole('button', { name: 'Requested', exact: true })).toHaveCount(0)
  await expect(main(page).getByRole('button', { name: 'Request', exact: true })).toHaveCount(catalogued)
  expect(await slackRequests(request), 'the server no longer has it open').toEqual([])

  await page.reload()
  await expect(main(page).getByRole('heading', { name: 'Add a tool' })).toBeVisible()
  await expect(main(page).getByRole('button', { name: 'Requested', exact: true })).toHaveCount(0)
  await expect(main(page).getByRole('button', { name: 'Request', exact: true })).toHaveCount(catalogued)
})
