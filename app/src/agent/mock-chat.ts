// The demo agent's chat engine: runs, turns, frames, the queue and the chat list and history reads (the server's side of C4 and
// C5 in memory). It loads with the first send, not with the page (Today's JS budget, scripts/check-bundle.mjs): `MockAgent`
// holds what the snapshot, saved state and chat list need, and hands this class the rest through `Host`.
import { models } from './data'
import type { ChatEvent } from './types'
import type {
  ActiveRun, ChatList, ChatPage, ChatSendInput, Instant, MessagePart, RunFrame, SendTurnResult, StoredMessage, TurnFailure, AgentErrorCode,
} from './types'
import type { ErrorReason } from '../../shared/contract/common'
import type { TraceKey } from './data'
import type { Job, JobOutcome } from '../../shared/contract/jobs'
import { CONFLICT, FORBIDDEN, INVALID, NOT_FOUND, RATE_LIMITED, REASON } from '../../shared/contract/error-codes'
import { FAIL, NOTICE } from '../../shared/contract/chat-codes'
import { JOB_CARRIED_ON_TEXT } from '../../shared/server-turn-text'
import { demoNow } from './demo-clock'
import { instantOf, moneyOf } from '../lib/format'
import { dollarsIn } from '../state/derive'
import { buildScript } from './mock-script'
import type { ScriptHost } from './mock-script'
import type { MockJobs } from './mock-jobs'
import type { MockActions } from './mock-actions'
import type { MockRun, MockTurn, RunInfo, Script, ScriptedTurn } from './mock'

export type { ScriptedTurn }

/** What the engine takes from the mock: its state, the sample this.h.k.chats and the pieces it shares (scripts, saved run info, rejections). */
export interface Host {
  state: import('./types').AgentState
  demo: import('./types').DemoContext
  startedAt: number
  seen: Record<string, number>
  created: Set<string>
  createdInfo: Map<string, { title: string; at: Instant }>
  mockRuns: Map<string, MockRun>
  history: Map<string, StoredMessage[]>
  runInfo: Map<string, RunInfo>
  scripted: ScriptedTurn | null
  k: { chats: import('./types').ChatThread[]; ME_ID: string; SESSION: string; FINISHED: string; THINKING_STEP_MS: number; tools: import('./types').ToolsData; traceKey(t: string): import('./data').TraceKey; meName(): string }
  commit(next: Partial<import('./types').AgentState>): boolean
  read(): import('./types').AgentData
  rev(rec: string, base: number): number
  rejected(code: AgentErrorCode, text: string, tell: boolean, extra?: { reason?: ErrorReason; current?: Record<string, unknown> }): Promise<never>
  notify(n: import('./types').AgentNotice): void
  knownChat(id: string): boolean
  chatBase(id: string): { id: string; title: string; at: Instant } | undefined
  chatUniverse(): { id: string; title: string; at: Instant }[]
  summary(c: { id: string; title: string; at: Instant }): import('./types').ChatSummary
  lastAt(id: string, began: Instant): Instant
  cursorOf(key: string): string
  keyOf(cursor: string): string | null
  saveRunInfo(id: string, info: RunInfo): void
  saveRoutine(part: Extract<MessagePart, { type: 'routine' }>, replaces: string | undefined, info: RunInfo): MessagePart
  takeBack(replaced: string, info: RunInfo): void
  traceOf(id: string): import('./types').Trace | null
  loadJobs(): Promise<MockJobs>
  loadedJobs(): MockJobs | null
  loadActions(): Promise<MockActions>
  loadedActions(): MockActions | null
}

const LIVE_JOB_COST_MINOR = 145
const DEFAULT_PROGRESS_STEPS: { label: string; helpers: number }[] = [
  { label: 'Joining 60-day ShipBob return postage', helpers: 1 },
  { label: 'Writing final margin comparison', helpers: 0 },
]

export class ChatEngine {
  private readonly h: Host
  constructor(h: Host) { this.h = h }
  private turnsById = new Map<string, MockTurn>()
  /** `chatId/clientTurnKey` to what the send answered, so a retry answers the same turn. */
  private sendKeys = new Map<string, { hash: string; result: SendTurnResult }>()
  private damaged = new Set<string>()
  private idSeq = 0
  private epoch = 0
  private activeJobRuns = new Map<string, { run: MockRun; controller: AbortController; contTurn?: MockTurn; wakeNow?: AbortController; fenced?: 'paused' | 'deleted' | 'reset' }>()

  /** Reset demo: forget every turn, key and damaged session. */
  clear() {
    this.epoch++
    this.turnsById.clear()
    this.sendKeys.clear()
    this.damaged.clear()
    this.activeJobRuns.forEach(j => { j.fenced = 'reset'; j.controller.abort() })
    this.activeJobRuns.clear()
  }

  listChats(opts: { cursor?: string; limit?: number; deleted?: boolean } = {}): Promise<ChatList> {
    const limit = opts.limit ?? 50
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) return this.h.rejected(INVALID, 'The page size must be 1 to 100.', true)
    let all = this.h.chatUniverse().map(c => this.h.summary(c)).filter(c => c.deleted === !!opts.deleted)
      .sort((a, b) => b.at.ms - a.at.ms || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
    if (opts.cursor !== undefined) {
      const key = this.h.keyOf(opts.cursor)
      const m = key === null ? null : /^(-?\d+):(.*)$/.exec(key)
      if (!m) return this.h.rejected(INVALID, 'That page cursor is not valid.', true)
      const [ms, id] = [Number(m[1]), m[2]]
      all = all.filter(c => c.at.ms < ms || (c.at.ms === ms && c.id < id))
    }
    const items = all.slice(0, limit)
    const last = items.at(-1)
    for (const c of items) this.h.seen[`chat:${c.id}`] = c.rev
    return Promise.resolve({ items, nextCursor: all.length > limit && last ? this.h.cursorOf(`${last.at.ms}:${last.id}`) : null })
  }

  /** The sample chat's turns as stored messages: ids from the chat's place in the list, so they never change. */
  seedMessages(id: string): StoredMessage[] {
    const ci = this.h.k.chats.findIndex(c => c.id === id)
    if (ci < 0) return []
    const c = this.h.k.chats[ci]
    const id22 = (kind: string, a: number, b: number) => `${kind}_${`s${a.toString(36).padStart(3, '0')}${b.toString(36).padStart(3, '0')}`.padEnd(22, '0')}`
    const runId = id22('r', ci, 0)
    const out: StoredMessage[] = []
    let turnId = '', n = 0
    c.turns.forEach((t, j) => {
      if (t.role === 'user') {
        turnId = id22('t', ci, j); n = 0
        out.push({ id: `${turnId}.u`, role: 'user', text: t.text, turnId, runId, pos: out.length, at: c.at })
        return
      }
      for (const part of t.parts) out.push({ id: `${turnId}.${n++}`, role: 'agent', part, trace: t.trace, model: t.model, at: c.at, turnId, runId, pos: out.length })
    })
    return out
  }
  allMessages(id: string): StoredMessage[] {
    return [...this.seedMessages(id), ...(this.h.loadedJobs()?.messages(id) ?? []), ...(this.h.loadedActions()?.messages(id) ?? []), ...(this.h.history.get(id) ?? [])]
  }
  /** A chat with no sample turns is one the agent keeps: its history lives in the jobs and actions stores, loaded on first use. */
  private async keepLoaded(id: string): Promise<void> {
    if (this.h.k.chats.find(c => c.id === id)?.turns.length !== 0) return
    if (!this.h.loadedJobs()) await this.h.loadJobs()
    if (!this.h.loadedActions()) await this.h.loadActions()
  }

  async getChat(id: string, cursor?: string): Promise<ChatPage> {
    const base = this.h.chatBase(id) ?? this.h.read().chat.chats.find(c => c.id === id)
    if (!base) return this.h.rejected(NOT_FOUND, "That chat isn't available. It may have been deleted.", true)
    await this.keepLoaded(id)
    const all = this.allMessages(id)
    let below = all.length
    if (cursor !== undefined) {
      const key = this.h.keyOf(cursor)
      const m = key === null ? null : /^p(\d+)$/.exec(key)
      if (!m) return this.h.rejected(INVALID, 'That page cursor is not valid.', true)
      below = Number(m[1])
    }
    const size = 50
    const page = all.filter(m => m.pos < below).slice(-size).reverse()
    const first = page.at(-1)
    const runs: ActiveRun[] = [...this.h.mockRuns.values()].filter(r => r.live && r.chatId === id).map(r => ({ runId: r.runId, chatId: r.chatId, lastSeq: r.frames.length, live: true }))
    const chat = this.h.summary(base)
    this.h.seen[`chat:${id}`] = chat.rev
    return { chat, messages: page, nextCursor: first && first.pos > 0 ? this.h.cursorOf(`p${first.pos}`) : null, runs }
  }

  resetSession(chatId: string): Promise<void> {
    if (!this.h.knownChat(chatId)) return this.h.rejected(NOT_FOUND, "That chat isn't available. It may have been deleted.", true)
    this.damaged.delete(chatId)
    return Promise.resolve()
  }

  // ----- chat runs -----

  id22(kind: 'r' | 't'): string { return `${kind}_${(this.h.k.SESSION + (++this.idSeq).toString(36).padStart(6, '0')).padEnd(22, '0').slice(0, 22)}` }
  nowInstant = (): Instant => instantOf(demoNow(this.h.startedAt).getTime())

  emit(run: MockRun, event: ChatEvent) {
    const frame: RunFrame = { runId: run.runId, seq: run.frames.length + 1, at: this.nowInstant(), event }
    run.frames.push(frame)
    for (const sub of [...run.subs]) sub(frame)
  }

  /** The send's refusals and checks, in the design's order (4.3). Null when the send may go on. */
  sendRefusal(input: ChatSendInput): Promise<never> | null {
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(input.clientTurnKey)) return this.h.rejected(INVALID, 'The send needs a key of 8 to 64 letters, numbers, _ or -.', true)
    if (!input.text.trim()) return this.h.rejected(INVALID, 'There is nothing to send.', true)
    if ((input.attachments?.length ?? 0) > 10) return this.h.rejected(INVALID, 'A message takes at most 10 files.', true, { reason: REASON.tooMany })
    if (!models.some(m => m.id === input.model)) return this.h.rejected(INVALID, `"${input.model}" isn't a model.`, true)
    // The run whose answer this one replaces is a run id (`r_` and 22 characters): a turn id, an empty string or anything else is refused, as the server's schema does.
    if (input.replacesRun !== undefined && !/^r_[A-Za-z0-9_-]{22}$/.test(input.replacesRun)) return this.h.rejected(INVALID, 'replacesRun is not a run id.', true)
    return null
  }

  send(chatId: string, input: ChatSendInput): Promise<SendTurnResult> {
    if (!this.h.knownChat(chatId) || this.h.state.chatDeleted[chatId]) return this.h.rejected(NOT_FOUND, "That chat isn't available. It may have been deleted.", true)
    const bad = this.sendRefusal(input)
    if (bad) return bad
    // The same key and payload answers the same turn; the same key with another payload is refused. Checked before any other rule.
    const hash = JSON.stringify([input.text, input.quote ?? null, input.priority ?? 'next', input.model, input.replacesRun ?? null, input.attachments ?? []])
    const keyed = this.sendKeys.get(`${chatId}/${input.clientTurnKey}`)
    if (keyed) return keyed.hash === hash ? Promise.resolve(keyed.result) : this.h.rejected(CONFLICT, 'That key was already used for another message.', true, { reason: REASON.keyReused })
    if (this.h.state.paused !== null) return this.h.rejected(FORBIDDEN, 'Your Inhouse agent is paused.', true, { reason: REASON.paused })
    if (this.damaged.has(chatId)) return this.h.rejected(CONFLICT, "This chat's memory couldn't be saved. Start it fresh to go on.", true, { reason: REASON.sessionDamaged })
    const live = [...this.h.mockRuns.values()].find(r => r.live && r.chatId === chatId)
    const waiting = [...this.h.mockRuns.values()].flatMap(r => r.turns).filter(t => t.chatId === chatId && t.state === 'queued').length
    if (waiting >= 10) return this.h.rejected(RATE_LIMITED, 'Too many messages are waiting in this chat.', true, { reason: REASON.queueFull })
    const priority = input.priority ?? 'next'
    const run: MockRun = live ?? { runId: this.id22('r'), chatId, frames: [], live: true, turns: [], subs: new Set() }
    const turn: MockTurn = {
      turnId: this.id22('t'), runId: run.runId, chatId, input: { ...input, priority }, ord: ++this.idSeq, queuedAt: this.nowInstant(), state: 'queued',
      interrupt: new AbortController(), hard: new AbortController(),
    }
    const hasActiveJob = [...this.activeJobRuns.values()].some(e => e.run === run)
    const result: SendTurnResult = { runId: run.runId, turnId: turn.turnId, messageId: `${turn.turnId}.u`, position: live && (run.turns.some(t => t.state !== 'ended') || hasActiveJob) ? 'queued' : 'starting' }
    this.sendKeys.set(`${chatId}/${input.clientTurnKey}`, { hash, result })
    this.turnsById.set(turn.turnId, turn)
    run.turns.push(turn)
    if (!live) {
      this.h.mockRuns.set(run.runId, run)
      this.emit(run, { type: 'run.started', runId: run.runId, chatId })
    }
    this.emit(run, {
      type: 'turn.queued', turnId: turn.turnId, messageId: result.messageId, text: input.text, ...(input.quote !== undefined ? { quote: input.quote } : {}),
      attachments: input.attachments ?? [], priority, by: this.h.k.ME_ID,
    })
    if (!live) void this.drive(run)
    // `now` ends the live turn (or wakes a job between continuation steps) and goes next; it never cancels a running job (issue 677).
    else if (priority === 'now') {
      const liveTurn = run.turns.find(t => t.state === 'live')
      if (liveTurn) {
        liveTurn.cutByMessage = true
        liveTurn.interrupt.abort()
      } else {
        for (const entry of this.activeJobRuns.values()) {
          if (entry.run === run) entry.wakeNow?.abort()
        }
      }
    }
    return Promise.resolve(result)
  }

  rank = (t: MockTurn) => ({ now: 0, next: 1, later: 2 }[t.input.priority ?? 'next'])
  pickNext(run: MockRun): MockTurn | undefined {
    return run.turns.filter(t => t.state === 'queued').sort((a, b) => this.rank(a) - this.rank(b) || a.ord - b.ord)[0]
  }

  /** A turn that never ran: out of the queue, with the reason. */
  cancel(run: MockRun, turn: MockTurn, why: Extract<ChatEvent, { type: 'turn.cancelled' }>['why']) {
    if (turn.state === 'ended') return
    turn.state = 'ended'
    turn.hard.abort()
    this.emit(run, { type: 'turn.cancelled', turnId: turn.turnId, why })
    // The question is kept in the chat's history, as the server's D1 keeps it.
    this.project(run, turn, [], { trace: 'generic' }, turn.input.model)
  }

  async drive(run: MockRun) {
    const myEpoch = this.epoch
    const began = Date.now()
    let count = 0
    try {
      while (this.epoch === myEpoch) {
        const turn = this.pickNext(run)
        if (!turn) break
        if (await this.runTurn(run, turn)) count++
      }
    } finally {
      if (this.epoch === myEpoch) {
        // Over the moment nothing waits: a message sent after this starts a run of its own.
        run.live = false
        const last = [...run.turns].reverse().find(t => this.h.traceOf(t.turnId))
        const t = last ? this.h.traceOf(last.turnId) : null
        this.emit(run, { type: 'run.finished', runId: run.runId, turns: count, durationMs: t?.durationMs ?? Date.now() - began, cost: t?.cost ?? { minor: 0, currency: 'USD' } })
      }
    }
  }

  /** Waits `ms` of demo time, or until the turn (or an extra abort signal) ends early. */
  pause_(ms: number, turn: MockTurn, extra?: AbortSignal | AbortSignal[]): Promise<void> {
    return new Promise<void>(resolve => {
      const extras = extra ? (Array.isArray(extra) ? extra : [extra]) : []
      const signals = [turn.interrupt.signal, turn.hard.signal, ...extras]
      if (signals.some(x => x.aborted)) { resolve(); return }
      let t: ReturnType<typeof setTimeout> | undefined = undefined
      const done = () => { clearTimeout(t); signals.forEach(x => x.removeEventListener('abort', done)); resolve() }
      t = setTimeout(done, ms)
      signals.forEach(x => x.addEventListener('abort', done, { once: true }))
    })
  }

  finish(run: MockRun, turn: MockTurn, outcome: 'done' | 'interrupted' | 'stopped' | 'failed', reason?: TurnFailure) {
    turn.state = 'ended'
    this.emit(run, { type: 'turn.finished', turnId: turn.turnId, outcome, ...(reason ? { reason } : {}) })
  }

  /** Ends a running live job run immediately when the user clicks Cancel job. */
  cancelJobRun(ended: Job) {
    const entry = this.activeJobRuns.get(ended.jobId)
    if (!entry) return
    this.activeJobRuns.delete(ended.jobId)
    entry.controller.abort()
    if (entry.contTurn && entry.contTurn.state === 'live') {
      this.finish(entry.run, entry.contTurn, 'stopped')
    }
    const durationMs = ended.endedAt ? Math.max(0, ended.endedAt.ms - ended.startedAt.ms) : 0
    this.emit(entry.run, { type: 'job.ended', jobId: ended.jobId, outcome: ended.outcome ?? ('cancelled' as JobOutcome), durationMs, cost: ended.cost ?? { minor: 0, currency: 'USD' } })
  }

  /** What the server stores once the turn ends (D1): the question (or server carry-on note) and the parts that were written. */
  project(run: MockRun, turn: MockTurn, parts: { messageId: string; part: MessagePart; at: Instant }[], info: RunInfo, model: string, asEvent = false) {
    const list = this.h.history.get(turn.chatId) ?? []
    let pos = this.seedMessages(turn.chatId).length + (this.h.loadedJobs()?.messages(turn.chatId).length ?? 0) + (this.h.loadedActions()?.messages(turn.chatId).length ?? 0) + list.length
    const atts = turn.input.attachments?.map(a => ({ name: a.name, meta: '', icon: 'description', fileId: a.fileId }))
    const user: StoredMessage = asEvent
      ? { id: `${turn.turnId}.u`, role: 'event', text: turn.input.text, turnId: turn.turnId, runId: run.runId, pos: pos++, at: turn.queuedAt }
      : {
          id: `${turn.turnId}.u`, role: 'user', text: turn.input.text, ...(turn.input.quote !== undefined ? { quote: turn.input.quote } : {}), ...(atts?.length ? { atts } : {}),
          turnId: turn.turnId, runId: run.runId, pos: pos++, at: turn.queuedAt,
        }
    const answers = parts.map((p): StoredMessage => ({ id: p.messageId, role: 'agent', part: p.part, trace: turn.turnId, model, at: p.at, turnId: turn.turnId, runId: run.runId, pos: pos++ }))
    this.h.history.set(turn.chatId, [...list, user, ...answers])
    void info
  }

  /** Runs one turn to its end. True when it started (a cancelled one didn't). */
  async runTurn(run: MockRun, turn: MockTurn): Promise<boolean> {
    const myEpoch = this.epoch
    const { input } = turn
    // At the cap a chat turn is refused the way a scripted capReached turn is (decision L-A8). Same test as Usage's capStatus:
    // the Monthly cap typed in Settings, else the scenario's; the data's own answer when it judged that cap, else spend against it.
    const { usage } = this.h.read()
    const typed = dollarsIn(this.h.state.settings['s:cap'])
    const cap = typed === null ? usage.cap : moneyOf(typed, usage.cap.currency)
    const atCap = usage.capReached !== undefined && usage.cap.minor === cap.minor ? usage.capReached : usage.total.minor >= cap.minor
    const forced = atCap ? 'capReached' : this.h.scripted
    this.h.scripted = null
    if (this.h.k.chats.find(c => c.id === turn.chatId)?.turns.length === 0) {
      await this.keepLoaded(turn.chatId)
      if (this.epoch !== myEpoch) return false
    }
    if (forced === 'capReached') {
      this.emit(run, { type: 'notice', code: NOTICE.capReached })
      this.finish(run, turn, 'failed', FAIL.capReached)
      this.project(run, turn, [], { trace: 'generic' }, input.model)
      return false
    }
    if (forced === 'budgetBusyThenStart' || forced === 'budgetBusyThenFail') {
      // Back to waiting, not failed: it tries again every 15 s, and gives up after 2 minutes.
      this.emit(run, { type: 'notice', code: NOTICE.budgetBusy })
      await this.pause_(forced === 'budgetBusyThenStart' ? 15_000 : 120_000, turn)
      if (this.epoch !== myEpoch || turn.state === 'ended') return false
      if (forced === 'budgetBusyThenFail') { this.finish(run, turn, 'failed', FAIL.budgetBusy); this.project(run, turn, [], { trace: 'generic' }, input.model); return false }
    }
    turn.state = 'live'
    this.emit(run, { type: 'turn.started', turnId: turn.turnId, model: input.model })
    const jobs = this.h.loadedJobs()
    const existingJob = jobs?.job(turn.chatId) ?? null
    const liveJob = existingJob && existingJob.state !== 'ended' ? existingJob : null
    const seededFollowUp = jobs?.seededReply(turn.chatId, input.text.trim(), Boolean(liveJob)) ?? null
    const s: Script = seededFollowUp
      ? {
          thinking: seededFollowUp.isFollowUp ? ['Checking audit progress…'] : ['Checking your tools…', 'Writing the answer…'],
          delayMs: this.h.k.THINKING_STEP_MS,
          trace: this.h.k.traceKey(seededFollowUp.trace),
          parts: seededFollowUp.parts,
        }
      : buildScript(this.h as unknown as ScriptHost, input.text.trim(), turn.chatId)
    let info: RunInfo = { trace: s.trace }
    this.h.saveRunInfo(turn.turnId, info)
    let stepN = 0
    const step = (label: string) => this.emit(run, { type: 'step', turnId: turn.turnId, stepId: `${turn.turnId}.s${stepN++}`, label })
    const ended = () => this.epoch !== myEpoch || turn.interrupt.signal.aborted || turn.hard.signal.aborted
    step('Reading your question…')
    let elapsed = 0, i = 0
    while (elapsed < s.delayMs && !ended()) {
      const slice = Math.min(this.h.k.THINKING_STEP_MS, s.delayMs - elapsed)
      await this.pause_(slice, turn)
      if (this.epoch !== myEpoch) return false
      if (ended()) break
      elapsed += slice
      if (elapsed < s.delayMs) step(s.thinking[Math.min(i++, s.thinking.length - 1)])
    }
    if (this.epoch !== myEpoch) return false
    const written: { messageId: string; part: MessagePart; at: Instant }[] = []
    let carryOn: { progressLabel: string; progressSteps?: { label: string; helpers: number }[]; carryOnText: string; trace: TraceKey } | null = null
    if (!ended()) {
      if (forced === 'crash') { this.finish(run, turn, 'failed', FAIL.sessionCrashed); this.project(run, turn, written, info, input.model); return true }
      const replaces = input.replacesRun
      const personQueued = run.turns.some(t => t.state === 'queued' && t.turnId !== turn.turnId)
      const canPromote = !liveJob && !personQueued && this.h.state.paused === null && !this.h.state.chatDeleted[turn.chatId]
      const scriptedLimit = forced === 'turnBudget' || forced === 'maxTurns'
      const isLongTask = !forced && Boolean(s.longJob)
      const promoted = scriptedLimit && canPromote
      const autoLong = isLongTask && canPromote
      // A routine or skill the answer makes is saved as its card appears, so its id comes from what is saved at that moment.
      const chosen = (promoted || isLongTask) ? s.parts.slice(0, 1) : s.parts
      let n = 0
      for (const part of chosen) {
        const out = part.type === 'routine' && part.routine.id === '' ? this.h.saveRoutine(part, replaces, info) : part
        const at = this.nowInstant()
        written.push({ messageId: `${turn.turnId}.${n++}`, part: out, at })
        this.emit(run, { type: 'part', turnId: turn.turnId, messageId: `${turn.turnId}.${n - 1}`, part: out, model: input.model, at })
      }
      if (!promoted && !isLongTask) s.after?.(info, replaces)
      const failed = s.parts.some(x => x.type === 'error')
      // An answer that failed replaces nothing: what the earlier run made stays, and this run carries it on, so the next
      // answer in the chain (Try again, or Regenerate of the error) updates it instead of making a second.
      if (replaces && !failed) this.h.takeBack(replaces, info)
      const was = replaces && failed ? this.h.runInfo.get(replaces) : undefined
      if (was) { info.kept = was.routine ?? was.kept; info.skill = was.skill }
      this.h.saveRunInfo(turn.turnId, info)
      if (!run.info || info.routine || info.skill) { run.info = info; this.h.saveRunInfo(run.runId, info) }
      if (forced === 'turnBudget') this.finish(run, turn, 'failed', FAIL.turnBudget)
      else if (forced === 'maxTurns' || isLongTask) this.finish(run, turn, 'failed', FAIL.maxTurns)
      else this.finish(run, turn, 'done')
      if (forced === 'sessionDamaged') { this.damaged.add(turn.chatId); this.emit(run, { type: 'notice', code: NOTICE.sessionDamaged }) }
      if (promoted) {
        carryOn = {
          progressLabel: 'Analyzing orders and SKU fulfillment across Shopify and ShipBob',
          progressSteps: [
            { label: 'Cross-checking SKU stock across warehouses', helpers: 1 },
            { label: 'Verifying open order fulfillment status', helpers: 0 },
          ],
          carryOnText: 'Finished checking every SKU and fulfillment log across the remaining orders. Nothing else exceeded the 3-day threshold.',
          trace: this.h.k.traceKey('long-job-run'),
        }
      } else if (autoLong && s.longJob) {
        carryOn = s.longJob
      }
    } else {
      this.finish(run, turn, turn.hard.signal.aborted ? 'stopped' : 'interrupted')
    }
    this.project(run, turn, written, info, input.model)
    // Re-read the live job after streaming/pause so a cancel during a follow-up never emits a stale job.progress (issue 643).
    const currentJob = liveJob ? jobs?.job(turn.chatId) ?? null : null
    if (currentJob && currentJob.jobId === liveJob!.jobId && currentJob.state !== 'ended' && !ended()) {
      this.emit(run, {
        type: 'job.progress', jobId: currentJob.jobId,
        label: currentJob.progress?.label ?? 'Working on a long job', helpers: currentJob.progress?.helpers ?? 0,
      })
    }
    if (carryOn && !ended() && this.h.state.paused === null && !this.h.state.chatDeleted[turn.chatId]) {
      await this.driveLongJob(run, turn, carryOn, input.model)
      if (this.epoch !== myEpoch) return false
    }
    info = { trace: info.trace }
    return true
  }

  private async driveLongJob(
    run: MockRun,
    rootTurn: MockTurn,
    plan: { progressLabel: string; progressSteps?: { label: string; helpers: number }[]; carryOnText: string; trace: TraceKey },
    model: string,
  ) {
    const myEpoch = this.epoch
    const jobs = await this.h.loadJobs()
    if (this.epoch !== myEpoch || rootTurn.hard.signal.aborted || rootTurn.interrupt.signal.aborted || this.h.state.paused !== null || this.h.state.chatDeleted[run.chatId]) return
    const { job, controller } = jobs.startJob(run.chatId, rootTurn.turnId, plan.progressLabel, 2)
    const active: { run: MockRun; controller: AbortController; contTurn?: MockTurn; wakeNow?: AbortController; fenced?: 'paused' | 'deleted' | 'reset' } = { run, controller }
    this.activeJobRuns.set(job.jobId, active)
    this.emit(run, { type: 'job.started', jobId: job.jobId, rootTurnId: rootTurn.turnId })
    this.emit(run, { type: 'job.progress', jobId: job.jobId, label: plan.progressLabel, helpers: 2 })

    const steps = plan.progressSteps ?? DEFAULT_PROGRESS_STEPS
    let stepIdx = 0
    let gapRemaining = 4_000
    let needsGap = true
    const fencedAs = (): 'paused' | 'deleted' | 'reset' | undefined => active.fenced
    const isReset = () => this.epoch !== myEpoch || fencedAs() === 'reset'
    const drainNow = async () => {
      while (true) {
        if (isReset() || fencedAs() || controller.signal.aborted || this.h.state.paused !== null || this.h.state.chatDeleted[run.chatId]) break
        const urgent = run.turns.find(t => t.state === 'queued' && t.input.priority === 'now')
        if (!urgent) break
        await this.runTurn(run, urgent)
      }
    }

    try {
      while (true) {
        if (needsGap) {
          const wake = new AbortController()
          active.wakeNow = wake
          const t0 = Date.now()
          await this.pause_(gapRemaining, rootTurn, [controller.signal, wake.signal])
          active.wakeNow = undefined
          gapRemaining = Math.max(0, gapRemaining - (Date.now() - t0))
          if (isReset()) return
          if (fencedAs() === 'deleted' || this.h.state.chatDeleted[run.chatId]) {
            const ended = jobs.endJob(run.chatId, job.jobId, 'cancelled', 20)
            if (ended) this.emit(run, { type: 'job.ended', jobId: job.jobId, outcome: 'cancelled', durationMs: 0, cost: ended.cost ?? { minor: 0, currency: 'USD' } })
            return
          }
          if (rootTurn.hard.signal.aborted || this.h.state.paused !== null || fencedAs() === 'paused') {
            const ended = jobs.endJob(run.chatId, job.jobId, 'cancelled', 20)
            if (ended) this.emit(run, { type: 'job.ended', jobId: job.jobId, outcome: 'cancelled', durationMs: 0, cost: ended.cost ?? { minor: 0, currency: 'USD' } })
            return
          }
          if (controller.signal.aborted) return
          if (wake.signal.aborted) {
            await drainNow()
            if (isReset()) return
            if (fencedAs() === 'deleted' || this.h.state.chatDeleted[run.chatId]) {
              const ended = jobs.endJob(run.chatId, job.jobId, 'cancelled', 20)
              if (ended) this.emit(run, { type: 'job.ended', jobId: job.jobId, outcome: 'cancelled', durationMs: Math.max(0, ended.endedAt!.ms - ended.startedAt.ms), cost: ended.cost ?? { minor: 0, currency: 'USD' } })
              return
            }
            if (fencedAs() === 'paused' || this.h.state.paused !== null) {
              const ended = jobs.endJob(run.chatId, job.jobId, 'cancelled', 20)
              if (ended) this.emit(run, { type: 'job.ended', jobId: job.jobId, outcome: 'cancelled', durationMs: Math.max(0, ended.endedAt!.ms - ended.startedAt.ms), cost: ended.cost ?? { minor: 0, currency: 'USD' } })
              return
            }
            if (controller.signal.aborted) return
            if (gapRemaining > 0) continue
          }
          needsGap = false
        }

        const contTurnId = this.id22('t')
        const contTurn: MockTurn = {
          turnId: contTurnId, runId: run.runId, chatId: run.chatId,
          input: { clientTurnKey: `job-${contTurnId.slice(2, 16)}`, text: JOB_CARRIED_ON_TEXT, model, priority: 'next' },
          ord: ++this.idSeq, queuedAt: this.nowInstant(), state: 'live',
          interrupt: new AbortController(), hard: new AbortController(),
        }
        active.contTurn = contTurn
        this.turnsById.set(contTurnId, contTurn)
        run.turns.push(contTurn)
        this.h.saveRunInfo(contTurnId, { trace: plan.trace })
        this.emit(run, {
          type: 'turn.queued', turnId: contTurnId, messageId: `${contTurnId}.u`, text: JOB_CARRIED_ON_TEXT,
          attachments: [], priority: 'next', by: this.h.k.ME_ID, source: 'job',
        })
        this.emit(run, { type: 'turn.started', turnId: contTurnId, model })
        let sN = 0
        const step = (label: string) => this.emit(run, { type: 'step', turnId: contTurnId, stepId: `${contTurnId}.s${sN++}`, label })
        const contAborted = () => isReset() || controller.signal.aborted || contTurn.interrupt.signal.aborted || contTurn.hard.signal.aborted || this.h.state.paused !== null || Boolean(this.h.state.chatDeleted[run.chatId])
        if (stepIdx === 0) {
          step('Asking a helper')
          step(plan.progressLabel)
          await this.pause_(6_000, contTurn, controller.signal)
        } else {
          step(steps[Math.min(stepIdx - 1, steps.length - 1)]!.label)
          if (stepIdx >= steps.length) await this.pause_(4_000, contTurn, controller.signal)
        }
        while (stepIdx < steps.length) {
          if (contAborted()) break
          const next = steps[stepIdx]!
          jobs.updateProgress(run.chatId, job.jobId, next.label, next.helpers)
          this.emit(run, { type: 'job.progress', jobId: job.jobId, label: next.label, helpers: next.helpers })
          step(next.label)
          stepIdx++
          await this.pause_(7_000, contTurn, controller.signal)
          if (contAborted()) break
        }
        active.contTurn = undefined
        if (isReset()) return
        if (fencedAs() === 'deleted' || this.h.state.chatDeleted[run.chatId]) {
          if (contTurn.state === 'live') this.finish(run, contTurn, 'stopped')
          this.project(run, contTurn, [], { trace: plan.trace }, model, true)
          const ended = jobs.endJob(run.chatId, job.jobId, 'cancelled', 40)
          if (ended) this.emit(run, { type: 'job.ended', jobId: job.jobId, outcome: 'cancelled', durationMs: Math.max(0, ended.endedAt!.ms - ended.startedAt.ms), cost: ended.cost ?? { minor: 0, currency: 'USD' } })
          return
        }
        if (fencedAs() === 'paused' || contTurn.hard.signal.aborted || this.h.state.paused !== null) {
          if (contTurn.state === 'live') this.finish(run, contTurn, 'stopped')
          this.project(run, contTurn, [], { trace: plan.trace }, model, true)
          const ended = jobs.endJob(run.chatId, job.jobId, 'cancelled', 40)
          if (ended) this.emit(run, { type: 'job.ended', jobId: job.jobId, outcome: 'cancelled', durationMs: Math.max(0, ended.endedAt!.ms - ended.startedAt.ms), cost: ended.cost ?? { minor: 0, currency: 'USD' } })
          return
        }
        if (controller.signal.aborted) {
          // cancelJobRun already finished contTurn (if live) and emitted job.ended; project the carry-on note cleanly.
          if (contTurn.state === 'ended') this.project(run, contTurn, [], { trace: plan.trace }, model, true)
          return
        }
        if (contTurn.interrupt.signal.aborted) {
          if (contTurn.cutByMessage) {
            this.finish(run, contTurn, 'interrupted')
            this.project(run, contTurn, [], { trace: plan.trace }, model, true)
            await drainNow()
            if (isReset()) return
            if (fencedAs() === 'deleted' || this.h.state.chatDeleted[run.chatId]) {
              const ended = jobs.endJob(run.chatId, job.jobId, 'cancelled', 40)
              if (ended) this.emit(run, { type: 'job.ended', jobId: job.jobId, outcome: 'cancelled', durationMs: Math.max(0, ended.endedAt!.ms - ended.startedAt.ms), cost: ended.cost ?? { minor: 0, currency: 'USD' } })
              return
            }
            if (fencedAs() === 'paused' || this.h.state.paused !== null) {
              const ended = jobs.endJob(run.chatId, job.jobId, 'cancelled', 40)
              if (ended) this.emit(run, { type: 'job.ended', jobId: job.jobId, outcome: 'cancelled', durationMs: Math.max(0, ended.endedAt!.ms - ended.startedAt.ms), cost: ended.cost ?? { minor: 0, currency: 'USD' } })
              return
            }
            if (controller.signal.aborted) return
            continue
          }
          const ended = jobs.endJob(run.chatId, job.jobId, 'cancelled', 40)
          if (ended) this.emit(run, { type: 'job.ended', jobId: job.jobId, outcome: 'cancelled', durationMs: Math.max(0, ended.endedAt!.ms - ended.startedAt.ms), cost: ended.cost ?? { minor: 0, currency: 'USD' } })
          this.finish(run, contTurn, 'interrupted')
          this.project(run, contTurn, [], { trace: plan.trace }, model, true)
          return
        }
        const jobCapDollars = dollarsIn(this.h.state.settings['s:job_cap'])
        const jobCapMinor = jobCapDollars === null ? null : Math.round(jobCapDollars * 100)
        if (jobCapMinor !== null && jobCapMinor <= LIVE_JOB_COST_MINOR) {
          this.finish(run, contTurn, 'done')
          this.project(run, contTurn, [], { trace: plan.trace }, model, true)
          const ended = jobs.endJob(run.chatId, job.jobId, 'budget', jobCapMinor)
          if (ended) this.emit(run, { type: 'job.ended', jobId: job.jobId, outcome: 'budget', durationMs: Math.max(0, ended.endedAt!.ms - ended.startedAt.ms), cost: ended.cost ?? { minor: 0, currency: 'USD' } })
          return
        }
        const at = this.nowInstant()
        const part: MessagePart = { type: 'text', text: plan.carryOnText }
        const msgId = `${contTurnId}.0`
        this.emit(run, { type: 'part', turnId: contTurnId, messageId: msgId, part, model, at })
        this.finish(run, contTurn, 'done')
        this.project(run, contTurn, [{ messageId: msgId, part, at }], { trace: plan.trace }, model, true)
        const ended = jobs.endJob(run.chatId, job.jobId, 'done', LIVE_JOB_COST_MINOR)
        if (ended) this.emit(run, { type: 'job.ended', jobId: job.jobId, outcome: 'done', durationMs: Math.max(0, ended.endedAt!.ms - ended.startedAt.ms), cost: ended.cost ?? { minor: 0, currency: 'USD' } })
        return
      }
    } finally {
      if (!isReset()) this.activeJobRuns.delete(job.jobId)
    }
  }

  interrupt(turnId: string): Promise<void> { return this.endTurn(turnId, 'interrupt') }
  stop(turnId: string): Promise<void> { return this.endTurn(turnId, 'hard') }
  endTurn(turnId: string, how: 'interrupt' | 'hard'): Promise<void> {
    const turn = this.turnsById.get(turnId)
    const run = turn && this.h.mockRuns.get(turn.runId)
    if (!turn || !run) return this.h.rejected(NOT_FOUND, 'That answer is not here.', true)
    if (turn.state === 'ended') return this.h.rejected(CONFLICT, this.h.k.FINISHED, true, { reason: REASON.turnEnded })
    if (turn.state === 'queued') this.cancel(run, turn, 'removed')
    else (how === 'interrupt' ? turn.interrupt : turn.hard).abort()
    return Promise.resolve()
  }

  activeRuns(): Promise<ActiveRun[]> {
    return Promise.resolve([...this.h.mockRuns.values()].filter(r => r.live).map(r => ({ runId: r.runId, chatId: r.chatId, lastSeq: r.frames.length, live: true })))
  }

  attach(runId: string, onFrame: (f: RunFrame) => void, fromSeq = 0, onRefused?: (code: AgentErrorCode) => void): () => void {
    const run = this.h.mockRuns.get(runId)
    // A run nobody here knows is refused, as the server's socket answers `refused`.
    if (!run) { onRefused?.(NOT_FOUND); return () => undefined }
    // The replay and the subscription are one step: nothing sent in between is missed or sent twice.
    for (const f of run.frames) if (f.seq > fromSeq) onFrame(f)
    run.subs.add(onFrame)
    return () => { run.subs.delete(onFrame) }
  }

  activeJobChatIds(): Set<string> {
    return new Set([...this.activeJobRuns.values()].map(e => e.run.chatId))
  }

  /** Everything live ends: queued turns are cancelled with `why`, live ones are stopped (pause, delete). */
  fence(match: (run: MockRun) => boolean, why: 'paused' | 'deleted') {
    for (const run of this.h.mockRuns.values()) {
      if (!run.live || !match(run)) continue
      if (why === 'paused') this.emit(run, { type: 'notice', code: 'paused' })
      for (const t of run.turns) {
        if (t.state === 'queued') this.cancel(run, t, why)
        else if (t.state === 'live') t.hard.abort()
      }
      for (const entry of this.activeJobRuns.values()) {
        if (entry.run === run) {
          entry.fenced = why
          entry.controller.abort()
        }
      }
    }
  }

}
