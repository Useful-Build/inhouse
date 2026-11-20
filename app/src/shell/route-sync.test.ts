// The hash sync against a fake address bar, with the app's own writes modelled (they go through the same `HashBar`). Ways it can fail:
//  1. the race: the person sets a hash, and the app re-renders (resize, data) before `hashchange` is read, so the app writes its
//     old page over it (the phone Usage spec, #106);
//  2. the same race through the other triggers: the phone settings menu flipping, a new chat getting its id;
//  3. a hash that names where the app already is (`#/chats` with the newest chat open, `#/settings` on desktop) is left as typed, and
//     the next real move then replaces an entry where it should push one;
//  4. the app's own out-of-band writes (App tidying an unknown link, the Library closing a direct file link) leave the record of
//     what it wrote stale, and the guard swallows the next real move;
//  5. the guard swallows a real in-app move, or treats `#/chats` on an older chat, or `#/chats/new` on a started chat, as the same place.
import { describe, expect, it } from 'vitest'
import { createHashBar, createHashSync } from './route-sync'
import type { Parsed, Place } from './route-sync'

const SLUGS: Record<string, string> = { today: 'today', usage: 'usage', chats: 'chats', settings: 'settings', library: 'library' }
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
  let replaceNext = false
  const hashBar = createHashBar({
    hash: () => entries[entries.length - 1],
    state: () => null,
    replace: (_s, h) => { entries[entries.length - 1] = h },
    push: (_s, h) => { entries.push(h) },
  })
  const sync = createHashSync(hashBar, { toHash, fromHash, takeReplaceEntry: () => { const r = replaceNext; replaceNext = false; return r }, fromMenuState: 'menu' })
  return {
    entries, hashBar, sync,
    setHash: (h: string) => { entries[entries.length - 1] = h },
    /** The listener runs, as App's `apply` does: it adopts the hash; for an unknown one it then writes the canonical hash. */
    hashchange: (unknownTo?: string) => { hashBar.adopt(); if (unknownTo) hashBar.replace(unknownTo) },
    replaceNext: () => { replaceNext = true },
  }
}
const place = (over: Partial<Place> = {}): Place => ({ page: 'settings', appKey: '', setTab: 'team-spend', chatKey: 'new', menu: false, phone: false, chatIsNew: false, defaultChat: 'c1', ...over })

describe('a hash someone set wins over a re-render (failure 1)', () => {
  it('leaves #/usage alone when the effect re-runs for the phone flag before hashchange', () => {
    const b = bar('#/settings/team-spend')
    b.sync.sync(place())
    b.setHash('#/usage')
    b.sync.sync(place({ phone: true }))
    expect(b.entries).toEqual(['#/usage'])
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
    b.sync.sync(place({ page: 'chats', chatKey: 'c9', chatIsNew: true }))
    expect(b.entries).toEqual(['#/usage'])
  })
})

describe('a hash that names the same place in other words is tidied, and the next move pushes (failure 3)', () => {
  it('replaces #/chats with the newest chat, then pushes the next move', () => {
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
  })
})

describe('the app\'s own out-of-band writes keep the record true (failure 4)', () => {
  it('an unknown typed link: adopt, the app\'s canonical replace, then a rail move pushes', () => {
    const b = bar('#/today')
    b.sync.sync(place({ page: 'today' }))
    b.setHash('#/nowhere')
    b.hashchange('#/today')
    b.sync.sync(place({ page: 'usage' }))
    expect(b.entries).toEqual(['#/today', '#/usage'])
  })
  it('the Library closing a direct file link: its replace, then a rail move pushes', () => {
    const b = bar('#/library/f1')
    b.sync.sync(place({ page: 'library' }))
    b.hashBar.replace('#/library')
    b.sync.sync(place({ page: 'library' }))
    b.sync.sync(place({ page: 'today' }))
    expect(b.entries).toEqual(['#/library', '#/today'])
  })
})

describe('a real move still writes, and only the same place is "here" (failure 5)', () => {
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
  it('does not tidy a person-set #/chats while an older chat is open', () => {
    const b = bar('#/chats/c2')
    b.sync.sync(place({ page: 'chats', chatKey: 'c2', defaultChat: 'c1' }))
    b.setHash('#/chats')
    b.sync.sync(place({ page: 'chats', chatKey: 'c2', defaultChat: 'c1', phone: true }))
    expect(b.entries).toEqual(['#/chats'])
  })
  it('does not tidy a person-set #/chats/new on a chat that has an id', () => {
    const b = bar('#/chats/c9')
    b.sync.sync(place({ page: 'chats', chatKey: 'c9', chatIsNew: true }))
    b.setHash('#/chats/new')
    b.sync.sync(place({ page: 'chats', chatKey: 'c9', chatIsNew: true, phone: true }))
    expect(b.entries).toEqual(['#/chats/new'])
  })
  it('still replaces #/chats/new when the app gives its own new chat an id', () => {
    const b = bar('#/chats/new')
    b.sync.sync(place({ page: 'chats', chatKey: 'new' }))
    b.sync.sync(place({ page: 'chats', chatKey: 'c9', chatIsNew: true }))
    expect(b.entries).toEqual(['#/chats/c9'])
  })
})
