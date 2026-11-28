// A returning visitor keeps their demo: the browser storage that main's build wrote before the agent seam (P1) -- a started
// chat, a draft, the model pick and an approval mid-hold -- opens on the new build with all of it intact.
// The fixture is e2e/support/fixtures/demo-storage-pre-seam.json (captured by support/capture/demo-storage.capture.ts).
import { readFileSync } from 'node:fs'
import { expect, test } from './support/fx.js'
import type { Page } from '@playwright/test'

type Stored = Record<string, string>
const stored: Stored = JSON.parse(readFileSync(new URL('./support/fixtures/demo-storage-pre-seam.json', import.meta.url), 'utf8'))
const parsed = Object.entries(stored).map(([key, value]) => ({ key, value, json: JSON.parse(value) as Record<string, any> }))
// The demo's own state is the entry that carries the demo clock's zero; the rest (the session, the runs) are written as they were.
const demoEntry = parsed.find(e => 'demoStartedAt' in e.json)
const demoState = demoEntry?.json as Record<string, any>
const rest = parsed.filter(e => e !== demoEntry)
const session = parsed.map(e => e.json).find(j => Array.isArray(j.started)) as {
  started: { id: string; title: string }[]
  chats: Record<string, { extras: { role: string; text?: string; part?: { type: string; text?: string; table?: { summary: string } } }[] }>
  drafts: Record<string, { text: string }>
  modelSel: string
}

/** Writes the fixture's other entries before the app loads, once per tab (a reload keeps what the page saved). */
const restore = (entries: [string, string][]) => {
  if (sessionStorage.getItem('upgrade-restored')) return
  for (const [k, v] of entries) localStorage.setItem(k, v)
  sessionStorage.setItem('upgrade-restored', '1')
}

const side = (page: Page) => page.getByRole('complementary', { name: 'Sidebar' })

test('A demo stored by the build before the seam opens with its chat, draft, model pick and approval mid-hold intact', async ({ fx, page }) => {
  expect(demoEntry, 'the fixture holds the demo state').toBeDefined()
  const [approvalId, approval] = Object.entries(demoState.approved as Record<string, { ms: number; title: string; by: string; atMin: number }>)[0]
  // The card's aria-label is its problem's title: problem `stock` in src/agent/sample-data/problems.json, which the
  // fixture's approval is for (copied: a spec reads sample data only through `fx`).
  expect(approvalId).toBe('stock')
  const problemTitle = 'Ridge 30L Pack runs out in 9 days'
  const chat = session.started[0]
  const answer = session.chats[chat.id].extras.find(m => m.part?.type === 'text')!.part!.text!
  const table = session.chats[chat.id].extras.find(m => m.part?.type === 'table')!.part!.table!.summary
  const [draftChat, draft] = Object.entries(session.drafts)[0]
  const draftTitle = fx.names.chats.find(c => c.id === draftChat)!.title

  // The page clock starts at the moment the approval was logged and keeps ticking while the page loads, so it is paused
  // as soon as the app is up: the hold (10 s from the approval) is then still pending, and only runFor moves it. If a
  // very slow load let the hold run out before the pause, the held check below fails rather than passes by accident.
  await page.clock.install({ time: approval.ms })
  // The seed carries no demo switches: the restore below writes the fixture's own switches entry, whose ambient is Off.
  // Passing `demo: { ambient: 'Always' }` here would be silently overridden by it, so it isn't passed.
  await fx.seedSaved({}, demoState)
  // After the seed (which clears storage first), so the fixture's other entries stay.
  await page.addInitScript(restore, rest.map(e => [e.key, e.value] as [string, string]))
  await fx.open('#/today')
  await expect(page.getByRole('heading', { level: 1 })).toContainText(`Good morning, ${fx.names.user.name.split(' ')[0]}.`)
  await page.clock.pauseAt(await page.evaluate(() => Date.now()) + 100)

  // The model pick.
  const pick = { sonnet: 'Fast' }[session.modelSel] ?? session.modelSel
  await expect(page.getByRole('button', { name: `Model: ${pick}` })).toBeVisible()

  // The started chat, with its answer and table.
  await side(page).getByRole('button', { name: chat.title, exact: true }).click()
  const log = page.getByRole('log', { name: 'Conversation' })
  await expect(log.getByText(answer)).toBeVisible()
  await expect(log.getByText(table)).toBeVisible()

  // The draft in the other chat's composer.
  await side(page).getByRole('button', { name: draftTitle, exact: true }).click()
  await expect(page.getByRole('banner')).toContainText(draftTitle)
  await expect(page.getByRole('textbox', { name: 'Message Inhouse' })).toHaveValue(draft.text)

  // The approval is mid-hold, then goes out on the clock.
  await side(page).getByRole('button', { name: 'Today', exact: true }).click()
  // The card is the fixture's approval, found by its problem title (the card's aria-label).
  const approved = page.getByRole('article', { name: problemTitle, exact: true })
  await expect(approved).toContainText('going out')
  await expect(page.getByRole('article').filter({ hasText: 'going out' })).toHaveCount(1)
  expect(Object.keys(((await fx.saved()).demo.sent as Record<string, unknown>) ?? {})).not.toContain(approvalId)
  await page.clock.runFor(12_000)
  await expect(approved).not.toContainText('going out')
  // The card shows the approval's converted time: the fixture's `atMin` 480 (8:00 AM) is now an instant that reads 8:00 AM
  // in the device's time zone, next to the approver's first name.
  expect(approval.atMin).toBe(480)
  await expect(approved).toContainText(`Approved by ${approval.by.split(' ')[0]} at 8:00 AM`)
  await expect.poll(async () => Object.keys(((await fx.saved()).demo.sent as Record<string, unknown>) ?? {})).toContain(approvalId)
  // The CSP guard's teardown waits one animation frame per page, and a paused fake clock holds animation frames too.
  await page.clock.resume()
})
