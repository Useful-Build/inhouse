// The contract suite: one set of tests run over every target in targets.ts (P1: the mock). It holds a client to the shared
// schema in shared/contract/ and to the AgentClient's documented behaviour.
//
// Ways a client can break the contract, written down before the tests:
//  - a read() value, a state, a file, a notification or a trace that doesn't parse through its schema, in some stage or scenario;
//  - a run event that doesn't parse, a run that doesn't begin with run.started or doesn't end in one terminal event;
//  - a write that returns something its schema rejects, or leaves state that doesn't parse;
//  - a snapshot that changes identity with nothing changed (React re-renders forever), or keeps it after a change (it never updates);
//  - a failed write that stays applied, resolves, rejects with something other than an AgentError, or tells nobody;
//  - a listener that fires after it unsubscribed.
// The property at the end covers the first and third at once: any sequence of writes keeps everything parseable.
//
// To replay a failing property: VITE_PROP_SEED=<seed> npm run test:unit. Longer run: VITE_PROP_RUNS=1000.
import { fc } from '@fast-check/vitest'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { z } from 'zod'
import {
  AgentDataSchema, AgentNotificationSchema, AgentStateSchema, ApproveResultSchema, LibraryFileSchema, RoutineRunSchema, RunEventSchema,
  TraceSchema,
} from '../../../shared/contract'
import type { AgentNotice, RunEvent, Scenario, Stage } from '../types'
import { AgentError, SCENARIOS, STAGES } from '../types'
import type { ContractTarget } from './targets'
import { targets } from './targets'

const numRuns = Number(import.meta.env.VITE_PROP_RUNS) || 100
const seedText = import.meta.env.VITE_PROP_SEED
const params: fc.Parameters<unknown> = { numRuns, ...(seedText ? { seed: Number(seedText) } : {}) }

const parse = <S extends z.ZodType>(schema: S, value: unknown, where: string): z.infer<S> => {
  const r = schema.safeParse(value)
  if (!r.success) throw new Error(`${where} doesn't parse: ${JSON.stringify(r.error.issues.slice(0, 3))}`)
  return r.data
}

/** Reads an answer to its end. Fake timers: the clock is advanced until the stream closes, so there is no real wait. */
async function drain(stream: AsyncIterable<RunEvent>): Promise<RunEvent[]> {
  const events: RunEvent[] = []
  let finished = false
  const done = (async () => { for await (const e of stream) events.push(e) })().finally(() => { finished = true })
  done.catch(() => undefined) // awaited below; this keeps a failure from being unhandled while the clock advances
  for (let i = 0; !finished; i++) {
    if (i > 500) throw new Error(`the answer didn't end after 500 s of demo time; events so far: ${events.map(e => e.type).join(', ')}`)
    await vi.advanceTimersByTimeAsync(1000)
  }
  await done
  return events
}

const TERMINAL = ['run.finished', 'run.failed', 'run.stopped']

describe.each(targets)('contract: $name', (t: ContractTarget) => {
  let notices: AgentNotice[]
  let unsubscribe: () => void
  beforeEach(() => {
    vi.useFakeTimers()
    t.reset()
    notices = []
    unsubscribe = t.client.onNotice(n => notices.push(n))
  })
  afterEach(() => {
    unsubscribe()
    t.failSaves(false)
    vi.useRealTimers()
  })

  const stageAndScenario = STAGES.flatMap(stage => SCENARIOS.map(scenario => [stage, scenario] as [Stage, Scenario]))

  /** The first chat the client has: asks go to it. */
  const chatId = (): string => {
    const id = t.client.read().chat.chats[0]?.id ?? t.client.allChatIds()[0]
    if (!id) throw new Error('the client has no chat to ask in')
    return id
  }
  /** The first problem whose approval is held 10 s before it goes out, and the first reversible one (no hold). */
  const heldProblem = () => t.client.read().problems.find(p => !p.draft.rev)!.id
  const reversibleProblem = () => t.client.read().problems.find(p => p.draft.rev)?.id

  // ---------- reads ----------
  describe('reads parse through their schema', () => {
    test.each(stageAndScenario)('every read in %s, %s', (stage, scenario) => {
      t.seed({ stage, scenario })
      const c = t.client
      const data = parse(AgentDataSchema, c.read(), 'read()')
      parse(AgentStateSchema, c.getSnapshot(), 'getSnapshot()')
      c.listFiles().forEach((f, i) => parse(LibraryFileSchema, f, `listFiles()[${i}]`))
      c.listNotifications().forEach((n, i) => parse(AgentNotificationSchema, n, `listNotifications()[${i}]`))
      // Every trace id the data points to: a problem's, and each chat answer's.
      const ids = [...data.problems.flatMap(p => (p.trace ? [p.trace] : [])), ...data.chat.chats.flatMap(ch => ch.turns.flatMap(turn => (turn.role === 'agent' ? [turn.trace] : [])))]
      for (const id of ids) {
        const trace = c.getTrace(id)
        expect(trace, `getTrace("${id}") is null`).not.toBeNull()
        parse(TraceSchema, trace, `getTrace("${id}")`)
      }
      expect(c.getTrace('no-such-trace')).toBeNull()
      expect(c.allChatIds().length).toBeGreaterThanOrEqual(data.chat.chats.length)
    })

    test('Loading reports loading; every other scenario reports ready', () => {
      for (const scenario of SCENARIOS) {
        t.seed({ stage: 'Act', scenario })
        expect(t.client.read().status).toBe(scenario === 'Loading' ? 'loading' : 'ready')
      }
    })
  })

  // ---------- run events ----------
  describe('ask() streams events that parse', () => {
    const checkRun = (events: RunEvent[]) => {
      events.forEach((e, i) => parse(RunEventSchema, e, `event ${i} (${e.type})`))
      expect(events[0]?.type).toBe('run.started')
      const ends = events.filter(e => TERMINAL.includes(e.type))
      expect(ends, 'exactly one terminal event').toHaveLength(1)
      expect(TERMINAL).toContain(events.at(-1)!.type)
      const started = events[0] as Extract<RunEvent, { type: 'run.started' }>
      for (const e of ends) expect((e as { runId: string }).runId).toBe(started.runId)
      return events
    }

    test.each(STAGES)('every suggested question, in %s', async stage => {
      t.seed({ stage, scenario: 'Normal' })
      const questions = t.client.read().chat.suggestions
      expect(questions.length).toBeGreaterThan(0)
      for (const q of questions) {
        const events = checkRun(await drain(t.client.ask(q, { chatId: chatId() })))
        expect(events.at(-1)!.type, q).toBe('run.finished')
        expect(events.some(e => e.type === 'part'), `${q} answers with a part`).toBe(true)
      }
    })

    test('an off-script question answers with what it can do and the suggestions as chips', async () => {
      t.seed({ stage: 'Act', scenario: 'Normal' })
      const events = checkRun(await drain(t.client.ask('Please translate this into Klingon', { chatId: chatId() })))
      const parts = events.flatMap(e => (e.type === 'part' ? [e.part] : []))
      const chips = parts.find(p => p.type === 'suggestions')
      expect(chips && chips.type === 'suggestions' && chips.questions).toEqual(t.client.read().chat.suggestions)
    })

    test('a run carries its trace id, and getTrace opens it', async () => {
      t.seed({ stage: 'Act', scenario: 'Normal' })
      const events = checkRun(await drain(t.client.ask('Which orders are stuck?', { chatId: chatId() })))
      for (const e of events) if (e.type === 'part') parse(TraceSchema, t.client.getTrace(e.trace), `getTrace("${e.trace}")`)
    })

    test('a routine request makes a routine that is saved in state', async () => {
      t.seed({ stage: 'Act', scenario: 'Normal' })
      const before = t.client.getSnapshot().routinesExtra.length
      const events = checkRun(await drain(t.client.ask('Every Monday at 9 AM send me the refund numbers', { chatId: chatId() })))
      const card = events.flatMap(e => (e.type === 'part' && e.part.type === 'routine' ? [e.part.routine] : []))[0]
      expect(card).toBeDefined()
      const extra = t.client.getSnapshot().routinesExtra
      expect(extra).toHaveLength(before + 1)
      expect(extra.some(r => r.id === card.id)).toBe(true)
    })

    test('a skill request makes a skill that is saved in state', async () => {
      t.seed({ stage: 'Act', scenario: 'Normal' })
      const before = t.client.getSnapshot().skillsExtra.length
      const events = checkRun(await drain(t.client.ask('Please create a skill that checks stock levels', { chatId: chatId() })))
      expect(events.some(e => e.type === 'part' && e.part.type === 'skill')).toBe(true)
      expect(t.client.getSnapshot().skillsExtra).toHaveLength(before + 1)
    })

    test('a question with a disconnected tool ends in run.failed with an error part', async () => {
      t.seed({ stage: 'Act', scenario: 'Tool disconnected' })
      const events = checkRun(await drain(t.client.ask('How many Gorgias tickets about refunds are open?', { chatId: chatId() })))
      expect(events.at(-1)!.type).toBe('run.failed')
      expect(events.some(e => e.type === 'part' && e.part.type === 'error')).toBe(true)
    })

    test.each(['First day', 'Loading'] as const)('%s answers that it has nothing to read yet', async scenario => {
      t.seed({ stage: 'Act', scenario })
      checkRun(await drain(t.client.ask('Which orders are stuck?', { chatId: chatId() })))
    })

    test('a message sent into a running answer starts a turn; one sent after it ended is refused with a notice', async () => {
      t.seed({ stage: 'Act', scenario: 'Normal' })
      const events: RunEvent[] = []
      let finished = false
      const done = (async () => { for await (const e of t.client.ask('Which orders are stuck?', { chatId: chatId() })) events.push(e) })().finally(() => { finished = true })
      await vi.advanceTimersByTimeAsync(0)
      const runId = (events[0] as Extract<RunEvent, { type: 'run.started' }>).runId
      await t.client.send(runId, 'And which are over $500?', { priority: 'later' })
      for (let i = 0; !finished && i < 500; i++) await vi.advanceTimersByTimeAsync(1000)
      await done
      checkRun(events)
      expect(events.some(e => e.type === 'turn.started' && e.text === 'And which are over $500?')).toBe(true)
      await expect(t.client.send(runId, 'Too late')).rejects.toMatchObject({ name: 'AgentError', code: 'conflict' })
      await expect(t.client.interrupt(runId)).rejects.toBeInstanceOf(AgentError)
      expect(notices.filter(n => n.type === 'error' && n.code === 'conflict')).toHaveLength(2)
    })

    test('stop ends the run with run.stopped', async () => {
      t.seed({ stage: 'Act', scenario: 'Normal' })
      const events: RunEvent[] = []
      const done = (async () => { for await (const e of t.client.ask('Which orders are stuck?', { chatId: chatId() })) events.push(e) })()
      await vi.advanceTimersByTimeAsync(0)
      t.client.stop((events[0] as Extract<RunEvent, { type: 'run.started' }>).runId)
      await vi.advanceTimersByTimeAsync(1000)
      await done
      checkRun(events)
      expect(events.at(-1)!.type).toBe('run.stopped')
    })
  })

  // ---------- writes ----------
  describe('write results parse and change state', () => {
    test('approve a held draft: the result parses, the hold ends in a sent notice', async () => {
      t.seed({ stage: 'Act', scenario: 'Normal' })
      const id = heldProblem()
      const result = parse(ApproveResultSchema, await t.client.approve(id), 'approve()')
      expect(result.held).toBe(true)
      expect(t.client.getSnapshot().approved[id]).toEqual(result.record)
      expect(t.client.getSnapshot().sent[id]).toBeUndefined()
      await vi.advanceTimersByTimeAsync(10_000)
      expect(t.client.getSnapshot().sent[id]).toBe(true)
      expect(notices).toContainEqual({ type: 'approval.sent', id, text: result.doneText })
      parse(AgentStateSchema, t.client.getSnapshot(), 'getSnapshot()')
    })

    test('approve twice returns the first record', async () => {
      t.seed({ stage: 'Act', scenario: 'Normal' })
      const id = heldProblem()
      const first = await t.client.approve(id)
      expect(await t.client.approve(id)).toEqual({ ...first, held: true })
    })

    test('undo inside the hold stops the send; undo after it went out rejects with conflict and a notice', async () => {
      t.seed({ stage: 'Act', scenario: 'Normal' })
      const id = heldProblem()
      await t.client.approve(id)
      await t.client.undo(id)
      expect(t.client.getSnapshot().approved[id]).toBeUndefined()
      await vi.advanceTimersByTimeAsync(11_000)
      expect(notices.some(n => n.type === 'approval.sent')).toBe(false)
      await t.client.approve(id)
      await vi.advanceTimersByTimeAsync(10_000)
      const snap = t.client.getSnapshot()
      await expect(t.client.undo(id)).rejects.toMatchObject({ name: 'AgentError', code: 'conflict' })
      expect(notices.at(-1)).toMatchObject({ type: 'error', code: 'conflict' })
      expect(t.client.getSnapshot(), 'a refused undo changes nothing').toBe(snap)
    })

    test('a reversible draft finishes at once', async () => {
      t.seed({ stage: 'Act', scenario: 'Normal' })
      const id = reversibleProblem()
      if (!id) return
      expect((await t.client.approve(id)).held).toBe(false)
    })

    test('edit a draft', async () => {
      t.seed({ stage: 'Act', scenario: 'Normal' })
      const id = heldProblem()
      await t.client.editDraft(id, 'New wording')
      expect(t.client.getSnapshot().edits[id]).toBe('New wording')
    })

    test('run a routine now: the result parses and heads the list of runs', async () => {
      t.seed({ stage: 'Run', scenario: 'Normal' })
      for (const r of t.client.read().routines) {
        const run = parse(RoutineRunSchema, await t.client.runRoutine(r.id), `runRoutine(${r.id})`)
        expect(run.routine).toBe(r.id)
        expect(t.client.getSnapshot().routineRuns[0]).toEqual(run)
      }
    })

    test('delete a routine and restore it', async () => {
      const id = t.client.read().routines[0].id
      await t.client.deleteRoutine(id)
      expect(t.client.getSnapshot().routinesDeleted[id]).toBe(true)
      await t.client.restoreRoutine(id)
      expect(t.client.getSnapshot().routinesDeleted[id]).toBeUndefined()
    })

    test.each(['snoozed', 'dismissed', 'declined'] as const)('set a problem aside as %s, then bring it back', async reason => {
      const id = heldProblem()
      await t.client.setAside(id, reason)
      expect(t.client.getSnapshot().setAside[id]).toMatchObject({ reason })
      await t.client.setAside(id, null)
      expect(t.client.getSnapshot().setAside[id]).toBeUndefined()
    })

    test('approving a problem that was set aside clears it', async () => {
      const id = heldProblem()
      await t.client.setAside(id, 'snoozed')
      await t.client.approve(id)
      expect(t.client.getSnapshot().setAside[id]).toBeUndefined()
    })

    test('pause resolves to when, resume clears it', async () => {
      const at = await t.client.pause()
      expect(t.client.getSnapshot().paused).toBe(at)
      await t.client.resume()
      expect(t.client.getSnapshot().paused).toBeNull()
    })

    test('undo what the agent handled, then redo it', async () => {
      t.seed({ stage: 'Run', scenario: 'Normal' })
      const id = heldProblem()
      expect(await t.client.undoHandled(id)).toEqual(expect.any(String))
      expect(t.client.getSnapshot().undone[id]).toBeDefined()
      await t.client.redoHandled(id)
      expect(t.client.getSnapshot().undone[id]).toBeUndefined()
    })

    test('send a team request', async () => {
      const req = { icon: 'build', title: 'Connect Klaviyo', sub: 'From Settings', status: 'Requested' }
      await t.client.sendTeamRequest(req)
      expect(t.client.getSnapshot().teamRequests[0]).toEqual(req)
    })

    test('toggles, requests, pauses, memory, settings and photos', async () => {
      const c = t.client
      await c.setToggle('r:Morning check', false)
      expect(c.getSnapshot().toggles['r:Morning check']).toBe(false)
      await c.requestTool('klaviyo', true)
      expect(c.getSnapshot().requestedTools.klaviyo).toBe(true)
      await c.requestTool('klaviyo', false)
      expect(c.getSnapshot().requestedTools.klaviyo).toBeUndefined()
      await c.requestSkill('Stock check')
      expect(c.getSnapshot().requestedSkills['Stock check']).toBe(true)
      await c.setToolPaused('shopify', true)
      expect(c.getSnapshot().toolPaused.shopify).toBe(true)
      await c.setToolPaused('shopify', false)
      expect(c.getSnapshot().toolPaused.shopify).toBeUndefined()
      await c.forgetMemory('some-line', true)
      expect(c.getSnapshot().forgot['some-line']).toBe(true)
      await c.forgetMemory('some-line', false)
      expect(c.getSnapshot().forgot['some-line']).toBeUndefined()
      await c.setSetting('g:name', 'Sam Example')
      expect(c.getSnapshot().settings['g:name']).toBe('Sam Example')
      await c.setSetting('g:name', null)
      expect(c.getSnapshot().settings['g:name']).toBeUndefined()
      await c.setPhoto('person-1', 'data:image/png;base64,AAAA')
      await c.setPhoto('person-1', null)
      expect(c.getSnapshot().settings['photo:person-1']).toBe('')
      parse(AgentStateSchema, c.getSnapshot(), 'getSnapshot()')
    })

    test('mark notifications read: only the new ones change state', async () => {
      const ids = t.client.listNotifications().map(n => n.id)
      expect(ids.length).toBeGreaterThan(0)
      await t.client.markNoticesRead(ids)
      expect(Object.keys(t.client.getSnapshot().readNotices).sort()).toEqual([...ids].sort())
      const snap = t.client.getSnapshot()
      await t.client.markNoticesRead(ids)
      expect(t.client.getSnapshot(), 'marking what is read already changes nothing').toBe(snap)
      expect(t.client.listNotifications().every(n => !n.unread)).toBe(true)
    })

    test('delete library files and restore them', async () => {
      const files = t.client.listFiles()
      const ids = files.slice(0, 2).map(f => f.id)
      await t.client.deleteFiles(ids)
      expect(t.client.listFiles().map(f => f.id)).not.toContain(ids[0])
      expect(t.client.listFiles()).toHaveLength(files.length - ids.length)
      await t.client.restoreFiles(ids)
      expect(t.client.listFiles().map(f => f.id)).toEqual(files.map(f => f.id))
    })

    test('chats: create, rename, pin, delete, restore', async () => {
      const c = t.client
      await c.createChat({ id: 'contract-chat-1', title: 'A new chat' })
      expect(c.allChatIds()).toContain('contract-chat-1')
      await c.renameChat('contract-chat-1', '  Spaced   title  ')
      expect(c.getSnapshot().chatTitles['contract-chat-1']).toBe('Spaced title')
      await c.renameChat('contract-chat-1', null)
      expect(c.getSnapshot().chatTitles['contract-chat-1']).toBeUndefined()
      await c.pinChat('contract-chat-1', true)
      expect(c.getSnapshot().chatPinned['contract-chat-1']).toBe(true)
      await c.deleteChats(['contract-chat-1'])
      expect(c.getSnapshot().chatDeleted['contract-chat-1']).toBe(true)
      await c.restoreChats(['contract-chat-1'])
      expect(c.getSnapshot().chatDeleted['contract-chat-1']).toBeUndefined()
      await expect(c.createChat({ id: '  ', title: 'No id' })).rejects.toBeInstanceOf(AgentError)
    })

    test('asking in a chat the client never made fails loud', async () => {
      await expect(t.client.ask('Hello?', { chatId: 'no-such-chat' })[Symbol.asyncIterator]().next()).rejects.toThrow(/unknown chat id/)
    })
  })

  // ---------- snapshots ----------
  describe('snapshots keep their identity until something changes', () => {
    test('every read returns the same object when nothing changed', () => {
      const c = t.client
      expect(c.getSnapshot()).toBe(c.getSnapshot())
      expect(c.read()).toBe(c.read())
      expect(c.listFiles()).toBe(c.listFiles())
      expect(c.listNotifications()).toBe(c.listNotifications())
    })

    test('state is a new object after a write', async () => {
      const before = t.client.getSnapshot()
      await t.client.pause()
      expect(t.client.getSnapshot()).not.toBe(before)
      expect(before.paused).toBeNull()
    })

    test('files are a new array after a delete, notifications after a read mark, data after a scenario change', async () => {
      const files = t.client.listFiles()
      await t.client.deleteFiles([files[0].id])
      expect(t.client.listFiles()).not.toBe(files)

      const notes = t.client.listNotifications()
      await t.client.markNoticesRead(notes.map(n => n.id))
      expect(t.client.listNotifications()).not.toBe(notes)

      const data = t.client.read()
      t.seed({ stage: 'Act', scenario: 'Cap reached' })
      expect(t.client.read()).not.toBe(data)
    })

    test('subscribe tells listeners of every change, and stops after unsubscribe', async () => {
      const calls = vi.fn()
      const off = t.client.subscribe(calls)
      await t.client.pause()
      expect(calls).toHaveBeenCalledTimes(1)
      t.seed({ stage: 'Run', scenario: 'Normal' })
      expect(calls).toHaveBeenCalledTimes(2)
      off()
      await t.client.resume()
      expect(calls).toHaveBeenCalledTimes(2)
    })
  })

  // ---------- notices and rollback ----------
  describe('a failed write is taken back and the person is told', () => {
    /** Every write that saves, with the state it changes: none may stay applied when the save fails. */
    const writes: [string, (c: ContractTarget['client']) => Promise<unknown>][] = [
      ['approve', c => c.approve(heldProblem())],
      ['editDraft', c => c.editDraft(heldProblem(), 'x')],
      ['undoHandled', c => c.undoHandled(heldProblem())],
      ['pause', c => c.pause()],
      ['setToggle', c => c.setToggle('r:Morning check', false)],
      ['requestTool', c => c.requestTool('klaviyo', true)],
      ['requestSkill', c => c.requestSkill('Stock check')],
      ['setToolPaused', c => c.setToolPaused('shopify', true)],
      ['forgetMemory', c => c.forgetMemory('some-line', true)],
      ['setSetting', c => c.setSetting('g:name', 'Sam Example')],
      ['setPhoto', c => c.setPhoto('person-1', 'data:image/png;base64,AAAA')],
      ['sendTeamRequest', c => c.sendTeamRequest({ icon: 'build', title: 'Connect Klaviyo', sub: 'From Settings', status: 'Requested' })],
      ['markNoticesRead', c => c.markNoticesRead(c.listNotifications().map(n => n.id))],
      ['deleteFiles', c => c.deleteFiles([c.listFiles()[0].id])],
      ['setAside', c => c.setAside(heldProblem(), 'dismissed')],
      ['runRoutine', c => c.runRoutine(c.read().routines[0].id)],
      ['deleteRoutine', c => c.deleteRoutine(c.read().routines[0].id)],
      ['renameChat', c => c.renameChat(chatId(), 'Renamed')],
      ['pinChat', c => c.pinChat(chatId(), true)],
      ['deleteChats', c => c.deleteChats([chatId()])],
    ]

    describe.each([['Normal'], ['Cap reached']] as const)('in the %s scenario', scenario => {
      test.each(writes)('%s: rejects with an AgentError, restores the snapshot and sends save.failed', async (_name, write) => {
        t.seed({ stage: 'Act', scenario })
        const before = t.client.getSnapshot()
        const data = t.client.read()
        t.failSaves(true)
        await expect(write(t.client)).rejects.toBeInstanceOf(AgentError)
        expect(t.client.getSnapshot(), 'the change was taken back').toBe(before)
        expect(t.client.read(), 'read() is untouched').toBe(data)
        expect(notices.some(n => n.type === 'save.failed' || n.type === 'error')).toBe(true)
      })
    })

    test('the Cap reached scenario reads at the cap, and a write still works there', async () => {
      t.seed({ stage: 'Act', scenario: 'Cap reached' })
      const data = parse(AgentDataSchema, t.client.read(), 'read()')
      expect(data.usage.total).toBeGreaterThan(0)
      await t.client.setToggle('r:Morning check', false)
      expect(t.client.getSnapshot().toggles['r:Morning check']).toBe(false)
      expect(notices).toEqual([])
    })

    test('an injected AgentError: a refused undo rejects with the same code its notice carries', async () => {
      t.seed({ stage: 'Act', scenario: 'Normal' })
      const id = heldProblem()
      await t.client.approve(id)
      await vi.advanceTimersByTimeAsync(10_000)
      const error: unknown = await t.client.undo(id).catch((e: unknown) => e)
      expect(error).toBeInstanceOf(AgentError)
      const notice = notices.find(n => n.type === 'error')
      expect(notice).toMatchObject({ type: 'error', code: (error as AgentError).code, text: (error as AgentError).message })
    })

    test('a save that fails while a hold finishes tells the person and the next write still works', async () => {
      t.seed({ stage: 'Act', scenario: 'Normal' })
      await t.client.approve(heldProblem())
      t.failSaves(true)
      await vi.advanceTimersByTimeAsync(10_000)
      expect(notices.some(n => n.type === 'save.failed')).toBe(true)
      t.failSaves(false)
      await t.client.pause()
      parse(AgentStateSchema, t.client.getSnapshot(), 'getSnapshot()')
    })

    test('a write that fails does not raise an unhandled rejection when nobody awaits it', async () => {
      t.seed({ stage: 'Act', scenario: 'Normal' })
      t.failSaves(true)
      void t.client.pause()
      await vi.advanceTimersByTimeAsync(0)
      expect(notices.some(n => n.type === 'save.failed')).toBe(true)
    })
  })

  // ---------- property: any sequence of writes ----------
  describe('properties', () => {
    // Ids come from the client, so the sequence acts on things that exist and the failure it finds is the client's.
    const ids = () => {
      const d = t.client.read()
      return {
        problems: d.problems.map(p => p.id),
        routines: d.routines.map(r => r.id),
        files: t.client.listFiles().map(f => f.id),
        chats: t.client.allChatIds(),
      }
    }
    const key = fc.string({ unit: 'grapheme-ascii', minLength: 1, maxLength: 8 })
    const pick = (n: number) => fc.nat(n === 0 ? 0 : n - 1)

    type Op = (c: ContractTarget['client'], i: ReturnType<typeof ids>) => Promise<unknown>
    // First day has no problems and Loading no routines: an op with nothing to act on does nothing.
    const nth = <T,>(list: T[], n: number): T | undefined => list[n % Math.max(1, list.length)]
    const on = <T,>(list: T[], n: number, f: (x: T) => Promise<unknown>): Promise<unknown> => { const x = nth(list, n); return x === undefined ? Promise.resolve() : f(x) }
    const op: fc.Arbitrary<{ name: string; run: Op }> = fc.oneof(
      fc.tuple(pick(50), fc.boolean()).map(([n, hold]): { name: string; run: Op } => ({ name: `approve#${n}`, run: (c, i) => on(i.problems, n, id => (hold ? c.approve(id) : c.undo(id))) })),
      fc.tuple(pick(50), fc.string()).map(([n, s]): { name: string; run: Op } => ({ name: 'editDraft', run: (c, i) => on(i.problems, n, id => c.editDraft(id, s)) })),
      fc.tuple(pick(50), fc.boolean()).map(([n, undo]): { name: string; run: Op } => ({ name: 'undoHandled', run: (c, i) => on(i.problems, n, id => (undo ? c.undoHandled(id) : c.redoHandled(id))) })),
      fc.boolean().map((p): { name: string; run: Op } => ({ name: 'pause', run: c => (p ? c.pause() : c.resume()) })),
      fc.tuple(key, fc.boolean()).map(([k, b]): { name: string; run: Op } => ({ name: 'setToggle', run: c => c.setToggle(k, b) })),
      fc.tuple(key, fc.boolean()).map(([k, b]): { name: string; run: Op } => ({ name: 'requestTool', run: c => c.requestTool(k, b) })),
      key.map((k): { name: string; run: Op } => ({ name: 'requestSkill', run: c => c.requestSkill(k) })),
      fc.tuple(key, fc.boolean()).map(([k, b]): { name: string; run: Op } => ({ name: 'setToolPaused', run: c => c.setToolPaused(k, b) })),
      fc.tuple(key, fc.boolean()).map(([k, b]): { name: string; run: Op } => ({ name: 'forgetMemory', run: c => c.forgetMemory(k, b) })),
      fc.tuple(key, fc.option(fc.string(), { nil: null })).map(([k, v]): { name: string; run: Op } => ({ name: 'setSetting', run: c => c.setSetting(k, v) })),
      fc.tuple(key, fc.option(fc.string(), { nil: null })).map(([k, v]): { name: string; run: Op } => ({ name: 'setPhoto', run: c => c.setPhoto(k, v) })),
      fc.tuple(fc.string(), fc.string(), fc.string(), fc.string()).map(([icon, title, sub, status]): { name: string; run: Op } => ({ name: 'sendTeamRequest', run: c => c.sendTeamRequest({ icon, title, sub, status }) })),
      fc.boolean().map((all): { name: string; run: Op } => ({ name: 'markNoticesRead', run: c => c.markNoticesRead(all ? c.listNotifications().map(n => n.id) : c.listNotifications().slice(0, 1).map(n => n.id)) })),
      fc.tuple(fc.array(pick(50), { maxLength: 3 }), fc.boolean()).map(([ns, del]): { name: string; run: Op } => ({ name: 'files', run: (c, i) => { const f = ns.map(n => nth(i.files, n)).filter((x): x is string => x !== undefined); return del ? c.deleteFiles(f) : c.restoreFiles(f) } })),
      fc.tuple(pick(50), fc.option(fc.constantFrom('snoozed', 'dismissed', 'declined'), { nil: null })).map(([n, r]): { name: string; run: Op } => ({ name: 'setAside', run: (c, i) => on(i.problems, n, id => c.setAside(id, r)) })),
      fc.tuple(pick(50), fc.constantFrom('run', 'delete', 'restore')).map(([n, a]): { name: string; run: Op } => ({ name: `routine-${a}`, run: (c, i) => on(i.routines, n, id => (a === 'run' ? c.runRoutine(id) : a === 'delete' ? c.deleteRoutine(id) : c.restoreRoutine(id))) })),
      fc.tuple(pick(50), fc.constantFrom('rename', 'clear', 'pin', 'unpin', 'delete', 'restore'), fc.string()).map(([n, a, s]): { name: string; run: Op } => ({
        name: `chat-${a}`,
        run: (c, i) => on(i.chats, n, id => (a === 'rename' ? c.renameChat(id, s) : a === 'clear' ? c.renameChat(id, null) : a === 'pin' ? c.pinChat(id, true) : a === 'unpin' ? c.pinChat(id, false) : a === 'delete' ? c.deleteChats([id]) : c.restoreChats([id]))),
      })),
      fc.tuple(fc.constantFrom(...STAGES), fc.constantFrom(...SCENARIOS)).map(([stage, scenario]): { name: string; run: Op } => ({ name: `seed ${stage}/${scenario}`, run: async () => t.seed({ stage, scenario }) })),
    )

    test('any sequence of writes keeps every read parseable', async () => {
      await fc.assert(fc.asyncProperty(fc.array(op, { maxLength: 25 }), async steps => {
        t.reset()
        t.seed({ stage: 'Act', scenario: 'Normal' })
        const log: string[] = []
        for (const step of steps) {
          log.push(step.name)
          try { await step.run(t.client, ids()) }
          catch (e) { if (!(e instanceof AgentError)) throw new Error(`${step.name} threw ${String(e)} after ${log.join(', ')}`) }
          const c = t.client
          parse(AgentDataSchema, c.read(), `read() after ${log.join(', ')}`)
          parse(AgentStateSchema, c.getSnapshot(), `getSnapshot() after ${log.join(', ')}`)
          c.listFiles().forEach(f => parse(LibraryFileSchema, f, `listFiles() after ${log.join(', ')}`))
          c.listNotifications().forEach(n => parse(AgentNotificationSchema, n, `listNotifications() after ${log.join(', ')}`))
        }
      }), params)
    })

    test('a change that fails to save never changes the snapshot, whatever came before', async () => {
      await fc.assert(fc.asyncProperty(fc.array(op, { maxLength: 10 }), op, async (before, failing) => {
        t.reset()
        t.seed({ stage: 'Act', scenario: 'Normal' })
        for (const step of before) await step.run(t.client, ids()).catch(() => undefined)
        const snap = t.client.getSnapshot()
        const heldBefore = Object.keys(snap.approved).length
        t.failSaves(true)
        await failing.run(t.client, ids()).catch(() => undefined)
        t.failSaves(false)
        // Switching stage or scenario isn't a save, so a seed step may legitimately change what read() shows, never the state.
        expect(t.client.getSnapshot(), `after ${failing.name} failed to save`).toBe(snap)
        expect(Object.keys(t.client.getSnapshot().approved)).toHaveLength(heldBefore)
      }), params)
    })
  })
})
