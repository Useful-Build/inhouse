// The session process's run loop, without the SDK: the SDK's `query` comes in as a parameter, so tests drive this with a
// mocked query at the process boundary. src/session/main.ts loads the real SDK and calls this.
//
// One session process runs one run: it says `ready`, takes one `run` message and then:
//   1. brings the chat's files into the work folder (`inputs/`, `outputs/`; src/files/), up to the restore cap;
//   2. runs one `query()` with the session store adapter (src/store/), streaming every SDK message back as an `sdk`
//      event. A prompt goes in as a one-message stream, so `interrupt()` works (it needs streaming input); the `""`
//      resume after a deferred call's answer stays a plain string (P0 S1: an empty stream left the deferred tool
//      unavailable), and an interrupt there falls back to the abort signal;
//   3. at the end: the deferred call, if the run deferred one (with the runner's own one-call check), then the new and
//      changed files under `outputs/`, then the store's checkpoint and repair (`checkpoint`, or `mirror_error`), then
//      exactly one terminal event (`finished` or `failed`). After a stop the checkpoint goes first and the files after
//      it, if time allows: the stop's `endWithinMs` is the end phase's deadline, so the run keeps its checkpoint, cost
//      and a deferred call's waiting state before the root's grace runs out.
// It also carries R2's blocking audit hook: `audit(entry)` resolves once the root has the entry on the Worker's stream.
import type { Options, Query, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { AuditEntry, DEFERRED_INPUT_MAX_BYTES, SDK_MESSAGE_MAX_BYTES, jsonBytes } from '../../../shared/protocol/index.ts'
import { createFiles, snapshotOutputs } from '../files/files.ts'
import { RootMessage, capSdkMessage, monotonicMs, type RunConfig, type SessionEvent } from '../protocol/local.ts'
import { LOCAL_MAX_DEPTH, deeperThan, type LineResult } from '../protocol/ndjson.ts'
import { createStoreAdapter, type Fetch } from '../store/adapter.ts'
import type { QueryGuards } from './seam.ts'

export type QueryFn = (params: { prompt: string | AsyncIterable<SDKUserMessage>; options: Options }) => Pick<Query, 'interrupt'> & AsyncIterable<SDKMessage>

/** The session's side of the local channel (src/session/channel.ts in production). */
export type SessionChannel = {
  /** A promise means the channel is full: the run loop reads no more SDK messages until it settles. */
  send(message: unknown): void | Promise<void>
  /** Each line from the root, parsed, or the framing error (oversized, not JSON) that ends the run. */
  onMessage(handler: (line: LineResult) => void): void
  /** The root's side has closed: nothing more will come. */
  onClose?(handler: () => void): void
}

/** Calls to the root's loopback proxy (the store and files routes). */
export type SessionIo = { fetch: Fetch; proxyUrl: string }

/**
 * How the SDK flushes the transcript to the store. `'eager'` (alpha): in test/store/eager.test.ts (the real CLI, a hard
 * kill while the next model call is held), the live turn reached the store shortly after the CLI wrote it, where
 * `'batched'` didn't. That's what was shown, not a guarantee: the checkpoint and repair stay as the backstop.
 */
export const STORE_FLUSH: NonNullable<Options['sessionStoreFlush']> = 'eager'

/** How long an audit entry may wait for the root's ack before the hook's call is refused. */
export const AUDIT_TIMEOUT_MS = 10_000
/** The part of the audit timeout kept for the ack's way back: the root takes an entry only before the rest has passed. */
export const AUDIT_ACK_MARGIN_MS = 2_000

/** Env names the session process must not hand to the CLI. There's no Node IPC channel any more; the filter stays. */
const NOT_FOR_THE_CLI = /^NODE_CHANNEL_/

export function cliEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(env)) if (v !== undefined && !NOT_FOR_THE_CLI.test(k)) out[k] = v
  return out
}

/** The `inhouse` MCP server's name (R2's guard allows only it). */
export const INHOUSE_SERVER = 'inhouse'

/** Compaction (Wasim, item 22 E2): the 1M window, compacted at 600,000 tokens, below the gate's 650,000 refusal. */
export const AUTO_COMPACT_WINDOW = 600_000

/**
 * The engine's model settings for a run (Claude Code's env-vars page, read 2026-11-20). Every alias resolves to a model
 * the egress allows (the run's `model` or `sideModel`): `ANTHROPIC_DEFAULT_HAIKU_MODEL` is the `haiku` alias and the
 * background model; subagents run on the turn's model (`CLAUDE_CODE_SUBAGENT_MODEL`, forced so a model Claude names
 * when it spawns one doesn't win); the `sonnet`, `opus` and `fable` aliases resolve to the turn's model too.
 * `CLAUDE_CODE_AUTO_COMPACT_WINDOW` sets how full the context gets before compaction (no `CLAUDE_CODE_DISABLE_1M_CONTEXT`:
 * the 1M window stays). It binds subagents too: the subagents page (read 2026-11-20) says a subagent uses the lowest of
 * its own `autoCompactWindow`, the model's window and the window this variable sets. A per-subagent value can only
 * lower that, and would need custom agent definitions, which R2's guard refuses (`agents` is a guarded option), so
 * none is set. The CLI's own concurrency
 * (parallel subagents) isn't limited here: the Worker's gate holds a turn to 4 model calls in flight.
 */
export function modelEnv(config: Pick<RunConfig, 'model' | 'sideModel'>): Record<string, string> {
  return {
    ANTHROPIC_DEFAULT_HAIKU_MODEL: config.sideModel,
    ANTHROPIC_DEFAULT_SONNET_MODEL: config.model,
    ANTHROPIC_DEFAULT_OPUS_MODEL: config.model,
    ANTHROPIC_DEFAULT_FABLE_MODEL: config.model,
    CLAUDE_CODE_SUBAGENT_MODEL: config.model,
    CLAUDE_CODE_SUBAGENT_MODEL_FORCE: '1',
    CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(AUTO_COMPACT_WINDOW),
  }
}

export function baseOptions(config: RunConfig, cwd: string, env: Record<string, string>, abortController: AbortController, sessionStore?: Options['sessionStore']): Options {
  // The `inhouse` server goes through the root's proxy (sessionEnv() always sets INHOUSE_PROXY_URL; a bare test env
  // without it gets no server).
  const proxy = env.INHOUSE_PROXY_URL
  return {
    cwd,
    env: { ...env, ...modelEnv(config) },
    abortController,
    systemPrompt: config.systemPrompt,
    ...(proxy ? { mcpServers: { [INHOUSE_SERVER]: { type: 'http', url: `${proxy.replace(/\/$/, '')}/mcp/` } } } : {}),
    model: config.model,
    effort: config.effort,
    maxTurns: config.maxTurns,
    maxBudgetUsd: config.maxBudgetUsd,
    settingSources: [],
    // The SDK's own CLI spawn and MCP delivery: the CLI gets fresh stdio pipes, so it never holds the local channel
    // (src/session/channel.ts), and the SDK reads its stderr as usual.
    ...(config.resume ? { resume: config.sessionId } : { sessionId: config.sessionId }),
    ...(sessionStore ? { sessionStore, sessionStoreFlush: STORE_FLUSH } : {}),
  }
}

/** The prompt as a one-message stream, held open until `done` settles (the SDK ends the run when its input ends). */
export function streamingPrompt(text: string, done: Promise<void>): AsyncIterable<SDKUserMessage> {
  return (async function* () {
    yield { type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null }
    await done
  })()
}

/** The most characters of file names in the note on what was left out; past it the note says how many more. */
export const LEFT_OUT_NOTE_MAX_CHARS = 2000

/**
 * What the agent is told about the chat's files that weren't brought in (names up to a length cap). `leftOut` is every
 * name, uncapped (not the event's list, whose last name may be its "and N more").
 */
export function leftOutNote(leftOut: string[]): string {
  const shown: string[] = []
  let chars = 0
  for (const name of leftOut) {
    if (chars + name.length > LEFT_OUT_NOTE_MAX_CHARS) break
    shown.push(name)
    chars += name.length + 2
  }
  const more = leftOut.length - shown.length
  const names = more === 0 ? shown.join(', ') : `${shown.join(', ')}${shown.length > 0 ? ', ' : ''}and ${more} more`
  return `[The chat's files over the restore size cap were not brought into the work folder: ${names}]`
}

/**
 * The deepest SDK message sent whole. The root refuses a line nested past `LOCAL_MAX_DEPTH`, and the event's envelope
 * (`{type:'event', event:{type:'sdk', message}}`) adds two levels; two more are spare. A deeper message goes as a stub.
 */
export const SDK_MESSAGE_MAX_DEPTH = LOCAL_MAX_DEPTH - 4

const message = (e: unknown) => String(e instanceof Error ? e.message : e).slice(0, 2000)

type Result = Extract<SDKMessage, { type: 'result' }>

/**
 * Tool calls the model made in its current turn (since the last tool results came back), by id: the main thread's
 * only (`parent_tool_use_id === null`), not a subagent's. A deferral the CLI honoured with more than one call in the
 * turn (P0 S1 saw it, though the docs say it can't happen) leaves the others' results unknown, so the runner defers only
 * when the turn's calls are exactly the deferred one.
 */
class TurnToolUses {
  #ids = new Set<string>()
  see(m: SDKMessage) {
    if ((m as { parent_tool_use_id?: unknown }).parent_tool_use_id !== null) return
    const content = (m as { message?: { content?: unknown } }).message?.content
    if (!Array.isArray(content)) return
    if (m.type === 'user' && content.some((b) => (b as { type?: unknown })?.type === 'tool_result')) this.#ids.clear()
    if (m.type === 'assistant') for (const b of content) if ((b as { type?: unknown })?.type === 'tool_use') this.#ids.add(String((b as { id?: unknown }).id))
  }
  get count() {
    return this.#ids.size
  }
  /** The turn's calls are this one call and nothing else. */
  only(id: string) {
    return this.#ids.size === 1 && this.#ids.has(id)
  }
}

/** Resolves with `p`'s outcome, or with null once `signal` aborts (whichever comes first). Never rejects. */
function settleOrCut<T>(p: Promise<T>, signal: AbortSignal): Promise<{ value: T } | null> {
  if (signal.aborted) return Promise.resolve(null)
  return new Promise((resolve) => {
    const onAbort = () => resolve(null)
    signal.addEventListener('abort', onAbort, { once: true })
    p.then(
      (value) => (signal.removeEventListener('abort', onAbort), resolve({ value })),
      () => (signal.removeEventListener('abort', onAbort), resolve(null)),
    )
  })
}

export async function runSession(deps: {
  channel: SessionChannel
  query: QueryFn
  guards: QueryGuards
  cwd: string
  env: NodeJS.ProcessEnv
  io: SessionIo
  log?: (entry: Record<string, unknown>) => void
  auditTimeoutMs?: number
}): Promise<void> {
  const { channel } = deps
  const log = deps.log ?? ((e) => process.stderr.write(`${JSON.stringify(e)}\n`))
  let ended = false
  const emit = (event: SessionEvent): void | Promise<void> => {
    if (ended) return
    if (event.type === 'finished' || event.type === 'failed') {
      ended = true
      failAudits('the run has ended')
    }
    return channel.send({ type: 'event', event })
  }

  // ---- The audit transport (R2's blocking hook calls `audit`).
  const audits = new Map<number, { resolve: () => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>()
  let nextAudit = 0
  let channelClosed = false
  function failAudits(why: string) {
    for (const [id, a] of audits) {
      clearTimeout(a.timer)
      a.reject(new Error(`audit refused: ${why}`))
      audits.delete(id)
    }
  }
  const settleAudit = (id: number, error: string | null) => {
    const a = audits.get(id)
    if (!a) return
    audits.delete(id)
    clearTimeout(a.timer)
    if (error === null) a.resolve()
    else a.reject(new Error(`audit refused: ${error}`))
  }
  /** Resolves once the root has written the entry to the Worker's stream; rejects on a nack, a closed channel or the timeout. */
  const audit = (entry: AuditEntry): Promise<void> => {
    const parsed = AuditEntry.safeParse(entry)
    if (!parsed.success) return Promise.reject(new Error(`audit refused: ${z.prettifyError(parsed.error)}`))
    if (ended || channelClosed) return Promise.reject(new Error('audit refused: the run has ended'))
    const id = nextAudit++
    const timeout = deps.auditTimeoutMs ?? AUDIT_TIMEOUT_MS
    const expiresAt = monotonicMs() + timeout - Math.min(AUDIT_ACK_MARGIN_MS, Math.floor(timeout / 2))
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => settleAudit(id, 'no answer from the root in time'), timeout)
      audits.set(id, { resolve, reject, timer })
      void channel.send({ type: 'audit', id, expiresAt, entry: parsed.data })
    })
  }
  channel.onClose?.(() => {
    channelClosed = true
    failAudits('the channel to the root closed')
  })

  let q: ReturnType<QueryFn> | null = null
  let stopping = false
  /** Aborts when a stop arrives: a files save in the normal order gives way to the checkpoint. */
  const stopCut = new AbortController()
  /** Aborts `endWithinMs` after the stop arrived: the end phase's deadline. */
  const deadlineCut = new AbortController()
  let deadlineTimer: NodeJS.Timeout | undefined
  /** An interrupt that came before the query existed: applied as soon as it does. */
  let interruptPending = false
  const abort = new AbortController()
  let resolveRun!: (config: RunConfig) => void
  const runConfig = new Promise<RunConfig>((r) => (resolveRun = r))
  let gotRun = false
  /** Ends the streaming prompt, so the SDK ends the run once its turn is over. */
  let endInput!: () => void
  const inputDone = new Promise<void>((r) => (endInput = r))

  const halt = async () => {
    endInput()
    if (q === null) {
      interruptPending = true
      return
    }
    try {
      await q.interrupt()
    } catch {
      // interrupt() needs the streaming prompt; the `""` resume has none, so it falls back to the abort signal.
      abort.abort()
    }
  }

  channel.onMessage((line) => {
    if (!line.ok) {
      emit({ type: 'failed', reason: 'protocol', message: `unreadable line from the root: ${line.error}` })
      abort.abort()
      return
    }
    const parsed = RootMessage.safeParse(line.value)
    if (!parsed.success) {
      emit({ type: 'failed', reason: 'protocol', message: `bad message from the root: ${z.prettifyError(parsed.error)}`.slice(0, 2000) })
      abort.abort()
      return
    }
    const m = parsed.data
    if (m.type === 'run') {
      if (gotRun) {
        emit({ type: 'failed', reason: 'protocol', message: 'a second run message' })
        abort.abort()
        return
      }
      gotRun = true
      resolveRun(m.config)
    } else if (m.type === 'interrupt') {
      void halt()
    } else if (m.type === 'audit_ack') {
      settleAudit(m.id, null)
    } else if (m.type === 'audit_nack') {
      settleAudit(m.id, m.error)
    } else {
      stopping = true
      if (deadlineTimer === undefined) {
        deadlineTimer = setTimeout(() => deadlineCut.abort(), m.endWithinMs)
        deadlineTimer.unref()
      }
      stopCut.abort()
      // A stop before the run: nothing has started, so the run ends here and no query ever runs.
      if (!gotRun) {
        emit({ type: 'failed', reason: 'stopped', message: 'stopped before the run started' })
        abort.abort()
        return
      }
      void halt()
    }
  })
  channel.send({ type: 'ready' })

  /** A step before the query failed (the guards, the outputs snapshot): logged, and the run ends typed, never as a crash. */
  const setupFailed = (step: string, e: unknown) => {
    log({ type: 'session_setup_failed', step, error: message(e).slice(0, 300) })
    return emit({ type: 'failed', reason: 'sdk_error', message: 'the session could not be set up' })
  }

  const config = await Promise.race([
    runConfig,
    new Promise<null>((r) => abort.signal.addEventListener('abort', () => r(null), { once: true })),
  ])
  if (config === null || ended) return
  // A stop that came with the run (or while it was being read): end it without calling query().
  if (stopping) return emit({ type: 'failed', reason: 'stopped', message: 'stopped before the query started' })

  // 1. The guarded options, before anything touches the work folder: a guard that refuses this run ends it here, typed,
  // with the folder as the host left it.
  // A resume is checked against the Worker's `expect` on the SDK's first load of the main transcript, which comes
  // before any model call; a mismatch aborts the query and the run fails `store`.
  let resumeRefused: string | null = null
  const store = createStoreAdapter({
    fetch: deps.io.fetch,
    proxyUrl: deps.io.proxyUrl,
    expect: config.resume ? config.expect : null,
    onResumeRefused: (why) => {
      resumeRefused = why
      log({ type: 'resume_refused', why })
      abort.abort()
    },
    // `query_started` goes on the SDK's first store call, not when query() is called: until the SDK touches the store,
    // the transcript is as the last checkpoint left it, and a run that ends before that (a stop, an interrupt, an SDK
    // error before the resume's load) leaves the chat's session as it was (`released.queryRan: false`).
    onFirstCall: () => void channel.send({ type: 'query_started' }),
  })
  let options: Options
  try {
    options = deps.guards.apply(baseOptions(config, deps.cwd, cliEnv(deps.env), abort, store.store), config, { audit })
  } catch (e) {
    return setupFailed('guards', e)
  }

  // 2. The chat's files.
  const files = createFiles({ fetch: deps.io.fetch, proxyUrl: deps.io.proxyUrl, cwd: deps.cwd, caps: config.fileCaps, log })
  let leftOut: string[]
  try {
    // A stop cuts the restore at once: no query will run, and the run must end within the stop's deadline.
    const restored = await files.restore(stopCut.signal)
    leftOut = restored.leftOut
    if (restored.event.restored > 0 || restored.event.leftOut.length > 0) await emit(restored.event)
  } catch (e) {
    if (stopping) return emit({ type: 'failed', reason: 'stopped', message: 'stopped before the query started' })
    log({ type: 'files_restore_failed', error: message(e).slice(0, 300) })
    return emit({ type: 'failed', reason: 'files', message: "the chat's files could not be brought into the work folder" })
  }
  if (ended) return
  if (stopping) return emit({ type: 'failed', reason: 'stopped', message: 'stopped before the query started' })
  let before: Awaited<ReturnType<typeof snapshotOutputs>>
  try {
    before = await snapshotOutputs(deps.cwd, log)
  } catch (e) {
    return setupFailed('outputs_snapshot', e)
  }

  // 3. The query.
  const text = config.prompt !== '' && leftOut.length > 0 ? `${config.prompt}\n\n${leftOutNote(leftOut)}` : config.prompt
  const prompt = text === '' ? '' : streamingPrompt(text, inputDone)
  const turn = new TurnToolUses()
  let result: Result | null = null
  let thrown: unknown = null
  let threw = false
  try {
    q = deps.query({ prompt, options })
    // A stop or interrupt that came while the query was being set up.
    if (stopping || interruptPending) void halt()
    for await (const m of q) {
      if (ended) break
      turn.see(m)
      // Capped here as well as in the root, so an honest session never sends a line over the channel's cap.
      const raw = m as unknown as Record<string, unknown>
      const stub = (why: 'tooDeep' | 'unencodable') => ({ message: { type: String(raw.type).slice(0, 64), [why]: true }, truncated: true })
      const capped = deeperThan(raw, SDK_MESSAGE_MAX_DEPTH) ? stub('tooDeep') : (capSdkMessage(raw, SDK_MESSAGE_MAX_BYTES) ?? stub('unencodable'))
      if (m.type === 'result') {
        result = m
        // The turn is over: the input ends, so the SDK ends the run rather than wait for another message.
        endInput()
      }
      // Backpressure: while the root isn't reading, the next SDK message waits rather than piling up in this heap.
      await emit({ type: 'sdk', ...capped })
    }
  } catch (e) {
    threw = true
    thrown = e
  }
  endInput()
  if (ended) return

  // 4. The end: the deferred call, files, the store, then the one terminal event.
  let terminal: Extract<SessionEvent, { type: 'finished' | 'failed' }>
  const check = store.resumeCheck()
  // A resume that ended before the SDK touched the store (stopped, interrupted or an SDK error before its first load):
  // the transcript is untouched, so the run ends as it ended, with no checkpoint and no mirror error, and the chat keeps
  // its last good state.
  const untouchedResume = check.state === 'pending' && !store.touched()
  if (resumeRefused !== null || check.state === 'failed') {
    terminal = { type: 'failed', reason: 'store', message: `the store doesn't hold the transcript to resume: ${resumeRefused ?? (check.state === 'failed' ? check.error : '')}`.slice(0, 2000) }
  } else if (check.state === 'pending' && !stopping && !abort.signal.aborted && (result !== null || !untouchedResume)) {
    // An unstopped query that ended (with a result, or after writing to the store) without the SDK ever loading the main
    // transcript: nothing proved the resume ran on the expected transcript. A stop or an interrupt keeps its own end.
    terminal = { type: 'failed', reason: 'store', message: 'the resume never loaded its transcript from the store' }
  } else if (result !== null && (!threw || stopping || abort.signal.aborted)) {
    // A result was seen: the run finished, even when a stop or interrupt raced its end (cost and usage are kept).
    terminal = finishedEvent(result)
    const deferred = result.subtype === 'success' ? result.deferred_tool_use : undefined
    if (deferred) {
      if (jsonBytes(deferred.input) > DEFERRED_INPUT_MAX_BYTES) terminal = { type: 'failed', reason: 'sdk_error', message: 'a deferred call whose input is over the cap' }
      else if (turn.only(deferred.id)) await emit({ type: 'deferred', toolUseId: deferred.id, toolName: deferred.name, input: deferred.input })
      else terminal = { type: 'failed', reason: 'sdk_error', message: `a deferred call in a turn with ${turn.count} tool calls; the runner defers only a lone call, and only that one` }
    }
  } else if (stopping) terminal = { type: 'failed', reason: 'stopped', message: 'stopped' }
  // An interrupt that fell back to the abort signal makes the SDK throw an AbortError: that's an interrupt, not an SDK fault.
  else if (abort.signal.aborted) terminal = { type: 'failed', reason: 'interrupted', message: 'interrupted' }
  else terminal = { type: 'failed', reason: 'sdk_error', message: threw ? message(thrown) : 'the query ended without a result' }

  // Without a stop: files, then the checkpoint. A stop (before or during the save) cuts the save; the checkpoint goes
  // first, then the rest of the files, both within the stop's deadline.
  let filesDone = stopping ? false : await files.save(before, emit, stopCut.signal)
  const cp = untouchedResume ? null : await settleOrCut(store.checkpoint(), deadlineCut.signal)
  if (untouchedResume) log({ type: 'checkpoint_skipped', why: 'the resume ended before the SDK touched the store' })
  else if (cp === null) await emit({ type: 'mirror_error', message: "the store's checkpoint did not finish before the stop's deadline" })
  else {
    if (cp.value.repaired > 0) log({ type: 'store_repaired', batches: cp.value.repaired })
    // Protocol v2's checkpoint reports the store's whole main transcript (the adapter loads the SDK's main key when this
    // run wrote none). A first run that neither wrote nor loaded one leaves it empty (`mainEntries: 0`: no transcript
    // to resume); a resume that never loaded one can't say, so that's a mirror error rather than a guess.
    const main = cp.value.ok ? (cp.value.main ?? (config.resume ? null : { mainEntries: 0, lastUuid: null, lastUuidIndex: null })) : null
    if (cp.value.ok && main !== null) await emit({ type: 'checkpoint', ...main, runEntries: cp.value.entries })
    else await emit({ type: 'mirror_error', message: cp.value.ok ? 'a resume that never loaded its transcript' : cp.value.error })
  }
  if (!filesDone && !deadlineCut.signal.aborted) filesDone = await files.save(before, emit, deadlineCut.signal)
  if (!filesDone) log({ type: 'files_save_cut', why: "the stop's deadline" })
  clearTimeout(deadlineTimer)
  await emit(terminal)
}

function finishedEvent(result: Result): Extract<SessionEvent, { type: 'finished' }> {
  return {
    type: 'finished',
    subtype: result.subtype,
    isError: result.is_error,
    numTurns: result.num_turns,
    costUsd: result.total_cost_usd,
    usage: result.usage as unknown as Record<string, unknown>,
  }
}
