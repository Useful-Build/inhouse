// M1-P (N6's server side, N3's texts) on the BrandAgent's real SQLite with the port fakes. Expected values are literals
// written here, never read from the code under test. Ways it can fail, written down first:
//  1. a turn with a helpers' model starts without the helpers (or with only one key: the runner refuses), a turn
//     without one starts with them, or the run grant doesn't carry the model the start names;
//  2. a pre-M1-P object loses rows on upgrade, or an old turn or token reads a helper model it never had;
//  3. a helper's model calls are left out of the turn's settle ("subagent spend is on the ledger");
//  4. a job's continuation loses the helpers its root had;
//  5. a continuation reads, after a reload, as the person's own message, or its failure's "Try again" re-sends the
//     server's own job text instead of the person's question;
//  6. the shipped job ports still have no texts, so no turn is ever promoted.
import { env } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'
import type { SendTurnResult } from '../../../shared/contract/runs.ts'
import { HelperAgents, RunStart } from '../../../shared/protocol/index.ts'
import { HELPER_AGENTS } from '../../prompt/agents.ts'
import { JOB_TEXTS } from '../../prompt/job.ts'
import { JOB_CARRIED_ON_TEXT, chatStore } from '../../db/chats.ts'
import { MEMBER, d1Chat, ev, fullAnswer, inAgent, settle } from '../../testing/brand-agent/core-harness.ts'
import type { Harness } from '../../testing/brand-agent/core-harness.ts'
import { fakeJobDeps, jobsOf, wireJobs } from '../../testing/brand-agent/job-kit.ts'
import type { RunEventBody } from '../../../shared/protocol/index.ts'
import { jobDeps } from './compose.ts'
import type { ModelCallUsage, ModelCallWorst, Refusal, SubmitTurn } from './ports.ts'
import { storedProjection } from './projection.ts'
import { createAgentTables } from './schema.ts'
import { createRunTokensTable, hashRunToken } from './tokens.ts'
import { createScriptedModel } from '../../../test/scripted-model/index.ts'
import { SCENARIOS } from '../../../test/scripted-model/scenarios.ts'
import { HELPER_ANSWER, HELPER_REPORT, HELPER_USAGE } from '../../../test/scripted-model/scenarios/subagents.ts'

const ok = (r: SendTurnResult | Refusal): SendTurnResult => {
  if ('refused' in r) throw new Error(`refused ${JSON.stringify(r.refused)}`)
  return r
}
let CHAT = ''
let chats = 0
beforeEach(() => { CHAT = `c_m1p${++chats}_${Math.random().toString(36).slice(2, 8)}` })

/** An Opus turn whose helpers run on Sonnet (route 29's pick for a brand with Sonnet on), or none. */
const opusTurn = (key: string, subagentModel?: string): SubmitTurn => ({
  chatId: CHAT, by: { kind: 'person', memberId: MEMBER }, model: 'claude-opus-5-5', pickerId: 'opus', effort: 'medium',
  sideModel: 'claude-haiku-5-5', maxTurns: 25, webFetchDomains: [],
  input: { clientTurnKey: key, text: `question ${key}`, priority: 'next', model: 'opus', attachments: [] },
  ...(subagentModel === undefined ? {} : { subagentModel }),
})
const placedStarts = (h: Harness) => h.pool.calls.filter(c => c.method === 'place').map(c => c.args[0] as RunStart)
const W = (model: string, micro: number): ModelCallWorst => ({ model, inputTokens: 1000, maxTokens: 1000, modifiers: {}, micro })
const U = (micro: number): ModelCallUsage => ({ inputTokens: 100, outputTokens: 50, cacheWrite5mTokens: 0, cacheWrite1hTokens: 0, cacheReadTokens: 0, webSearches: 0, micro })
const cp = (n: number) => ({ mainEntries: n, lastUuid: `u${n}`, lastUuidIndex: n - 1 })
const maxTurns = (n: number): RunEventBody[] => [ev.started(), ev.tool('Bash'), ev.text('working'), ev.checkpoint(n, `u${n}`, n - 1), ev.finished('error_max_turns'), ev.released(cp(n))]

describe('the helpers on a turn (failure 1)', () => {
  it('a turn with a helpers\' model starts with both helpers and that model, and its grant lets the model through', () => inAgent(async h => {
    const t = ok(await h.core.submitTurn(opusTurn('key-helpers1', 'claude-sonnet-5-5')))
    await settle()
    const [rs] = placedStarts(h)
    expect(rs).toMatchObject({ runId: t.turnId, model: 'claude-opus-5-5', subagentModel: 'claude-sonnet-5-5' })
    expect(rs!.agents).toEqual(HELPER_AGENTS)
    expect(RunStart.safeParse(rs).success).toBe(true)
    expect(h.turn(t.turnId).subagent_model).toBe('claude-sonnet-5-5')
    const grant = h.tokens.check(await hashRunToken(rs!.runToken), 'model', h.clock.now)
    expect(grant).toMatchObject({ turnId: t.turnId, model: 'claude-opus-5-5', sideModel: 'claude-haiku-5-5', subagentModel: 'claude-sonnet-5-5' })
  }))

  it('a turn without one (a routine, or a turn stored before M1-P) starts with neither key, and its grant has none', () => inAgent(async h => {
    const t = ok(await h.core.submitTurn(opusTurn('key-helpers2')))
    await settle()
    const [rs] = placedStarts(h)
    expect('agents' in rs!).toBe(false)
    expect('subagentModel' in rs!).toBe(false)
    expect(h.turn(t.turnId).subagent_model).toBeNull()
    expect(h.tokens.check(await hashRunToken(rs!.runToken), 'model', h.clock.now)).toMatchObject({ turnId: t.turnId, subagentModel: null })
  }))

  it('the helpers\' words fit the protocol\'s caps', () => {
    expect(HelperAgents.parse(HELPER_AGENTS)).toEqual(HELPER_AGENTS)
  })
})

describe('upgrade (failure 2)', () => {
  it('a pre-M1-P object gains turns.subagent_model and run_tokens.subagent_model, its rows kept and read as none', () => inAgent(async h => {
    const t = ok(await h.submit(CHAT, 'key-oldrow1'))
    await settle()
    const [rs] = placedStarts(h)
    h.sql.exec('ALTER TABLE turns DROP COLUMN subagent_model')
    h.sql.exec('ALTER TABLE run_tokens DROP COLUMN subagent_model')
    createAgentTables(h.sql)
    createRunTokensTable(h.sql)
    const cols = (table: string) => h.sql.exec<{ name: string }>(`SELECT name FROM pragma_table_info('${table}')`).toArray().map(r => r.name)
    expect(cols('turns')).toContain('subagent_model')
    expect(cols('run_tokens')).toContain('subagent_model')
    expect(h.turns()).toHaveLength(1)
    expect(h.turn(t.turnId)).toMatchObject({ client_key: 'key-oldrow1', subagent_model: null })
    expect(h.tokens.check(await hashRunToken(rs!.runToken), 'model', h.clock.now)).toMatchObject({ turnId: t.turnId, model: 'claude-sonnet-5-5', subagentModel: null })
    // A restart over the upgraded tables starts a helpers turn.
    const h2 = h.restart()
    ok(await h2.core.submitTurn({ ...opusTurn('key-newrow1', 'claude-sonnet-5-5'), chatId: `${CHAT}-b` }))
    await settle()
    expect(placedStarts(h2).at(-1)).toMatchObject({ subagentModel: 'claude-sonnet-5-5' })
  }))
})

describe('subagent spend is on the ledger (failure 3)', () => {
  it('a turn whose helper made model calls settles the sum of every call, the helper\'s included', () => inAgent(async h => {
    const t = ok(await h.core.submitTurn(opusTurn('key-spend1', 'claude-sonnet-5-5'))).turnId
    await settle()
    // The main agent on Opus, then a researcher on Sonnet, then the main agent again (the egress admits each one).
    const calls: [string, string, number][] = [['c1', 'claude-opus-5-5', 40_000], ['c2', 'claude-sonnet-5-5', 15_000], ['c3', 'claude-opus-5-5', 25_000]]
    for (const [id, model] of calls) {
      void h.core.admitModelCall(t, id, W(model, 100_000))
      await settle()
      await h.core.renewModelCall(t, id, U(0))
    }
    for (const [id, , micro] of calls) expect(await h.core.releaseModelCall(t, id, { usage: U(micro), cut: false })).toEqual({ ok: true })
    h.push(t, ...fullAnswer('done', 2))
    await settle()
    expect(h.turn(t).state).toBe('ended')
    expect(h.sql.exec<{ model: string; micro: number }>('SELECT model, micro FROM model_calls WHERE turn_id = ? ORDER BY n', t).toArray().map(r => [r.model, r.micro]))
      .toEqual([['claude-opus-5-5', 40_000], ['claude-sonnet-5-5', 15_000], ['claude-opus-5-5', 25_000]])
    expect(h.usage.final.has(t)).toBe(true)
    expect(h.usage.booked.get(t)).toBe(80_000)
    expect(h.usage.spent).toBe(80_000)
  }))
})

describe('a job with the real texts (failures 4, 5, 6)', () => {
  it('the shipped job ports carry the real texts: jobs are on', () => {
    expect(jobDeps(env).texts).toBe(JOB_TEXTS)
  })

  it('a continuation keeps the helpers, reads as the agent carrying on after a reload, and its "Try again" asks the person\'s question', () => inAgent(async h => {
    await d1Chat(CHAT, MEMBER)
    const deps = fakeJobDeps()
    deps.texts = JOB_TEXTS
    deps.settingsAnswer = { ...deps.settingsAnswer, model: 'claude-opus-5-5', pickerId: 'opus', subagentModel: 'claude-sonnet-5-5' }
    wireJobs(h, deps)
    const root = ok(await h.core.submitTurn(opusTurn('key-root1', 'claude-sonnet-5-5')))
    await settle()
    h.push(root.turnId, ...maxTurns(3))
    await settle()
    await h.tick(0)
    const [job] = jobsOf(h)
    expect(job).toMatchObject({ root_turn_id: root.turnId, state: 'running' })
    const cont = h.turns().find(t => t.job_id === job!.job_id && t.turn_id !== root.turnId)!
    expect(cont).toMatchObject({ source: 'job', text: JOB_TEXTS.carryOn(1), subagent_model: 'claude-sonnet-5-5' })
    expect(placedStarts(h).at(-1)).toMatchObject({ runId: cont.turn_id, subagentModel: 'claude-sonnet-5-5', agents: HELPER_AGENTS })
    // The continuation fails (not a limit the job carries on from): its end row offers the person's own question.
    h.push(cont.turn_id, ev.started(), ev.failed('sdk_error'), ev.released(cp(3)))
    await settle()
    const rows = storedProjection(h.sql, cont.turn_id)!.rows
    expect(rows[0]).toMatchObject({ id: `${cont.turn_id}.u`, role: 'user', text: JOB_TEXTS.carryOn(1), extra_json: JSON.stringify({ source: 'job' }) })
    expect(JSON.parse(rows.at(-1)!.extra_json!)).toEqual({ failure: 'sdk_error', retryQuestion: `question key-root1` })
    // The root's own row is the person's, untouched.
    expect(storedProjection(h.sql, root.turnId)!.rows[0]).toMatchObject({ role: 'user', text: 'question key-root1', extra_json: null })
    // After a reload (D1): the continuation is the agent carrying on, never the person's message.
    await h.tick(60_000)
    const page = await chatStore({ db: env.DB }).messages(CHAT, null, 50)
    expect(page.find(m => m.id === `${cont.turn_id}.u`)).toMatchObject({ role: 'event', text: JOB_CARRIED_ON_TEXT })
    expect(page.find(m => m.id === `${root.turnId}.u`)).toMatchObject({ role: 'user', text: 'question key-root1' })
    expect(page.some(m => m.role === 'user' && m.text.includes('Automatic note'))).toBe(false)
  }))
})

// The sandbox's scripted helper turn (e2e/api/helpers.spec.ts). Ways it could fail: a helper request that isn't ours
// (no researcher words, or offered the Agent tool) gets an answer, or the main thread's answer comes without the
// helper's result.
describe('the helper-research scenario', () => {
  const post = (body: Record<string, unknown>) =>
    new Request('http://proxy/model/v1/messages', { method: 'POST', body: JSON.stringify({ model: 'claude-sonnet-5-5', stream: false, ...body }) })
  const answer = async (m: ReturnType<typeof createScriptedModel>, body: Record<string, unknown>) =>
    (await (await m.handle(post(body), 'helper-research')).json()) as { content?: { type: string; text?: string; id?: string; input?: Record<string, unknown> }[]; usage?: unknown; error?: { message: string } }

  it('starts the researcher, answers its own request with the marked usage, then answers from its report', async () => {
    const m = createScriptedModel(SCENARIOS)
    const tools = [{ name: 'Bash' }, { name: 'Agent' }]
    const first = await answer(m, { tools, messages: [{ role: 'user', content: 'scenario:helper-research go' }] })
    const call = first.content!.find(b => b.type === 'tool_use')!
    expect(call.input).toMatchObject({ subagent_type: 'researcher' })
    const helperBody = { system: [{ type: 'text', text: HELPER_AGENTS.researcher.prompt }], tools: [{ name: 'Read' }, { name: 'WebFetch' }], messages: [{ role: 'user', content: String(call.input!.prompt) }] }
    const helper = await answer(m, helperBody)
    expect(helper).toMatchObject({ content: [{ type: 'text', text: HELPER_REPORT }], usage: HELPER_USAGE })
    // Not ours: offered the Agent tool (a miss), or without the server's researcher words (not the researcher's branch).
    const m2 = createScriptedModel(SCENARIOS)
    await answer(m2, { tools, messages: [{ role: 'user', content: 'scenario:helper-research go' }] })
    expect((await answer(m2, { ...helperBody, tools: [{ name: 'Agent' }] })).error?.message).toContain('the helper was offered the Agent tool')
    // Without the server's researcher words it is not the researcher's conversation: it never gets the report.
    expect(JSON.stringify(await answer(m2, { ...helperBody, system: 'You are general-purpose.' }))).not.toContain(HELPER_REPORT)
    const last = await answer(m, { tools, messages: [
      { role: 'user', content: 'scenario:helper-research go' },
      { role: 'assistant', content: first.content },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: call.id, content: HELPER_REPORT }] },
    ] })
    expect(last.content).toEqual([{ type: 'text', text: HELPER_ANSWER }])
    // A helper whose own request missed comes back as its text, not an error: the main thread's answer is a miss then.
    const m3 = createScriptedModel(SCENARIOS)
    await answer(m3, { tools, messages: [{ role: 'user', content: 'scenario:helper-research go' }] })
    const missed = await answer(m3, { tools, messages: [
      { role: 'user', content: 'scenario:helper-research go' },
      { role: 'assistant', content: first.content },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: call.id, content: 'API Error: 400 scripted model miss' }] },
    ] })
    expect(missed.error?.message).toContain("the helper's result is not its report")
  })
})
