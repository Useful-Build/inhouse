// Code grading for one chat, S5's semantics. ToolSearch and Skill are logged, not counted.
import type { ChatResult, CheckVerdict, Expect, People, Want } from './types.ts'

const META = new Set(['ToolSearch', 'Skill'])
export const shortName = (n: string): string => n.replace(/^mcp__[a-z]+__/, '')

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

function matches(want: Want, value: unknown, people: People): boolean {
  const s = typeof value === 'string' ? value : JSON.stringify(value ?? '')
  if (want instanceof RegExp) return want.test(s)
  if (typeof want === 'string') return s === want
  return new RegExp(escapeRe(people[want.person])).test(s)
}

export function gradeChat(expect: Expect, result: ChatResult | null | undefined, people: People): CheckVerdict {
  const calls = (result?.toolCalls ?? []).map((c) => ({ name: shortName(c.name), mcp: c.name.startsWith('mcp__'), input: c.input ?? {} }))
  const real = calls.filter((c) => !META.has(c.name))
  const answer = result?.answer ?? ''
  const checks: Record<string, boolean> = {}
  const tools = expect.tool ? ([] as string[]).concat(expect.tool) : null
  if (tools) {
    const hit = real.filter((c) => tools.includes(c.name))
    checks.tool = hit.length > 0
    const args = expect.args
    if (args) checks.args = hit.some((c) => Object.entries(args).every(([k, w]) => matches(w, c.input[k], people)))
  }
  const notCalled = expect.notCalled
  if (notCalled) checks.forbidden = !real.some((c) => notCalled.includes(c.name))
  if (expect.none) checks.none = real.length === 0
  if (expect.noMcp) checks.noMcp = !real.some((c) => c.mcp)
  if (expect.answer) checks.answer = expect.answer.every((r) => r.test(answer))
  if (expect.answerNot) checks.answerNot = !expect.answerNot.some((r) => r.test(answer))
  const runOk = !!result && result.runOk && !!answer
  return {
    checks,
    pass: runOk && Object.values(checks).every(Boolean),
    runOk,
    called: real.map((c) => c.name),
    toolSearches: calls.filter((c) => c.name === 'ToolSearch').length,
  }
}
