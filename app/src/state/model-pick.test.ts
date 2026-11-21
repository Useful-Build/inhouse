// The model a person picks in the composer survives a reload. Ways it fails, written first: the saved choice is checked against
// the team's models while the product has not read them yet (an empty list), so it is thrown away and the picker reads the
// default again ("Fast" before a reload, "Smart" after); or the check is dropped altogether, so an id the team doesn't offer
// stays picked once the models are known. Driven the way the app does it (as session.upgrade.test.ts does): save a session in
// local storage, make a fresh store and read what it restored.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentData } from '../agent/types'

let storage: Map<string, string>
beforeEach(() => {
  storage = new Map()
  vi.stubGlobal('localStorage', { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => { storage.set(k, v) }, removeItem: (k: string) => { storage.delete(k) } })
  vi.stubGlobal('window', { addEventListener: () => undefined })
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

const SESSION_KEY = 'inhouse.ui.session.v1'

/** A fresh store over an agent whose models are `models` (null: the demo's own four), after a session that picked `picked`. */
async function restoredPick(picked: unknown, models: string[] | null): Promise<string | null> {
  storage.set(SESSION_KEY, JSON.stringify({ started: [], chats: {}, drafts: {}, todayDraft: '', modelSel: picked, feedback: {}, libraryView: 'masonry', answering: [], queued: {} }))
  vi.resetModules()
  if (models !== null) {
    const { agent } = await import('../agent')
    const real = agent.read.bind(agent)
    vi.spyOn(agent, 'read').mockImplementation(() => ({ ...real(), models: real().models.filter(m => models.includes(m.id)) }) as AgentData)
  }
  const { useUi } = await import('./store')
  return useUi.getState().modelSel
}

describe('the picked model after a reload', () => {
  it('is kept while the product has not read its models yet', async () => {
    expect(await restoredPick('sonnet', [])).toBe('sonnet')
  })
  it('is kept when the team offers it', async () => {
    expect(await restoredPick('sonnet', ['sonnet', 'opus'])).toBe('sonnet')
  })
  it('is dropped when the models are known and the team does not offer it', async () => {
    expect(await restoredPick('haiku', ['sonnet', 'opus'])).toBeNull()
  })
  it('is dropped when it is not a string', async () => {
    expect(await restoredPick(7, [])).toBeNull()
    expect(await restoredPick(null, [])).toBeNull()
  })
})
