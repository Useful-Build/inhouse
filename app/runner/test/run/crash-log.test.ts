// The root's last catch (src/server/crash-log.ts): a crash logs the error's name only and exits 1.
import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import { logCrashes } from '../../src/server/crash-log.ts'

const CANARY = 'CANARY-chat-text-7f3a'

describe('logCrashes', () => {
  it.each([
    ['uncaughtException', 'root_uncaught_exception'],
    ['unhandledRejection', 'root_unhandled_rejection'],
  ] as const)('%s: logs the name only, then exits 1', (event, type) => {
    const proc = Object.assign(new EventEmitter(), { exits: [] as number[], exit(code: number) { this.exits.push(code) } })
    const logs: Record<string, unknown>[] = []
    logCrashes(proc, (e) => void logs.push(e))
    proc.emit(event, new TypeError(`bad input: ${CANARY}`))
    expect(logs).toEqual([{ type, error: 'TypeError' }])
    expect(JSON.stringify(logs)).not.toContain(CANARY)
    expect(proc.exits).toEqual([1])
  })
})
