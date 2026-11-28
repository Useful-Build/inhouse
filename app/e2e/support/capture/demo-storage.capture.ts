// Captures what a returning visitor's browser holds for the demo before the agent seam (P1) changes the stored shapes:
// a started chat, a draft in a second chat, the model pick and an approval mid-hold at Act. It writes every localStorage
// key the app owns (`inhouse.*`) to e2e/support/fixtures/demo-storage-pre-seam.json, which the upgrade spec loads.
//
// A plain Playwright script, not a spec: no project matches *.capture.ts. Run it once against main's demo build from
// before P1, served with `vite preview`:
//   BASE_URL=http://localhost:5193 node e2e/support/capture/demo-storage.capture.ts
// It fails like the CSP guard (e2e/csp.ts) does: on any CSP violation or a page served without the CSP header.
import { chromium, expect } from '@playwright/test'
import type { Page } from '@playwright/test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const baseURL = process.env.BASE_URL
if (!baseURL) throw new Error('Set BASE_URL to the demo build to capture from, e.g. BASE_URL=http://localhost:5193')
const OUT = fileURLToPath(new URL('../fixtures/demo-storage-pre-seam.json', import.meta.url))

// The same flows and names as memory.spec.ts, composer.spec.ts and state.spec.ts.
const Q = 'Which orders are stuck over 3 days?'
const A = '3 orders · $556'
const SECOND_CHAT = 'Why did refunds jump?'
const DRAFT = 'A draft I have not sent yet'
const KESTREL = 'Ridge 30L Pack runs out in 9 days'

type Violation = { directive: string; blocked: string; source: string; page: string }
declare global {
  interface Window { __cspReport?: (v: Violation) => void }
}

// Every step logs its name and has a deadline, so a hang names its step instead of running until the lock kills it.
// The deadline is AbortSignal.timeout (no fixed wait: it only fails a step that hasn't finished).
const STEP_MS = 30_000
const step = async <T>(name: string, run: () => Promise<T>, ms = STEP_MS): Promise<T> => {
  console.log(`capture: ${name}`)
  let done = false
  const deadline = AbortSignal.timeout(ms)
  const timedOut = new Promise<never>((_, reject) => {
    deadline.addEventListener('abort', () => { if (!done) reject(new Error(`capture: step "${name}" did not finish in ${ms / 1000} s`)) }, { once: true })
  })
  try { return await Promise.race([run(), timedOut]) } finally { done = true }
}

const browser = await chromium.launch()
try {
  const context = await browser.newContext({ baseURL, viewport: { width: 1440, height: 900 } })
  // Actions and navigations fail on their own well inside a step's deadline.
  context.setDefaultTimeout(15_000)

  // The CSP guard, as in e2e/csp.ts.
  const violations: Violation[] = []
  const unguarded: string[] = []
  context.on('response', response => {
    if (response.request().resourceType() !== 'document' || response.status() >= 300) return
    if (!response.headers()['content-security-policy']) unguarded.push(response.url())
  })
  await context.exposeBinding('__cspReport', (_source, v: Violation) => { violations.push(v) })
  await context.addInitScript(() => {
    const report = window.__cspReport
    document.addEventListener('securitypolicyviolation', e => {
      report?.({ directive: e.violatedDirective, blocked: e.blockedURI, source: `${e.sourceFile}:${e.lineNumber}`, page: location.href })
    })
  })

  const page: Page = await context.newPage()
  // App time is ours: the 10 s send hold must still be pending when storage is read. The clock fakes timers and
  // requestAnimationFrame alike, so while it's paused below no animation frame runs.
  await page.clock.install()
  await page.addInitScript(() => {
    if (sessionStorage.getItem('capture-seeded')) return
    localStorage.clear()
    localStorage.setItem('inhouse.demo.switches.v1', JSON.stringify({ scenario: 'Normal', ambient: 'Off', animateMark: false }))
    sessionStorage.setItem('capture-seeded', '1')
  })
  await step('open Today', () => page.goto('/?demo#/today'))

  const side = page.getByRole('complementary', { name: 'Sidebar' })
  const log = page.getByRole('log', { name: 'Conversation' })
  const chatBox = page.getByRole('textbox', { name: 'Message Inhouse' })

  // The model pick, then a question from Today: it starts a chat of its own.
  await step('pick the Fast model', async () => {
    await page.getByRole('button', { name: 'Model: Smart' }).click()
    await page.getByRole('menuitemradio', { name: /Fast/ }).click()
    await expect(page.getByRole('button', { name: 'Model: Fast' })).toBeVisible()
  })
  await step('ask from Today and get the answer', async () => {
    await page.getByRole('textbox', { name: 'Ask Inhouse' }).fill(Q)
    await page.keyboard.press('Enter')
    await expect(log.getByText(A)).toBeVisible({ timeout: 15_000 })
    expect(await page.evaluate(() => location.hash)).toMatch(/^#\/chats\/chat-new-/)
  })

  // A draft in a second chat's composer.
  await step('type a draft in a second chat', async () => {
    await side.getByRole('button', { name: SECOND_CHAT, exact: true }).click()
    await expect(page.getByRole('banner')).toContainText(SECOND_CHAT)
    await chatBox.fill(DRAFT)
  })

  // Approve the Kestrel reorder on Today: it's held for 10 s before it goes out.
  await step('approve the Kestrel reorder', async () => {
    await side.getByRole('button', { name: 'Today', exact: true }).click()
    await page.getByRole('article').filter({ hasText: KESTREL }).getByRole('button', { name: 'Review' }).click()
    await page.getByRole('dialog').getByRole('button', { name: 'Approve and send to Kestrel' }).click()
    await expect(page.getByRole('status').filter({ hasText: 'Approved. It goes out in 10 seconds.' })).toBeVisible()
    await page.keyboard.press('Escape')
  })

  // Stop app time just ahead, then run past the session save (debounced 300 ms): the hold is still pending.
  await step('pause app time past the session save', async () => {
    const now = await page.evaluate(() => Date.now())
    await page.clock.pauseAt(now + 100)
    await page.clock.runFor(500)
    await expect(page.getByRole('article').filter({ hasText: KESTREL })).toContainText('going out')
  })

  const stored = await step('read localStorage', () => page.evaluate(() => {
    const out: Record<string, string> = {}
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)!
      if (key.startsWith('inhouse.')) out[key] = localStorage.getItem(key)!
    }
    return out
  }))
  const session = JSON.parse(stored['inhouse.ui.session.v1'] ?? 'null') as { started?: unknown[]; drafts?: Record<string, { text?: string }>; modelSel?: string } | null
  expect(session, 'the session was saved').not.toBeNull()
  expect(session!.started, 'one started chat').toHaveLength(1)
  expect(Object.values(session!.drafts ?? {}).some(d => d.text === DRAFT), 'the second chat\'s draft').toBe(true)
  expect(session!.modelSel, 'the model pick').toBeTruthy()
  const demo = JSON.parse(stored['inhouse.demo.v2'] ?? 'null') as { approved?: Record<string, unknown>; sent?: Record<string, unknown> } | null
  expect(Object.keys(demo?.approved ?? {}), 'one approval').toHaveLength(1)
  expect(Object.keys(demo?.sent ?? {}), 'nothing sent yet: the approval is mid-hold').toHaveLength(0)

  // Let queued violation events fire, as e2e/csp.ts does: one animation frame per open page. The paused clock holds
  // requestAnimationFrame too (this wait hung before), so storage is already read and app time runs again first.
  await step('flush queued CSP violation events', async () => {
    await page.clock.resume()
    for (const open of context.pages()) {
      if (open.isClosed()) continue
      await open.evaluate(() => new Promise(r => requestAnimationFrame(() => r(null)))).catch((err: unknown) => {
        if (!open.isClosed()) throw err
      })
    }
  })
  expect(unguarded, `Pages served without a Content-Security-Policy header: ${unguarded.join(', ')}`).toEqual([])
  expect(violations, `CSP violations: ${violations.map(v => `${v.directive} blocked ${v.blocked} (${v.source}) on ${v.page}`).join('; ')}`).toEqual([])

  const sorted = Object.fromEntries(Object.entries(stored).sort(([a], [b]) => a.localeCompare(b)))
  mkdirSync(dirname(OUT), { recursive: true })
  writeFileSync(OUT, JSON.stringify(sorted, null, 2) + '\n')
  console.log(`Wrote ${Object.keys(sorted).length} keys to ${OUT}: ${Object.keys(sorted).join(', ')}`)
} finally {
  await browser.close()
}
