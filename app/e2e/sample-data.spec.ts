// Every control shows real sample data and works: Settings dropdowns, text fields and search, the chats
// (each opens its own conversation, See all lists them), and the search boxes and pickers on other pages.
import { readFileSync } from 'node:fs'
import { expect, test, type Fx } from './support/fx.js'
import { mockSource, sampleFiles, sampleJson as json } from './support/sample-reads.js'
import type { Page } from '@playwright/test'
import { atRest } from './states.js'
/** A sample time ("-3d 16:20": days from the demo's Monday, Nov 16, and a local time), as minutes from that Monday's midnight. */
const offsetMin = (at: string) => {
  const m = /^([+-]?\d+)d (\d\d):(\d\d)$/.exec(at)
  if (!m) throw new Error(`Not a sample time like "-3d 16:20": "${at}"`)
  return Number(m[1]) * 24 * 60 + Number(m[2]) * 60 + Number(m[3])
}
/** A sample time's day, as days from the demo's Monday. */
const dayOf = (at: string) => Math.floor(offsetMin(at) / (24 * 60))
const DATA_FILES = sampleFiles()
/** Keys that hold notes for whoever edits the data: never shown in the app. */
const NOTE_KEYS = new Set(['fieldGuide', 'sampleFacts', 'rowShape', 'usedBy', 'stepKinds', 'rule', 'kinds', 'openQuestion', 'placeholders'])
/** Keys that hold machine values (ids, keys, paths, ISO times): never shown as text. A video's duration ("1:36") isn't a time of day. */
/** A `note` is shown text (a Library doc's note, a routine card's notes), except the editor's note at a file's top level
 *  and on usage.json's Cap reached block. */
const EDITOR_NOTES = new Set(['usage.json.capReached.note'])
const MACHINE_KEYS = new Set(['iso', 'id', 'k', 'key', 'src', 'poster', 'photo', 'logo', 'icon', 'sev', 'kind', 'type', 'place', 'site', 'problemId', 'trace', 'match', 'ratio', 'media', 'opens', 'onlyInScenario', 'duration', 'tool'])
/** Every string a person can read in the app, as [file, path, text]. */
const TIME_DATA = /^(?:[+-]?\d+d )?\d{2}:\d{2}$/
const machineTimes: [string, string, string][] = []
function personText(): [string, string, string][] {
  const out: [string, string, string][] = []
  const walk = (file: string, v: unknown, path: string, key: string) => {
    if (NOTE_KEYS.has(key) || (key === 'note' && (path === `${file}.note` || EDITOR_NOTES.has(path)))) return
    if (typeof v === 'string') {
      // C1 stores times as data the app parses, never shows: a day offset plus a local time ("-3d 16:00") or a clock
      // time ("07:00"). Those whole values go to machineTimes (checked for validity below), not the text scan.
      if (TIME_DATA.test(v)) { machineTimes.push([file, path, v]); return }
      if (!MACHINE_KEYS.has(key) && !(key === 'at' && /^\d{4}-\d\d-\d\dT/.test(v))) out.push([file, path, v])
      return
    }
    if (Array.isArray(v)) { v.forEach((x, i) => walk(file, x, `${path}[${i}]`, key)); return }
    if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(file, x, `${path}.${k}`, k)
  }
  for (const f of DATA_FILES) walk(f, json(f), f, '')
  return out
}

async function start(fx: Fx, stage: 'Watch' | 'Act' | 'Run' = 'Act', hash = '#/today') {
  await fx.seed({ stage, demo: { ambient: 'Always' } })
  await fx.open(hash)
}

const side = (page: Page) => page.getByRole('complementary', { name: 'Sidebar' })
const shot = async (page: Page, name: string) => { await atRest(page); await page.screenshot({ path: test.info().outputPath(`${name}.png`), fullPage: true }) }
/** Reset demo clears every change and goes back to Today. */
async function resetDemo(page: Page) {
  await page.getByRole('button', { name: /Demo switches/ }).click()
  await page.getByRole('button', { name: 'Reset demo' }).click()
  await page.getByRole('button', { name: 'Close demo switches' }).click()
  await expect(page.getByRole('heading', { level: 1 }).first()).toContainText('things need you')
}
const settingsPage = async (page: Page, label: string) => {
  await side(page).getByRole('button', { name: /account and settings/i }).click()
  await page.getByRole('menuitem', { name: 'Your settings' }).click()
  await page.getByRole('navigation', { name: 'Settings' }).getByRole('button', { name: label }).click()
}

test('Settings: a dropdown opens a real list, the pick survives a reload and Reset demo clears it', async ({ page, fx }) => {
  await start(fx, 'Act', '#/settings/you-general')
  // New York is the default zone, shown by its name (the saved value stays the zone's id).
  const zone = page.getByRole('combobox', { name: 'Time zone: Eastern Time (New York)' })
  await zone.click()
  const list = page.getByRole('listbox', { name: 'Time zone' })
  await expect(list.getByRole('option')).toHaveCount(9)
  await expect(list.getByRole('option', { name: 'Eastern Time (New York)' })).toHaveAttribute('aria-selected', 'true')
  await shot(page, 'settings-dropdown-open')
  await list.getByRole('option', { name: 'Central Time (Chicago)' }).click()
  await expect(list).toHaveCount(0)
  await expect(page.getByRole('combobox', { name: 'Time zone: Central Time (Chicago)' })).toBeVisible()
  // Saved as the zone's id, not its name.
  expect((await fx.saved()).demo.settings?.['g:tz']).toBe('America/Chicago')

  // It persists across a reload.
  await page.reload()
  await expect(page.getByRole('combobox', { name: 'Time zone: Central Time (Chicago)' })).toBeVisible()

  await resetDemo(page)
  await settingsPage(page, 'General')
  await expect(page.getByRole('combobox', { name: 'Time zone: Eastern Time (New York)' })).toBeVisible()
  await page.reload()
  await expect(page.getByRole('combobox', { name: 'Time zone: Eastern Time (New York)' })).toBeVisible()
})

test('Settings: a dropdown works from the keyboard and Escape closes it without a change', async ({ page, fx }) => {
  await start(fx, 'Act', '#/settings/you-notif')
  const send = page.getByRole('combobox', { name: 'Send alerts to: Slack' })
  await send.focus()
  await page.keyboard.press('ArrowDown')
  const list = page.getByRole('listbox', { name: 'Send alerts to' })
  // Focus moves into the list, onto the current value.
  await expect(list.getByRole('option', { name: 'Slack', exact: true })).toBeFocused()
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Escape')
  await expect(list).toHaveCount(0)
  await expect(send).toBeFocused()
  await expect(send).toHaveAttribute('aria-expanded', 'false')

  await page.keyboard.press('ArrowDown')
  await expect(list.getByRole('option', { name: 'Slack', exact: true })).toBeFocused()
  await page.keyboard.press('ArrowDown')
  await expect(list.getByRole('option', { name: 'Email and Slack' })).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('combobox', { name: 'Send alerts to: Email and Slack' })).toBeFocused()
})

test('Settings: Who approves what and the spending cap dropdowns change their values', async ({ page, fx }) => {
  await start(fx, 'Run', '#/settings/team-approvals')
  const rule = page.getByRole('combobox', { name: /^Orders over \$5,000: Dana Kim/ })
  await rule.click()
  // Call 3 (P2): approving is a job per rule, not a role, so every member is offered (Sam, Dana, Leo, Priya) and Anyone who approves.
  await expect(page.getByRole('option')).toHaveCount(5)
  await expect(page.getByRole('option', { name: 'Priya Shah' })).toBeVisible()
  await page.getByRole('option', { name: 'Sam Mercer' }).click()
  await expect(page.getByRole('combobox', { name: 'Orders over $5,000: Sam Mercer' })).toBeVisible()
  await page.goto('/?demo#/settings/team-spend')
  await page.getByRole('combobox', { name: 'Show amounts in: USD ($)' }).click()
  await page.getByRole('option', { name: 'GBP (£)' }).click()
  await expect(page.getByRole('combobox', { name: 'Show amounts in: GBP (£)' })).toBeVisible()
  await shot(page, 'settings-spend')
})

test('Settings: a text field is editable, saved, shown in the account menu and cleared by Reset demo', async ({ page, fx }) => {
  await start(fx, 'Act', '#/settings/you-general')
  const name = page.getByRole('textbox', { name: 'Name', exact: true })
  await expect(name).toHaveValue('Sam Mercer')
  await name.fill('Samuel Mercer')
  await page.reload()
  await expect(page.getByRole('textbox', { name: 'Name', exact: true })).toHaveValue('Samuel Mercer')
  await side(page).getByRole('button', { name: /account and settings/i }).click()
  await expect(page.getByRole('menu', { name: 'Account' })).toBeVisible()
  await expect(page.getByRole('menu', { name: 'Account' }).getByText('Samuel Mercer', { exact: true })).toBeVisible()
  await page.keyboard.press('Escape')

  await page.getByRole('navigation', { name: 'Settings' }).getByRole('button', { name: 'Spending cap' }).click()
  await page.getByRole('textbox', { name: 'Monthly cap' }).fill('$400')
  await expect(page.getByRole('textbox', { name: 'Monthly cap' })).toHaveValue('$400')

  await resetDemo(page)
  await settingsPage(page, 'General')
  await expect(page.getByRole('textbox', { name: 'Name', exact: true })).toHaveValue('Sam Mercer')
})

test('Settings: search filters the menu to matching pages and rows', async ({ page, fx }) => {
  await start(fx, 'Act', '#/settings/you-general')
  const nav = page.getByRole('navigation', { name: 'Settings' })
  const menu = nav.locator('button[data-nav-row]')
  const search = page.getByRole('searchbox', { name: 'Search settings' })
  // 14 with P5 W4's Slack notices: the sample brand has Slack connected (a brand without it keeps 13, brand-data.spec.ts).
  await expect(menu).toHaveCount(14)

  await search.fill('time zone')
  await expect(menu).toHaveCount(1)
  await expect(menu.filter({ hasText: /General/ })).toContainText('Time zone')

  // Matches on a row's text, across pages.
  await search.fill('retention')
  await expect(menu).toHaveCount(0)
  await search.fill('older chats')
  await expect(menu.filter({ hasText: /Data and access/ })).toContainText('Chats')
  await menu.filter({ hasText: /Data and access/ }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Data and access' })).toBeVisible()
  await shot(page, 'settings-search')

  await search.fill('zzzz')
  await expect(menu).toHaveCount(0)
  await expect(page.getByText('No settings match "zzzz".')).toBeVisible()
  // Escape clears the box and the whole menu comes back.
  await search.press('Escape')
  await expect(search).toHaveValue('')
  await expect(menu).toHaveCount(14)
})

test('Chats: there is no Chats item in the nav; New chat and Recent chats stay', async ({ page, fx }) => {
  await start(fx)
  await expect(page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Chats' })).toHaveCount(0)
  await expect(side(page).getByRole('button', { name: 'Chats', exact: true })).toHaveCount(0)
  await expect(side(page).getByRole('button', { name: 'New chat' })).toBeVisible()
  await expect(side(page).getByText('Recent chats')).toBeVisible()
  await expect(side(page).getByRole('button', { name: 'See all' })).toBeVisible()
})

test('Chats: each recent chat opens its own conversation', async ({ page, fx }) => {
  await start(fx)
  const chats: [string, string][] = [
    ['Stuck orders over 3 days', '3 orders · $556'],
    ['Why did refunds jump?', 'Refund requests rose from 14 last week to 31 this week.'],
    ["What to feature in Friday's email", 'The Cairn Insulated Bottle is the safe pick'],
    ['Amazon payout gap', 'paid $18,420'],
  ]
  for (const [name, text] of chats) {
    await side(page).getByRole('button', { name, exact: true }).click()
    await expect(page.getByRole('banner')).toContainText(name)
    await expect(page.locator('main').getByText(text).first()).toBeVisible()
    await expect(side(page).getByRole('button', { name, exact: true })).toHaveAttribute('aria-current', 'page')
    await shot(page, `chat-${name.replace(/\W+/g, '-').toLowerCase()}`)
    // The others are not in it.
    for (const [, other] of chats.filter(([n]) => n !== name)) await expect(page.locator('main').getByText(other)).toHaveCount(0)
  }
  // A question asked in one chat stays with it.
  await side(page).getByRole('button', { name: 'Why did refunds jump?', exact: true }).click()
  await page.getByRole('textbox', { name: 'Message Inhouse' }).fill('And last week?')
  await page.keyboard.press('Enter')
  await expect(page.locator('main').getByText('And last week?')).toBeVisible()
  await side(page).getByRole('button', { name: 'Amazon payout gap', exact: true }).click()
  await expect(page.locator('main').getByText('And last week?')).toHaveCount(0)
  await side(page).getByRole('button', { name: 'Why did refunds jump?', exact: true }).click()
  await expect(page.locator('main').getByText('And last week?')).toBeVisible()
})

test('Chats: every seeded answer has its steps line and, opened, its model and seconds, from its own trace', async ({ page, fx }) => {
  const traces = json('traces.json').traces as Record<string, { durationSeconds: number; steps: { kind: string; label: string; detail?: string }[] }>
  const toolNames = (json('tools.json').details as Record<string, { name: string }>)
  const names = Object.values(toolNames).map(d => d.name)
  const modes = json('models.json').modes as { id: string; label: string; model: string }[]
  const secs = (x: number) => (x < 60 ? `${Math.round(x * 10) / 10}s` : `${Math.floor(x / 60)}m ${Math.round(x % 60)}s`)
  type Turn = { user?: string; stage?: string; trace?: string; model?: string }
  const seed = json('chat-script.json').seedThread.turns as Turn[]
  const chats = json('chats.json').chats as { id: string; turns: 'seedThread' | Turn[] }[]
  await start(fx)
  for (const c of chats) {
    // In Act, the answers that show: each turn's footer is its last answer's trace.
    const expected: string[] = []
    const expectedMeta: string[] = []
    let inAnswer = false
    for (const t of typeof c.turns === 'string' ? seed : c.turns) {
      if (t.user) { inAnswer = false; continue }
      const tr = traces[t.trace!.split(' ')[0]]
      // Its model is the mode (models.json) whose model its trace's last model step names, so the line and the steps agree.
      // Checked for every stage's answer, not only the ones Act shows.
      const last = tr.steps.filter(x => x.kind === 'model').at(-1)?.detail?.split(' · ')[0]
      const mode = modes.find(m => m.id === t.model)
      expect(mode?.model, `${c.id}: ${t.trace}`).toBe(last)
      if (t.stage && t.stage !== 'Act') continue
      // The steps line names the connected tools the run read (not wrote to), in order, with a check, and counts the steps; the model and seconds are in the opened list.
      const read = [...new Set(tr.steps.filter(x => x.kind === 'tool' && !/^(saved|sent|created|posted|updated|wrote|drafted|deleted|changed|added|scheduled|replied|approved)\b/i.test(x.label.split(' · ').slice(1).join(' · '))).map(x => x.label.split(' · ')[0]).filter(n => names.includes(n)))]
      const named = read.length > 1 ? `${read.slice(0, -1).join(', ')} and ${read.at(-1)}` : read.join('')
      const line = `${read.length ? `Checked ${named} · ` : ''}${tr.steps.length - 1} steps`
      const meta = `${mode!.label} · ${secs(tr.durationSeconds)}`
      if (inAnswer) { expected[expected.length - 1] = line; expectedMeta[expectedMeta.length - 1] = meta } else { expected.push(line); expectedMeta.push(meta) }
      inAnswer = true
    }
    await page.evaluate(id => { location.hash = `#/chats/${id}` }, c.id)
    const lines = page.getByRole('log', { name: 'Conversation' }).locator('[data-steps] > button')
    await expect(lines, c.id).toHaveText(expected.map(l => new RegExp(`^${l.startsWith('Checked') ? 'check' : ''}${l.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}chevron_right$`)))
    await expect(lines.first(), c.id).toBeVisible()
    for (const line of await lines.all()) await line.click()
    await expect(page.getByRole('log', { name: 'Conversation' }).locator('[data-steps-meta]'), c.id).toHaveText(expectedMeta)
  }
  await shot(page, 'chat-footers-stuck')
})

test('Chats: See all lists every chat, search filters by title, picking one opens it', async ({ page, fx }) => {
  await start(fx)
  await side(page).getByRole('button', { name: 'See all' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'All chats' })).toBeVisible()
  const main = page.locator('main')
  for (const t of ['Stuck orders over 3 days', 'Why did refunds jump?', "What to feature in Friday's email", 'Amazon payout gap', 'Weekly numbers, Nov 7 to 13', 'Ridge 30L reorder quantity', 'Meta Ads on low-stock products', 'Kestrel delivery times']) {
    await expect(main.getByRole('button', { name: new RegExp(t.replace(/[?']/g, '.')) })).toBeVisible()
  }
  await expect(main.getByRole('region', { name: 'Today' })).toBeVisible()
  await expect(main.getByRole('region', { name: 'Earlier' })).toBeVisible()
  await shot(page, 'chats-see-all')

  const search = main.getByRole('searchbox', { name: 'Search chats' })
  await search.fill('kestrel')
  await expect(main.getByRole('button', { name: /Kestrel delivery times/ })).toBeVisible()
  await expect(main.getByRole('button', { name: /Amazon payout gap/ })).toHaveCount(0)
  await search.fill('nothing like this')
  await expect(main.getByText('No chats match "nothing like this".')).toBeVisible()
  await search.fill('RIDGE')
  await main.getByRole('button', { name: /Ridge 30L reorder quantity/ }).click()
  await expect(page.getByRole('banner')).toContainText('Ridge 30L reorder quantity')
  await expect(main.getByText('You sell about 21 a day and have 295 left')).toBeVisible()
  await shot(page, 'chat-ridge')

  // The old #/chats link still works.
  await page.goto('/?demo&again=1#/chats')
  await expect(page.getByRole('banner')).toContainText('Stuck orders over 3 days')
})

test('Tools and Skills: search filters the lists; the tool page links to the vendor', async ({ page, fx }) => {
  await start(fx, 'Act', '#/tools')
  const search = page.getByRole('searchbox', { name: 'Search tools' })
  await search.fill('ship')
  await expect(page.getByRole('button', { name: /ShipBob/ })).toBeVisible()
  await expect(page.getByText('ShipStation')).toBeVisible()
  await expect(page.getByRole('button', { name: /Xero/ })).toHaveCount(0)
  await shot(page, 'tools-search')
  await search.fill('qqq')
  await expect(page.getByText('No tools match "qqq"')).toBeVisible()
  await page.goto('/?demo#/tools/shopify')
  await expect(page.getByRole('link', { name: /shopify\.com/ })).toHaveAttribute('href', 'https://shopify.com')

  await page.goto('/?demo#/skills')
  const skills = page.getByRole('searchbox', { name: 'Search skills' })
  await skills.fill('reorder')
  await expect(page.getByText('Your skills')).toBeVisible()
  await shot(page, 'skills-search')
  await skills.fill('qqq')
  await expect(page.getByText('No skills match "qqq".')).toBeVisible()
})

test('Usage: the month picker lists this month, the chart ends today; Today sorts by amount; Help and Sign out answer', async ({ page, fx }) => {
  await start(fx, 'Act', '#/usage')
  await expect(page.getByText('$78.40').first()).toBeVisible()
  // One bar a day up to today, Mon, Nov 16, and the projection follows them: $78.40 over 16 days is about $147.
  await expect(page.locator('[data-usage-bar]')).toHaveCount(16)
  await expect(page.locator('[data-usage-bar]').last()).toHaveAccessibleName('Nov 16: $2.40')
  await expect(page.getByText('On track for about $147 this month, under your cap')).toBeVisible()
  // November is the first month with spend, the only one: a picker with one month offers no choice, so there is none.
  await expect(page.getByRole('combobox', { name: /^Month/ })).toHaveCount(0)
  await shot(page, 'usage-november')

  await page.goto('/?demo#/today')
  const first = page.getByRole('article').first()
  await expect(first).toContainText('Trail Shell Jacket (M, Olive) is oversold by 5')
  await page.getByRole('combobox', { name: 'Sort cards: Most urgent first' }).click()
  await page.getByRole('option', { name: 'Biggest amount first' }).click()
  await expect(page.getByRole('article').first()).toContainText('Ridge 30L Pack runs out in 9 days')

  await side(page).getByRole('button', { name: /account and settings/i }).click()
  await page.getByRole('menuitem', { name: 'Help and guides' }).click()
  const help = page.getByRole('dialog', { name: 'Help and guides' })
  await help.getByRole('button', { name: 'How approvals work' }).click()
  await expect(help).toContainText('you have 10 seconds to undo')
  await shot(page, 'help-window')
  await page.keyboard.press('Escape')
  await expect(help).toHaveCount(0)

  await side(page).getByRole('button', { name: /account and settings/i }).click()
  await page.getByRole('menuitem', { name: 'Sign out' }).click()
  await expect(page.getByRole('status').filter({ hasText: "Sign out isn't connected in this demo" })).toBeVisible()
})

// ---------- one fact, one value (M35, M10, M34) ----------

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

test('Data: every "Mon, Nov 16" in the sample data has the right weekday on the 2026 calendar', () => {
  const found: string[] = []
  const wrong: string[] = []
  for (const [file, path, text] of personText()) {
    for (const m of text.matchAll(/\b(Sun|Mon|Tue|Wed|Thu|Fri|Sat), (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{1,2})\b/g)) {
      const month = MONTHS.indexOf(m[2])
      // The demo is November 2026; January dates are the next year.
      const d = new Date(month === 0 ? 2027 : 2026, month, Number(m[3]))
      found.push(m[0])
      if (WEEKDAYS[d.getDay()] !== m[1]) wrong.push(`${file} ${path}: "${m[0]}" is a ${WEEKDAYS[d.getDay()]}`)
    }
  }
  // The long form too ("Monday, November 16").
  const LONG_DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
  const LONG_MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
  for (const [file, path, text] of personText()) {
    for (const m of text.matchAll(new RegExp(`\\b(${LONG_DAYS.join('|')}), (${LONG_MONTHS.join('|')}) (\\d{1,2})\\b`, 'g'))) {
      const month = LONG_MONTHS.indexOf(m[2])
      const d = new Date(month === 0 ? 2027 : 2026, month, Number(m[3]))
      found.push(m[0])
      if (LONG_DAYS[d.getDay()] !== m[1]) wrong.push(`${file} ${path}: "${m[0]}" is a ${LONG_DAYS[d.getDay()]}`)
    }
  }
  expect(found.length).toBeGreaterThan(20)
  expect(wrong).toEqual([])
  // The demo's own day.
  expect(json('meta.json').fixedClock.label).toBe('Monday, November 16, 2026')
})

test('Data: every time stored as data is a valid day offset and local time, or a clock time', () => {
  machineTimes.length = 0
  personText()
  expect(machineTimes.length).toBeGreaterThan(20)
  const wrong = machineTimes.filter(([, , v]) => {
    const m = /^(?:([+-]?\d+)d )?(\d{2}):(\d{2})$/.exec(v)
    return !m || Number(m[2]) > 23 || Number(m[3]) > 59 || (m[1] !== undefined && Math.abs(Number(m[1])) > 60)
  }).map(([f, p, v]) => `${f} ${p}: ${v}`)
  expect(wrong).toEqual([])
})

test('Data: no text a person reads holds a 24-hour time, "2025", an old "17 Nov" date, UK spelling or the words sample, demo or mock', () => {
  const bad: string[] = []
  for (const [file, path, text] of personText()) {
    const checks: [RegExp, string][] = [
      [/\b\d{1,2}:[0-5]\d\b(?! [AP]M)/, '24-hour time'],
      [/\b2025\b/, '2025'],
      [/\b\d{1,2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b/, 'day before month'],
      [/\b(colour|summaris|fulfilment|centre|organis|favour|behaviour|catalogue)/i, 'UK spelling'],
      [/\b(sample|demo|mock)\b/i, 'sample, demo or mock'],
    ]
    // "Last October" is last year's month, so that one source line is the only 2025 allowed.
    for (const [re, what] of checks) if (re.test(text) && text !== 'Sales, October 2025') bad.push(`${file} ${path} (${what}): ${text.slice(0, 80)}`)
  }
  // The answers written in code, not in the data: the formatted query answer and the ask-for-a-time reply.
  const mock = mockSource()
  const inCode = [/const QUERY_ANSWER = \[([\s\S]*?)\]\.join/, /const ASK_FOR_TIME = ('.*')/].map(re => re.exec(mock)?.[1])
  expect(inCode.every(Boolean), 'the answers in the demo agent were found').toBe(true)
  for (const text of inCode as string[]) {
    for (const [re, what] of [[/\b(sample|demo|mock)\b/i, 'sample, demo or mock'], [/\b2025\b/, '2025'], [/\b(colour|summaris|fulfilment|centre|organis|favour|behaviour|catalogue)/i, 'UK spelling'], [/\b\d{1,2}:[0-5]\d\b(?!( |\\u00a0)[AP]M)/, '24-hour time']] as [RegExp, string][]) {
      if (re.test(text)) bad.push(`mock.ts (${what}): ${text.slice(0, 80)}`)
    }
  }
  expect(bad).toEqual([])
})

test('Data: the month so far has one daily figure a day up to today, and the figures add up', () => {
  const u = json('usage.json')
  const sum = (xs: number[]) => Math.round(xs.reduce((a, b) => a + b, 0) * 100) / 100
  // The demo is Mon, Nov 16: sixteen days of November, Nov 1 with nothing spent (the first tool connected on Nov 2).
  expect(u.dailyDollars).toHaveLength(16)
  expect(u.capReached.dailyDollars).toHaveLength(16)
  expect(u.dailyDollars[0]).toBe(0)
  expect(u.capReached.dailyDollars[0]).toBe(0)
  expect(sum(u.dailyDollars)).toBe(u.totalDollars)
  expect(sum(u.capReached.dailyDollars)).toBe(u.capReached.totalDollars)
  // No earlier month: nothing was spent before November.
  expect(json('usage-history.json').months).toEqual([])
})

test('Data: a file made in a chat names that chat by its title', () => {
  const titles = new Map((json('chats.json').chats as { id: string; title: string }[]).map(c => [c.id, c.title]))
  titles.set('stuck', json('chat-script.json').seedThread.title)
  const files = json('library.json').files as { id: string; from: string; link?: { to: string; id?: string } }[]
  const fromChats = files.filter(f => f.link?.to === 'chat')
  expect(fromChats.length).toBeGreaterThan(3)
  for (const f of fromChats) expect(f.from, f.id).toBe('Chat: ' + titles.get(f.link!.id!))
})

test("Data: every seeded answer names its own trace, and its steps and seconds are that trace's", () => {
  const traces = json('traces.json').traces as Record<string, { durationSeconds: number; steps: { kind: string; endSeconds: number }[] }>
  type Turn = { trace?: string; agent?: { type: string }[] }
  const chats = json('chats.json').chats as { id: string; at: string; turns: 'seedThread' | Turn[] }[]
  const seed = json('chat-script.json').seedThread.turns as Turn[]
  const answers = chats.flatMap(c => (typeof c.turns === 'string' ? seed : c.turns).map(t => ({ chat: c.id, ...t }))).filter(t => t.agent)
  const used = new Map<string, string>()
  for (const a of answers) {
    const key = (a.trace ?? '').split(' ')[0]
    expect(traces[key], `${a.chat}: trace "${a.trace}"`).toBeTruthy()
    // One trace per answer: two answers on the same steps would show the same seconds for different work. Stage
    // variants of one turn share it.
    const owner = used.get(key)
    expect(owner === undefined || owner === a.chat, `trace "${key}" is used by ${owner} and ${a.chat}`).toBe(true)
    used.set(key, a.chat)
    // The answer's footer is its one link to the steps: no work row repeats it with its own time.
    expect(a.agent!.filter(p => p.type === 'workRow'), `${a.chat}: a work row`).toEqual([])
    const t = traces[key]
    expect(t.steps[0].kind).toBe('root')
    expect(t.steps[0].endSeconds).toBe(t.durationSeconds)
  }
  // The scripted answers name traces that exist too.
  const script = json('chat-script.json')
  for (const k of [...script.scripted.map((x: { trace: string }) => x.trace), script.fallback.trace, script.firstDayTrace, script.loadingTrace]) {
    expect(traces[String(k).split(' ')[0]], `scripted trace "${k}"`).toBeTruthy()
  }
  // All chats is newest first by a real time.
  const ats = chats.map(c => offsetMin(c.at))
  expect(ats).toEqual([...ats].sort((a, b) => b - a))
})

test('Data: PO-1187, the stuck-orders window, the cap and Slack each have one value', () => {
  // PO-1187: the Today card's amount is the PDF's total, and the price list prices it.
  const po = (json('problems.json').problems as { id: string; cost: { minor: number; currency: string } }[]).find(p => p.id === 'po')!
  const files = json('library.json').files as { id: string; doc?: { table?: { rows: string[][]; total?: string[] } } }[]
  const pdf = files.find(f => f.id === 'a-po-1187')!
  const dollars = (v: string) => Number(v.replace(/[$,]/g, '')) || 0
  expect(po.cost.currency).toBe('USD')
  expect(Math.round(dollars(pdf.doc!.table!.total![2]) * 100)).toBe(po.cost.minor)
  // Its lines add up to its total: units and dollars.
  const lines = pdf.doc!.table!.rows
  expect(lines.reduce((a, r) => a + dollars(r[2]), 0)).toBe(dollars(pdf.doc!.table!.total![2]))
  expect(lines.reduce((a, r) => a + (Number(r[1]) || 0), 0)).toBe(Number(pdf.doc!.table!.total![1]))
  const all = personText().map(([, , t]) => t).join('\n')
  expect(all).not.toContain('$19,320')
  // Stuck orders: one window, "over 3 days", wherever a number of days goes with it.
  expect(all).not.toMatch(/stuck over [0-24-9] days|not picked after [0-24-9] days/)
  // Slack is a channel from Act, not a tool to add.
  const tools = json('tools.json')
  expect(tools.catalog.map((c: { k: string }) => c.k)).not.toContain('slack')
  expect(tools.channels.map((c: { key: string; need: number }) => [c.key, c.need])).toEqual([['slack', 1]])
  // The Cap reached month spends exactly the cap, and its cost per conversation matches this month's.
  const u = json('usage.json')
  const sum = (xs: number[]) => Math.round(xs.reduce((a, b) => a + b, 0) * 100) / 100
  expect(u.capReached.totalDollars).toBe(u.capDollars)
  expect(sum(u.capReached.dailyDollars)).toBe(u.capDollars)
  expect((u.capReached.totalDollars / u.capReached.conversations).toFixed(2)).toBe((u.totalDollars / u.conversations).toFixed(2))
  // A routine locked in Watch has no skill active in Watch.
  const skills = json('skills.json').skills as { n: string; need: number }[]
  for (const r of json('routines.json').routines as { name: string; need: number }[]) {
    const skill = skills.find(k => r.name.toLowerCase().includes(k.n.toLowerCase()))
    if (skill) expect(skill.need, `${skill.n} vs the ${r.name} routine`).toBeGreaterThanOrEqual(r.need)
  }
})

test('Data: the bell is newest first, no denied text anywhere a person reads, no chat reads a tool before it was connected, and Klaviyo has one date', () => {
  const bell = (json('notifications.json').notifications as { at: string }[]).map(n => offsetMin(n.at))
  expect(bell, 'the bell, newest first').toEqual([...bell].sort((a, b) => b - a))

  // E2E_DENY_NAMES is a comma-separated list of texts that must never show; unset or empty, a generic list of placeholders stands in.
  const deny = (process.env.E2E_DENY_NAMES || 'lorem,TODO,sample data').split(',').map(d => d.trim().toLowerCase()).filter(Boolean)
  expect(personText().filter(([, , t]) => deny.some(d => t.toLowerCase().includes(d))), 'text with a denied name or placeholder').toEqual([])

  // A chat's answers read only tools that were connected by the chat's day ("since": "-3d 09:00"). A tool still being
  // connected has `liveBy` instead, and no chat reads it.
  const tools = json('tools.json')
  const since = new Map((Object.values(tools.details) as { name: string; since?: string }[]).flatMap(d => (d.since ? [[d.name, dayOf(d.since)] as const] : [])))
  const traces = json('traces.json').traces as Record<string, { steps: { kind: string; label: string }[] }>
  const late: string[] = []
  // (The stuck chat's turns are the seed thread in chat-script.json, named here by a string, and it's dated today, after every tool was connected.)
  for (const c of json('chats.json').chats as { id: string; at: string; turns: { trace?: string }[] | string }[]) {
    const day = dayOf(c.at)
    for (const key of (Array.isArray(c.turns) ? c.turns : []).flatMap(t => (t.trace ? [t.trace.split(' ')[0]] : []))) {
      for (const s of traces[key]?.steps ?? []) {
        const on = s.kind === 'tool' ? since.get(s.label.split(' · ')[0]) : undefined
        if (on !== undefined && on > day) late.push(`${c.id} (${c.at}) reads ${s.label} before it was connected`)
      }
    }
  }
  expect(late).toEqual([])

  // Klaviyo goes live on one date, wherever it's said.
  const liveDay = new Date(2026, 10, 16 + dayOf(tools.details.klaviyo.liveBy))
  const live = `${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][liveDay.getDay()]}, Nov ${liveDay.getDate()}`
  const dates = personText().filter(([, , t]) => /klaviyo/i.test(t) && /Nov \d/.test(t)).map(([f, path, t]) => [f, path, /\w{3}, Nov \d{1,2}/.exec(t)?.[0]])
  expect(dates.length).toBeGreaterThan(0)
  expect(dates.filter(([, , d]) => d !== live)).toEqual([])
})

test('Facts agree across screens: PO-1187, the waiting count and the stuck-orders window', async ({ page, fx }) => {
  await start(fx)
  // The waiting count: Today, the nav badge, the bell and Approvals.
  await expect(page.getByRole('heading', { level: 1 })).toContainText('6 things need you')
  // The badge adds the demo's three agent cards waiting on Sam (Stage 1 M3-U: two batches and a teammate's refund).
  await expect(page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: /Approvals/ })).toContainText('9')
  await page.getByRole('button', { name: /^Notifications/ }).click()
  await expect(page.getByRole('dialog', { name: 'Notifications' })).toContainText('6 drafts are waiting for your approval.')
  await page.keyboard.press('Escape')
  await page.goto('/?demo#/approvals')
  await expect(page.getByRole('heading', { level: 2, name: /^Waiting for you/ })).toHaveText(/·\s6$/)

  // PO-1187: $5,100 on its Today card and in its PDF in the Library.
  await page.goto('/?demo#/today')
  await expect(page.getByRole('article').filter({ hasText: 'PO-1187 from Kestrel is 6 days late' })).toContainText('$5,100')
  await page.goto('/?demo#/library')
  await page.getByRole('list', { name: 'Files' }).getByRole('listitem').filter({ hasText: 'PO-1187-kestrel-summit-fleece.pdf' }).first().click()
  const viewer = page.getByRole('dialog', { name: 'File: PO-1187-kestrel-summit-fleece.pdf' })
  await expect(viewer).toContainText('$5,100')
  await expect(viewer).not.toContainText('$19,320')
  await shot(page, 'facts-po-1187-pdf')

  // Stuck orders: the chat, its routine and the skill say "over 3 days".
  await page.goto('/?demo#/chats/stuck')
  const log = page.getByRole('log', { name: 'Conversation' })
  await expect(log).toContainText('stuck over 3 days')
  await expect(log).not.toContainText(/over 2 days/)
  // In Act no chat says what it can't do "in Watch".
  await page.goto('/?demo#/chats/refunds')
  await expect(log).not.toContainText('in Watch')
})

test('Activity: every time sits on one line', async ({ page, fx }) => {
  await start(fx, 'Run', '#/activity')
  // Run shows the most lines, "10:12 AM" the widest time.
  const times = page.locator('[data-activity-time]')
  await expect(times.first()).toBeVisible()
  await expect(page.locator('main')).toContainText('10:12 AM')
  const lines = await times.evaluateAll(els => els.map(e => ({ t: e.textContent, lines: Math.round(e.getBoundingClientRect().height / parseFloat(getComputedStyle(e).lineHeight)) })))
  expect(lines.filter(l => l.lines !== 1), 'times that wrap').toEqual([])
  await shot(page, 'activity-times')
})

test('The Klaviyo request shows its status, never a date, and hides on First day; Ask Leo says it isn\'t connected; the audit CSV has plain spaces', async ({ page, fx }) => {
  await start(fx, 'Act')
  const team = page.getByRole('dialog', { name: 'Your Inhouse team' })
  /** The team window, from the account menu's "Your Inhouse team", once the item counts `open` requests. */
  const openTeam = async (open: number) => {
    await side(page).getByRole('button', { name: /account and settings/i }).click()
    const item = page.getByRole('menu', { name: 'Account' }).getByRole('menuitem', { name: /^Your Inhouse team/ })
    await expect(item).toHaveAccessibleName(`Your Inhouse team ${open} open`)
    await item.click()
  }
  // Two open requests: the Klaviyo connection and the weekly wholesale job.
  await openTeam(2)
  await team.getByRole('radio', { name: /^Your requests/ }).click()
  const openList = team.getByRole('list', { name: 'Open requests' })
  await expect(openList.getByRole('listitem')).toHaveCount(2)
  await expect(openList.getByRole('listitem').filter({ hasText: 'Connect Klaviyo' })).toContainText('With the team')
  await expect(openList).not.toContainText(/Live by|Call on/)
  await page.keyboard.press('Escape')
  await expect(team).toHaveCount(0)

  // The approver's Ask button says it isn't wired up, as a sentence.
  await page.getByRole('article', { name: 'Trail Shell Jacket (M, Olive) is oversold by 5' }).click({ position: { x: 12, y: 12 } })
  const panel = page.getByRole('dialog')
  // Asking the approver is in the window's More menu.
  await panel.getByRole('button', { name: 'More', exact: true }).click()
  await page.getByRole('menu', { name: 'More actions' }).getByRole('menuitem', { name: 'Ask Leo' }).click()
  await expect(page.locator('[data-toast]').filter({ hasText: "Asking Leo isn't connected in this demo." })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(panel).toHaveCount(0)

  // The audit log's download: its times have a plain space, not the screen's no-break space.
  await page.evaluate(() => { location.hash = '#/settings/team-audit' })
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download CSV' }).click()])
  const csv = readFileSync(await download.path(), 'utf8')
  expect(csv).toMatch(/\d [AP]M/)
  expect(csv).not.toContain(' ')

  // First day: nothing is being connected yet, so the menu counts one request fewer.
  await page.getByRole('button', { name: /^Demo switches:/ }).click()
  await page.getByRole('dialog', { name: 'Demo switches' }).getByRole('button', { name: 'First day', exact: true }).click()
  await page.getByRole('button', { name: 'Close demo switches' }).click()
  // The Klaviyo request is no longer listed or counted.
  await openTeam(1)
  await expect(team).toBeVisible()
  await team.getByRole('radio', { name: /^Your requests/ }).click()
  const firstDay = team.getByRole('list', { name: 'Open requests' })
  await expect(firstDay.getByRole('listitem')).toHaveCount(1)
  await expect(firstDay).toContainText('Weekly wholesale stock report')
  await expect(firstDay).not.toContainText('Connect Klaviyo')
  await shot(page, 'team-window-first-day')
})
