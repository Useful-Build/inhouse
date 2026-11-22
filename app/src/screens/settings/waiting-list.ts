// The Team memory page's waiting list (P6a W2): what waits for an admin's OK, read when the page opens, and each Approve
// or Reject. A plain store the page subscribes to, so its order of reads and decisions is testable without a browser.
// - A 403 is "refused": no section. Any other failed read is "failed": the section says so, with Retry.
// - A decision that settles (done or a conflict) drops its row at once; its buttons wait until the list is read again.
// - Each read has a number: an answer from a read that a later one replaced is dropped, so a decided fact never comes back.
import { AgentError } from '../../agent/types'
import type { WaitingMemory } from '../../agent/types'

export type WaitingStatus = 'unread' | 'ready' | 'failed' | 'refused'
export interface WaitingState {
  status: WaitingStatus
  facts: WaitingMemory[]
  /** Facts whose decision is on its way, until the list is read again after it. */
  deciding: ReadonlySet<string>
}
export interface WaitingDeps {
  waitingMemory(): Promise<WaitingMemory[]>
  reviewMemory(key: string, approved: boolean): Promise<void>
  refreshMemory(): Promise<void>
  toast(text: string, opts?: { icon?: string; key?: string }): void
}

export function waitingList(d: WaitingDeps) {
  let state: WaitingState = { status: 'unread', facts: [], deciding: new Set() }
  let seq = 0
  const listeners = new Set<() => void>()
  const set = (next: Partial<WaitingState>) => { state = { ...state, ...next }; listeners.forEach(l => l()) }
  const without = (key: string) => state.facts.filter(f => f.key !== key)
  // A failed memory read already told the person (the client's own notice); nothing more to do here.
  const readMemory = () => { d.refreshMemory().catch(() => undefined) }

  const read = (): Promise<void> => {
    const mine = ++seq
    return d.waitingMemory().then(
      facts => { if (mine === seq) set({ status: 'ready', facts }) },
      (e: unknown) => { if (mine === seq) set({ status: e instanceof AgentError && e.code === 'forbidden' ? 'refused' : 'failed', facts: [] }) },
    )
  }

  const decide = (key: string, approved: boolean): void => {
    if (state.deciding.has(key)) return
    set({ deciding: new Set(state.deciding).add(key) })
    const settled = () => { set({ facts: without(key) }) }
    d.reviewMemory(key, approved).then(
      () => {
        settled()
        d.toast(approved ? 'Approved. Your Inhouse agent will use this.' : "Rejected. Your Inhouse agent won't use this.")
      },
      (e: unknown) => {
        const current = e instanceof AgentError && e.code === 'conflict' ? e.current : undefined
        if (!current) {
          // Not a conflict (a dropped reply, say): the approve may have landed, so the team list is read again too.
          if (approved) readMemory()
          return
        }
        settled()
        if (current.waiting === true) {
          d.toast(typeof current.text === 'string' ? `Someone changed this. It's now "${current.text}".` : 'Someone changed this. It has been updated.', { icon: 'info', key: 'conflict' })
        } else if (current.forgotten === true) {
          d.toast('Someone rejected this already.', { icon: 'info', key: 'conflict' })
        } else {
          d.toast('Someone approved this already. Your Inhouse agent uses it.', { icon: 'info', key: 'conflict' })
          readMemory()
        }
      },
    ).then(read).finally(() => {
      const deciding = new Set(state.deciding)
      deciding.delete(key)
      set({ deciding })
    })
  }

  return {
    get: (): WaitingState => state,
    subscribe: (l: () => void) => { listeners.add(l); return () => { listeners.delete(l) } },
    read,
    decide,
  }
}
