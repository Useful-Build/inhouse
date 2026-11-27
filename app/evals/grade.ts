// Code grading for one chat, S5's semantics. ToolSearch and Skill are logged, not counted.
import type { ChatResult, CheckVerdict, Expect, People, Want } from './types.ts'

const META = new Set(['ToolSearch', 'Skill'])
export const shortName = (n: string): string => n.replace(/^mcp__[a-z]+__/, '')

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

function matches(want: Want, value: unknown, people: People): boolean {
  const s = typeof value === 'string' ? value : JSON.stringify(value ?? '')
  if (want instanceof RegExp) return want.test(s)
  if (typeof want === 'string') return s === want
  if ('person' in want && typeof want.person === 'string' && Object.keys(want).length === 1) return new RegExp(escapeRe(people[want.person as keyof People])).test(s)
  // A nested object: each named field of the value matches its want (T09's `to: { members: ... }`).
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  return Object.entries(want).every(([k, w]) => matches(w as Want, (value as Record<string, unknown>)[k], people))
}

/** The served schema of an expected tool has no fields: its args aren't graded (A9, after the first full baseline). */
export const ARGS_NOT_GRADED = 'the served schema defines no fields'

/** Curly apostrophes read as straight ones (#549: "can’t" is "can't"), so a case's patterns needn't spell both. */
export const foldApostrophes = (s: string): string => s.replace(/[\u2018\u2019\u02BC]/g, "'")

export function gradeChat(expect: Expect, result: ChatResult | null | undefined, people: People, o: { openSchema?: ReadonlySet<string> } = {}): CheckVerdict {
  const calls = (result?.toolCalls ?? []).map((c) => ({ name: shortName(c.name), mcp: c.name.startsWith('mcp__'), input: c.seedInput ?? c.input ?? {} }))
  const real = calls.filter((c) => !META.has(c.name))
  const answer = foldApostrophes(result?.answer ?? '')
  const checks: Record<string, boolean> = {}
  const tools = expect.tool ? ([] as string[]).concat(expect.tool) : null
  let argsNotGraded: string | undefined
  if (tools) {
    const hit = real.filter((c) => tools.includes(c.name))
    checks.tool = hit.length > 0
    const args = expect.args
    if (args && tools.every((t) => o.openSchema?.has(t))) argsNotGraded = ARGS_NOT_GRADED
    else if (args) checks.args = hit.some((c) => Object.entries(args).every(([k, w]) => matches(w, c.input[k], people)))
  }
  const notCalled = expect.notCalled
  if (notCalled) checks.forbidden = !real.some((c) => notCalled.includes(c.name))
  if (expect.none) checks.none = real.length === 0
  if (expect.noMcp) checks.noMcp = !real.some((c) => c.mcp)
  if (expect.answer) checks.answer = expect.answer.every((r) => r.test(answer))
  if (expect.answerNot) checks.answerNot = !expect.answerNot.some((r) => r.test(answer))
  const atMost = expect.atMost
  if (atMost) checks.atMost = Object.entries(atMost).every(([name, n]) => real.filter((c) => c.name === name).length <= n)
  const before = expect.before
  if (before) {
    const at = (name: string): number => real.findIndex((c) => c.name === name)
    checks.before = before.every(([first, then]) => at(first) >= 0 && at(then) >= 0 && at(first) < at(then))
  }
  const runOk = !!result && result.runOk && !!answer
  return {
    checks,
    pass: runOk && Object.values(checks).every(Boolean),
    runOk,
    called: real.map((c) => c.name),
    toolSearches: calls.filter((c) => c.name === 'ToolSearch').length,
    ...(argsNotGraded ? { argsNotGraded } : {}),
  }
}
