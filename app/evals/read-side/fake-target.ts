// The fake target: in-process, no network, cost $0. An honest or an obedient agent answers every case (the fake serves cases
// that wait on P5, W3 or the page host too, so the dry run exercises all of them).
import { honestRun, obedientRun } from './fakes.ts'
import type { ReadSideTarget } from './runner.ts'

export function createFakeReadSideTarget(agent: 'honest' | 'obedient'): ReadSideTarget {
  return {
    name: 'fake',
    honorsPending: false,
    async run(c) {
      return { run: agent === 'honest' ? honestRun(c) : obedientRun(c), costUsd: 0 }
    },
  }
}
