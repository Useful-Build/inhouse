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
  const [approvalId, approval] = Object.entries(demoState.approved as Record<string, { ms: number; title: string }>)[0]
  const chat = session.started[0]
  const answer = session.chats[chat.id].extras.find(m => m.part?.type === 'text')!.part!.text!
  const table = session.chats[chat.id].extras.find(m => m.part?.type === 'table')!.part!.table!.summary
  const [draftChat, draft] = Object.entries(session.drafts)[0]
  const draftTitle = fx.names.chats.find(c => c.id === draftChat)!.title

  // The approval's hold runs on real time and the demo on the demo clock: the page clock starts at the moment the
  // approval was logged, so its 10 s hold is pending however long the load takes, and runFor ends it.
  await page.clock.install({ time: approval.ms })
  await fx.seedSaved({ stage: 'Act', demo: { ambient: 'Always' } }, demoState)
  // After the seed (which clears storage first), so the fixture's other entries stay.
  await page.addInitScript(restore, rest.map(e => [e.key, e.value] as [string, string]))
  await fx.open('#/today')
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Good morning, Sam.')

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
  await expect(page.getByRole('textbox', { name: 'Message your Inhouse agent' })).toHaveValue(draft.text)

  // The approval is mid-hold, then goes out on the clock.
  await side(page).getByRole('button', { name: 'Today', exact: true }).click()
  const held = page.getByRole('article').filter({ hasText: 'going out' })
  await expect(held).toHaveCount(1)
  await page.clock.runFor(12_000)
  await expect(page.getByRole('article').filter({ hasText: 'going out' })).toHaveCount(0)
  await expect.poll(async () => Object.keys(((await fx.saved()).demo.sent as Record<string, unknown>) ?? {})).toContain(approvalId)
})
