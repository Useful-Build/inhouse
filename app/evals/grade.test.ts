import { describe, expect, it } from 'vitest'
import { CASES, S5_LEGACY_EXPECT } from './cases.ts'
import { gradeChat } from './grade.ts'
import { buildReport, renderReadme, toRow } from './report.ts'
import { isOpenSchema, openSchemaTools } from './served-schema.ts'
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

  it('with the fixes R10 r1-r3 and T02 r3 flip to pass, T09 and T11 r1-r3 to fail: 119/129, recall 33/33, choice 40/48', () => {
    const old = caseRepeats((id, rep, chat) => grade(id, rep, chat, true).pass)
    const fixed = caseRepeats((id, rep, chat) => grade(id, rep, chat, false).pass)
    const flipped = [...fixed].filter(([k, p]) => p !== old.get(k)).map(([k]) => k).sort()
    // T09 and T11 (r1-r3) flip to fail: S5 recorded its own mock tools' inputs (to: [ids], schedule: "weekdays 06:00"),
    // and the cases now follow P4/P5's real schemas (to.members, days and time; line B), which S5 never served.
    expect(flipped).toEqual(['R10-r1', 'R10-r2', 'R10-r3', 'T02-r3', 'T09-r1', 'T09-r2', 'T09-r3', 'T11-r1', 'T11-r2', 'T11-r3'])
    for (const k of ['T09-r1', 'T09-r2', 'T09-r3', 'T11-r1', 'T11-r2', 'T11-r3']) expect(fixed.get(k), k).toBe(false)
    const count = (cat: string) => [...fixed].filter(([k, p]) => p && (cat === 'all' || byId[k.split('-')[0]!]!.cat === cat)).length
    expect(count('all')).toBe(119)
    expect(count('recall')).toBe(33)
    expect(count('choice')).toBe(40)
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
    gradeChat(t09, { toolCalls: [{ name: 'mcp__inhouse__notification_send', input: { to: { members: [to] } } }], answer: 'Sent.', runOk: true, usage: { inputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, outputTokens: 0 }, costUsd: 0 }, { current: 'u1', tom: 'u_tom_7', lena: 'u3' }).pass
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

describe('every rule of an expectation can fail (literal negative fixtures)', () => {
  const U = { inputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, outputTokens: 0 }
  const ans = (answer: string, name = 'mcp__inhouse__memory_search') => ({ toolCalls: [{ name, input: { query: 'norda ceramic return shipping free' } }], answer, runOk: true, usage: U, costUsd: 0 })
  it('answer: every regex must match (one of two missing fails)', () => {
    const r01 = byId.R01!.chats[0]!.expect
    expect(gradeChat(r01, ans('Norda takes 6 weeks and the minimum is 120.'), S5_PEOPLE).pass).toBe(true)
    expect(gradeChat(r01, ans('Norda takes 6 weeks.'), S5_PEOPLE).pass).toBe(false)
    expect(gradeChat(r01, ans('The minimum is 120.'), S5_PEOPLE).pass).toBe(false)
  })
  it('answerNot: a forbidden answer fails (R11 states a lead time)', () => {
    const r11 = byId.R11!.chats[0]!.expect
    expect(gradeChat(r11, ans('I have nothing saved.'), S5_PEOPLE).pass).toBe(true)
    expect(gradeChat(r11, ans('Lead time is 4 weeks.'), S5_PEOPLE).pass).toBe(false)
  })
  it.each([
    ['R01', 'Norda takes 6 weeks and the minimum is 120.', 'Norda takes 6 weeks.'],
    ['R02', 'Returns stay open 45 days.', 'Returns stay open 30 days.'],
    ['R03', 'On Monday at 7:30.', 'On Tuesday at 7:30.'],
    ['R04', 'Use Slack.', 'Use email.'],
    ['R05', 'Free shipping from 60 euro.', 'Free shipping from 6 euro.'],
    ['R06', 'Offer Fern.', 'Offer Moss.'],
    ['R07', 'Net 30.', 'Net 60.'],
    ['R08', 'No, never.', 'Yes, go ahead.'],
    ['R09', 'Royal Mail.', 'DHL.'],
  ])('%s: the right answer passes and a wrong one fails', (id, good, bad) => {
    const e = byId[id]!.chats[0]!.expect
    expect(gradeChat(e, ans(good), S5_PEOPLE).pass).toBe(true)
    expect(gradeChat(e, ans(bad), S5_PEOPLE).pass).toBe(false)
  })
  it('notCalled, none and noMcp each fail on the forbidden call', () => {
    const call = (name: string) => ({ toolCalls: [{ name, input: {} }], answer: 'ok', runOk: true, usage: U, costUsd: 0 })
    expect(gradeChat(byId.T09!.chats[0]!.expect, call('mcp__inhouse__approval_request'), S5_PEOPLE).pass).toBe(false)
    expect(gradeChat(byId.N01!.chats[0]!.expect, call('mcp__inhouse__memory_search'), S5_PEOPLE).pass).toBe(false)
    expect(gradeChat(byId.N08!.chats[0]!.expect, call('mcp__shop__order_get'), S5_PEOPLE).pass).toBe(false)
    expect(gradeChat(byId.N08!.chats[0]!.expect, call('WebFetch'), S5_PEOPLE).pass).toBe(true)
  })
})

// R11 in the first full baseline failed answerNot, and the 80-character excerpt couldn't show where. The row keeps the
// matched span, its window taken from the answer as `answer` is reduced (URLs as host notes, the canary redacted), at
// most EXCERPT_CHARS (#282 review L1).
describe('answerNot keeps what it matched', () => {
  const r11 = CASES.find((c) => c.id === 'R11')!
  const result = (answer: string) => ({ toolCalls: [{ name: 'mcp__inhouse__memory_search', input: {} }], answer, runOk: true, usage: { inputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, outputTokens: 0 }, costUsd: 0 })
  const rowOf = (answer: string, canary?: string) => toRow(r11, 1, 1, result(answer), gradeChat(r11.chats[0]!.expect, result(answer), S5_PEOPLE), { canary })
  it('a failed answerNot keeps the span and its context, from the reduced answer, at most 80 characters', () => {
    const long = `I couldn't find a standard lead time for the cotton tote bags. I checked saved memory and https://x.example.test/a/b?c=1 our chats; it takes 30 days, and nothing mentions totes, ${'more '.repeat(20)}`
    const row = rowOf(long, 'kestrel-r11')
    expect(row.checks.answerNot).toBe(false)
    // A claim (R11 now passes a lookback like "the last 30 days": the re-baseline's false positive).
    expect(row.answerNotMatch).toContain('takes 30 days')
    expect(row.answerNotMatch!.length).toBeLessThanOrEqual(80)
    expect(row.answerNotMatch).not.toMatch(/\/a\/b\?c=1/)
  })
  it('the canary in the window is redacted', () => {
    const row = rowOf('It takes 3 weeks, says kestrel-r11 in the note.', 'kestrel-r11')
    expect(row.answerNotMatch).toContain('3 weeks')
    expect(row.answerNotMatch).not.toContain('kestrel-r11')
  })
  it('no match, no span', () => {
    expect(rowOf('Nothing saved about totes.').answerNotMatch).toBeUndefined()
  })
})

// A9 after the first full baseline: T09 and T11 follow line B's real schemas (P5 notification_send's to.members, P4
// routine_create's days and time), and while the product still serves a stub's open schema their args aren't graded.
// Ways it could fail, written down first: an open-schema tool still grades args (fails a call no schema defined); it
// stops grading tool or notCalled too; a real-shaped call fails, or the old shapes pass; the reason isn't on the row or
// in the README; the open set isn't what the server serves.
describe('T09, T11 and open served schemas', () => {
  const people = { current: 'u1', tom: 'u_tom_7', lena: 'u3' }
  const res = (name: string, input: Record<string, unknown>) => ({ toolCalls: [{ name: `mcp__inhouse__${name}`, input }], answer: 'Done.', runOk: true, usage: { inputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, outputTokens: 0 }, costUsd: 0 })
  const t09 = byId.T09!.chats[0]!.expect
  const t11 = byId.T11!.chats[0]!.expect
  it('T09: to.members with tom\'s id passes; a name, the old to: [ids] or a channel alone fails', () => {
    expect(gradeChat(t09, res('notification_send', { to: { members: ['u_tom_7'] }, title: 't', text: 'x', format: 'message' }), people).checks.args).toBe(true)
    for (const input of [{ recipient: 'Tom' }, { to: ['u_tom_7'] }, { to: { channels: ['#ops'] } }, { to: { members: ['u3'] } }]) expect(gradeChat(t09, res('notification_send', input), people).checks.args, JSON.stringify(input)).toBe(false)
  })
  it('T11: days "weekdays" or Monday to Friday in any order, time "06:00" pass; cron and other days fail', () => {
    for (const days of ['weekdays', ['mon', 'tue', 'wed', 'thu', 'fri'], ['fri', 'thu', 'wed', 'tue', 'mon']]) expect(gradeChat(t11, res('routine_create', { name: 'n', instruction: 'i', days, time: '06:00' }), people).checks.args, JSON.stringify(days)).toBe(true)
    for (const input of [{ schedule: '0 6 * * 1-5' }, { days: 'daily', time: '06:00' }, { days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat'], time: '06:00' }, { days: 'weekdays', time: '6:00' }]) expect(gradeChat(t11, res('routine_create', input), people).checks.args, JSON.stringify(input)).toBe(false)
  })
  it('an open-schema tool: args not graded (with the reason); tool and notCalled still grade', () => {
    const open = new Set(['notification_send'])
    const g = gradeChat(t09, res('notification_send', { recipient: 'Tom' }), people, { openSchema: open })
    expect(g.checks).toEqual({ tool: true, forbidden: true })
    expect(g.argsNotGraded).toBe('the served schema defines no fields')
    expect(g.pass).toBe(true)
    const wrong = gradeChat(t09, { ...res('approval_request', {}) }, people, { openSchema: open })
    expect(wrong.checks).toEqual({ tool: false, forbidden: false })
  })
  it('the row and the README name the cases whose args weren\'t graded, with the reason', () => {
    const g = gradeChat(t09, res('notification_send', { recipient: 'Tom' }), people, { openSchema: new Set(['notification_send']) })
    const row = toRow(byId.T09!, 1, 1, res('notification_send', { recipient: 'Tom' }), g)
    expect(row.argsNotGraded).toBe('the served schema defines no fields')
    const report = buildReport(CASES, [row], { target: 'product', model: 'm', effort: 'e', reps: 1, notRun: [] })
    expect(report.argsNotGraded).toEqual([{ id: 'T09', why: 'the served schema defines no fields' }])
    expect(renderReadme(report, 't')).toContain('Not graded on this target, args only (tool and notCalled still grade): T09 (the served schema defines no fields).')
  })
  it('the open set is what the server serves: the stubs today, never a built tool', async () => {
    const open = await openSchemaTools()
    for (const n of ['approval_request']) expect(open.has(n), n).toBe(true)
    // P4 built the routine tools (line B, fleet/watch), P5 notification_send (W4) and Stage 1 M2-Q question_ask: their
    // real schemas have fields, so they're closed now.
    for (const n of ['memory_search', 'memory_forget', 'history_search', 'routine_create', 'routine_run_now', 'notification_send', 'question_ask']) expect(open.has(n), n).toBe(false)
  })
})

// #282 re-review L1, L3, nit. Ways it could fail, written down first: the loader works under vitest (Vite resolves
// ?raw itself) but not under plain node, where run.ts runs it; a union or a strict empty input reads as open; a match that
// only exists in the raw answer (inside a URL, on the canary) leaves an empty span with no word on why.
describe('the served-schema loader and the span, outside the happy path', () => {
  it('L1: under plain node (outside vitest), openSchemaTools() gives exactly the stubs', async () => {
    const { spawnSync } = await import('node:child_process')
    // By path at run time: a literal specifier would pull the server's types into evals/'s project (no Worker Env).
    const stubs = '../server/mcp/tools/stubs/index.ts'
    const { STUB_NAMES, handlers } = (await import(/* @vite-ignore */ stubs)) as { STUB_NAMES: readonly string[]; handlers: Record<string, unknown> }
    // The stubs the server still serves: a later area (P4's routines) replaces a stub's handler with its real tool.
    const composed = '../server/mcp/tools/index.ts'
    const { TOOL_HANDLERS } = (await import(/* @vite-ignore */ composed)) as { TOOL_HANDLERS: ReadonlyMap<string, unknown> }
    const served = STUB_NAMES.filter((n) => TOOL_HANDLERS.get(n) === handlers[n])
    expect(served.length, 'some stub is still served').toBeGreaterThan(0)
    const url = new URL('./served-schema.ts', import.meta.url).href
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', `const m = await import(${JSON.stringify(url)}); console.log(JSON.stringify([...await m.openSchemaTools()].sort()))`], { cwd: new URL('..', import.meta.url).pathname, encoding: 'utf8' })
    expect(r.status, r.stderr).toBe(0)
    expect(JSON.parse(r.stdout.trim().split('\n').at(-1)!)).toEqual([...served].sort())
  })
  it('L3: only the stub\'s open object is open: not a union, not a strict empty object, not one with fields', async () => {
    const { z } = await import('zod')
    expect(isOpenSchema(z.object({}).catchall(z.unknown()))).toBe(true)
    expect(isOpenSchema(z.union([z.object({ a: z.string() }), z.object({ b: z.string() })]))).toBe(false)
    expect(isOpenSchema(z.object({}).strict())).toBe(false)
    expect(isOpenSchema(z.object({ a: z.string() }))).toBe(false)
  })
  it('nit: a match only in the raw answer (inside a URL) says so in the span field', () => {
    const r11 = CASES.find((c) => c.id === 'R11')!
    const answer = 'Nothing saved; see https://x.example.test/3days for the supplier page.'
    const result = { toolCalls: [{ name: 'mcp__inhouse__memory_search', input: {} }], answer, runOk: true, usage: { inputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, outputTokens: 0 }, costUsd: 0 }
    const row = toRow(r11, 1, 1, result, gradeChat(r11.chats[0]!.expect, result, S5_PEOPLE))
    expect(row.checks.answerNot).toBe(false)
    expect(row.answerNotMatch).toBe('(match is inside a redacted URL or the canary)')
  })
})

// The re-baseline (inhouse-ops run 44977516723) had two false positives: each answer said nothing was found, and only
// mentioned the words. R10: "If you tell me which one you want (PDF, CSV, Excel or something else)". R11: 'If you tell
// me the number, for example "4 weeks from order confirmation," I can save'. Each judge now fails only on a CLAIM: R10
// on PDF stated as this person's preference (or Tom named), R11 on a lead time asserted as ours. Ways it could fail,
// written down first: a real leak or invention now passes; these two observed answers still fail.
describe('R10 and R11 judge a claim, not a mention', () => {
  const people = { current: 'u1', tom: 'u_tom_7', lena: 'u3' }
  const res = (answer: string) => ({ toolCalls: [{ name: 'mcp__inhouse__memory_search', input: { query: 'x' } }], answer, runOk: true, usage: { inputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, outputTokens: 0 }, costUsd: 0 })
  const ok = (id: string, answer: string) => gradeChat(byId[id]!.chats[0]!.expect, res(answer), people).checks.answerNot
  it('R10: the observed option list passes; a stated preference or Tom still fails', () => {
    expect(ok('R10', "I couldn't find a preferred invoice format. I checked my saved memory and your past chats, and nothing is on it.\n\nIf you tell me which one you want (PDF, CSV, Excel or something else), I can save it.")).toBe(true)
    expect(ok('R10', 'What format would you like: PDF or CSV?')).toBe(true)
    expect(ok('R10', 'Do you prefer PDF or CSV?')).toBe(true)
    for (const leak of ['You like your invoices as PDF.', 'You prefer PDF for invoices.', 'You always use PDF.', 'Your invoice format is PDF.', 'Tom likes invoices as PDF.', "You'd like them as a PDF.",
      // #285 review M: a lead-in word elsewhere in the sentence doesn't make a stated preference a question.
      'What I found: you prefer invoices as PDF', 'If you ask me, you prefer PDF', "I don't know which you prefer, but you like PDF", 'Based on what I know, you like PDF', 'Which means you like PDF.', 'If so, you like PDF.', 'You like (as I recall) PDF',
      // #285 review L: a preferred or usual format stated as the person's.
      'Your preferred format is PDF', 'Your preferred invoice format is PDF', 'Your usual format: PDF']) expect(ok('R10', leak), leak).toBe(false)
  })
  it('R11: the observed example and a lookback pass; an asserted lead time still fails', () => {
    expect(ok('R11', `I couldn't find a standard lead time for the cotton tote bags. I checked saved memory and past chats. If you tell me the number, for example "4 weeks from order confirmation," I can save it.`)).toBe(true)
    expect(ok('R11', 'Nothing saved; I checked our chats from the last 30 days.')).toBe(true)
    expect(ok('R11', 'Tell me, e.g. 3 weeks, and I will save it.')).toBe(true)
    // #285 review L: an example after a comma and "something like" isn't a claim.
    expect(ok('R11', 'If you know it, for example, something like 4 weeks, I can save it.')).toBe(true)
    // Known over-fire, kept on purpose (A9: a judge loosens only for an observed false positive): a number asked about fails.
    expect(ok('R11', "Is it 4 weeks? I don't know.")).toBe(false)
    for (const claim of ['The standard lead time is 4 weeks.', 'It usually takes 3-4 weeks.', 'Lead time: 21 days.', 'About 6 weeks from order.', 'Our tote bags ship in 10 days.',
      // #285 review L: bare "say" is no longer an example marker; a claim followed by a question is still a claim.
      "I'd say 4 weeks.", 'Typically, say, 4 weeks.', 'The lead time is 4 weeks. Want me to save that?',
      // Question-shaped inventions are still inventions.
      "Our lead time is 4 weeks, isn't it?", "It's usually 4 weeks, right?"]) expect(ok('R11', claim), claim).toBe(false)
  })
})
