// The spec fixture `fx`: sample names, and seeding, reading back or resetting the app's state, without a spec knowing the
// mock's storage keys or its sample strings. Specs opt in with: import { expect, test } from './support/fx.js'
// `test` is the CSP guard's test (../csp.ts) plus `fx`, so every spec that uses it keeps the guard.
//
// `Fx` below is what a client must provide. clients/mock.ts implements it for the demo; P2 adds clients/real.ts.
import type { Response } from '@playwright/test'
import { expect, test as base } from '../csp.js'
import { mockClient } from './clients/mock.js'

export type Stage = 'Watch' | 'Act' | 'Run'
export type Theme = 'light' | 'dark'
/** The demo's dot sweep. "When Ava works" is the value an old version saved; the app maps it to "When working". */
export type Ambient = 'Always' | 'Off' | 'When working' | 'When Ava works'

/**
 * Demo-only switches. Nothing here exists outside the mock: a real client refuses a seed that carries `demo`
 * (it throws), so a spec that needs it can't run against the real app by accident.
 */
export type DemoSwitches = {
  /** Default "Off". */
  ambient?: Ambient
  /** Default false. */
  animateMark?: boolean
  /** A brand other than the sample one: its name, and whether the sample's Slack channel shows. */
  brand?: { brandName: string; channels: boolean }
}

export type Seed = {
  stage: Stage
  /** A scenario switch ("Normal", "First day", "Loading", "Cap reached", "Tool disconnected"). Default "Normal". */
  scenario?: string
  /** The app's own theme preference (product too), saved before the app loads. */
  theme?: Theme
  /** Seed on the first load of the tab only (a reload keeps what the page saved). Default true. */
  once?: boolean
  demo?: DemoSwitches
}

/** Changes the stage (and demo switches) on the loads that follow, keeping everything the page saved. */
export type Restage = Pick<Seed, 'stage' | 'scenario' | 'demo'>

/** The demo's saved state, as the app wrote it (or as an earlier version did): a spec passes old values to check they load. */
export type SavedDemo = Record<string, unknown>

/** What the app saved, parsed. A missing entry reads as empty. */
export type Saved = {
  /** The demo's saved state. */
  demo: {
    settings?: Record<string, string>
    chatTitles?: Record<string, string>
    chatPinned?: Record<string, boolean>
    chatDeleted?: Record<string, boolean>
    demoStartedAt?: number
  } & Record<string, unknown>
  /** The demo's run turns: [turn id, info]. */
  runs: [string, { trace: string }][]
  /** The app's UI session (open chats, queued messages). */
  session: {
    chats?: Record<string, { extras: { role: string; text?: string; part?: { type: string } }[] }>
    answering?: string[]
    queued?: Record<string, unknown>
  } & Record<string, unknown>
}

/** The sample data's names, read from the data files so a spec never repeats a sample string it can look up. */
export type Names = {
  brand: string
  user: { id: string; name: string; initials: string; email: string; title: string; role: string }
  people: { id: string; name: string; email: string; role: string }[]
  tools: { connected: string[]; beingConnected: string[]; catalog: { key: string; name: string }[] }
  chats: { id: string; title: string }[]
}

export interface Fx {
  /** Read lazily: seeding never depends on the sample data's shape. */
  readonly names: Names
  /** Starts the page from a clean state (storage cleared) with these settings, before the app loads. One seed per page. */
  seed(s: Seed): Promise<void>
  /** `seed`, plus a saved demo state written under it. Demo-only. One seed per page. */
  seedSaved(s: Seed, saved: SavedDemo): Promise<void>
  /** Changes the stage on later loads of this page, keeping saved state (a mid-test move to another stage). */
  restage(s: Restage): Promise<void>
  /** What the app has saved, parsed. Call it on a loaded page. */
  saved(): Promise<Saved>
  /**
   * Back to a clean demo: the next load starts from nothing, with no earlier seed applied. Navigates the page away
   * (so the app can't write back), clears its storage, and leaves the page blank: call `open` (or `seed` then `open`)
   * afterwards. Cookies are the one thing it leaves alone: don't clear them between `reset` and the next load.
   */
  reset(): Promise<void>
  /** Opens the app at a route ("#/today"). */
  open(hash?: string): Promise<Response | null>
}

export const test = base.extend<{ fx: Fx }>({
  fx: async ({ page }, provide) => { await provide(mockClient(page)) },
})

export { expect }
