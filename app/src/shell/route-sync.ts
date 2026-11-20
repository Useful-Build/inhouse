// The address bar and the app's state follow each other: a change in the app writes the hash (`sync`, from an effect in
// App.tsx), a change to the hash (a typed link, Back, a script) is read into the app by the `hashchange` listener
// (`adopt`, then `applyRoute`). The write must never beat a hash someone else set. The hash event arrives after the effect
// that would write, so when the app re-renders for another reason in between (a phone-width resize flipping `phone` or
// `menu`, a chat id arriving when data loads), the effect would put the old page back and the person's change would be
// lost. So `sync` leaves a readable hash that wasn't the app's own and names another place alone: the listener reads it.
// A hash that names where the app already is, in its own words (`#/chats` with the newest chat open), is tidied to the
// canonical form with `replaceState`, so the next real move still pushes an entry.
//
// One writer: every write of the hash by the app (this sync, App's tidying of an unknown link, the Library's own moves, the
// error screen) goes through the `HashBar`, which records what it wrote. A raw `history.replaceState` anywhere else would
// leave that record stale, and `sync` would then take the app's own address for someone else's and swallow every move
// until the next hashchange. `build-support/route-sync-wiring.test.ts` fails when a raw write appears.


export interface Place { page: string; appKey: string; setTab: string; chatKey: string; menu: boolean; phone: boolean; chatIsNew: boolean; defaultChat: string | null }
/** A route read from a hash (`fromHash` in App.tsx). */
export interface Parsed { page?: string; appKey?: string; setTab?: string; chat?: string; setMenu?: boolean }
/** The browser's address bar and history, so a test can stand in for them. */
export interface HashHost { hash(): string; state(): unknown; replace(state: unknown, hash: string): void; push(state: unknown, hash: string): void }

/** The address bar with a record of the last hash the app wrote or read. The only place the app writes the hash. */
export function createHashBar(host: HashHost) {
  let written = host.hash()
  return {
    hash: () => host.hash(),
    state: () => host.state(),
    /** The last hash the app wrote or read. */
    written: () => written,
    /** The listener read the hash into the app: it is the app's own now. */
    adopt() { written = host.hash() },
    /** Replaces the current entry's hash. */
    replace(hash: string, state: unknown = null) { host.replace(state, hash); written = host.hash() },
    /** Adds an entry. */
    push(hash: string, state: unknown = null) { host.push(state, hash); written = host.hash() },
  }
}
export type HashBar = ReturnType<typeof createHashBar>

export interface SyncDeps {
  toHash(p: Place): string
  fromHash(hash: string): Parsed | null
  /** The store's one-shot "replace the next entry" flag (a settings page opened from the phone menu). */
  takeReplaceEntry(): boolean
  /** The history state of a settings page opened from the phone menu, so its Back button can step back. */
  fromMenuState: unknown
}

/** On a phone the settings menu and a settings page are two entries; desktop tidies #/settings into its page. */
const sameMenu = (cur: Parsed, p: Place) => !(p.page === 'settings' && p.phone) || (cur.setMenu ?? p.menu) === p.menu
const samePlace = (cur: Parsed, p: Place) => cur.page === p.page && (cur.appKey ?? p.appKey) === p.appKey && (cur.setTab ?? p.setTab) === p.setTab && sameMenu(cur, p)

/**
 * Whether a route names the place the app is in, in other words: `#/chats` is the newest chat, `#/settings` on desktop is
 * the open tab. A chat is never filled in from the place: `#/chats` while an older chat is open, or `#/chats/new` on a
 * chat that has an id, names somewhere else, and a hash like that is the person's, to be read.
 */
const namesHere = (cur: Parsed, p: Place): boolean =>
  samePlace(cur, p) && (p.page !== 'chats' || (cur.chat === undefined ? p.chatKey === (p.defaultChat ?? 'new') : cur.chat === p.chatKey))

export function createHashSync(bar: HashBar, deps: SyncDeps) {
  return {
    /** Writes the app's place into the hash, unless a hash someone else just set is waiting to be read. */
    sync(p: Place): void {
      const h = deps.toHash(p)
      const current = bar.hash()
      // An open Library file keeps its own link (#/library/<id>, see screens/library/route.ts).
      if (current === h || (p.page === 'library' && current.startsWith(`${h}/`))) { bar.adopt(); return }
      const cur = deps.fromHash(current)
      if (cur && current !== bar.written() && !namesHere(cur, p)) return
      // A hash that only needs tidying (none, unknown, the same place in other words) replaces the entry. A real move adds one.
      // A new chat getting its id when the first question is asked also replaces: Back skips the empty chat.
      const tidy = !cur || namesHere(cur, p) || (samePlace(cur, p) && p.page === 'chats' && cur.chat === 'new' && p.chatIsNew)
      if (deps.takeReplaceEntry() || tidy) bar.replace(h, bar.state())
      else bar.push(h, p.phone && p.page === 'settings' && !p.menu && cur.page === 'settings' && cur.setMenu ? deps.fromMenuState : null)
    },
  }
}
