// The contract suite: one set of tests run over every target in targets.ts (P1: the mock). It holds a client to the shared
// schema in shared/contract/ and to the AgentClient's documented behaviour. A test names no id, question or timer of its
// own: it asks the target (`t.fixtures`, `t.advance`, `t.seed`, `t.failSaves`, `t.injectError`), so P2's real target joins
// the list without a test changing.
//
// Ways a client can break the contract, written down before the tests:
//  - a read() value, a state, a file, a notification, a notice or a trace that doesn't parse through its schema, in some stage or scenario;
//  - a run event that doesn't parse, a run that doesn't begin with run.started or doesn't end in one terminal event;
//  - a write that returns something its schema rejects, or leaves state that doesn't parse;
//  - a snapshot that changes identity with nothing changed (React re-renders forever), or keeps it after a change (it never updates);
//  - a write that doesn't show at once (optimistic), or doesn't tell its listeners;
//  - a failed write that stays applied, resolves, rejects with something other than an AgentError (or the wrong code),
//    tells nobody, tells twice, tells with the wrong kind of notice, or still sends what it was taken back from;
//  - a listener that fires after it unsubscribed;
//  - (P2) a write to a record changed behind the client that applies anyway, or rejects without the record as it is now
//    (`conflict` with `current`); a setting key or value outside the registry, or a role, photo or grant sent through a
//    setting, that is taken; `me()` that doesn't parse or whose `can` disagrees with the role; a team left with no Admin;
//    an email invited twice; two live support grants; a failed read that `retry` doesn't bring back.
// The properties at the end cover the first and third at once (any sequence of writes and runs keeps everything parseable)
// and the failure case at once (a write that fails never changes the snapshot).
//
// To replay a failing property: VITE_PROP_SEED=<seed> npm run test:unit. Longer run: VITE_PROP_RUNS=1000.
import { fc } from '@fast-check/vitest'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { z } from 'zod'
import {
  AgentDataSchema, AgentErrorCodeSchema, AgentNoticeSchema, AgentNotificationSchema, AgentStateSchema, ApproveResultSchema, ErrorReasonSchema, InstantSchema,
  LibraryFileSchema, MeSchema, MemberRecordSchema, RoutineRunSchema, RunEventSchema, SettingRecordSchema, SupportGrantSchema, ToolSetupSchema, TraceSchema,
} from '../../../shared/contract'
import type { AgentClient, AgentNotice, AgentState, RunEvent, Scenario, SendPriority, Stage } from '../types'
import { AgentError, SCENARIOS, STAGES } from '../types'
import type { ContractTarget, WriteMethod } from './targets'
import { targets } from './targets'

/** The server's access rows, as far as the Admin's `can` check reads them. */
interface AccessRows {
  accessMatrix: { method: string; pattern: string; class: string; allow: string[]; adminWrite?: boolean }[]
  canRows: Record<string, { method: string; pattern: string; as?: string }>
}
const ACCESS_ROWS = '../../../server/access-matrix.ts'

const numRuns = Number(import.meta.env.VITE_PROP_RUNS) || 100
const seedText = import.meta.env.VITE_PROP_SEED
const params: fc.Parameters<unknown> = { numRuns, ...(seedText ? { seed: Number(seedText) } : {}) }

const parse = <S extends z.ZodType>(schema: S, value: unknown, where: string): z.infer<S> => {
  const r = schema.safeParse(value)
  if (!r.success) throw new Error(`${where} doesn't parse: ${JSON.stringify(r.error.issues.slice(0, 3))}`)
  return r.data
}

const TERMINAL = ['run.finished', 'run.failed', 'run.stopped']
/** How far the clock moves between looks at a run, and the most demo time one event may take before the run is called stuck. */
const STEP_MS = 1000
const STUCK_MS = 10 * 60 * 1000
const SKIP = Symbol('nothing to write')

type Started = Extract<RunEvent, { type: 'run.started' }>

describe.each(targets)('contract: $name', (t: ContractTarget) => {
  const fx = t.fixtures
  /**
   * A case that needs a client method runs only on a target that serves it (`serves`): the real target serves the P2 methods
   * and nothing else until its phase, so what needs a run, an approval, a routine, the library or a stage's sample data
   * belongs to the targets that have them.
   */
  const lacks = (...methods: (keyof AgentClient)[]) => !methods.every(m => t.serves(m))
  /** `only('ask')('title', fn)` and `only('ask').each(rows)('title', fn)`: the test, or a skipped one by that name. */
  const only = (...methods: (keyof AgentClient)[]) => (lacks(...methods) ? test.skip : test)
  /** An example write the target serves: `pause` where it has it, else a text setting. `shown` says whether its change is on a snapshot. */
  const probe = () => (t.serves('pause')
    ? { method: 'pause' as const, run: () => t.client.pause(), undo: () => t.client.resume(), shown: (s: AgentState) => s.paused !== null }
    : { method: 'setSetting' as const, run: () => t.client.setSetting(fx.settingKey, fx.settingValue), undo: () => t.client.setSetting(fx.settingKey, null), shown: (s: AgentState) => s.settings[fx.settingKey] === fx.settingValue })
  const describeIf = (...methods: (keyof AgentClient)[]) => (lacks(...methods) ? describe.skip : describe)
  /** Property runs: the env's count, capped by the target's own (a real target makes several HTTP round trips per run). */
  const runParams: fc.Parameters<unknown> = { ...params, numRuns: Math.min(numRuns, t.propertyRuns ?? numRuns) }
  let notices: AgentNotice[]
  let unsubscribe: () => void
  /** Every `subscribe` listener a test adds: the mock is one shared instance, so each comes off after the test, pass or fail. */
  let offs: (() => void)[] = []
  const subscribe = (listener: () => void) => {
    const off = t.client.subscribe(listener)
    offs.push(off)
    return off
  }
  const dropListeners = () => { const all = offs; offs = []; all.forEach(off => off()) }

  /** A first-run client in a stage and scenario, with the notice collector listening (a reset replaces the client). */
  const fresh = async (stage: Stage = 'Act', scenario: Scenario = 'Normal') => {
    unsubscribe?.()
    dropListeners()
    await t.reset()
    await t.seed({ stage, scenario })
    notices = []
    unsubscribe = t.client.onNotice(n => notices.push(n))
  }
  beforeEach(async () => {
    await t.setup()
    await fresh()
  })
  afterEach(async () => {
    unsubscribe()
    dropListeners()
    await t.failSaves(false)
    await t.teardown()
    // Every notice the test collected is one the schema accepts.
    notices.forEach((n, i) => parse(AgentNoticeSchema, n, `notice ${i}`))
  })

  /** Parses every notice collected so far, then forgets them: none is cleared unread. */
  const clearNotices = () => {
    notices.forEach((n, i) => parse(AgentNoticeSchema, n, `notice ${i}`))
    notices.length = 0
  }

  /** One answer being read. It moves the target's clock on until the next event is there; it never counts loops. */
  const startRun = (question: string, opts: { chatId?: string; replacesRun?: string } = {}) => {
    const it = t.client.ask(question, { chatId: opts.chatId ?? chatId(), ...(opts.replacesRun ? { replacesRun: opts.replacesRun } : {}) })[Symbol.asyncIterator]()
    const events: RunEvent[] = []
    let over = false
    return {
      events,
      /** The next event, or undefined once the run ended. */
      async next(): Promise<RunEvent | undefined> {
        if (over) return undefined
        const pending = it.next()
        let settled = false
        pending.then(() => { settled = true }, () => { settled = true })
        for (let waited = 0; ; waited += STEP_MS) {
          await t.settle() // an event already on its way arrives before the clock moves
          if (settled) break
          if (waited > STUCK_MS) throw new Error(`no event after ${STUCK_MS / 1000} s of demo time; events so far: ${events.map(e => e.type).join(', ')}`)
          await t.advance(STEP_MS)
        }
        const r = await pending
        if (r.done) { over = true; return undefined }
        events.push(r.value)
        // The terminal event is the end: nothing after it is read.
        if (TERMINAL.includes(r.value.type)) { over = true; await it.return?.(undefined) }
        return r.value
      },
      /** Reads to the run's terminal event. */
      async toEnd(): Promise<RunEvent[]> {
        while (await this.next()) { /* each event is collected by next() */ }
        return events
      },
    }
  }
  const drain = (question: string, opts?: { chatId?: string; replacesRun?: string }) => startRun(question, opts).toEnd()

  const checkRun = (events: RunEvent[]) => {
    events.forEach((e, i) => parse(RunEventSchema, e, `event ${i} (${e.type})`))
    expect(events[0]?.type).toBe('run.started')
    const ends = events.filter(e => TERMINAL.includes(e.type))
    expect(ends, 'exactly one terminal event').toHaveLength(1)
    expect(events.at(-1)!.type, 'the run ends on its terminal event').toBe(ends[0].type)
    const started = events[0] as Started
    expect((ends[0] as { runId: string }).runId).toBe(started.runId)
    return events
  }
  /** The state and the data a run left behind still parse. */
  const checkWorld = (where: string) => {
    parse(AgentStateSchema, t.client.getSnapshot(), `getSnapshot() ${where}`)
    parse(AgentDataSchema, t.client.read(), `read() ${where}`)
  }

  /** The first chat the client has: asks go to it. */
  const chatId = (): string => {
    const id = t.client.read().chat.chats[0]?.id ?? t.client.allChatIds()[0]
    if (!id) throw new Error('the client has no chat to ask in')
    return id
  }
  /** The first problem whose approval is held before it goes out, and the first reversible one (no hold). */
  const heldProblem = () => {
    const p = t.client.read().problems.find(x => !x.draft.rev)
    if (!p) throw new Error('no problem with a held approval in this stage and scenario')
    return p.id
  }
  const reversibleProblem = () => t.client.read().problems.find(p => p.draft.rev)?.id
  const firstRoutine = () => {
    const r = t.client.read().routines[0]
    if (!r) throw new Error('no routine in this stage and scenario')
    return r.id
  }
  const firstFile = () => {
    const f = t.client.listFiles()[0]
    if (!f) throw new Error('no library file in this stage and scenario')
    return f.id
  }
  /** Moves the clock on until `cond` holds: for what the client does by itself (a hold ending, a save failing late). */
  const until = async (cond: () => boolean, what: string) => {
    for (let waited = 0; !cond(); waited += STEP_MS) {
      if (waited > STUCK_MS) throw new Error(`${what} didn't happen within ${STUCK_MS / 1000} s of demo time`)
      await t.settle()
      if (cond()) return
      await t.advance(STEP_MS)
    }
  }
  const errorOf = async (p: Promise<unknown>): Promise<unknown> => p.then(() => undefined, (e: unknown) => e)

  const stageAndScenario = STAGES.flatMap(stage => SCENARIOS.map(scenario => [stage, scenario] as [Stage, Scenario]))

  // ---------- reads ----------
  describe('reads parse through their schema', () => {
    only('ask').each(stageAndScenario)('every read in %s, %s', async (stage, scenario) => {
      await t.seed({ stage, scenario })
      const c = t.client
      const data = parse(AgentDataSchema, c.read(), 'read()')
      parse(AgentStateSchema, c.getSnapshot(), 'getSnapshot()')
      c.listFiles().forEach((f, i) => parse(LibraryFileSchema, f, `listFiles()[${i}]`))
      c.listNotifications().forEach((n, i) => parse(AgentNotificationSchema, n, `listNotifications()[${i}]`))
      // Every trace id the data points to: a problem's, and each chat answer's.
      const ids = [...data.problems.flatMap(p => (p.trace ? [p.trace] : [])), ...data.chat.chats.flatMap(ch => ch.turns.flatMap(turn => (turn.role === 'agent' ? [turn.trace] : [])))]
      if (scenario === 'Normal') expect(ids.length, 'the Normal scenario points at traces').toBeGreaterThan(0)
      for (const id of ids) {
        const trace = c.getTrace(id)
        expect(trace, `getTrace("${id}") is null`).not.toBeNull()
        parse(TraceSchema, trace, `getTrace("${id}")`)
      }
      expect(c.getTrace(fx.unknownTraceId)).toBeNull()
      const all = c.allChatIds()
      all.forEach((id, i) => expect(id, `allChatIds()[${i}]`).toEqual(expect.any(String)))
      expect(all.length).toBeGreaterThanOrEqual(data.chat.chats.length)
    })

    test('Loading reports loading; every other scenario reports ready', async () => {
      for (const scenario of SCENARIOS) {
        await t.seed({ stage: 'Act', scenario })
        expect(t.client.read().status, scenario).toBe(scenario === 'Loading' ? 'loading' : 'ready')
      }
    })

    // A product screen reads a tool's connection, the setup list and the morning check's progress from the agent's data,
    // never from a scenario name: these hold for whatever a client serves.
    test('tool connection, setup and read progress name known tools and agree with what is connected, in every scenario', async () => {
      for (const scenario of SCENARIOS) {
        await t.seed({ stage: 'Act', scenario })
        const data = parse(AgentDataSchema, t.client.read(), 'read()')
        const { tools } = data
        for (const key of Object.keys(tools.connection)) {
          expect(tools.connected, `${scenario}: tools.connection names "${key}", which isn't connected`).toContain(key)
          expect(Object.hasOwn(tools.details, key), `${scenario}: tools.connection names an unknown tool "${key}"`).toBe(true)
        }
        // A setup entry is keyed by a tool being connected that the data describes (Today lists it by that key, in
        // `beingConnected`'s order), and the list is over once the agent has a tool to read.
        for (const key of Object.keys(tools.setup)) {
          expect(tools.beingConnected, `${scenario}: tools.setup names "${key}", which isn't being connected`).toContain(key)
          expect(Object.hasOwn(tools.details, key), `${scenario}: tools.setup names an unknown tool "${key}"`).toBe(true)
        }
        if (tools.connected.length) expect(tools.setup, `${scenario}: a setup list although a tool is connected`).toEqual({})
        expect(tools.readDone, `${scenario}: read more tools than are connected`).toBeLessThanOrEqual(tools.connected.length)
        if (data.status === 'ready') expect(tools.readDone, `${scenario}: a ready agent has read every connected tool`).toBe(tools.connected.length)
      }
    })

    only('ask')('a tool whose login failed reads as disconnected since an instant; with every login working, none does', async () => {
      await fresh('Act', 'Normal')
      expect(t.client.read().tools.connection).toEqual({})
      await fresh('Act', 'Tool disconnected')
      const lost = Object.values(t.client.read().tools.connection)
      expect(lost).toHaveLength(1)
      expect(lost[0].status).toBe('disconnected')
      parse(InstantSchema, lost[0].since, 'tools.connection[].since')
    })

    only('ask')('before the first tool is live the setup list names tools being connected; once tools read, it is empty', async () => {
      await fresh('Act', 'First day')
      const first = t.client.read().tools
      expect(first.connected).toEqual([])
      expect(Object.keys(first.setup).length).toBeGreaterThan(0)
      for (const [key, s] of Object.entries(first.setup)) {
        expect(first.beingConnected, `setup lists "${key}", which isn't being connected`).toContain(key)
        parse(ToolSetupSchema, s, `tools.setup["${key}"]`)
      }
      await fresh('Act', 'Normal')
      expect(t.client.read().tools.setup).toEqual({})
    })
  })

  // ---------- run events ----------
  describeIf('ask')('ask() streams events that parse', () => {
    test.each(STAGES)('every suggested question, in %s', async stage => {
      await fresh(stage)
      const questions = t.client.read().chat.suggestions
      expect(questions.length).toBeGreaterThan(0)
      for (const q of questions) {
        const events = checkRun(await drain(q))
        expect(events.at(-1)!.type, q).toBe('run.finished')
        expect(events.some(e => e.type === 'step'), `${q} shows a step before it answers`).toBe(true)
        expect(events.some(e => e.type === 'part'), `${q} answers with a part`).toBe(true)
        checkWorld(`after "${q}"`)
      }
    })

    test('an off-script question answers with what it can do and the suggestions as chips', async () => {
      const events = checkRun(await drain(fx.questions.offScript))
      const chips = events.flatMap(e => (e.type === 'part' ? [e.part] : [])).find(p => p.type === 'suggestions')
      expect(chips && chips.type === 'suggestions' && chips.questions).toEqual(t.client.read().chat.suggestions)
    })

    test('a run opens its trace: the run id, and the trace on each part', async () => {
      const events = checkRun(await drain(fx.questions.table))
      const runId = (events[0] as Started).runId
      parse(TraceSchema, t.client.getTrace(runId), `getTrace("${runId}")`)
      const parts = events.flatMap(e => (e.type === 'part' ? [e] : []))
      expect(parts.length).toBeGreaterThan(0)
      for (const e of parts) parse(TraceSchema, t.client.getTrace(e.trace), `getTrace("${e.trace}")`)
    })

    test('a part may carry the model that answered and when; if it does they are a string and an instant', async () => {
      const events = await drain(fx.questions.table)
      const parts = events.flatMap(e => (e.type === 'part' ? [e] : []))
      expect(parts.length).toBeGreaterThan(0)
      for (const e of parts) {
        if (e.model !== undefined) expect(typeof e.model).toBe('string')
        if (e.at !== undefined) parse(InstantSchema, e.at, 'part.at')
      }
    })

    test('a question with a table answers with a table part, in every stage', async () => {
      for (const stage of STAGES) {
        await fresh(stage)
        const parts = (await drain(fx.questions.table)).flatMap(e => (e.type === 'part' ? [e.part] : []))
        expect(parts.some(p => p.type === 'table'), `a table in ${stage}`).toBe(true)
      }
    })

    test('a request that needs an approval: an approval part and approval.requested in Act, a refusal in Watch', async () => {
      const act = checkRun(await drain(fx.questions.approval))
      const part = act.flatMap(e => (e.type === 'part' ? [e.part] : [])).find(p => p.type === 'approval')
      expect(part, 'an approval part').toBeDefined()
      const requested = act.find(e => e.type === 'approval.requested')
      expect(requested, 'approval.requested').toBeDefined()
      expect(requested && requested.type === 'approval.requested' && requested.approvalId).toBe(part && part.type === 'approval' && part.problemId)
      expect(t.client.read().problems.some(p => p.id === (part && part.type === 'approval' ? part.problemId : ''))).toBe(true)

      await fresh('Watch')
      const watch = checkRun(await drain(fx.questions.approval))
      expect(watch.flatMap(e => (e.type === 'part' ? [e.part] : [])).some(p => p.type === 'notInThisStage'), 'notInThisStage in Watch').toBe(true)
      expect(watch.some(e => e.type === 'approval.requested')).toBe(false)
    })

    test('a routine request makes a routine that is saved in state', async () => {
      const before = t.client.getSnapshot().routinesExtra.length
      const events = checkRun(await drain(fx.questions.routineRequest))
      const card = events.flatMap(e => (e.type === 'part' && e.part.type === 'routine' ? [e.part.routine] : []))[0]
      expect(card).toBeDefined()
      const extra = t.client.getSnapshot().routinesExtra
      expect(extra).toHaveLength(before + 1)
      expect(extra.some(r => r.id === card.id)).toBe(true)
      checkWorld('after a routine request')
    })

    test('a skill request makes a skill that is saved in state', async () => {
      const before = t.client.getSnapshot().skillsExtra.length
      const events = checkRun(await drain(fx.questions.skillRequest))
      expect(events.some(e => e.type === 'part' && e.part.type === 'skill')).toBe(true)
      expect(t.client.getSnapshot().skillsExtra).toHaveLength(before + 1)
      checkWorld('after a skill request')
    })

    test('a question with a disconnected tool ends in run.failed with an error part, and the failed run still opens its trace', async () => {
      await fresh('Act', 'Tool disconnected')
      const events = checkRun(await drain(fx.questions.disconnectedTool))
      expect(events.at(-1)!.type).toBe('run.failed')
      expect(events.some(e => e.type === 'part' && e.part.type === 'error')).toBe(true)
      const runId = (events[0] as Started).runId
      parse(TraceSchema, t.client.getTrace(runId), `getTrace("${runId}") of the failed run`)
    })

    test.each(['First day', 'Loading'] as const)('%s answers that it has nothing to read yet', async scenario => {
      await fresh('Act', scenario)
      const events = checkRun(await drain(fx.questions.table))
      expect(events.some(e => e.type === 'part' && e.part.type === 'text')).toBe(true)
    })

    test.each(['now', 'next', 'later'] as const)('a message sent into a running answer with priority %s starts a turn with its own trace', async (priority: SendPriority) => {
      const run = startRun(fx.questions.table)
      const first = await run.next()
      expect(first?.type).toBe('run.started')
      const runId = (first as Started).runId
      await t.client.send(runId, fx.questions.followUp, { priority })
      const events = checkRun(await run.toEnd())
      expect(events.some(e => e.type === 'turn.started' && e.text === fx.questions.followUp)).toBe(true)
      // The new turn's trace id is the one on its first part, whatever the client calls it.
      const turn = events.findIndex(e => e.type === 'turn.started' && e.text === fx.questions.followUp)
      expect(turn, 'the follow-up opens a turn').toBeGreaterThanOrEqual(0)
      const part = events.slice(turn + 1).find(e => e.type === 'part')
      expect(part, 'the new turn answers with a part').toBeDefined()
      const traceId = (part as Extract<RunEvent, { type: 'part' }>).trace
      expect(traceId).not.toBe(runId)
      parse(TraceSchema, t.client.getTrace(traceId), `getTrace("${traceId}")`)
      checkWorld('after a message sent into a run')
    })

    test('a message sent after the run ended is refused with a conflict and a notice, and so is an interrupt', async () => {
      const events = checkRun(await drain(fx.questions.table))
      const runId = (events[0] as Started).runId
      const sent = await errorOf(t.client.send(runId, fx.questions.tooLate))
      expect(sent).toBeInstanceOf(AgentError)
      expect(parse(AgentErrorCodeSchema, (sent as AgentError).code, 'send() error code')).toBe('conflict')
      const interrupted = await errorOf(t.client.interrupt(runId))
      expect(interrupted).toBeInstanceOf(AgentError)
      expect((interrupted as AgentError).code).toBe('conflict')
      expect(notices.filter(n => n.type === 'error' && n.code === 'conflict')).toHaveLength(2)
      expect(notices).toHaveLength(2)
    })

    test('interrupt on a live run ends its turn; with nothing waiting the run ends', async () => {
      const run = startRun(fx.questions.table)
      const first = await run.next()
      expect(await t.client.interrupt((first as Started).runId), 'interrupt() resolves to nothing').toBeUndefined()
      const events = checkRun(await run.toEnd())
      expect(TERMINAL).toContain(events.at(-1)!.type)
      expect(notices).toEqual([])
    })

    test('interrupt cuts a live run short mid-turn: it ends as stopped, with the parts before the cut and none after', async () => {
      const whole = checkRun(await drain(fx.questions.table))
      expect(whole.some(e => e.type === 'part'), 'left alone, the answer has parts').toBe(true)
      const run = startRun(fx.questions.table)
      const first = await run.next()
      expect((await run.next())?.type, 'the turn is under way').toBe('step')
      const cut = run.events.length
      await t.client.interrupt((first as Started).runId)
      const events = checkRun(await run.toEnd())
      expect(events.at(-1)!.type, 'an interrupt with nothing waiting ends the run as stopped').toBe('run.stopped')
      expect(events.slice(cut).filter(e => e.type === 'part'), 'no part after the cut').toEqual([])
      expect(events.filter(e => e.type === 'part').length, 'the answer was cut short').toBeLessThan(whole.filter(e => e.type === 'part').length)
      expect(notices).toEqual([])
    })

    test('stop ends the run with run.stopped', async () => {
      const run = startRun(fx.questions.table)
      const first = await run.next()
      expect(first?.type).toBe('run.started')
      t.client.stop((first as Started).runId)
      const events = checkRun(await run.toEnd())
      expect(events.at(-1)!.type).toBe('run.stopped')
      checkWorld('after a stop')
    })

    test('asking in a chat the client never made fails loud', async () => {
      const failure = await errorOf(startRun(fx.questions.table, { chatId: fx.unknownChatId }).next())
      expect(failure).toBeInstanceOf(AgentError)
      expect(parse(AgentErrorCodeSchema, (failure as AgentError).code, 'ask() error code')).toBe('not_found')
    })
  })

  // ---------- writes ----------
  describe('write results parse and change state', () => {
    only('approve')('approve a held draft: the result parses, the hold ends in a sent notice', async () => {
      const id = heldProblem()
      const result = parse(ApproveResultSchema, await t.client.approve(id), 'approve()')
      expect(result.held).toBe(true)
      expect(t.client.getSnapshot().approved[id]).toEqual(result.record)
      expect(t.client.getSnapshot().sent[id]).toBeUndefined()
      await t.advance(fx.holdMs)
      expect(t.client.getSnapshot().sent[id]).toBe(true)
      expect(notices).toContainEqual({ type: 'approval.sent', id, text: result.doneText })
      checkWorld('after a hold ended')
    })

    only('approve')('approve twice returns the first record, parsed, and still holds', async () => {
      const id = heldProblem()
      const first = await t.client.approve(id)
      const second = parse(ApproveResultSchema, await t.client.approve(id), 'the second approve()')
      expect(second).toEqual({ ...first, held: true })
    })

    only('approve', 'undo')('undo inside the hold stops the send; undo after it went out rejects with conflict and a notice', async () => {
      const id = heldProblem()
      await t.client.approve(id)
      await t.client.undo(id)
      expect(t.client.getSnapshot().approved[id]).toBeUndefined()
      await t.advance(fx.holdMs + STEP_MS)
      expect(notices.some(n => n.type === 'approval.sent')).toBe(false)
      await t.client.approve(id)
      await t.advance(fx.holdMs)
      const snap = t.client.getSnapshot()
      const refused = await errorOf(t.client.undo(id))
      expect(refused).toBeInstanceOf(AgentError)
      expect(parse(AgentErrorCodeSchema, (refused as AgentError).code, 'undo() error code')).toBe('conflict')
      expect(notices.at(-1)).toMatchObject({ type: 'error', code: 'conflict' })
      expect(t.client.getSnapshot(), 'a refused undo changes nothing').toBe(snap)
    })

    only('approve')('a reversible draft finishes at once, and its result parses', async () => {
      const id = reversibleProblem()
      expect(id, 'the Act scenario has a reversible draft').toBeDefined()
      const result = parse(ApproveResultSchema, await t.client.approve(id!), 'approve() of a reversible draft')
      expect(result.held).toBe(false)
    })

    only('approve', 'editDraft')('edit a draft', async () => {
      const id = heldProblem()
      await t.client.editDraft(id, 'New wording')
      expect(t.client.getSnapshot().edits[id]).toBe('New wording')
    })

    only('runRoutine')('run a routine now: the result parses and heads the list of runs', async () => {
      await fresh('Run')
      const routines = t.client.read().routines
      expect(routines.length).toBeGreaterThan(0)
      for (const r of routines) {
        const run = parse(RoutineRunSchema, await t.client.runRoutine(r.id), `runRoutine(${r.id})`)
        expect(run.routine).toBe(r.id)
        expect(t.client.getSnapshot().routineRuns[0]).toEqual(run)
      }
    })

    only('deleteRoutine')('delete a routine and restore it', async () => {
      const id = firstRoutine()
      await t.client.deleteRoutine(id)
      expect(t.client.getSnapshot().routinesDeleted[id]).toBe(true)
      await t.client.restoreRoutine(id)
      expect(t.client.getSnapshot().routinesDeleted[id]).toBeUndefined()
    })

    only('approve', 'setAside').each(['snoozed', 'dismissed', 'declined'] as const)('set a problem aside as %s, then bring it back', async reason => {
      const id = heldProblem()
      await t.client.setAside(id, reason)
      expect(t.client.getSnapshot().setAside[id]).toMatchObject({ reason })
      await t.client.setAside(id, null)
      expect(t.client.getSnapshot().setAside[id]).toBeUndefined()
    })

    only('approve', 'setAside')('approving a problem that was set aside clears it', async () => {
      const id = heldProblem()
      await t.client.setAside(id, 'snoozed')
      await t.client.approve(id)
      expect(t.client.getSnapshot().setAside[id]).toBeUndefined()
    })

    only('pause')('pause resolves to when, resume clears it', async () => {
      const at = parse(InstantSchema, await t.client.pause(), 'pause()')
      expect(parse(AgentStateSchema, t.client.getSnapshot(), 'getSnapshot()').paused).toEqual(at)
      expect(Date.parse(at.iso), 'iso and ms name one moment').toBe(at.ms)
      await t.client.resume()
      expect(t.client.getSnapshot().paused).toBeNull()
    })

    only('undoHandled')('undo what the agent handled, then redo it', async () => {
      await fresh('Run')
      const id = heldProblem()
      const toast = parse(z.string(), await t.client.undoHandled(id), 'undoHandled()')
      expect(toast.length).toBeGreaterThan(0)
      expect(t.client.getSnapshot().undone[id]).toBeDefined()
      await t.client.redoHandled(id)
      expect(t.client.getSnapshot().undone[id]).toBeUndefined()
    })

    only('sendTeamRequest')('send a team request', async () => {
      await t.client.sendTeamRequest(fx.teamRequest)
      expect(t.client.getSnapshot().teamRequests[0]).toEqual(fx.teamRequest)
    })

    only('requestTool', 'requestSkill', 'setToolPaused', 'forgetMemory')('requests, tool pauses and memory', async () => {
      const c = t.client
      await c.requestTool(fx.toolKey, true)
      expect(c.getSnapshot().requestedTools[fx.toolKey]).toBe(true)
      await c.requestTool(fx.toolKey, false)
      expect(c.getSnapshot().requestedTools[fx.toolKey]).toBeUndefined()
      await c.requestSkill(fx.skillName)
      expect(c.getSnapshot().requestedSkills[fx.skillName]).toBe(true)
      await c.setToolPaused(fx.toolKey, true)
      expect(c.getSnapshot().toolPaused[fx.toolKey]).toBe(true)
      await c.setToolPaused(fx.toolKey, false)
      expect(c.getSnapshot().toolPaused[fx.toolKey]).toBeUndefined()
      await c.forgetMemory(fx.memoryKey, true)
      expect(c.getSnapshot().forgot[fx.memoryKey]).toBe(true)
      await c.forgetMemory(fx.memoryKey, false)
      expect(c.getSnapshot().forgot[fx.memoryKey]).toBeUndefined()
      checkWorld('after the plain writes')
    })

    only('setToggle', 'setSetting', 'setPhoto')('toggles, settings and photos', async () => {
      const c = t.client
      await c.setToggle(fx.toggleKey, false)
      expect(c.getSnapshot().toggles[fx.toggleKey]).toBe(false)
      await c.setSetting(fx.settingKey, fx.settingValue)
      expect(c.getSnapshot().settings[fx.settingKey]).toBe(fx.settingValue)
      await c.setSetting(fx.settingKey, null)
      expect(c.getSnapshot().settings[fx.settingKey]).toBeUndefined()
      const photoOf = () => c.read().people.members.find(m => m.id === fx.personId)?.photo
      await c.setPhoto(fx.personId, fx.photoDataUrl)
      expect(photoOf(), 'the photo reads as the target says it does once set').toEqual(fx.photoAfterSet instanceof RegExp ? expect.stringMatching(fx.photoAfterSet) : fx.photoAfterSet)
      await c.setPhoto(fx.personId, null)
      expect(photoOf(), 'a removed photo no longer reads as the photo').toBeNull()
      expect(Object.keys(c.getSnapshot().settings).filter(k => k.startsWith('photo:')), 'a photo is not a setting').toEqual([])
      checkWorld('after the plain writes')
    })

    only('markNoticesRead')('mark notifications read: only the new ones change state', async () => {
      const ids = t.client.listNotifications().map(n => n.id)
      expect(ids.length).toBeGreaterThan(0)
      await t.client.markNoticesRead(ids)
      expect(Object.keys(t.client.getSnapshot().readNotices).sort()).toEqual([...ids].sort())
      const snap = t.client.getSnapshot()
      await t.client.markNoticesRead(ids)
      expect(t.client.getSnapshot(), 'marking what is read already changes nothing').toBe(snap)
      expect(t.client.listNotifications().every(n => !n.unread)).toBe(true)
    })

    only('deleteFiles')('delete library files and restore them', async () => {
      const files = t.client.listFiles()
      expect(files.length).toBeGreaterThan(1)
      const ids = files.slice(0, 2).map(f => f.id)
      await t.client.deleteFiles(ids)
      expect(t.client.listFiles().map(f => f.id)).not.toContain(ids[0])
      expect(t.client.listFiles()).toHaveLength(files.length - ids.length)
      await t.client.restoreFiles(ids)
      expect(t.client.listFiles().map(f => f.id)).toEqual(files.map(f => f.id))
    })

    only('createChat')('createChat changes the snapshot (a write changes identity, so React sees the new chat)', async () => {
      const before = t.client.getSnapshot()
      await t.client.createChat(fx.newChat)
      expect(t.client.getSnapshot()).not.toBe(before)
    })

    only('createChat')('chats: create, rename, pin, delete, restore', async () => {
      const c = t.client
      const { id, title } = fx.newChat
      await c.createChat({ id, title })
      expect(c.allChatIds()).toContain(id)
      await c.renameChat(id, fx.paddedTitle)
      expect(c.getSnapshot().chatTitles[id]).toBe(fx.paddedTitleTrimmed)
      await c.renameChat(id, null)
      expect(c.getSnapshot().chatTitles[id]).toBeUndefined()
      await c.pinChat(id, true)
      expect(c.getSnapshot().chatPinned[id]).toBe(true)
      await c.pinChat(id, false)
      expect(c.getSnapshot().chatPinned[id]).toBeUndefined()
      await c.deleteChats([id])
      expect(c.getSnapshot().chatDeleted[id]).toBe(true)
      await c.restoreChats([id])
      expect(c.getSnapshot().chatDeleted[id]).toBeUndefined()
      const refused = await errorOf(c.createChat({ id: '  ', title: fx.newChat.title }))
      expect(refused).toBeInstanceOf(AgentError)
      expect(parse(AgentErrorCodeSchema, (refused as AgentError).code, 'createChat() error code')).toBeDefined()
      expect(notices).toHaveLength(1)
      expect(notices[0].type).toBe('error')
    })

    only('ask')('a question asked in a chat made with createChat is answered', async () => {
      await t.client.createChat(fx.newChat)
      checkRun(await drain(fx.questions.table, { chatId: fx.newChat.id }))
    })
  })

  // ---------- snapshots ----------
  describe('snapshots keep their identity until something changes', () => {
    test.each(stageAndScenario)('nothing changed: every read returns the same object in %s, %s', async (stage, scenario) => {
      await t.seed({ stage, scenario })
      const c = t.client
      expect(c.getSnapshot()).toBe(c.getSnapshot())
      expect(c.read()).toBe(c.read())
      expect(c.listFiles()).toBe(c.listFiles())
      expect(c.listNotifications()).toBe(c.listNotifications())
    })

    test('a write gives a new state object and leaves read() alone', async () => {
      const w = probe()
      const before = t.client.getSnapshot()
      const data = t.client.read()
      await w.run()
      expect(t.client.getSnapshot()).not.toBe(before)
      expect(w.shown(before)).toBe(false)
      expect(t.client.read(), 'a write does not change the scenario data').toBe(data)
      const after = t.client.getSnapshot()
      expect(t.client.getSnapshot(), 'reading changes nothing').toBe(after)
    })

    only('deleteFiles', 'markNoticesRead')('files are a new array after a delete, notifications after a read mark, data after a scenario change', async () => {
      const files = t.client.listFiles()
      await t.client.deleteFiles([firstFile()])
      expect(t.client.listFiles()).not.toBe(files)

      const notes = t.client.listNotifications()
      await t.client.markNoticesRead(notes.map(n => n.id))
      expect(t.client.listNotifications()).not.toBe(notes)

      const data = t.client.read()
      await t.seed({ stage: 'Act', scenario: 'Cap reached' })
      expect(t.client.read()).not.toBe(data)
    })

    test('subscribe tells listeners of every change, and stops after unsubscribe', async () => {
      // `seed` resolves only once the client shows the new world, so a listener has heard it by the time it returns.
      const w = probe()
      const calls = vi.fn(() => t.client.getSnapshot())
      const off = subscribe(calls)
      const before = t.client.getSnapshot()
      await w.run()
      expect(calls.mock.calls.length, 'a write tells the listener').toBeGreaterThanOrEqual(1)
      expect(calls.mock.results.at(-1)!.value, 'what the listener saw is the new state').toBe(t.client.getSnapshot())
      expect(t.client.getSnapshot()).not.toBe(before)
      const afterWrite = calls.mock.calls.length
      // A scenario change is the demo's (a target with no scenarios has no data to change).
      if (t.serves('ask')) {
        const data = t.client.read()
        await t.seed({ stage: 'Act', scenario: 'Cap reached' })
        expect(calls.mock.calls.length, 'a scenario change tells the listener').toBeGreaterThan(afterWrite)
        expect(t.client.read()).not.toBe(data)
      }
      off()
      const heard = calls.mock.calls.length
      await w.undo()
      expect(calls.mock.calls.length, 'nothing after unsubscribe').toBe(heard)
    })
  })

  // ---------- optimistic writes, notices and rollback ----------
  describe('a write shows at once; a failed one is taken back and the person is told', () => {
    interface WriteCase {
      label: string
      method: WriteMethod
      /** What has to be true first (run with saves working). */
      prepare?: (c: ContractTarget['client']) => Promise<unknown>
      run: (c: ContractTarget['client']) => Promise<unknown>
      /** What the write changes, when it isn't the state: compared before, during and after. */
      observe?: (c: ContractTarget['client']) => unknown
      /** False: the write doesn't save through the client's store, so a forced save failure can't fail it (createChat on the mock: its chat ids live in memory only; reported to the orchestrator). */
      saves?: boolean
    }
    const noop = async () => undefined
    const endLiveGrant = async (c: ContractTarget['client']) => { const g = c.read().people.supportGrant; if (g?.live) await c.endSupportGrant(g.id) }
    const ensureLiveGrant = async (c: ContractTarget['client']) => { if (!c.read().people.supportGrant?.live) await c.grantSupport(4) }
    let deletedFile = ''
    const allCases: WriteCase[] = [
      { label: 'approve', method: 'approve', run: c => c.approve(heldProblem()) },
      { label: 'undo', method: 'undo', prepare: c => c.approve(heldProblem()), run: c => c.undo(heldProblem()) },
      { label: 'editDraft', method: 'editDraft', run: c => c.editDraft(heldProblem(), 'x') },
      { label: 'undoHandled', method: 'undoHandled', run: c => c.undoHandled(heldProblem()) },
      { label: 'redoHandled', method: 'redoHandled', prepare: c => c.undoHandled(heldProblem()), run: c => c.redoHandled(heldProblem()) },
      { label: 'createChat', method: 'createChat', run: c => c.createChat(fx.newChat), observe: c => c.allChatIds(), saves: false },
      { label: 'pause', method: 'pause', run: c => c.pause() },
      { label: 'resume', method: 'resume', prepare: c => c.pause(), run: c => c.resume() },
      { label: 'setToggle', method: 'setToggle', run: c => c.setToggle(fx.toggleKey, false) },
      { label: 'requestTool', method: 'requestTool', run: c => c.requestTool(fx.toolKey, true) },
      { label: 'requestSkill', method: 'requestSkill', run: c => c.requestSkill(fx.skillName) },
      { label: 'setToolPaused', method: 'setToolPaused', run: c => c.setToolPaused(fx.toolKey, true) },
      { label: 'forgetMemory', method: 'forgetMemory', run: c => c.forgetMemory(fx.memoryKey, true) },
      { label: 'setSetting', method: 'setSetting', run: c => c.setSetting(fx.settingKey, fx.settingValue) },
      { label: 'setPhoto', method: 'setPhoto', run: c => c.setPhoto(fx.personId, fx.photoDataUrl), observe: c => c.read().people.members },
      { label: 'inviteMember', method: 'inviteMember', run: c => c.inviteMember(fx.invite), observe: c => c.read().people.members },
      { label: 'setMemberRole', method: 'setMemberRole', run: c => c.setMemberRole(fx.otherMemberId, 'admin'), observe: c => c.read().people.members },
      { label: 'removeMember', method: 'removeMember', run: c => c.removeMember(fx.otherMemberId), observe: c => c.read().people.members },
      { label: 'grantSupport', method: 'grantSupport', prepare: endLiveGrant, run: c => c.grantSupport(4), observe: c => c.read().people.supportGrant },
      { label: 'endSupportGrant', method: 'endSupportGrant', prepare: ensureLiveGrant, run: c => c.endSupportGrant(c.read().people.supportGrant!.id), observe: c => c.read().people.supportGrant },
      { label: 'sendTeamRequest', method: 'sendTeamRequest', run: c => c.sendTeamRequest(fx.teamRequest) },
      { label: 'markNoticesRead', method: 'markNoticesRead', run: c => c.markNoticesRead(c.listNotifications().map(n => n.id)) },
      { label: 'deleteFiles', method: 'deleteFiles', run: c => c.deleteFiles([firstFile()]) },
      { label: 'restoreFiles', method: 'restoreFiles', prepare: async c => { deletedFile = firstFile(); await c.deleteFiles([deletedFile]) }, run: c => c.restoreFiles([deletedFile]) },
      { label: 'setAside', method: 'setAside', run: c => c.setAside(heldProblem(), 'dismissed') },
      { label: 'setAside (bring back)', method: 'setAside', prepare: c => c.setAside(heldProblem(), 'dismissed'), run: c => c.setAside(heldProblem(), null) },
      { label: 'runRoutine', method: 'runRoutine', run: c => c.runRoutine(firstRoutine()) },
      { label: 'deleteRoutine', method: 'deleteRoutine', run: c => c.deleteRoutine(firstRoutine()) },
      { label: 'restoreRoutine', method: 'restoreRoutine', prepare: c => c.deleteRoutine(firstRoutine()), run: c => c.restoreRoutine(firstRoutine()) },
      { label: 'renameChat', method: 'renameChat', run: c => c.renameChat(chatId(), 'Renamed') },
      { label: 'pinChat', method: 'pinChat', run: c => c.pinChat(chatId(), true) },
      { label: 'deleteChats', method: 'deleteChats', run: c => c.deleteChats([chatId()]) },
      { label: 'restoreChats', method: 'restoreChats', prepare: c => c.deleteChats([chatId()]), run: c => c.restoreChats([chatId()]) },
    ]
    /** Only the writes this target serves. */
    const cases = allCases.filter(w => t.serves(w.method))
    const observe = (w: WriteCase) => (w.observe ?? ((c: ContractTarget['client']) => c.getSnapshot()))(t.client)

    /** The client in the scenario, the write's prerequisite done, listeners and notices fresh. */
    const arm = async (scenario: Scenario, w: WriteCase) => {
      await fresh('Act', scenario)
      await (w.prepare ?? noop)(t.client)
      await t.settle()
      clearNotices()
      const heard: ReturnType<ContractTarget['client']['getSnapshot']>[] = []
      const off = subscribe(() => heard.push(t.client.getSnapshot()))
      return { snapshot: t.client.getSnapshot(), data: t.client.read(), observed: observe(w), heard, off }
    }
    /** After a failed `approve`: it never goes out later. */
    const neverSent = async (w: WriteCase) => {
      if (w.method !== 'approve') return
      await t.advance(fx.holdMs * 2)
      expect(notices.filter(n => n.type === 'approval.sent'), 'a failed approve is never sent').toEqual([])
      expect(Object.keys(t.client.getSnapshot().sent)).toEqual([])
    }

    describe.each([['Normal'], ['Cap reached']] as const)('in the %s scenario', scenario => {
      test.each(cases)('$label: shows at once when it works', async w => {
        const before = await arm(scenario, w)
        const settled = w.run(t.client)
        expect(observe(w), 'the change shows before the write settles').not.toEqual(before.observed)
        await settled
        await until(() => before.heard.length >= 1, 'the listeners being told')
        before.off()
        expect(before.heard.length, 'listeners were told').toBeGreaterThanOrEqual(1)
        expect(notices).toEqual([])
        checkWorld(`after ${w.label}`)
      })

      test.each(cases.filter(w => w.saves !== false))('$label: with saves failing it rejects, is taken back, and sends one failed-save notice', async w => {
        const before = await arm(scenario, w)
        await t.failSaves(true)
        const failure = await errorOf(w.run(t.client))
        before.off()
        expect(failure, 'rejects with an AgentError').toBeInstanceOf(AgentError)
        parse(AgentErrorCodeSchema, (failure as AgentError).code, `${w.label} error code`)
        expect(t.client.getSnapshot(), 'the change was taken back').toBe(before.snapshot)
        expect(t.client.read(), 'read() is untouched').toBe(before.data)
        expect(observe(w)).toEqual(before.observed)
        expect(notices, 'exactly one notice').toHaveLength(1)
        expect(parse(AgentNoticeSchema, notices[0], 'the notice')).toMatchObject({ type: t.failedSaveNotice })
        expect(before.heard.length, 'listeners were told of the rollback').toBeGreaterThanOrEqual(1)
        expect(before.heard.at(-1), 'the last thing they saw is the restored state').toBe(before.snapshot)
        await neverSent(w)
      })

      test.each(cases)('$label: with the server refusing it rejects with that code, is taken back, and sends one error notice', async w => {
        const before = await arm(scenario, w)
        for (const code of ['forbidden', 'conflict'] as const) {
          await t.injectError(w.method, code)
          clearNotices()
          before.heard.length = 0
          const settled = errorOf(w.run(t.client))
          expect(observe(w), `${code}: the change shows before the server answers`).not.toEqual(before.observed)
          const failure = await settled
          expect(failure).toBeInstanceOf(AgentError)
          expect((failure as AgentError).code).toBe(code)
          expect(t.client.getSnapshot(), 'the change was taken back').toBe(before.snapshot)
          expect(observe(w)).toEqual(before.observed)
          expect(notices, 'exactly one notice').toHaveLength(1)
          expect(parse(AgentNoticeSchema, notices[0], 'the notice')).toMatchObject({ type: 'error', code })
          expect(before.heard.length, 'listeners heard the change and its rollback').toBeGreaterThanOrEqual(2)
          expect(before.heard.at(-1)).toBe(before.snapshot)
          await neverSent(w)
        }
        before.off()
      })
    })

    test('a write that is not awaited still tells the person when the server refuses it', async () => {
      const w = probe()
      await t.injectError(w.method, 'forbidden')
      void w.run()
      await until(() => notices.length > 0, 'the notice')
      expect(notices).toEqual([{ type: 'error', code: 'forbidden', text: expect.any(String) }])
    })

    test('a refused write takes back only itself: a write made while it was in flight stays', async () => {
      const w = probe()
      await t.injectError(w.method, 'forbidden')
      const refused = errorOf(w.run())
      await t.client.setToggle(fx.toggleKey, false) // lands before the refusal does
      expect(await refused).toBeInstanceOf(AgentError)
      const snap = t.client.getSnapshot()
      expect(snap.toggles[fx.toggleKey], 'the write that worked is kept').toBe(false)
      expect(w.shown(snap), 'the refused write is taken back').toBe(false)
      expect(notices).toHaveLength(1)
      expect(notices[0]).toMatchObject({ type: 'error', code: 'forbidden' })
    })

    only('approve', 'pause')('a refused pause leaves the hold of an approve made while it was in flight: it still sends', async () => {
      const id = heldProblem()
      await t.injectError('pause', 'forbidden')
      const refused = errorOf(t.client.pause())
      await t.client.approve(id) // its hold starts before the refusal lands
      expect(await refused).toBeInstanceOf(AgentError)
      expect(t.client.getSnapshot().paused, 'the refused write is taken back').toBeNull()
      await t.advance(fx.holdMs)
      expect(t.client.getSnapshot().sent[id], 'the hold still sent').toBe(true)
      expect(notices.some(n => n.type === 'approval.sent' && n.id === id)).toBe(true)
    })

    test('a refused setting takes back only its own entry: a setting saved while it was in flight stays', async () => {
      await t.injectError('setSetting', 'forbidden')
      const refused = errorOf(t.client.setSetting(fx.settingKey, fx.settingValue))
      const disarmed = t.injectError('setSetting', null) // not awaited: the second write must start before the refusal lands
      const meanwhile = t.client.setSetting(fx.otherSetting.key, fx.otherSetting.value) // replaces the same settings record before the refusal lands
      await disarmed
      await meanwhile
      expect(await refused).toBeInstanceOf(AgentError)
      const settings = t.client.getSnapshot().settings
      expect(settings[fx.settingKey], 'the refused setting is gone').toBeUndefined()
      expect(settings[fx.otherSetting.key], 'the setting saved meanwhile stays').toBe(fx.otherSetting.value)
    })

    test('a refusal on one method leaves the others working', async () => {
      const w = probe()
      await t.injectError(w.method, 'forbidden')
      await expect(w.run()).rejects.toBeInstanceOf(AgentError)
      // Another method, on another route where the target serves one: the refusal belongs to the method, not to what it touches.
      if (t.serves('setMemberRole')) {
        await t.client.setMemberRole(fx.otherMemberId, 'admin')
        expect(t.client.read().people.members.find(m => m.id === fx.otherMemberId)?.role).toBe('admin')
      } else {
        await t.client.setToggle(fx.toggleKey, false)
        expect(t.client.getSnapshot().toggles[fx.toggleKey]).toBe(false)
      }
      await t.injectError(w.method, null)
      await w.run()
      expect(w.shown(t.client.getSnapshot())).toBe(true)
    })

    only('ask')('the Cap reached scenario reads at the cap, and the agent still answers and writes there', async () => {
      const normal = parse(AgentDataSchema, t.client.read(), 'read()').usage
      expect(normal.total.currency, 'spend and cap share a currency').toBe(normal.cap.currency)
      expect(normal.total.minor, 'a normal month is under the cap').toBeLessThan(normal.cap.minor)
      await fresh('Act', 'Cap reached')
      const data = parse(AgentDataSchema, t.client.read(), 'read()')
      expect(data.usage.total.currency, 'spend and cap share a currency').toBe(data.usage.cap.currency)
      expect(data.usage.total.minor, 'spend is at or over the cap').toBeGreaterThanOrEqual(data.usage.cap.minor)
      expect(data.status).toBe('ready')
      await t.client.setToggle(fx.toggleKey, false)
      expect(t.client.getSnapshot().toggles[fx.toggleKey]).toBe(false)
      checkRun(await drain(fx.questions.table))
      expect(notices).toEqual([])
    })

    test('a write that fails does not raise an unhandled rejection when nobody awaits it', async () => {
      await t.failSaves(true)
      void probe().run()
      await until(() => notices.some(n => n.type === t.failedSaveNotice), 'the failed-save notice')
    })

    // What the agent writes by itself is a save in the client on the mock only; a server target adds its own failed-save case for agent writes in P2.
    // When the target says no, these show as skipped in the output, never silently.
    describe.runIf(t.capabilities.agentWritesSaveInClient)('agent writes that save in the client', () => {
      test('a save that fails while a hold finishes tells the person and the next write still works', async () => {
        await t.client.approve(heldProblem())
        await t.failSaves(true)
        await until(() => notices.some(n => n.type === t.failedSaveNotice), 'the failed-save notice')
        await t.failSaves(false)
        await t.client.pause()
        checkWorld('after the failed save')
      })

      test('a save that fails inside an answer tells the person, and the answer still ends', async () => {
        await t.failSaves(true)
        for (const question of [fx.questions.routineRequest, fx.questions.skillRequest]) {
          clearNotices()
          const events = checkRun(await drain(question))
          expect(TERMINAL).toContain(events.at(-1)!.type)
          expect(notices.some(n => n.type === t.failedSaveNotice), `${question}: a failed-save notice`).toBe(true)
        }
      })
    })
  })

  // ---------- P2: who is signed in, the team, revisions, settings, support access, paging and retry ----------
  describe('P2: members, revisions, settings and support access', () => {
    const members = () => t.client.read().people.members
    const member = (id: string) => members().find(m => m.id === id)
    /** The rejection a call makes, which must be an AgentError. */
    const refusal = async (p: Promise<unknown>): Promise<AgentError> => {
      const e = await errorOf(p)
      expect(e, 'rejects with an AgentError').toBeInstanceOf(AgentError)
      parse(AgentErrorCodeSchema, (e as AgentError).code, 'the error code')
      return e as AgentError
    }
    const skipUnless = (...methods: (keyof ContractTarget['client'])[]) => !methods.every(m => t.serves(m))

    test.skipIf(skipUnless('me'))('me() parses, names the signed-in person and is null while loading', async () => {
      const me = parse(MeSchema, t.client.me(), 'me()')
      expect(me.memberId).toBe(fx.me.memberId)
      expect(me.role).toBe(fx.me.role)
      expect(member(me.memberId), 'the signed-in person is on the team list').toBeDefined()
      expect(t.client.me(), 'a snapshot keeps its identity until something changes').toBe(t.client.me())
      await fresh('Act', 'Loading')
      expect(t.client.me()).toBeNull()
    })

    test.skipIf(skipUnless('me', 'setMemberRole'))('can follows the role: an Admin may do what a Member may not, and every person may read', async () => {
      const admin = parse(MeSchema, t.client.me(), 'me()')
      if (t.capabilities.adminCanDoEverything) expect(Object.values(admin.can).every(Boolean), 'the demo Admin can do everything').toBe(true)
      // The product's Admin can what the access rows let an Admin do: no technical write but a model's switch (`adminWrite`).
      else {
        // The rows are the server's (read at run time: the client program has no Workers types to compile them with).
        const rows = (await import(/* @vite-ignore */ ACCESS_ROWS)) as AccessRows
        for (const [k, row] of Object.entries(rows.canRows)) {
          const r = rows.accessMatrix.find(x => x.method === row.method && x.pattern === row.pattern)!
          const expected = r.class === 'technical' ? row.as === 'adminWrite' && !!r.adminWrite && r.allow.includes('admin') : r.allow.includes('admin')
          expect(admin.can[k as keyof typeof admin.can], `an Admin's can.${k}`).toBe(expected)
        }
      }
      await t.client.setMemberRole(fx.otherMemberId, 'admin')
      await t.client.setMemberRole(fx.me.memberId, 'member')
      const member = parse(MeSchema, t.client.me(), 'me() after the role change')
      expect(member.role).toBe('member')
      for (const k of ['invite', 'changeRole', 'remove', 'editBrandSettings', 'editTechnical', 'switchModel', 'grantSupport'] as const) expect(member.can[k], `a Member can't ${k}`).toBe(false)
      for (const k of ['viewMembers', 'viewAudit', 'exportAudit'] as const) expect(member.can[k], `a Member can ${k}`).toBe(true)
    })

    test('the team lists members by member id with a role of member or admin, and no role called Approver', async () => {
      const list = members()
      expect(list.length).toBeGreaterThan(0)
      list.forEach(m => parse(MemberRecordSchema, m, `member ${m.id}`))
      expect(new Set(list.map(m => m.id)).size, 'ids are unique').toBe(list.length)
      expect(list.filter(m => m.role === 'admin').length, 'there is an Admin').toBeGreaterThanOrEqual(1)
    })

    test('an approval rule names its approver by member id, or anyone', async () => {
      const { approvalRules } = t.client.read().people
      const ids = new Set(members().map(m => m.id))
      for (const r of approvalRules) expect(r.approver === 'anyone' || ids.has(r.approver), `${r.what}: ${r.approver}`).toBe(true)
    })

    only('approve', 'setAside')('records of the people name member ids: an approval, an undo and a set aside', async () => {
      const id = heldProblem()
      await t.client.approve(id)
      const other = t.client.read().problems.map(p => p.id).find(x => x !== id)
      if (!other) throw new Error('a second problem to set aside')
      await t.client.setAside(other, 'dismissed')
      const ids = new Set(members().map(m => m.id))
      const snap = t.client.getSnapshot()
      expect(ids.has(snap.approved[id].by), 'approved.by is a member id').toBe(true)
      for (const rec of Object.values(snap.setAside)) expect(ids.has(rec.by), 'setAside.by is a member id').toBe(true)
      t.client.read().auditLog.forEach(l => expect(l.actorId).toMatch(/^m_/))
    })

    test.skipIf(skipUnless('inviteMember', 'removeMember'))('invite, then remove, then invite again; an email already on the team is refused', async () => {
      await t.client.inviteMember(fx.invite)
      const invited = members().find(m => m.email === fx.invite.email)
      expect(invited, 'the invited person is on the list').toBeDefined()
      expect(invited).toMatchObject({ name: fx.invite.name, title: fx.invite.title, role: fx.invite.role, status: 'invited', photo: null })
      const again = await refusal(t.client.inviteMember({ ...fx.invite, email: fx.invite.email.toUpperCase() }))
      expect(again.code).toBe('conflict')
      expect(again.reason).toBe('already_member')
      await t.client.removeMember(invited!.id)
      expect(member(invited!.id)?.status ?? 'gone', 'a removed person is no longer active').toMatch(/removed|gone/)
      await t.client.inviteMember(fx.invite)
      expect(members().filter(m => m.email === fx.invite.email && m.status !== 'removed'), 'one open invitation').toHaveLength(1)
      checkWorld('after invite and remove')
    })

    test.skipIf(skipUnless('inviteMember'))('an invitation that fails its schema is invalid, and changes nothing', async () => {
      const before = t.client.read()
      for (const bad of [{ ...fx.invite, email: 'not-an-email' }, { ...fx.invite, name: '   ' }, { ...fx.invite, role: 'inhouse' as never }]) {
        const e = await refusal(t.client.inviteMember(bad))
        expect(e.code).toBe('invalid')
      }
      expect(t.client.read()).toBe(before)
    })

    test.skipIf(skipUnless('setMemberRole', 'removeMember'))('the last Admin can be neither demoted nor removed', async () => {
      const admins = members().filter(m => m.status === 'active' && m.role === 'admin')
      expect(admins, 'a first-run team has one Admin').toHaveLength(1)
      const [last] = admins
      for (const run of [() => t.client.setMemberRole(last.id, 'member'), () => t.client.removeMember(last.id)]) {
        const e = await refusal(run())
        expect(e.code).toBe('conflict')
        expect(e.reason).toBe('last_admin')
      }
      expect(member(last.id)).toMatchObject({ role: 'admin', status: 'active' })
      await t.client.setMemberRole(fx.otherMemberId, 'admin')
      await t.client.setMemberRole(last.id, 'member') // another Admin now stands
      expect(member(last.id)?.role).toBe('member')
    })

    test.skipIf(skipUnless('setMemberRole'))('a role change bumps the member rev, and an unknown member is not found', async () => {
      const before = member(fx.otherMemberId)!
      await t.client.setMemberRole(fx.otherMemberId, 'admin')
      expect(member(fx.otherMemberId)).toMatchObject({ role: 'admin' })
      expect(member(fx.otherMemberId)!.rev).toBeGreaterThan(before.rev)
      expect((await refusal(t.client.setMemberRole('m_nobody', 'admin'))).code).toBe('not_found')
      expect((await refusal(t.client.setMemberRole(fx.otherMemberId, 'inhouse' as never))).code).toBe('invalid')
    })

    test.skipIf(skipUnless('setMemberRole'))('a member changed behind the client: the next write rejects with conflict and the current record, and the snapshot shows it', async () => {
      await t.writeElsewhere({ kind: 'member', id: fx.otherMemberId }, 'admin')
      const e = await refusal(t.client.setMemberRole(fx.otherMemberId, 'member'))
      expect(e.code).toBe('conflict')
      expect(parse(MemberRecordSchema, e.current, 'current')).toMatchObject({ id: fx.otherMemberId, role: 'admin' })
      expect(member(fx.otherMemberId)?.role, 'the snapshot already holds the current value').toBe('admin')
      expect(notices.at(-1)).toMatchObject({ type: 'error', code: 'conflict' })
      await t.client.setMemberRole(fx.otherMemberId, 'member') // the client has seen it now, so this one lands
      expect(member(fx.otherMemberId)?.role).toBe('member')
    })

    test.skipIf(skipUnless('removeMember'))('removing a member changed behind the client is a conflict too, and removes nothing', async () => {
      await t.writeElsewhere({ kind: 'member', id: fx.otherMemberId }, 'admin')
      const e = await refusal(t.client.removeMember(fx.otherMemberId))
      expect(e.code).toBe('conflict')
      expect(member(fx.otherMemberId)?.status).toBe('active')
    })

    test('a setting changed behind the client: the next write rejects with conflict and the current setting, and the snapshot takes it', async () => {
      await t.writeElsewhere({ kind: 'setting', key: fx.settingKey }, 'Changed Elsewhere')
      const e = await refusal(t.client.setSetting(fx.settingKey, fx.settingValue))
      expect(e.code).toBe('conflict')
      expect(parse(SettingRecordSchema, e.current, 'current')).toMatchObject({ key: fx.settingKey, value: 'Changed Elsewhere' })
      expect(t.client.getSnapshot().settings[fx.settingKey]).toBe('Changed Elsewhere')
      await t.client.setSetting(fx.settingKey, fx.settingValue)
      expect(t.client.getSnapshot().settings[fx.settingKey]).toBe(fx.settingValue)
    })

    test('a switch changed behind the client is a conflict too, and a record of another kind stays writable', async () => {
      await t.writeElsewhere({ kind: 'setting', key: fx.toggleKey }, true)
      expect((await refusal(t.client.setToggle(fx.toggleKey, false))).code).toBe('conflict')
      expect(t.client.getSnapshot().toggles[fx.toggleKey]).toBe(true)
      await t.client.setSetting(fx.otherSetting.key, fx.otherSetting.value) // another record: not stale
    })

    test.skipIf(skipUnless('setToggle'))('two writes to one record, started together, both save in order: no notice, and the last one stays', async () => {
      const first = t.client.setToggle(fx.toggleKey, false)
      const second = t.client.setToggle(fx.toggleKey, true)
      await Promise.all([first, second])
      expect(t.client.getSnapshot().toggles[fx.toggleKey]).toBe(true)
      expect(notices).toEqual([])
    })

    only('forgetMemory', 'deleteRoutine', 'deleteFiles')('a memory line, a routine and a file changed behind the client: forget, delete and restore reject with conflict', async () => {
      const line = t.client.read().memory.team.flatMap(g => g.lines)[0]
      const routine = t.client.read().routines[0]
      const file = t.client.listFiles()[0]
      await t.writeElsewhere({ kind: 'memory', id: line.key })
      expect((await refusal(t.client.forgetMemory(line.key, true))).code).toBe('conflict')
      await t.writeElsewhere({ kind: 'routine', id: routine.id })
      expect((await refusal(t.client.deleteRoutine(routine.id))).code).toBe('conflict')
      await t.writeElsewhere({ kind: 'file', id: file.id })
      expect((await refusal(t.client.deleteFiles([file.id]))).code).toBe('conflict')
      expect(t.client.getSnapshot().forgot[line.key], 'nothing applied').toBeUndefined()
      expect(t.client.read().routines.find(r => r.id === routine.id)!.rev, 'the rev reads').toBeGreaterThan(routine.rev)
    })

    test.skipIf(skipUnless('setMemberRole', 'setSetting', 'grantSupport', 'endSupportGrant'))('a member, a setting and a grant carry a rev that a write bumps', async () => {
      members().forEach(m => expect(m.rev, `${m.id}`).toBeGreaterThanOrEqual(1))
      const before = member(fx.otherMemberId)!.rev
      await t.client.setMemberRole(fx.otherMemberId, 'admin')
      expect(member(fx.otherMemberId)!.rev, 'a role change bumps the member').toBeGreaterThan(before)
      // A setting's rev shows in the record a stale write is refused with: it counts up with every write.
      await t.client.setSetting(fx.settingKey, fx.settingValue)
      const revOf = async () => {
        await t.writeElsewhere({ kind: 'setting', key: fx.settingKey }, fx.settingValue)
        const e = await errorOf(t.client.setSetting(fx.settingKey, fx.settingValue))
        return parse(SettingRecordSchema, (e as AgentError).current, 'current').rev
      }
      const r1 = await revOf()
      expect(r1).toBeGreaterThanOrEqual(2)
      expect(await revOf(), 'each write bumps it').toBeGreaterThan(r1)
      const live = t.client.read().people.supportGrant
      if (live?.live) await t.client.endSupportGrant(live.id)
      await t.client.grantSupport(1)
      const g = t.client.read().people.supportGrant!
      expect(g.rev).toBeGreaterThanOrEqual(1)
      await t.client.endSupportGrant(g.id)
      expect(t.client.read().people.supportGrant!.rev, 'ending it bumps it').toBeGreaterThan(g.rev)
    })

    only('deleteRoutine')('every editable record carries a rev that a write bumps', async () => {
      const d = t.client.read()
      d.routines.forEach(r => expect(r.rev).toBeGreaterThanOrEqual(1))
      d.memory.team.flatMap(g => g.lines).concat(d.memory.personal).forEach(l => expect(l.rev).toBeGreaterThanOrEqual(1))
      t.client.listFiles().forEach(f => expect(f.rev).toBeGreaterThanOrEqual(1))
      const id = d.routines[0].id
      await t.client.deleteRoutine(id)
      expect(t.client.read().routines.find(r => r.id === id)!.rev).toBeGreaterThan(d.routines[0].rev)
    })

    test('a setting outside the registry, or with a value it refuses, is invalid and changes nothing', async () => {
      const snap = t.client.getSnapshot()
      for (const [key, value] of [['no:such-key', 'x'], [fx.settingKey, ''], ['g:theme', 'Neon'], ['g:tz', 'Mars/Olympus'], ['s:cap', 'lots'], ['g:name', 'x'.repeat(81)]] as const) {
        const e = await refusal(t.client.setSetting(key, value))
        expect(e.code, `${key} = ${value}`).toBe('invalid')
      }
      expect((await refusal(t.client.setToggle('no:such-key', true))).code).toBe('invalid')
      expect((await refusal(t.client.setToggle(fx.settingKey, true))).code, 'a text setting is not a switch').toBe('invalid')
      expect((await refusal(t.client.setSetting('n:slack', 'yes'))).code, 'a switch is not text').toBe('invalid')
      expect(t.client.getSnapshot(), 'nothing was written').toBe(snap)
      expect(notices.every(n => n.type === 'error' && n.code === 'invalid')).toBe(true)
    })

    test('a role, a photo and a grant can no longer be written as a setting', async () => {
      const snap = t.client.getSnapshot()
      for (const run of [
        () => t.client.setSetting(`p:${fx.personId}`, 'Admin'), () => t.client.setSetting(`photo:${fx.personId}`, fx.photoDataUrl),
        () => t.client.setSetting('d:support', 'on'), () => t.client.setToggle('d:support', true), () => t.client.setToggle(`p:${fx.personId}`, true),
      ]) expect((await refusal(run())).code).toBe('invalid')
      expect(t.client.getSnapshot()).toBe(snap)
      expect(member(fx.personId)?.role).toBe('admin')
    })

    test('the settings a person saves keep working: each accepted key and value, then the reset', async () => {
      for (const [key, value] of [[fx.settingKey, fx.settingValue], [fx.otherSetting.key, fx.otherSetting.value], [fx.choices.key, fx.choices.values[1]]] as const) {
        await t.client.setSetting(key, value)
        expect(t.client.getSnapshot().settings[key]).toBe(value)
        await t.client.setSetting(key, null)
        expect(t.client.getSnapshot().settings[key]).toBeUndefined()
      }
      await t.client.setToggle('n:slack', true)
      expect(t.client.getSnapshot().toggles['n:slack']).toBe(true)
    })

    test('setPhoto for a member that does not exist is not found', async () => {
      expect((await refusal(t.client.setPhoto('m_nobody', fx.photoDataUrl))).code).toBe('not_found')
    })

    test.skipIf(skipUnless('grantSupport', 'endSupportGrant'))('support access: one live grant at a time, of 1, 4, 24 or 72 hours, that an Admin can end', async () => {
      const grant = () => t.client.read().people.supportGrant
      const live = grant()
      if (live?.live) await t.client.endSupportGrant(live.id)
      expect(grant()?.live ?? false).toBe(false)
      for (const bad of [0, 2, 100]) expect((await refusal(t.client.grantSupport(bad))).code).toBe('invalid')
      await t.client.grantSupport(4)
      const g = parse(SupportGrantSchema, grant(), 'the grant')
      expect(g.live).toBe(true)
      expect(g.endsAt.ms - g.createdAt.ms).toBe(4 * 3_600_000)
      const second = await refusal(t.client.grantSupport(1))
      expect([second.code, second.reason]).toEqual(['conflict', 'grant_live'])
      await t.client.endSupportGrant(g.id)
      expect(grant()).toMatchObject({ id: g.id, live: false })
      expect(grant()!.endedAt).not.toBeNull()
      expect((await refusal(t.client.endSupportGrant(g.id))).code, 'an ended grant is not there to end').toBe('not_found')
      await t.client.grantSupport(1)
      expect(grant()?.live).toBe(true)
    })

    test.skipIf(skipUnless('grantSupport'))('a grant ends by itself when its hours pass', async () => {
      const live = t.client.read().people.supportGrant
      if (live?.live) await t.client.endSupportGrant(live.id)
      await t.client.grantSupport(1)
      expect(t.client.read().people.supportGrant?.live).toBe(true)
      await t.advance(3_600_000 + STEP_MS)
      expect(t.client.read().people.supportGrant?.live, 'one hour later it is over').toBe(false)
    })

    test.skipIf(skipUnless('grantSupport', 'endSupportGrant'))('ending a grant changed behind the client is a conflict with the current grant; one the other session ended is not found', async () => {
      const grant = () => t.client.read().people.supportGrant
      if (!grant()?.live) await t.client.grantSupport(4)
      const g = grant()!
      expect(g.live, 'a live grant to end').toBe(true)
      await t.writeElsewhere({ kind: 'grant', id: g.id })
      const e = await refusal(t.client.endSupportGrant(g.id))
      expect(e.code).toBe('conflict')
      expect(parse(SupportGrantSchema, e.current, 'current')).toMatchObject({ id: g.id, live: true })
      expect(grant()?.live, 'nothing was ended').toBe(true)
      await t.writeElsewhere({ kind: 'grant', id: g.id }, 'end')
      expect((await refusal(t.client.endSupportGrant(g.id))).code, 'the other session ended it: nothing live is left').toBe('not_found')
    })

    test.skipIf(skipUnless('retry'))('a resource whose read failed says so, with the error; retry reads it again; the rest stays ready', async () => {
      const ready = t.client.read()
      for (const k of Object.keys(ready.resources)) expect(ready.resources[k as keyof typeof ready.resources].status).toBe('ready')
      await t.failRead('members')
      const failed = t.client.read()
      expect(failed.resources.members.status).toBe('error')
      expect(parse(AgentErrorCodeSchema, failed.resources.members.error, 'the error code')).toBeDefined()
      expect(failed.resources.audit.status, 'only that resource failed').toBe('ready')
      expect(failed.status, 'the top-level status is the Loading scenario only').toBe('ready')
      let heard = 0
      subscribe(() => { heard++ })
      await t.client.retry('members')
      expect(t.client.read().resources.members).toEqual({ status: 'ready' })
      expect(members().length, 'the list is back').toBeGreaterThan(0)
      expect(heard, 'listeners were told').toBeGreaterThanOrEqual(1)
      parse(AgentDataSchema, t.client.read(), 'read() after retry')
    })

    test('Loading reports every resource loading, and the rest report ready', async () => {
      await fresh('Act', 'Loading')
      for (const r of Object.values(t.client.read().resources)) expect(r.status).toBe('loading')
      await fresh('Act', 'First day')
      for (const r of Object.values(t.client.read().resources)) expect(r.status).toBe('ready')
    })

    test.skipIf(t.capabilities.pagesLists)('a list that does not page says there is no more, and loadMore does nothing', async () => {
      const before = t.client.read()
      expect(before.more).toEqual({ audit: false, members: false })
      await t.client.loadMore('audit')
      await t.client.loadMore('members')
      expect(t.client.read()).toBe(before)
    })

    test('the audit log names each line by its actor member id and orders it newest first', async () => {
      const log = t.client.read().auditLog
      log.forEach(l => expect(l.actorId).toMatch(/^m_[A-Za-z0-9_-]+$/))
      expect(log.map(l => l.id)).toEqual([...log.map(l => l.id)].sort((a, b) => b - a))
    })

    test('the export and sign out links are what the target names', async () => {
      expect(t.client.auditExportUrl()).toBe(fx.links.auditExport)
      expect(t.client.signOutUrl()).toBe(fx.links.signOut)
    })

    test.skipIf(skipUnless('inviteMember'))('a refusal carries its reason, and the reason parses', async () => {
      await t.client.inviteMember(fx.invite)
      const e = await refusal(t.client.inviteMember(fx.invite))
      expect(parse(ErrorReasonSchema, e.reason, 'reason')).toBe('already_member')
    })

    test.skipIf(skipUnless('inviteMember', 'removeMember'))('a member who was in the data at the start, removed and invited again, is one record, invited', async () => {
      const before = member(fx.otherMemberId)!
      await t.client.removeMember(fx.otherMemberId)
      await t.client.inviteMember({ name: before.name, email: before.email!, role: 'member' })
      const same = members().filter(m => m.id === fx.otherMemberId)
      expect(same, 'exactly one record with that id').toHaveLength(1)
      expect(same[0].status).toBe('invited')
      expect(new Set(members().map(m => m.id)).size, 'ids stay unique').toBe(members().length)
    })

    test('a photo and a new name move the member rev', async () => {
      const rev = () => member(fx.me.memberId)!.rev
      const r0 = rev()
      await t.client.setPhoto(fx.me.memberId, fx.photoDataUrl)
      const r1 = rev()
      expect(r1, 'a photo bumps it').toBeGreaterThan(r0)
      await t.client.setSetting('g:name', fx.settingValue)
      expect(rev(), 'the name bumps it').toBeGreaterThan(r1)
    })

    only('ask', 'deleteRoutine')('a routine made in a chat carries a rev that delete, restore, regenerate and take-back move', async () => {
      const cards = () => t.client.getSnapshot().routinesExtra
      const events = await drain(fx.questions.routineRequest)
      const runId = (events[0] as Started).runId
      const made = cards()[0]
      expect(made, 'the answer made a routine').toBeDefined()
      const r1 = made.rev ?? 1
      await t.client.deleteRoutine(made.id)
      const r2 = cards()[0].rev!
      expect(r2, 'delete moves it').toBeGreaterThan(r1)
      await t.client.restoreRoutine(made.id)
      const r3 = cards()[0].rev!
      expect(r3, 'restore moves it').toBeGreaterThan(r2)
      const again = await drain(fx.questions.routineRequest, { replacesRun: runId })
      expect(cards(), 'regenerate updates it in place').toHaveLength(1)
      const r4 = cards()[0].rev!
      expect(r4, 'regenerate moves it').toBeGreaterThan(r3)
      await drain(fx.questions.offScript, { replacesRun: (again[0] as Started).runId })
      expect(cards()[0].rev!, 'taking it back moves it').toBeGreaterThan(r4)
    })

  })

  // ---------- properties ----------
  describe('properties', () => {
    // Ids come from the client, so the sequence acts on things that exist and the failure it finds is the client's.
    const ids = () => {
      const d = t.client.read()
      return { problems: d.problems.map(p => p.id), routines: d.routines.map(r => r.id), files: t.client.listFiles().map(f => f.id), chats: t.client.allChatIds(), members: d.people.members.map(m => m.id) }
    }
    const key = fc.string({ unit: 'grapheme-ascii', minLength: 1, maxLength: 8 })
    const pick = (n: number) => fc.nat(n === 0 ? 0 : n - 1)
    const question = fc.oneof(fc.constantFrom(...Object.values(fx.questions)), fc.string())
    /** A valid instant: the same moment as ISO text and epoch ms, in years `toISOString` writes as four digits. */
    const instant = fc.date({ min: new Date(Date.UTC(2000, 0, 1)), max: new Date(Date.UTC(2100, 0, 1)), noInvalidDate: true }).map(d => ({ iso: d.toISOString(), ms: d.getTime() }))

    type Ids = ReturnType<typeof ids>
    /** `forSave`: the step is there to be failed by a save, so it skips what a client would refuse for another reason (undo of nothing approved). */
    type Op = (c: ContractTarget['client'], i: Ids, forSave?: boolean) => Promise<unknown>
    interface Step { name: string; run: Op }
    // First day has no problems and Loading no routines: an op with nothing to act on does nothing (SKIP).
    const nth = <T,>(list: T[], n: number): T | undefined => list[n % Math.max(1, list.length)]
    const on = <T,>(list: T[], n: number, f: (x: T) => Promise<unknown>): Promise<unknown> => { const x = nth(list, n); return x === undefined ? Promise.resolve(SKIP) : f(x) }
    const step = (name: string, run: Op): Step => ({ name, run })

    /** Writes: each one saves, so with saves failing each one must reject. */
    const earlierWriteOps: fc.Arbitrary<Step>[] = [
      fc.tuple(pick(50), fc.boolean()).map(([n, hold]) => step(`approve#${n}`, (c, i, forSave) => on(i.problems, n, id => (hold ? (c.getSnapshot().approved[id] ? Promise.resolve(SKIP) : c.approve(id)) : forSave && !c.getSnapshot().approved[id] ? Promise.resolve(SKIP) : c.undo(id))))),
      fc.tuple(pick(50), fc.string()).map(([n, s]) => step('editDraft', (c, i) => on(i.problems, n, id => c.editDraft(id, s)))),
      fc.tuple(pick(50), fc.boolean()).map(([n, undo]) => step('undoHandled', (c, i) => on(i.problems, n, id => (undo ? c.undoHandled(id) : c.redoHandled(id))))),
      fc.boolean().map(p => step('pause', c => (p ? c.pause() : c.resume()))),
      // A switch is a routine or skill switch (`r:`, `s:`) or a registry switch; any other key is `invalid` (the tests below), not a save failure.
      fc.tuple(key, fc.boolean()).map(([k, b]) => step('setToggle', c => c.setToggle(`r:${k}`, b))),
      fc.tuple(key, fc.boolean()).map(([k, b]) => step('requestTool', c => c.requestTool(k, b))),
      key.map(k => step('requestSkill', c => c.requestSkill(k))),
      fc.tuple(key, fc.boolean()).map(([k, b]) => step('setToolPaused', c => c.setToolPaused(k, b))),
      fc.tuple(key, fc.boolean()).map(([k, b]) => step('forgetMemory', c => c.forgetMemory(k, b))),
    ]
    /** The writes the P2 methods serve: what a target without runs, approvals or a library still runs. */
    const p2WriteOps: fc.Arbitrary<Step>[] = [
      fc.tuple(fc.constantFrom(fx.settingKey, fx.otherSetting.key, fx.choices.key), fc.boolean()).map(([k, reset]) => step('setSetting', c => c.setSetting(k, reset ? null : k === fx.choices.key ? fx.choices.values[0] : k === fx.settingKey ? fx.settingValue : fx.otherSetting.value))),
      // `forSave` takes an active member: a removed member's photo is refused (`not_found`) before any save, and that is not a save failure.
      fc.tuple(pick(50), fc.option(fc.string(), { nil: null })).map(([n, v]) => step('setPhoto', (c, i, forSave) => on(forSave ? c.read().people.members.filter(m => m.status !== 'removed').map(m => m.id) : i.members, n, id => c.setPhoto(id, v)))),
      // `forSave` skips what the client refuses for its own reason (the last Admin, a live grant, an email already invited), so a save failure is the only way it can reject.
      fc.tuple(pick(50), fc.constantFrom('admin', 'member', 'remove', 'invite', 'grant', 'end')).map(([n, a]) => step(`member-${a}`, (c, i, forSave) => {
        const live = c.read().people.supportGrant?.live
        const active = c.read().people.members.filter(m => m.status !== 'removed').map(m => m.id)
        if (a === 'invite') return c.inviteMember({ ...fx.invite, email: forSave ? 'save-fails@example.test' : `person${n}@example.test` })
        if (a === 'grant') return forSave && live ? Promise.resolve(SKIP) : c.grantSupport(1)
        if (a === 'end') { const g = c.read().people.supportGrant; return g?.live ? c.endSupportGrant(g.id) : Promise.resolve(SKIP) }
        if (forSave && a !== 'admin') return Promise.resolve(SKIP)
        return on(forSave ? active : i.members, n, id => (a === 'remove' ? c.removeMember(id) : c.setMemberRole(id, a)))
      })),
    ]
    const laterWriteOps: fc.Arbitrary<Step>[] = [
      fc.tuple(fc.string(), fc.string(), fc.string(), instant, fc.string(), fc.option(instant, { nil: undefined })).map(([icon, title, sub, at, status, statusAt]) => step('sendTeamRequest', c => c.sendTeamRequest({ icon, title, sub, at, status, ...(statusAt ? { statusAt } : {}) }))),
      fc.boolean().map(all => step('markNoticesRead', c => {
        const fresh = c.listNotifications().filter(n => n.unread).map(n => n.id)
        const wanted = all ? fresh : fresh.slice(0, 1)
        return wanted.length ? c.markNoticesRead(wanted) : Promise.resolve(SKIP)
      })),
      fc.tuple(fc.array(pick(50), { minLength: 1, maxLength: 3 }), fc.boolean()).map(([ns, del]) => step('files', (c, i) => {
        const f = ns.map(n => nth(i.files, n)).filter((x): x is string => x !== undefined)
        return f.length ? (del ? c.deleteFiles(f) : c.restoreFiles(f)) : Promise.resolve(SKIP)
      })),
      fc.tuple(pick(50), fc.option(fc.constantFrom('snoozed', 'dismissed', 'declined'), { nil: null })).map(([n, r]) => step('setAside', (c, i) => on(i.problems, n, id => c.setAside(id, r)))),
      fc.tuple(pick(50), fc.constantFrom('run', 'delete', 'restore')).map(([n, a]) => step(`routine-${a}`, (c, i) => on(i.routines, n, id => (a === 'run' ? c.runRoutine(id) : a === 'delete' ? c.deleteRoutine(id) : c.restoreRoutine(id))))),
      fc.tuple(pick(50), fc.constantFrom('rename', 'clear', 'pin', 'unpin', 'delete', 'restore'), fc.string()).map(([n, a, s]) => step(`chat-${a}`,
        (c, i) => on(i.chats, n, id => (a === 'rename' ? c.renameChat(id, s) : a === 'clear' ? c.renameChat(id, null) : a === 'pin' ? c.pinChat(id, true) : a === 'unpin' ? c.pinChat(id, false) : a === 'delete' ? c.deleteChats([id]) : c.restoreChats([id]))))),
    ]
    const writeOps = [...earlierWriteOps, ...p2WriteOps, ...laterWriteOps]
    /** Answers: asked, interrupted, stopped, or sent into, each read to its end. */
    const runOps: fc.Arbitrary<Step>[] = [
      question.map(q => step('ask', async () => { checkRun(await drain(q)) })),
      fc.tuple(question, fc.constantFrom('now', 'next', 'later'), fc.string()).map(([q, priority, text]) => step(`send ${priority}`, async c => {
        const run = startRun(q)
        const first = await run.next()
        await c.send((first as Started).runId, text, { priority })
        checkRun(await run.toEnd())
      })),
      question.map(q => step('interrupt', async c => {
        const run = startRun(q)
        const first = await run.next()
        await c.interrupt((first as Started).runId)
        checkRun(await run.toEnd())
      })),
      question.map(q => step('stop', async c => {
        const run = startRun(q)
        const first = await run.next()
        c.stop((first as Started).runId)
        checkRun(await run.toEnd())
      })),
    ]
    const seedOp: fc.Arbitrary<Step> = fc.tuple(fc.constantFrom(...STAGES), fc.constantFrom(...SCENARIOS)).map(([stage, scenario]) => step(`seed ${stage}/${scenario}`, async () => t.seed({ stage, scenario })))
    // A target that serves no runs (the real one, in P2) takes the P2 writes only: a seed there is a client that never heard back.
    const op = lacks('ask') ? fc.oneof(...p2WriteOps) : fc.oneof(...writeOps, ...runOps, seedOp)
    const writeOp = fc.oneof(...(lacks('ask') ? p2WriteOps : writeOps))

    test('any sequence of writes and answers keeps every read parseable', async () => {
      await fc.assert(fc.asyncProperty(fc.array(op, { maxLength: 25 }), async steps => {
        await fresh()
        const log: string[] = []
        for (const s of steps) {
          log.push(s.name)
          const failure = await errorOf(s.run(t.client, ids()))
          // A write may be refused (a conflict): it is an AgentError, never anything else.
          if (failure !== undefined && !(failure instanceof AgentError)) throw new Error(`${s.name} threw ${String(failure)} after ${log.join(', ')}`)
          const c = t.client
          const where = `after ${log.join(', ')}`
          parse(AgentDataSchema, c.read(), `read() ${where}`)
          parse(AgentStateSchema, c.getSnapshot(), `getSnapshot() ${where}`)
          c.listFiles().forEach(f => parse(LibraryFileSchema, f, `listFiles() ${where}`))
          c.listNotifications().forEach(n => parse(AgentNotificationSchema, n, `listNotifications() ${where}`))
        }
        notices.forEach(n => parse(AgentNoticeSchema, n, `a notice after ${log.join(', ')}`))
      }), runParams)
    })

    test('any sequence of fresh and stale writes: a stale one never applies and always returns the current record; a fresh one always lands', async () => {
      const { key, values } = fx.choices
      let stale = 0
      await fc.assert(fc.asyncProperty(fc.array(fc.tuple(fc.boolean(), fc.constantFrom(...values), fc.constantFrom(...values)), { minLength: 1, maxLength: 12 }), async steps => {
        await fresh()
        let lastRev = 0
        for (const [isStale, elsewhere, mine] of steps) {
          const snap = () => t.client.getSnapshot().settings[key]
          if (isStale) {
            await t.writeElsewhere({ kind: 'setting', key }, elsewhere)
            const e = await errorOf(t.client.setSetting(key, mine))
            expect(e, 'a stale write rejects').toBeInstanceOf(AgentError)
            expect((e as AgentError).code).toBe('conflict')
            const current = parse(SettingRecordSchema, (e as AgentError).current, 'current')
            expect(current.value, 'it returns the record as it is now').toBe(elsewhere)
            expect(current.rev, 'revisions only go up').toBeGreaterThan(lastRev)
            lastRev = current.rev
            expect(snap(), 'it never applied: the snapshot holds the current value').toBe(elsewhere)
            stale++
          } else {
            await t.client.setSetting(key, mine)
            expect(snap(), 'a fresh write lands').toBe(mine)
            lastRev += 1
          }
        }
      }), runParams)
      expect(stale, 'the property reached stale writes').toBeGreaterThan(0)
    })

    test('a write that fails to save rejects with an AgentError, tells the person, and never changes the snapshot', async () => {
      let rejected = 0
      await fc.assert(fc.asyncProperty(fc.array(op, { maxLength: 10 }), writeOp, async (before, failing) => {
        await fresh()
        for (const s of before) await errorOf(s.run(t.client, ids()))
        await t.settle()
        const snap = t.client.getSnapshot()
        clearNotices()
        await t.failSaves(true)
        const result = await failing.run(t.client, ids(), true).then(v => ({ v }), (e: unknown) => ({ e }))
        await t.failSaves(false)
        if ('v' in result && result.v === SKIP) return // nothing to write in this scenario (First day has no problems)
        // Not vacuous: a write that had something to save must reject, and say so in a notice.
        expect('e' in result, `${failing.name} rejects when it can't save`).toBe(true)
        expect('e' in result && result.e).toBeInstanceOf(AgentError)
        notices.forEach((n, i) => parse(AgentNoticeSchema, n, `notice ${i} of ${failing.name}`))
        expect(notices.some(n => n.type === t.failedSaveNotice), `${failing.name} sends the failed-save notice`).toBe(true)
        expect(t.client.getSnapshot(), `after ${failing.name} failed to save`).toBe(snap)
        rejected++
      }), runParams)
      expect(rejected, 'the property reached failing writes').toBeGreaterThan(0)
    })
  })
})
