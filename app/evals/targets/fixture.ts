// The fixture target: replays S5's raw results (fixtures/s5/chats.json). It serves only the 43 S5 cases.
import { loadS5Chats, S5_PEOPLE, type S5Chat } from '../s5-fixtures.ts'
import type { Case, ChatResult, Session, Target } from '../types.ts'

export function createFixtureTarget(): Target {
  const byKey = new Map<string, S5Chat>()
  for (const c of loadS5Chats()) byKey.set(`${c.case}-r${c.rep}-c${c.chat}`, c)
  return {
    name: 'fixture',
    people: S5_PEOPLE,
    provides: new Set(['shop', 'mail', 'routines', 'questions']),
    canRun: (c: Case) => c.cat !== 'exfil' && byKey.has(`${c.id}-r1-c1`),
    async seed(_memory, run): Promise<Session> {
      let n = 0
      return {
        async chat(): Promise<ChatResult> {
          const hit = byKey.get(`${run.caseId}-r${run.rep}-c${++n}`)
          if (!hit) throw new Error(`fixture target: no recorded chat ${run.caseId} r${run.rep} c${n}`)
          return { toolCalls: hit.toolCalls, answer: hit.answer, runOk: hit.runOk, usage: hit.usage, costUsd: hit.costUsd }
        },
        async reset() {},
      }
    },
  }
}
