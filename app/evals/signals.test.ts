// Every eval runner cancels on a hangup too (#719), and from the first signal on its wrangler calls are shielded (#716).
// Ways it could fail: a runner keeps its own SIGINT/SIGTERM list without SIGHUP; a second signal reaches the close's calls.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { CANCEL_SIGNALS } from './signals.ts'
import { wranglerCallsShielded } from './targets/door.ts'
import { stopOnSignals } from './read-side/cli.ts'
import { clearOnSignals } from './morning-check/remote.ts'
import { cancelHandler, listenForCancel } from './injection/run.ts'

const fakeProcess = () => {
  const handlers = new Map<string, () => void>()
  return { handlers, on: (s: string, h: () => void) => void handlers.set(s, h) }
}

// First in the file: the shield is per process, and the tests below set it too.
describe('#716: the first signal shields the wrangler calls the close makes', () => {
  it('a cancel shields them before the close starts', async () => {
    expect(wranglerCallsShielded()).toBe(false)
    let closed = false
    const handle = cancelHandler({ close: async () => { closed = wranglerCallsShielded() } }, mkdtempSync(path.join(tmpdir(), 'inj-shield-')), [], new AbortController(), () => {})
    handle('SIGINT', 130)
    await new Promise((r) => setTimeout(r, 10))
    expect(closed).toBe(true)
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
