// The mock client's side of the spec fixtures: the only file under e2e/ that knows the mock's storage keys, its demo URL
// and its sample data. Specs go through `fx` (../fx.ts); P2 adds clients/real.ts beside this one.
import { readFileSync } from 'node:fs'
import type { Page } from '@playwright/test'

export type Stage = 'Watch' | 'Act' | 'Run'
export type Theme = 'light' | 'dark'
export type Seed = {
  stage: Stage
  /** A scenario switch ("Normal", "First day", "Loading", "Cap reached", "Tool disconnected"). Default "Normal". */
  scenario?: string
  theme?: Theme
  /** Seed on the first load of the tab only (a reload keeps what the page saved). Default true. */
  once?: boolean
}

/** What the mock keeps in the browser. Never change these: a returning visitor keeps their demo. */
const KEYS = {
  switches: 'inhouse.demo.switches.v1',
  session: 'inhouse.demo.v2',
  theme: 'inhouse.theme',
} as const
const SEEDED = 'e2e-seeded'

/** The sample data's names, read from the data files so a spec never repeats a sample string it can look up. */
export type Names = {
  brand: string
  user: { id: string; name: string; initials: string; email: string; title: string; role: string }
  people: { id: string; name: string; email: string; role: string }[]
  tools: { connected: string[]; beingConnected: string[]; catalog: { key: string; name: string }[] }
  chats: { id: string; title: string }[]
}

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

export function mockClient(page: Page) {
  const install = (stored: Record<string, string>, once: boolean) =>
    page.addInitScript(([entries, onlyOnce, mark]) => {
      if (onlyOnce && sessionStorage.getItem(mark)) return
      localStorage.clear()
      for (const [k, v] of entries) localStorage.setItem(k, v)
      if (onlyOnce) sessionStorage.setItem(mark, '1')
    }, [Object.entries(stored), once, SEEDED] as const)

  return {
    names: sampleNames(),
    /** Clears the browser's storage, then writes the demo switches (and a theme) before the app loads. */
    seed({ stage, scenario = 'Normal', theme, once = true }: Seed) {
      const stored: Record<string, string> = {
        [KEYS.switches]: JSON.stringify({ stage, scenario, ambient: 'Off', animateMark: false }),
      }
      if (theme) stored[KEYS.theme] = theme
      return install(stored, once)
    },
    /** Clears the browser's storage, then writes exactly these stored values (key to string) before the app loads. */
    seedRaw(stored: Record<string, string>, once = true) {
      return install(stored, once)
    },
    /** Back to a clean demo: clears the storage of the page that is open. Call it after the page has loaded. */
    async reset() {
      await page.evaluate(() => { localStorage.clear(); sessionStorage.clear() })
    },
    /** Opens the demo at a route ("#/today"). */
    open(hash = '') {
      return page.goto('/?demo' + hash)
    },
    /** The real-time stamp the demo saved at its first load (ms): the zero of its clock. */
    demoStartedAt() {
      return page.evaluate(k => JSON.parse(localStorage.getItem(k) ?? '{}').demoStartedAt as number, KEYS.session)
    },
  }
}
