// The address bar and the app's state follow each other: a change in the app writes the hash (`sync`, from an effect in
// App.tsx), a change to the hash (a typed link, Back, a script) is read into the app by the `hashchange` listener
// (`adopt`, then `applyRoute`). The write must never beat a hash someone else set. The hash event arrives after the effect
// that would write, so when the app re-renders for another reason in between (a phone-width resize flipping `phone` or
// `menu`, a chat id arriving when data loads), the effect would put the old page back and the person's change would be
// lost. So `sync` leaves a readable hash that wasn't the app's own and names another place alone: the listener reads it.
// A hash that names where the app already is, in its own words (`#/chats` with the newest chat open), is tidied to the
// canonical form with `replaceState`, so the next real move still pushes an entry.

export interface Place { page: string; appKey: string; setTab: string; chatKey: string; menu: boolean; phone: boolean; chatIsNew: boolean }
/** A route read from a hash (`fromHash` in App.tsx). */
export interface Parsed { page?: string; appKey?: string; setTab?: string; chat?: string; setMenu?: boolean }
/** The browser's address bar and history, so a test can stand in for them. */
export interface HashHost { hash(): string; state(): unknown; replace(state: unknown, hash: string): void; push(state: unknown, hash: string): void }
export interface SyncDeps {
  toHash(p: Place): string
  fromHash(hash: string): Parsed | null
  /** The store's one-shot "replace the next entry" flag (a settings page opened from the phone menu). */
  takeReplaceEntry(): boolean
  /** The history state of a settings page opened from the phone menu, so its Back button can step back. */
  fromMenuState: unknown
}

/** Whether a route reads as the place the app is already in (its missing parts filled from the place). */
const isHere = (cur: Parsed, p: Place): boolean => {
  // On a phone the settings menu and a settings page are two entries; desktop tidies #/settings into its page.
  const sameMenu = !(p.page === 'settings' && p.phone) || (cur.setMenu ?? p.menu) === p.menu
  return (cur.page === p.page && (cur.appKey ?? p.appKey) === p.appKey && (cur.setTab ?? p.setTab) === p.setTab && (cur.chat ?? p.chatKey) === p.chatKey && sameMenu)
    // A new chat getting its id when the first question is asked: Back skips the empty chat.
    || (p.page === 'chats' && cur.page === 'chats' && cur.chat === 'new' && p.chatIsNew)
}

export function createHashSync(host: HashHost, deps: SyncDeps) {
  // The last hash the app wrote or read.
  let written = host.hash()
  return {
    /** The listener read the hash into the app: it is the app's own now. */
    adopt() { written = host.hash() },
    /** Writes the app's place into the hash, unless a hash someone else just set is waiting to be read. */
    sync(p: Place): void {
      const h = deps.toHash(p)
      const current = host.hash()
      // An open Library file keeps its own link (#/library/<id>, see screens/library/route.ts).
      if (current === h || (p.page === 'library' && current.startsWith(`${h}/`))) { written = current; return }
      const cur = deps.fromHash(current)
      const here = !!cur && isHere(cur, p)
      if (cur && current !== written && !here) return
      // A hash that only needs tidying (none, unknown, the same place in other words) replaces the entry. A real move adds one.
      if (deps.takeReplaceEntry() || !cur || here) host.replace(host.state(), h)
      else host.push(p.phone && p.page === 'settings' && !p.menu && cur.page === 'settings' && cur.setMenu ? deps.fromMenuState : null, h)
      written = host.hash()
    },
  }
}
