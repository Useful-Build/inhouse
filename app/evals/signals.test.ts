// Every eval runner cancels on a hangup too (#719), and from the first signal on its wrangler calls are shielded (#716).
// Ways it could fail: a runner keeps its own SIGINT/SIGTERM list without SIGHUP; a second signal reaches the close's calls.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { EventEmitter } from 'node:events'
import { CANCEL_SIGNALS, signalHost } from './signals.ts'
import { giveBackOnSignals } from './run-cancel.ts'
import { unshieldWranglerCallsForTests, wranglerCallsShielded } from './targets/door.ts'
import { stopOnSignals } from './read-side/cli.ts'
import { clearOnSignals } from './morning-check/remote.ts'
import { cancelHandler, listenForCancel } from './injection/run.ts'

const fakeProcess = () => {
  const handlers = new Map<string, () => void>()
  return { handlers, on: (s: string, h: () => void) => void handlers.set(s, h) }
}

// First in the file: the shield is per process, and the tests below set it too.
describe('#716: the first signal shields the wrangler calls the close makes', () => {
  afterEach(() => unshieldWranglerCallsForTests())
  it('a cancel shields them before the close starts', async () => {
    expect(wranglerCallsShielded()).toBe(false)
    let closed = false
    const handle = cancelHandler({ close: async () => { closed = wranglerCallsShielded() } }, mkdtempSync(path.join(tmpdir(), 'inj-shield-')), [], new AbortController(), () => {})
    handle('SIGINT', 130)
    await new Promise((r) => setTimeout(r, 10))
    expect(closed).toBe(true)
  })
})

// #739: each runner shields on its first signal itself, so deleting its own shieldWranglerCalls() turns one of these red.
describe('#739: every runner shields the wrangler calls on its first signal', () => {
  const next = () => new Promise((r) => setTimeout(r, 5))
  const host = () => {
    const p = fakeProcess()
    const log: string[] = []
    return { p, log, deps: { on: p.on, error: (l: string) => void log.push(l), exit: (c: number) => void log.push(`exit ${c}`) } }
  }
  afterEach(() => unshieldWranglerCallsForTests())

  it.each(CANCEL_SIGNALS)('read-side: %s shields before it stops anything', async (signal) => {
    const h = host()
    let at: boolean | null = null
    stopOnSignals(async () => { at = wranglerCallsShielded() }, h.deps)
    expect(wranglerCallsShielded()).toBe(false)
    h.p.handlers.get(signal)!()
    await next()
    expect(at).toBe(true)
  })

  it.each(CANCEL_SIGNALS)('morning-check: %s shields before the clear and the release', async (signal) => {
    const h = host()
    const at: boolean[] = []
    clearOnSignals({ close: () => void at.push(wranglerCallsShielded()), clearShop: async () => { at.push(wranglerCallsShielded()); return null } }, h.deps, async () => void at.push(wranglerCallsShielded()))
    expect(wranglerCallsShielded()).toBe(false)
    h.p.handlers.get(signal)!()
    await next()
    expect(at).toEqual([true, true, true])
  })

  it.each(CANCEL_SIGNALS)('evals/run.ts: %s shields before the target gives the lease back', async (signal) => {
    const h = host()
    let at: boolean | null = null
    giveBackOnSignals(async () => { at = wranglerCallsShielded(); return true }, h.deps)
    expect(wranglerCallsShielded()).toBe(false)
    h.p.handlers.get(signal)!()
    await next()
    expect(at).toBe(true)
    expect(h.log).toContain(`exit ${CANCEL_SIGNALS.find(([s]) => s === signal)![1]}`)
  })
})

// #741/#742 review: a second signal must not skip or double the give-back (the handlers were process.once, with no guard).
describe('a second signal: one give-back, the first signal\'s exit code, nothing cut short', () => {
  const pairs = [['SIGINT', 'SIGINT', 130], ['SIGINT', 'SIGTERM', 130], ['SIGTERM', 'SIGINT', 143], ['SIGHUP', 'SIGTERM', 129]] as const
  const wire = (which: 'morning-check' | 'run') => {
    const p = fakeProcess()
    const log: string[] = []
    let finished!: () => void
    const gate = new Promise<void>((r) => { finished = r })
    const deps = { on: p.on, error: (l: string) => void log.push(l), exit: (c: number) => void log.push(`exit ${c}`) }
    if (which === 'morning-check') clearOnSignals({ close: () => void log.push('close'), clearShop: async () => { log.push('clear'); await gate; return null } }, deps, async () => void log.push('release'))
    else giveBackOnSignals(async () => { log.push('close'); await gate; log.push('closed'); return true }, deps)
    return { p, log, finished }
  }
  const settle = () => new Promise((r) => setTimeout(r, 10))

  it.each(pairs)('morning-check: %s then %s clears and releases once, then exits %i once', async (first, second, code) => {
    const w = wire('morning-check')
    w.p.handlers.get(first)!()
    w.p.handlers.get(second)!()
    await settle()
    expect(w.log.filter((l) => l.startsWith('exit'))).toEqual([])
    expect(w.log.some((l) => l.includes(`${second} again`))).toBe(true)
    w.finished()
    await settle()
    expect(w.log.filter((l) => ['close', 'clear', 'release'].includes(l))).toEqual(['close', 'clear', 'release'])
    expect(w.log.filter((l) => l.startsWith('exit'))).toEqual([`exit ${code}`])
  })

  it.each(pairs)('evals/run.ts: %s then %s closes the target once, then exits %i once', async (first, second, code) => {
    const w = wire('run')
    w.p.handlers.get(first)!()
    w.p.handlers.get(second)!()
    await settle()
    expect(w.log.filter((l) => l.startsWith('exit'))).toEqual([])
    expect(w.log.some((l) => l.includes(`${second} again`))).toBe(true)
    w.finished()
    await settle()
    expect(w.log.filter((l) => l === 'close' || l === 'closed')).toEqual(['close', 'closed'])
    expect(w.log.filter((l) => l.startsWith('exit'))).toEqual([`exit ${code}`])
  })

  it('the real process host keeps its handler after a signal (on, never once): a second Ctrl-C reaches it, not Node\'s default', () => {
    const proc = Object.assign(new EventEmitter(), { exit: (() => {}) as (code?: number) => never })
    let hits = 0
    signalHost(proc as never).on('SIGINT', () => { hits++ })
    proc.emit('SIGINT')
    proc.emit('SIGINT')
    expect(hits).toBe(2)
    expect(proc.listenerCount('SIGINT')).toBe(1)
  })
})

describe('#719: SIGHUP cancels every runner, with exit 129', () => {
  it('the shared list holds SIGINT, SIGHUP and SIGTERM with their codes', () => {
    expect(CANCEL_SIGNALS).toEqual([['SIGINT', 130], ['SIGHUP', 129], ['SIGTERM', 143]])
  })

  it('read-side: a hangup stops the run, gives everything back, then exits 129; a second signal is only said', async () => {
    const p = fakeProcess()
    const log: string[] = []
    let exited!: (c: number) => void
    const exit = new Promise<number>((r) => { exited = r })
    stopOnSignals(async () => { log.push('stop') }, { on: p.on, error: (l) => log.push(l), exit: (c) => exited(c) })
    expect([...p.handlers.keys()]).toEqual(['SIGINT', 'SIGHUP', 'SIGTERM'])
    p.handlers.get('SIGHUP')!()
    p.handlers.get('SIGINT')!()
    expect(await exit).toBe(129)
    expect(log.filter((l) => l === 'stop')).toHaveLength(1)
    expect(log.some((l) => l.startsWith('read-side: SIGINT again'))).toBe(true)
  })

  it('morning-check: a hangup clears the shop override, gives the lease back, then exits 129', async () => {
    const p = fakeProcess()
    const log: string[] = []
    let exited!: (c: number) => void
    const exit = new Promise<number>((r) => { exited = r })
    clearOnSignals({ close: () => void log.push('close'), clearShop: async () => { log.push('clear'); return null } }, { on: p.on, exit: (c) => exited(c), error: () => {} }, async () => void log.push('release'))
    expect([...p.handlers.keys()]).toEqual(['SIGINT', 'SIGHUP', 'SIGTERM'])
    p.handlers.get('SIGHUP')!()
    expect(await exit).toBe(129)
    expect(log).toEqual(['close', 'clear', 'release'])
  })

  it('injection: the same list', () => {
    const p = fakeProcess()
    const got: string[] = []
    listenForCancel((s) => got.push(s), p as unknown as NodeJS.Process)
    expect([...p.handlers.keys()]).toEqual(['SIGINT', 'SIGHUP', 'SIGTERM'])
  })
})
