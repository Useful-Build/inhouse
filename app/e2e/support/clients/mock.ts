// The mock client's side of the spec fixtures: where the mock's storage keys, its demo URL and its sample data live
// (with support/capture/ and support/fixtures/). Specs go through `fx` (../fx.ts); P2 adds clients/real.ts beside this one.
import { readFileSync } from 'node:fs'
import type { Page } from '@playwright/test'
import type { Fx, Names, Restage, Saved, Seed, SavedDemo } from '../fx.js'

export type { Names, Seed, Stage, Theme } from '../fx.js'

/** What the mock keeps in the browser. Never change these: a returning visitor keeps their demo. */
const KEYS = {
  switches: 'inhouse.demo.switches.v1',
  demo: 'inhouse.demo.v2',
  runs: 'inhouse.demo.runs.v1',
  brand: 'inhouse.demo.data.v1',
  session: 'inhouse.ui.session.v1',
  theme: 'inhouse.theme',
} as const
const RESET_COOKIE = 'e2e-reset'

const DATA = new URL('../../../src/agent/sample-data/', import.meta.url)
const read = (file: string) => JSON.parse(readFileSync(new URL(file, DATA), 'utf8'))

export function sampleNames(): Names {
  const meta = read('meta.json')
  const people = read('people-and-rules.json')
  const tools = read('tools.json')
  const chats = read('chats.json')
  return {
    brand: meta.brand.name,
    user: meta.currentUser,
    people: people.members.map((m: Names['people'][number]) => ({ id: m.id, name: m.name, email: m.email, role: m.role })),
    tools: {
      connected: tools.connected,
      beingConnected: tools.beingConnected,
      catalog: tools.catalog.map((t: { k: string; name: string }) => ({ key: t.k, name: t.name })),
    },
    chats: chats.chats.map((c: { id: string; title: string }) => ({ id: c.id, title: c.title })),
  }
}

/** Per page: the id of the last script installed, whether the page was seeded, and the last id a reset switched off. */
const pages = new WeakMap<Page, { n: number; seeded: boolean }>()
const stateOf = (page: Page) => {
  let s = pages.get(page)
  if (!s) pages.set(page, (s = { n: 0, seeded: false }))
  return s
}

type Script = { id: number; entries: [string, string][]; once: boolean; clear: boolean }
/** Runs before every document of the page. A script whose id a reset has passed does nothing. */
function applySeed({ id, entries, once, clear }: Script) {
  const reset = /(?:^|;\s*)e2e-reset=(\d+)/.exec(document.cookie)
  if (reset && id <= Number(reset[1])) return
  const mark = `e2e-seeded-${id}`
  if (once && sessionStorage.getItem(mark)) return
  if (clear) localStorage.clear()
  for (const [k, v] of entries) localStorage.setItem(k, v)
  if (once) sessionStorage.setItem(mark, '1')
}

const switches = ({ stage, scenario = 'Normal', demo }: Restage) => ({
  [KEYS.switches]: JSON.stringify({ stage, scenario, ambient: demo?.ambient ?? 'Off', animateMark: demo?.animateMark ?? false }),
})

export function mockClient(page: Page): Fx & { demoStartedAt(): Promise<number> } {
  let names: Names | undefined
  const install = async (entries: Record<string, string>, once: boolean, clear: boolean) => {
    const st = stateOf(page)
    await page.addInitScript(applySeed, { id: ++st.n, entries: Object.entries(entries), once, clear })
  }
  const seedOnce = async (s: Seed, saved?: SavedDemo) => {
    const st = stateOf(page)
    if (st.seeded) throw new Error('fx.seed: this page was already seeded. Seed once per page; use fx.restage to change the stage later, or fx.reset first.')
    st.seeded = true
    const stored: Record<string, string> = switches(s)
    if (s.theme) stored[KEYS.theme] = s.theme
    if (s.demo?.brand) stored[KEYS.brand] = JSON.stringify(s.demo.brand)
    if (saved) stored[KEYS.demo] = JSON.stringify(saved)
    await install(stored, s.once ?? true, true)
  }
  const saved = async (): Promise<Saved> => {
    const [demo, runs, session] = await page.evaluate(
      keys => keys.map(k => localStorage.getItem(k)),
      [KEYS.demo, KEYS.runs, KEYS.session],
    )
    return { demo: JSON.parse(demo ?? '{}'), runs: JSON.parse(runs ?? '[]'), session: JSON.parse(session ?? '{}') }
  }

  return {
    get names() { return (names ??= sampleNames()) },
    seed: s => seedOnce(s),
    seedSaved: (s, savedDemo) => seedOnce(s, savedDemo),
    restage: s => install(switches(s), false, false),
    saved,
    async reset() {
      const st = stateOf(page)
      const origin = page.url().startsWith('http') ? new URL(page.url()).origin : null
      // 1. Leave the app, so its pagehide save has run and it can't write again.
      await page.goto('about:blank')
      // 2. Switch off every seed script installed so far, for every later load (a cookie survives the navigation).
      st.seeded = false
      if (!origin) return
      await page.context().addCookies([{ name: RESET_COOKIE, value: String(st.n), url: origin }])
      // 3. Clear the origin's storage from a page that isn't the app. The CSP header keeps the CSP guard armed.
      const blank = `${origin}/e2e-reset.html`
      await page.route(blank, r => r.fulfill({
        contentType: 'text/html', headers: { 'content-security-policy': "default-src 'none'" }, body: '<!doctype html><title>reset</title>',
      }))
      try {
        await page.goto(blank)
        await page.evaluate(() => { localStorage.clear(); sessionStorage.clear() })
      } finally {
        await page.unroute(blank)
        await page.goto('about:blank')
      }
    },
    open: (hash = '') => page.goto('/?demo' + hash),
    /** The real-time stamp the demo saved at its first load (ms): the zero of its clock. Mock only (states.ts). */
    async demoStartedAt() { return (await saved()).demo.demoStartedAt as number },
  }
}
