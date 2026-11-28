// The mock client's side of the spec fixtures: where the mock's storage keys, its demo URL and its sample data live
// (with support/capture/ and support/fixtures/). Specs go through `fx` (../fx.ts); P2 adds clients/real.ts beside this one.
import { readFileSync } from 'node:fs'
import type { Page } from '@playwright/test'
import type { Fx, Names, Restage, Saved, Seed, SavedDemo, Theme } from '../fx.js'

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
const RESET_MARK = 'e2e-reset'

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

/**
 * The last script id handed out. Ids count across every page, never per page: a popup starts with a copy of its opener's
 * sessionStorage (the reset mark and the once-marks with it), and a seed on the popup must not be skipped by a mark it
 * copied. A script installed after the copy always has a higher id than every mark in it.
 */
let lastId = 0

/** Per page: the id of the last script installed and whether the page was seeded. */
const pages = new WeakMap<Page, { n: number; seeded: boolean }>()
const stateOf = (page: Page) => {
  let s = pages.get(page)
  if (!s) pages.set(page, (s = { n: 0, seeded: false }))
  return s
}

type Script = { id: number; entries: [string, string][]; once: boolean; clear: boolean; stampStart?: boolean }
/**
 * Runs before every document of the page. The reset mark lives in this tab's sessionStorage (written by `reset`), so a
 * reset on one tab never switches off another tab's seeds. A script whose id the mark has passed does nothing. Ids are
 * unique across pages (`lastId`), so the marks a popup copies from its opener never cover a script of its own.
 */
function applySeed({ id, entries, once, clear, stampStart }: Script) {
  // about:blank and other non-http documents have no storage (it throws a SecurityError): nothing to seed there.
  if (!location.protocol.startsWith('http')) return
  const reset = sessionStorage.getItem('e2e-reset')
  if (reset && id <= Number(reset)) return
  const mark = `e2e-seeded-${id}`
  if (once && sessionStorage.getItem(mark)) return
  if (clear) localStorage.clear()
  for (const [k, v] of entries) {
    // The demo clock's zero is the time the seed applies in the browser, not when Node called seedSaved.
    localStorage.setItem(k, stampStart && k === 'inhouse.demo.v2' ? JSON.stringify({ demoStartedAt: Date.now(), ...JSON.parse(v) }) : v)
  }
  if (once) sessionStorage.setItem(mark, '1')
}

const switches = ({ stage, scenario = 'Normal', demo }: Restage) => ({
  [KEYS.switches]: JSON.stringify({ stage, scenario, ambient: demo?.ambient ?? 'Off', animateMark: demo?.animateMark ?? false }),
})

/**
 * The page's route has resolved. The Approvals, Routines, Activity, Tools and Skills pages (and the Library, Usage, Settings
 * and Streamdown markdown renderer) load their code lazily, so right after a navigation the page or an answer can still show
 * its Suspense fallback (`data-page-loading` or `data-markdown-loading`): a spec that reads or screenshots then sees the
 * fallback instead of the formatted view. `main` exists in the same render as either, so wait for `main` and both fallbacks
 * to go.
 */
export async function routeReady(page: Page): Promise<void> {
  await page.locator('main').waitFor()
  await page.locator('[data-page-loading]').waitFor({ state: 'detached' })
  await page.waitForFunction(() => !document.querySelector('[data-markdown-loading]'))
}

export function mockClient(page: Page, baseURL?: string): Fx & { demoStartedAt(): Promise<number> } {
  let names: Names | undefined
  const install = async (entries: Record<string, string>, once: boolean, clear: boolean, stampStart = false) => {
    const st = stateOf(page)
    st.n = ++lastId
    await page.addInitScript(applySeed, { id: st.n, entries: Object.entries(entries), once, clear, stampStart })
  }
  const seedOnce = async (s: Seed, saved?: SavedDemo) => {
    const st = stateOf(page)
    if (st.seeded) throw new Error('fx.seed: this page was already seeded. Seed once per page; use fx.restage to change the stage later, or fx.reset first.')
    st.seeded = true
    const stored: Record<string, string> = switches(s)
    if (s.theme) stored[KEYS.theme] = s.theme
    if (s.demo?.brand) stored[KEYS.brand] = JSON.stringify(s.demo.brand)
    if (saved) stored[KEYS.demo] = JSON.stringify(saved)
    await install(stored, s.once ?? true, true, !!saved)
  }
  const saved = async (): Promise<Saved> => {
    const [demo, runs, session, theme] = await page.evaluate(
      keys => keys.map(k => localStorage.getItem(k)),
      [KEYS.demo, KEYS.runs, KEYS.session, KEYS.theme],
    )
    return {
      demo: JSON.parse(demo ?? '{}'), runs: JSON.parse(runs ?? '[]'), session: JSON.parse(session ?? '{}'),
      ...(theme ? { theme: theme as Theme } : {}),
    }
  }

  return {
    get names() { return (names ??= sampleNames()) },
    seed: s => seedOnce(s),
    seedSaved: (s, savedDemo) => seedOnce(s, savedDemo),
    restage: s => install(switches(s), false, false),
    setTheme: theme => install({ [KEYS.theme]: theme }, false, false),
    saved,
    async reset() {
      const st = stateOf(page)
      const origin = page.url().startsWith('http') ? new URL(page.url()).origin : baseURL ? new URL(baseURL).origin : null
      if (!origin) throw new Error('fx.reset: the page is not on the app and the project has no baseURL, so there is no origin to clear.')
      // 1. Leave the app in every tab, so each pagehide save has run and no tab can write back after the clear.
      for (const p of page.context().pages()) if (p.url().startsWith('http')) await p.goto('about:blank')
      st.seeded = false
      // 2. Clear the origin's storage from a page that isn't the app (the CSP header keeps the CSP guard armed), then write
      //    this tab's reset mark: every seed script installed so far does nothing on this tab's later loads.
      const blank = `${origin}/e2e-reset.html`
      await page.route(blank, r => r.fulfill({
        contentType: 'text/html', headers: { 'content-security-policy': "default-src 'none'" }, body: '<!doctype html><title>reset</title>',
      }))
      try {
        await page.goto(blank)
        await page.evaluate(([mark, n]) => { localStorage.clear(); sessionStorage.clear(); sessionStorage.setItem(mark, n) }, [RESET_MARK, String(st.n)])
      } finally {
        await page.unroute(blank)
        await page.goto('about:blank')
      }
    },
    open: async (hash = '') => {
      const res = await page.goto('/?demo' + hash)
      await routeReady(page)
      return res
    },
    /** The real-time stamp the demo saved at its first load (ms): the zero of its clock. Mock only (states.ts). */
    async demoStartedAt() { return (await saved()).demo.demoStartedAt as number },
  }
}
