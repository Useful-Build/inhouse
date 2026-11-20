// RunStream alone (the root's per-run stamping), not the root around it: root.test.ts proves the same through the HTTP
// API with real sessions. Ways it could fail: under concurrent runs a seq repeats, skips or leaks across runs; events
// after the terminal one are written; a run ends twice.
import { fc, it } from '@fast-check/vitest'
import { expect } from 'vitest'
import type { RunEvent, RunEventBody } from '../../../shared/protocol/index.ts'
import { RunStream } from '../../src/server/run-stream.ts'

const body = fc.oneof(
  fc.constant<RunEventBody>({ type: 'checkpoint', mainEntries: 3, lastUuid: 'u-3', lastUuidIndex: 2, runEntries: 1 }),
  fc.constant<RunEventBody>({ type: 'sdk', message: { type: 'assistant' }, truncated: false }),
  fc.constant<RunEventBody>({ type: 'finished', subtype: 'success', isError: false, numTurns: 1, costUsd: 0, usage: {} }),
  fc.constant<RunEventBody>({ type: 'failed', reason: 'stopped', message: 'x' }),
)

it.prop([fc.array(fc.tuple(fc.nat(5), body), { maxLength: 200 }), fc.scheduler()])(
  'RunStream: every run gets seq 0..n-1 with no gaps, its own events only, and at most one end, under any interleaving',
  async (steps, s) => {
    const written: RunEvent[] = []
    const streams = Array.from({ length: 6 }, (_, i) => new RunStream(`run-${i}`, (e) => written.push(e)))
    // The scheduler runs the emits in an arbitrary order across runs.
    const all = Promise.all(steps.map(([run, b]) => s.schedule(Promise.resolve()).then(() => streams[run]!.emit(b))))
    await s.waitAll()
    await all
    for (const stream of streams) {
      const mine = written.filter((e) => e.runId === stream.runId)
      expect(mine.map((e) => e.seq)).toEqual(mine.map((_, i) => i))
      const ends = mine.filter((e) => e.type === 'finished' || e.type === 'failed')
      expect(ends.length).toBeLessThanOrEqual(1)
      if (ends.length === 1) expect(mine.at(-1)).toBe(ends[0])
    }
  },
)
