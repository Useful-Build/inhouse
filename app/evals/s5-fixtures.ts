// Loads the S5 raw results kept in fixtures/s5 (the grader's inputs and S5's own verdicts, nothing else).
import fs from 'node:fs'
import type { ChatResult, People } from './types.ts'

export const S5_PEOPLE: People = { current: 'p_maya', tom: 'p_tom', lena: 'p_lena' }

export interface S5Chat extends ChatResult {
  case: string
  rep: number
  chat: number
  isError: boolean
}
export interface S5Verdict {
  case: string
  rep: number
  chat: number
  pass: boolean
  checks: Record<string, boolean>
  called: string[]
}
export interface S5Summary {
  runs: number
  pass: number
  pct: number
  perRep: number[]
  cost: number
}

const read = (name: string): unknown => JSON.parse(fs.readFileSync(new URL(`./fixtures/s5/${name}`, import.meta.url), 'utf8'))

export function loadS5Chats(): S5Chat[] {
  const raw = read('chats.json') as (Omit<S5Chat, 'runOk'> & { isError: boolean })[]
  // S5's run_ok: the run ended without error and produced an answer.
  return raw.map((c) => ({ ...c, runOk: c.isError === false && !!c.answer }))
}

export function loadS5Verdicts(): {
  verdicts: S5Verdict[]
  summary: Record<string, S5Summary>
  recallSplit: { searched: number; answer: number; n: number }
} {
  return read('verdicts.json') as ReturnType<typeof loadS5Verdicts>
}
