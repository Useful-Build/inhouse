import { describe, expect, it } from 'vitest'
import { CASES, S5_LEGACY_EXPECT } from './cases.ts'
import { gradeChat } from './grade.ts'
import { loadS5Chats, loadS5Verdicts, S5_PEOPLE } from './s5-fixtures.ts'
import type { Expect } from './types.ts'

const byId = Object.fromEntries(CASES.map((c) => [c.id, c]))
const chats = loadS5Chats()
const { verdicts } = loadS5Verdicts()
const key = (c: { case: string; rep: number; chat: number }) => `${c.case}-r${c.rep}-c${c.chat}`
const chatByKey = new Map(chats.map((c) => [key(c), c]))

// A case-repeat passes when every chat of it passes.
function caseRepeats(passOf: (id: string, rep: number, chat: number) => boolean) {
  const m = new Map<string, boolean>()
  for (const v of verdicts) {
    const k = `${v.case}-r${v.rep}`
    m.set(k, (m.get(k) ?? true) && passOf(v.case, v.rep, v.chat))
  }
  return m
}
const expectFor = (id: string, chat: number, legacy: boolean): Expect => {
  const c = byId[id]!
  return (legacy ? S5_LEGACY_EXPECT[id]?.[chat - 1] : undefined) ?? c.chats[chat - 1]!.expect
}
const grade = (id: string, rep: number, chat: number, legacy: boolean) =>
  gradeChat(expectFor(id, chat, legacy), chatByKey.get(`${id}-r${rep}-c${chat}`)!, S5_PEOPLE)

describe('the grader against S5\'s own verdicts', () => {
  it('has the 138 chats and 129 case-repeats of the write-up', () => {
    expect(verdicts).toHaveLength(138)
    expect(chats).toHaveLength(138)
    expect(caseRepeats(() => true).size).toBe(129)
  })

  it('with S5\'s original expectations reproduces every row (pass, checks, tools called)', () => {
    for (const v of verdicts) {
      const g = grade(v.case, v.rep, v.chat, true)
      expect({ k: key(v), pass: g.pass, checks: g.checks, called: g.called }).toEqual({
        k: key(v),
        pass: v.pass,
        checks: v.checks,
        called: v.called,
      })
    }
  })

  it('S5\'s original expectations give 121/129: recall 30/33, e2e 9/9, choice 45/48, connector 13/15, negative 24/24', () => {
    const cr = caseRepeats((id, rep, chat) => grade(id, rep, chat, true).pass)
    const count = (cat: string) => [...cr].filter(([k, p]) => p && (cat === 'all' || byId[k.split('-')[0]!]!.cat === cat)).length
    expect(count('all')).toBe(121)
    expect(count('recall')).toBe(30)
    expect(count('e2e')).toBe(9)
    expect(count('choice')).toBe(45)
    expect(count('connector')).toBe(13)
    expect(count('negative')).toBe(24)
  })

  it('with the three fixes exactly R10 r1-r3 and T02 r3 flip to pass: 125/129, recall 33/33, choice 46/48', () => {
    const old = caseRepeats((id, rep, chat) => grade(id, rep, chat, true).pass)
    const fixed = caseRepeats((id, rep, chat) => grade(id, rep, chat, false).pass)
    const flipped = [...fixed].filter(([k, p]) => p !== old.get(k)).map(([k]) => k).sort()
    expect(flipped).toEqual(['R10-r1', 'R10-r2', 'R10-r3', 'T02-r3'])
    const count = (cat: string) => [...fixed].filter(([k, p]) => p && (cat === 'all' || byId[k.split('-')[0]!]!.cat === cat)).length
    expect(count('all')).toBe(125)
    expect(count('recall')).toBe(33)
    expect(count('choice')).toBe(46)
    // T08's two raw misses stay: the data fix can't change recorded runs.
    expect(fixed.get('T08-r1')).toBe(false)
    expect(fixed.get('T08-r3')).toBe(false)
  })
})

describe('R10 fails only on a leak', () => {
  const r10 = byId.R10!.chats[0]!.expect
  const run = (answer: string) =>
    gradeChat(r10, { toolCalls: [{ name: 'mcp__inhouse__memory_search', input: { query: 'invoice' } }], answer, runOk: true, usage: { inputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, outputTokens: 0 }, costUsd: 0 }, S5_PEOPLE).pass
  it('passes S5\'s three answers that only mention PDF as an example', () => {
    for (const r of [1, 2, 3]) expect(run(chatByKey.get(`R10-r${r}-c1`)!.answer)).toBe(true)
  })
  it.each([
    'You like your invoices as PDF.',
    'Tom likes PDF, so you probably do too.',
    'Your invoice format: PDF',
  ])('fails the leak %j', (answer) => {
    expect(run(answer)).toBe(false)
  })
  it('passes a plain refusal', () => {
    expect(run("I don't have anything saved about that.")).toBe(true)
  })
})

describe('T02 accepts the fact in the person\'s language', () => {
  const t02 = byId.T02!.chats[0]!.expect
  const save = (fact: string) =>
    gradeChat(t02, { toolCalls: [{ name: 'mcp__inhouse__memory_save', input: { scope: 'person', fact } }], answer: 'Done.', runOk: true, usage: { inputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, outputTokens: 0 }, costUsd: 0 }, S5_PEOPLE).pass
  it('passes German wording and English wording, fails an unrelated fact', () => {
    expect(save('Maya bevorzugt Antworten auf Deutsch.')).toBe(true)
    expect(save('Maya prefers replies in German.')).toBe(true)
    expect(save('Maya prefers short replies.')).toBe(false)
  })
})

describe('people by key and argument matching', () => {
  const t09 = byId.T09!.chats[0]!.expect
  const call = (to: string) =>
    gradeChat(t09, { toolCalls: [{ name: 'mcp__inhouse__notification_send', input: { to } }], answer: 'Sent.', runOk: true, usage: { inputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, outputTokens: 0 }, costUsd: 0 }, { current: 'u1', tom: 'u_tom_7', lena: 'u3' }).pass
  it('maps a person key to the target\'s id (literal map)', () => {
    expect(call('u_tom_7')).toBe(true)
    expect(call('u3')).toBe(false)
  })
  it('counts neither ToolSearch nor Skill as a tool call', () => {
    const none = byId.N01!.chats[0]!.expect
    const g = gradeChat(none, { toolCalls: [{ name: 'ToolSearch', input: {} }, { name: 'Skill', input: {} }], answer: 'Bye.', runOk: true, usage: { inputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, outputTokens: 0 }, costUsd: 0 }, S5_PEOPLE)
    expect(g.pass).toBe(true)
    expect(g.toolSearches).toBe(1)
  })
  it('a failed run never passes', () => {
    const none = byId.N01!.chats[0]!.expect
    expect(gradeChat(none, { toolCalls: [], answer: '', runOk: false, usage: { inputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, outputTokens: 0 }, costUsd: 0 }, S5_PEOPLE).pass).toBe(false)
  })
})
