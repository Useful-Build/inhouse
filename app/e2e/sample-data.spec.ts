// Every control shows real sample data and works: Settings dropdowns, text fields and search, the chats
// (each opens its own conversation, See all lists them), and the search boxes and pickers on other pages.
import { readFileSync, readdirSync } from 'node:fs'
import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { atRest } from './states.js'

/** The sample data, read straight from its folder for the data checks. */
const DATA_DIR = new URL('../src/agent/sample-data/', import.meta.url)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const json = (name: string): any => JSON.parse(readFileSync(new URL(name, DATA_DIR), 'utf8'))
const DATA_FILES = readdirSync(DATA_DIR).filter(f => f.endsWith('.json'))
/** Keys that hold notes for whoever edits the data: never shown in the app. */
const NOTE_KEYS = new Set(['fieldGuide', 'sampleFacts', 'rowShape', 'usedBy', 'stepKinds', 'rule', 'kinds', 'openQuestion', 'placeholders'])
/** Keys that hold machine values (ids, keys, paths, ISO times): never shown as text. A video's duration ("1:36") isn't a time of day. */
/** A `note` is shown text (a Library doc's note, a routine card's notes), except the editor's note at a file's top level
 *  and on usage.json's Cap reached block. */
const EDITOR_NOTES = new Set(['usage.json.capReached.note'])
const MACHINE_KEYS = new Set(['iso', 'id', 'k', 'key', 'src', 'poster', 'photo', 'logo', 'icon', 'sev', 'kind', 'type', 'place', 'site', 'problemId', 'trace', 'match', 'ratio', 'media', 'opens', 'onlyInScenario', 'duration', 'tool'])
/** Every string a person can read in the app, as [file, path, text]. */
function personText(): [string, string, string][] {
  const out: [string, string, string][] = []
  const walk = (file: string, v: unknown, path: string, key: string) => {
    if (NOTE_KEYS.has(key) || (key === 'note' && (path === `${file}.note` || EDITOR_NOTES.has(path)))) return
    if (typeof v === 'string') {
      if (!MACHINE_KEYS.has(key) && !(key === 'at' && /^\d{4}-\d\d-\d\dT/.test(v))) out.push([file, path, v])
      return
    }
    if (Array.isArray(v)) { v.forEach((x, i) => walk(file, x, `${path}[${i}]`, key)); return }
    if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(file, x, `${path}.${k}`, k)
  }
  for (const f of DATA_FILES) walk(f, json(f), f, '')
  return out
}

async function start(page: Page, stage: 'Watch' | 'Act' | 'Run' = 'Act', hash = '#/today') {
  await page.addInitScript(([s]) => {
    if (sessionStorage.getItem('e2e-seeded')) return
    localStorage.clear()
    localStorage.setItem('inhouse.demo.switches.v1', JSON.stringify({ stage: s, scenario: 'Normal', ambient: 'Always', animateMark: false }))
    sessionStorage.setItem('e2e-seeded', '1')
  }, [stage])
  await page.goto('/?demo' + hash)
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

test('Settings: a dropdown opens a real list, the pick survives a reload and Reset demo clears it', async ({ page }) => {
  await start(page, 'Act', '#/settings/you-general')
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
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('inhouse.demo.v2') ?? '{}').settings?.['g:tz'])).toBe('America/Chicago')

  // It persists across a reload.
  await page.reload()
  await expect(page.getByRole('combobox', { name: 'Time zone: Central Time (Chicago)' })).toBeVisible()

  await resetDemo(page)
  await settingsPage(page, 'General')
  await expect(page.getByRole('combobox', { name: 'Time zone: Eastern Time (New York)' })).toBeVisible()
  await page.reload()
  await expect(page.getByRole('combobox', { name: 'Time zone: Eastern Time (New York)' })).toBeVisible()
})

test('Settings: a dropdown works from the keyboard and Escape closes it without a change', async ({ page }) => {
  await start(page, 'Act', '#/settings/you-notif')
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

test('Settings: Who approves what and the spending cap dropdowns change their values', async ({ page }) => {
  await start(page, 'Run', '#/settings/team-approvals')
  const rule = page.getByRole('combobox', { name: /^Orders over \$5,000: Dana Kim/ })
  await rule.click()
  await expect(page.getByRole('option')).toHaveCount(4)
  await page.getByRole('option', { name: 'Sam Mercer' }).click()
  await expect(page.getByRole('combobox', { name: 'Orders over $5,000: Sam Mercer' })).toBeVisible()
  await page.goto('/?demo#/settings/team-spend')
  await page.getByRole('combobox', { name: 'Show amounts in: USD ($)' }).click()
  await page.getByRole('option', { name: 'GBP (£)' }).click()
  await expect(page.getByRole('combobox', { name: 'Show amounts in: GBP (£)' })).toBeVisible()
  await shot(page, 'settings-spend')
})

test('Settings: a text field is editable, saved, shown in the account menu and cleared by Reset demo', async ({ page }) => {
  await start(page, 'Act', '#/settings/you-general')
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

test('Settings: search filters the menu to matching pages and rows', async ({ page }) => {
  await start(page, 'Act', '#/settings/you-general')
  const nav = page.getByRole('navigation', { name: 'Settings' })
  const menu = nav.locator('button[data-nav-row]')
  const search = page.getByRole('searchbox', { name: 'Search settings' })
  await expect(menu).toHaveCount(13)

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
  await expect(menu).toHaveCount(13)
})

test('Chats: there is no Chats item in the nav; New chat and Recent chats stay', async ({ page }) => {
  await start(page)
  await expect(page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Chats' })).toHaveCount(0)
  await expect(side(page).getByRole('button', { name: 'Chats', exact: true })).toHaveCount(0)
  await expect(side(page).getByRole('button', { name: 'New chat' })).toBeVisible()
  await expect(side(page).getByText('Recent chats')).toBeVisible()
  await expect(side(page).getByRole('button', { name: 'See all' })).toBeVisible()
})

test('Chats: each recent chat opens its own conversation', async ({ page }) => {
  await start(page)
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
  await page.getByRole('textbox', { name: 'Message your Inhouse agent' }).fill('And last week?')
  await page.keyboard.press('Enter')
  await expect(page.locator('main').getByText('And last week?')).toBeVisible()
  await side(page).getByRole('button', { name: 'Amazon payout gap', exact: true }).click()
  await expect(page.locator('main').getByText('And last week?')).toHaveCount(0)
  await side(page).getByRole('button', { name: 'Why did refunds jump?', exact: true }).click()
  await expect(page.locator('main').getByText('And last week?')).toBeVisible()
})

test('Chats: every seeded answer ends with its footer, its model, steps and seconds from its own trace', async ({ page }) => {
  const traces = json('traces.json').traces as Record<string, { durationSeconds: number; steps: { kind: string; detail?: string }[] }>
  const modes = json('models.json').modes as { id: string; label: string; model: string }[]
  const secs = (x: number) => (x < 60 ? `${Math.round(x * 10) / 10}s` : `${Math.floor(x / 60)}m ${Math.round(x % 60)}s`)
  type Turn = { user?: string; stage?: string; trace?: string; model?: string }
  const seed = json('chat-script.json').seedThread.turns as Turn[]
  const chats = json('chats.json').chats as { id: string; turns: 'seedThread' | Turn[] }[]
  await start(page)
  for (const c of chats) {
    // In Act, the answers that show: each turn's footer is its last answer's trace.
    const expected: string[] = []
    let inAnswer = false
    for (const t of typeof c.turns === 'string' ? seed : c.turns) {
      if (t.user) { inAnswer = false; continue }
      if (t.stage && t.stage !== 'Act') continue
      const tr = traces[t.trace!.split(' ')[0]]
      // Its model is the mode (models.json) whose model its trace's last model step names, so the line and the steps agree.
      const last = tr.steps.filter(x => x.kind === 'model').at(-1)?.detail?.split(' · ')[0]
      const mode = modes.find(m => m.id === t.model)
      expect(mode?.model, `${c.id}: ${t.trace}`).toBe(last)
      const line = `${mode!.label} · ${tr.steps.length - 1} steps · ${secs(tr.durationSeconds)}`
      if (inAnswer) expected[expected.length - 1] = line; else expected.push(line)
      inAnswer = true
    }
    await page.evaluate(id => { location.hash = `#/chats/${id}` }, c.id)
    const footers = page.getByRole('log', { name: 'Conversation' }).locator('button span.tabular-nums').filter({ hasText: /steps ·/ })
    await expect(footers, c.id).toHaveText(expected)
    await expect(footers.first(), c.id).toBeVisible()
  }
  await shot(page, 'chat-footers-stuck')
})

test('Chats: See all lists every chat, search filters by title, picking one opens it', async ({ page }) => {
  await start(page)
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

test('Tools and Skills: search filters the lists; the tool page links to the vendor', async ({ page }) => {
  await start(page, 'Act', '#/tools')
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

test('Usage: the month picker lists this month, the chart ends today; Today sorts by amount; Help and Sign out answer', async ({ page }) => {
  await start(page, 'Act', '#/usage')
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
  const mock = readFileSync(new URL('../src/agent/mock.ts', import.meta.url), 'utf8')
  const inCode = [/const QUERY_ANSWER = \[([\s\S]*?)\]\.join/, /const ASK_FOR_TIME = ('.*')/].map(re => re.exec(mock)?.[1])
  expect(inCode.every(Boolean), 'the answers in mock.ts were found').toBe(true)
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
  const chats = json('chats.json').chats as { id: string; iso: string; turns: 'seedThread' | Turn[] }[]
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
  const isos = chats.map(c => c.iso)
  expect(isos).toEqual([...isos].sort().reverse())
})

test('Data: PO-1187, the stuck-orders window, the cap and Slack each have one value', () => {
  // PO-1187: the Today card's amount is the PDF's total, and the price list prices it.
  const po = (json('problems.json').problems as { id: string; cost: string }[]).find(p => p.id === 'po')!
  const files = json('library.json').files as { id: string; doc?: { table?: { rows: string[][]; total?: string[] } } }[]
  const pdf = files.find(f => f.id === 'a-po-1187')!
  expect(pdf.doc!.table!.total![2]).toBe(po.cost)
  // Its lines add up to its total: units and dollars.
  const dollars = (v: string) => Number(v.replace(/[$,]/g, '')) || 0
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
  const DAY_MIN = 24 * 60
  /** "7:30 AM" is today (Mon, Nov 16); "Fri, Nov 13" is that day. As minutes, for ordering. */
  const minutes = (when: string) => {
    const t = /^(\d{1,2}):(\d\d)[ \u00a0](AM|PM)$/.exec(when)
    if (t) return 16 * DAY_MIN + (Number(t[1]) % 12 + (t[3] === 'PM' ? 12 : 0)) * 60 + Number(t[2])
    const d = /^\w{3}, Nov (\d{1,2})$/.exec(when)
    if (!d) throw new Error(`The bell has a time it can't read: "${when}"`)
    return Number(d[1]) * DAY_MIN
  }
  const bell = (json('notifications.json').notifications as { when: string }[]).map(n => minutes(n.when))
  expect(bell, 'the bell, newest first').toEqual([...bell].sort((a, b) => b - a))

  // E2E_DENY_NAMES is a comma-separated list of texts that must never show; unset or empty, a generic list of placeholders stands in.
  const deny = (process.env.E2E_DENY_NAMES || 'lorem,TODO,sample data').split(',').map(d => d.trim().toLowerCase()).filter(Boolean)
  expect(personText().filter(([, , t]) => deny.some(d => t.toLowerCase().includes(d))), 'text with a denied name or placeholder').toEqual([])

  // A chat's answers read only tools that were connected by the chat's day ("since": "Nov 13").
  const tools = json('tools.json')
  const since = new Map((Object.values(tools.details) as { name: string; since: string }[]).map(d => [d.name, d.since]))
  const traces = json('traces.json').traces as Record<string, { steps: { kind: string; label: string }[] }>
  const late: string[] = []
  // (The stuck chat's turns are the seed thread in chat-script.json, named here by a string, and it's dated today, after every tool was connected.)
  for (const c of json('chats.json').chats as { id: string; iso: string; turns: { trace?: string }[] | string }[]) {
    const day = Number(c.iso.slice(8, 10))
    for (const key of (Array.isArray(c.turns) ? c.turns : []).flatMap(t => (t.trace ? [t.trace.split(' ')[0]] : []))) {
      for (const s of traces[key]?.steps ?? []) {
        const on = s.kind === 'tool' ? /^Nov (\d{1,2})$/.exec(since.get(s.label.split(' · ')[0]) ?? '') : null
        if (on && Number(on[1]) > day) late.push(`${c.id} (${c.iso}) reads ${s.label} before it was connected`)
      }
    }
  }
  expect(late).toEqual([])

  // Klaviyo goes live on one date, wherever it's said.
  const live = /Live by (\w{3}, Nov \d{1,2})$/.exec(tools.details.klaviyo.since)![1]
  const dates = personText().filter(([, , t]) => /klaviyo/i.test(t) && /Nov \d/.test(t)).map(([f, path, t]) => [f, path, /\w{3}, Nov \d{1,2}/.exec(t)?.[0]])
  expect(dates.length).toBeGreaterThan(0)
  expect(dates.filter(([, , d]) => d !== live)).toEqual([])
})

test('Facts agree across screens: PO-1187, the waiting count and the stuck-orders window', async ({ page }) => {
  await start(page)
  // The waiting count: Today, the nav badge, the bell and Approvals.
  await expect(page.getByRole('heading', { level: 1 })).toContainText('6 things need you')
  await expect(page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: /Approvals/ })).toContainText('6')
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

test('Activity: every time sits on one line in its column', async ({ page }) => {
  await start(page, 'Run', '#/activity')
  // Run shows the most lines, "10:12 AM" the widest time.
  const times = page.locator('[data-activity-row] > span:first-child')
  await expect(times.first()).toBeVisible()
  await expect(page.locator('main')).toContainText('10:12 AM')
  const lines = await times.evaluateAll(els => els.map(e => ({ t: e.textContent, lines: Math.round(e.getBoundingClientRect().height / parseFloat(getComputedStyle(e).lineHeight)) })))
  expect(lines.filter(l => l.lines !== 1), 'times that wrap').toEqual([])
  await shot(page, 'activity-times')
})

test('The Klaviyo line takes its date from the data and hides on First day; Ask Leo says it isn\'t connected; the audit CSV has plain spaces', async ({ page }) => {
  await start(page, 'Act')
  const live = side(page).getByText(/goes live by/)
  await expect(live).toHaveText('Klaviyo goes live by Fri, Nov 20.')
  const team = page.getByRole('dialog', { name: 'Your Inhouse team' })
  await side(page).getByRole('button', { name: 'Message the team →' }).click()
  await expect(team).toContainText('Live by Fri, Nov 20')
  await page.keyboard.press('Escape')
  await expect(team).toHaveCount(0)

  // The approver's Ask button says it isn't wired up, as a sentence.
  await page.getByRole('article', { name: 'Trail Shell Jacket (M, Olive) is oversold by 5' }).click({ position: { x: 12, y: 12 } })
  const panel = page.getByRole('dialog')
  await panel.getByRole('button', { name: 'Ask Leo' }).click()
  await expect(page.locator('[data-toast]').filter({ hasText: "Asking Leo isn't connected in this demo." })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(panel).toHaveCount(0)

  // The audit log's download: its times have a plain space, not the screen's no-break space.
  await page.evaluate(() => { location.hash = '#/settings/team-audit' })
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download CSV' }).click()])
  const csv = readFileSync(await download.path(), 'utf8')
  expect(csv).toMatch(/\d [AP]M/)
  expect(csv).not.toContain(' ')

  // First day: nothing is being connected yet, so neither the sidebar nor the team window names a date.
  await page.getByRole('button', { name: /^Demo switches:/ }).click()
  await page.getByRole('dialog', { name: 'Demo switches' }).getByRole('button', { name: 'First day', exact: true }).click()
  await page.getByRole('button', { name: 'Close demo switches' }).click()
  await expect(live).toHaveCount(0)
  await side(page).getByRole('button', { name: 'Message the team →' }).click()
  await expect(team).toBeVisible()
  await expect(team).not.toContainText('Live by')
  await shot(page, 'team-window-first-day')
})
