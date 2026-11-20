// The hash sync against a fake address bar. Ways it can fail, written down first:
//  1. the race: the person sets a hash, and the app re-renders (resize, data) before `hashchange` is read, so the app writes its
//     old page over it (the phone Usage spec, #106);
//  2. the same race through the other triggers: the phone settings menu flipping, a new chat getting its id;
//  3. a hash that names where the app already is in other words (`#/chats`, `#/settings` on desktop) is left as typed, and the
//     next real move then replaces an entry where it should push one (a lost Back entry);
//  4. the fix for 1 and 2 swallows a real in-app move.
import { describe, expect, it } from 'vitest'
import { createHashSync } from './route-sync'
import type { Parsed, Place } from './route-sync'

const SLUGS: Record<string, string> = { today: 'today', usage: 'usage', chats: 'chats', settings: 'settings' }
const toHash = (p: Place) => '#/' + SLUGS[p.page] + (p.page === 'settings' ? (p.menu ? '' : '/' + p.setTab) : p.page === 'chats' ? '/' + p.chatKey : '')
const fromHash = (h: string): Parsed | null => {
  if (!h.startsWith('#/')) return null
  const [slug, sub] = h.slice(2).split('/')
  const page = Object.keys(SLUGS).find(k => SLUGS[k] === slug)
  if (!page) return null
  return page === 'settings' ? (sub ? { page, setTab: sub, setMenu: false } : { page, setMenu: true }) : page === 'chats' ? (sub ? { page, chat: sub } : { page }) : { page }
}

/** A fake address bar with a history list. `setHash` is the person's (or a script's): no `hashchange` until `hashchange()`. */
function bar(initial: string) {
  const entries: string[] = [initial]
  const log: string[] = []
  let replaceNext = false
  const host = {
    hash: () => entries[entries.length - 1],
    state: () => null,
    replace: (_s: unknown, h: string) => { entries[entries.length - 1] = h; log.push(`replace ${h}`) },
    push: (_s: unknown, h: string) => { entries.push(h); log.push(`push ${h}`) },
  }
  const sync = createHashSync(host, { toHash, fromHash, takeReplaceEntry: () => { const r = replaceNext; replaceNext = false; return r }, fromMenuState: 'menu' })
  return {
    entries, log, sync,
    setHash: (h: string) => { entries[entries.length - 1] = h },
    /** The listener runs: it adopts the hash (and App.tsx then puts the route into the state). */
    hashchange: () => sync.adopt(),
    replaceNext: () => { replaceNext = true },
  }
}
const place = (over: Partial<Place> = {}): Place => ({ page: 'settings', appKey: '', setTab: 'team-spend', chatKey: 'new', menu: false, phone: false, chatIsNew: false, ...over })

describe('a hash someone set wins over a re-render (failure 1)', () => {
  it('leaves #/usage alone when the effect re-runs for the phone flag before hashchange', () => {
    const b = bar('#/settings/team-spend')
    b.sync.sync(place())
    b.setHash('#/usage')
    b.sync.sync(place({ phone: true }))
    expect(b.entries).toEqual(['#/usage'])
    expect(b.log).toEqual([])
  })
  it('then follows the app once the listener has read it', () => {
    const b = bar('#/settings/team-spend')
    b.setHash('#/usage')
    b.sync.sync(place({ phone: true }))
    b.hashchange()
    b.sync.sync(place({ page: 'usage', phone: true }))
    expect(b.entries).toEqual(['#/usage'])
  })
})

describe('the other triggers (failure 2)', () => {
  it('does not overwrite a set hash when the phone settings menu flips', () => {
    const b = bar('#/settings/team-spend')
    b.setHash('#/usage')
    b.sync.sync(place({ phone: true, menu: true }))
    expect(b.entries).toEqual(['#/usage'])
  })
  it('does not overwrite a set hash when a new chat gets its id', () => {
    const b = bar('#/chats/new')
    b.setHash('#/usage')
    b.sync.sync(place({ page: 'chats', chatKey: 'c1', chatIsNew: true }))
    expect(b.entries).toEqual(['#/usage'])
  })
})

describe('a hash that names the same place in other words is tidied, and the next move pushes (failure 3)', () => {
  it('replaces #/chats with the open chat, then pushes the next move', () => {
    const b = bar('#/chats/c1')
    b.sync.sync(place({ page: 'chats', chatKey: 'c1' }))
    b.setHash('#/chats')
    b.sync.sync(place({ page: 'chats', chatKey: 'c1', phone: true }))
    expect(b.entries).toEqual(['#/chats/c1'])
    b.sync.sync(place({ page: 'usage' }))
    expect(b.entries).toEqual(['#/chats/c1', '#/usage'])
  })
  it('replaces #/settings with the tab on desktop', () => {
    const b = bar('#/settings/team-spend')
    b.setHash('#/settings')
    b.sync.sync(place())
    expect(b.entries).toEqual(['#/settings/team-spend'])
    expect(b.log).toEqual(['replace #/settings/team-spend'])
  })
})

describe('a real move in the app still writes (failure 4)', () => {
  it('pushes an entry for a move, replaces for the one-shot flag and for an unreadable hash', () => {
    const b = bar('#/today')
    b.sync.sync(place({ page: 'today' }))
    b.sync.sync(place({ page: 'usage' }))
    expect(b.entries).toEqual(['#/today', '#/usage'])
    b.replaceNext()
    b.sync.sync(place({ page: 'chats', chatKey: 'c1' }))
    expect(b.entries).toEqual(['#/today', '#/chats/c1'])
    b.setHash('#main')
    b.sync.sync(place({ page: 'chats', chatKey: 'c1' }))
    expect(b.entries).toEqual(['#/today', '#/chats/c1'])
  })
})
