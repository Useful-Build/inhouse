// The Team memory page's waiting list (P6a W2, review round 1). Ways it can fail, written first:
//  1. a refused read (403) shows a section, or a failed read shows none (or no Retry);
//  2. a conflict's toast ignores what `current` says: someone else approved it (and memory isn't read, so the rule is in
//     neither list), rejected it, or changed its wording;
//  3. an approve whose answer was dropped (not a conflict) leaves memory unread, so an approved rule vanishes from both lists;
//  4. a decided row stays until the re-read, or `deciding` clears before the re-read answers;
//  5. a read that started before a decision settled answers after it and brings the decided fact back as a ghost row
//     with its old rev;
//  6. a second click on a row whose decision is on its way sends a second decision.
// Every promise is a deferred the test settles, so the order is the test's, not the event loop's.
import { describe, expect, it } from 'vitest'
import { AgentError } from '../../agent/types'
import type { WaitingMemory } from '../../agent/types'
import { waitingList } from './waiting-list'

const fact = (key: string, rev = 2, text = `Rule ${key}`): WaitingMemory => ({ key, text, source: 'Priya told your Inhouse agent in a chat', rev, scope: 'brand', waiting: true, kind: 'memory' })

function deferred<T>() {
  let resolve!: (v: T) => void, reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}
const flush = () => new Promise<void>(r => setTimeout(r, 0))

function harness() {
  const reads: ReturnType<typeof deferred<WaitingMemory[]>>[] = []
  const decisions: { key: string; approved: boolean; d: ReturnType<typeof deferred<void>> }[] = []
  const toasts: string[] = []
  let memoryReads = 0
  const list = waitingList({
    waitingMemory: () => { const d = deferred<WaitingMemory[]>(); reads.push(d); return d.promise },
    reviewMemory: (key, approved) => { const d = deferred<void>(); decisions.push({ key, approved, d }); return d.promise },
    refreshMemory: async () => { memoryReads++ },
    toast: text => { toasts.push(text) },
  })
  return { list, reads, decisions, toasts, memoryReads: () => memoryReads }
}
const conflict = (current: Record<string, unknown>) => new AgentError('conflict', 'Someone changed this.', { current })

describe('reading the list (failure 1)', () => {
  it('ready with the facts; a 403 is refused (no section); anything else is failed, and Retry reads again', async () => {
    const h = harness()
    expect(h.list.get().status).toBe('unread')
    h.list.read(); h.reads[0].resolve([fact('a')]); await flush()
    expect(h.list.get()).toMatchObject({ status: 'ready', facts: [fact('a')] })
    h.list.read(); h.reads[1].reject(new AgentError('forbidden', 'No.')); await flush()
    expect(h.list.get().status).toBe('refused')
    h.list.read(); h.reads[2].reject(new AgentError('unavailable', 'Down.')); await flush()
    expect(h.list.get().status).toBe('failed')
    // An answer that failed the contract (a person or active fact on route 77) rejects with `unknown`: failed, with Retry.
    h.list.read(); h.reads[3].reject(new AgentError('unknown', 'Something went wrong.')); await flush()
    expect(h.list.get().status).toBe('failed')
    h.list.read(); h.reads[4].resolve([]); await flush()
    expect(h.list.get()).toMatchObject({ status: 'ready', facts: [] })
  })
})

describe('a decision settles (failures 2 to 4)', () => {
  async function ready(...facts: WaitingMemory[]) {
    const h = harness()
    h.list.read(); h.reads[0].resolve(facts); await flush()
    return h
  }

  it('approved: told, the row goes at once, deciding stays until the re-read answers', async () => {
    const h = await ready(fact('a'), fact('b'))
    h.list.decide('a', true)
    expect(h.list.get().deciding.has('a')).toBe(true)
    h.decisions[0].d.resolve(); await flush()
    expect(h.toasts).toEqual(['Approved. Your Inhouse agent will use this.'])
    expect(h.list.get().facts.map(f => f.key)).toEqual(['b'])
    expect(h.list.get().deciding.has('a')).toBe(true)
    h.reads[1].resolve([fact('b')]); await flush()
    expect(h.list.get().deciding.has('a')).toBe(false)
  })

  it('rejected: told; memory isn\'t read', async () => {
    const h = await ready(fact('a'))
    h.list.decide('a', false)
    h.decisions[0].d.resolve(); await flush()
    expect(h.toasts).toEqual(["Rejected. Your Inhouse agent won't use this."])
    expect(h.memoryReads()).toBe(0)
  })

  it('a conflict says what current is: approved already (and memory is read), rejected already, or the new wording', async () => {
    const cases: [Record<string, unknown>, string, number][] = [
      [{ key: 'a', text: 'Rule a', rev: 3 }, 'Someone approved this already. Your Inhouse agent uses it.', 1],
      [{ key: 'a', text: 'Rule a', rev: 3, forgotten: true }, 'Someone rejected this already.', 0],
      [{ key: 'a', text: 'Ship by courier', rev: 3, waiting: true }, 'Someone changed this. It\'s now "Ship by courier".', 0],
    ]
    for (const [current, words, reads] of cases) {
      const h = await ready(fact('a'))
      h.list.decide('a', false)
      h.decisions[0].d.reject(conflict(current)); await flush()
      expect(h.toasts, words).toEqual([words])
      expect(h.memoryReads(), words).toBe(reads)
      expect(h.list.get().facts, words).toEqual([])
      h.reads[1].resolve(current.waiting ? [fact('a', 3, 'Ship by courier')] : []); await flush()
      expect(h.list.get().deciding.size, words).toBe(0)
    }
  })

  it('an approve that failed some other way (a dropped reply) still reads memory; a reject\'s does not', async () => {
    const h = await ready(fact('a'), fact('b'))
    h.list.decide('a', true)
    h.decisions[0].d.reject(new AgentError('offline', 'Offline.')); await flush()
    expect(h.memoryReads()).toBe(1)
    // The outcome isn't known: the row stays until the re-read says, and the page adds no toast (the client told once).
    expect(h.list.get().facts.map(f => f.key)).toEqual(['a', 'b'])
    expect(h.list.get().deciding.has('a')).toBe(true)
    expect(h.toasts).toEqual([])
    h.reads[1].resolve([fact('b')]); await flush()
    expect(h.list.get().facts.map(f => f.key)).toEqual(['b'])
    expect(h.list.get().deciding.has('a')).toBe(false)
    h.list.decide('b', false)
    h.decisions[1].d.reject(new AgentError('offline', 'Offline.')); await flush()
    expect(h.memoryReads()).toBe(1)
    expect(h.list.get().facts.map(f => f.key)).toEqual(['b'])
    expect(h.toasts).toEqual([])
  })
})

describe('reading state and reopening (review round 2)', () => {
  it('reading is true while the latest read is out, false once it answers (the Retry row waits on it)', async () => {
    const h = harness()
    h.list.read()
    expect(h.list.get().reading).toBe(true)
    h.reads[0].reject(new AgentError('unavailable', 'Down.')); await flush()
    expect(h.list.get()).toMatchObject({ status: 'failed', reading: false })
    h.list.read()
    expect(h.list.get()).toMatchObject({ status: 'failed', reading: true })
    h.reads[1].resolve([fact('a')]); await flush()
    expect(h.list.get()).toMatchObject({ status: 'ready', reading: false })
  })
  it('reopening shows no rows until the fresh read answers (no last list with live buttons)', async () => {
    const h = harness()
    h.list.read(); h.reads[0].resolve([fact('a', 2)]); await flush()
    h.list.open()
    expect(h.list.get()).toMatchObject({ status: 'unread', facts: [], reading: true })
    h.reads[1].resolve([fact('a', 3)]); await flush()
    expect(h.list.get()).toMatchObject({ status: 'ready', facts: [fact('a', 3)] })
  })
})

describe('stale reads and double clicks (failures 5 and 6)', () => {
  it('a read started before the decision settled, answering after the re-read, is dropped', async () => {
    const h = harness()
    h.list.read(); h.reads[0].resolve([fact('a', 2)]); await flush()
    h.list.read() // reads[1]: started before the decision, still out
    h.list.decide('a', true)
    h.decisions[0].d.resolve(); await flush() // re-read: reads[2]
    h.reads[2].resolve([]); await flush()
    h.reads[1].resolve([fact('a', 2)]); await flush()
    expect(h.list.get().facts).toEqual([])
  })
  it('a second decision on a row on its way sends nothing', async () => {
    const h = harness()
    h.list.read(); h.reads[0].resolve([fact('a')]); await flush()
    h.list.decide('a', true)
    h.list.decide('a', false)
    expect(h.decisions.map(d => [d.key, d.approved])).toEqual([['a', true]])
  })
})
