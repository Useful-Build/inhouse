// The session process's run loop, without the SDK: the SDK's `query` comes in as a parameter, so tests drive this with a
// mocked query at the process boundary. src/session/main.ts loads the real SDK and calls this.
//
// One session process runs one run: it says `ready`, takes one `run` message, runs one `query()`, streams every SDK
// message back as an `sdk` event and ends with exactly one terminal event (`finished` or `failed`).
// PR 2 adds the session store, files, deferred calls and the streaming prompt that `interrupt()` needs.
import type { Options, Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { SDK_MESSAGE_MAX_BYTES, type RunEventBody } from '../../../shared/protocol/index.ts'
import { RootMessage, capSdkMessage, type RunConfig } from '../protocol/local.ts'
import { LOCAL_MAX_DEPTH, deeperThan, type LineResult } from '../protocol/ndjson.ts'
import type { QueryGuards } from './seam.ts'

export type QueryFn = (params: { prompt: string; options: Options }) => Pick<Query, 'interrupt'> & AsyncIterable<SDKMessage>

/** The session's side of the local channel (src/session/channel.ts in production). */
export type SessionChannel = {
  /** A promise means the channel is full: the run loop reads no more SDK messages until it settles. */
  send(message: unknown): void | Promise<void>
  /** Each line from the root, parsed, or the framing error (oversized, not JSON) that ends the run. */
  onMessage(handler: (line: LineResult) => void): void
}

type SessionEvent = Exclude<RunEventBody, { type: 'started' }>

/** Env names the session process must not hand to the CLI. There's no Node IPC channel any more; the filter stays. */
const NOT_FOR_THE_CLI = /^NODE_CHANNEL_/

export function cliEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(env)) if (v !== undefined && !NOT_FOR_THE_CLI.test(k)) out[k] = v
  return out
}

export function baseOptions(config: RunConfig, cwd: string, env: Record<string, string>, abortController: AbortController): Options {
  return {
    cwd,
    env,
    abortController,
    model: config.model,
    effort: config.effort,
    maxTurns: config.maxTurns,
    maxBudgetUsd: config.maxBudgetUsd,
    settingSources: [],
    // The SDK's own CLI spawn and MCP delivery: the CLI gets fresh stdio pipes, so it never holds the local channel
    // (src/session/channel.ts), and the SDK reads its stderr as usual.
    ...(config.resume ? { resume: config.sessionId } : { sessionId: config.sessionId }),
  }
}

/**
 * The deepest SDK message sent whole. The root refuses a line nested past `LOCAL_MAX_DEPTH`, and the event's envelope
 * (`{type:'event', event:{type:'sdk', message}}`) adds two levels; two more are spare. A deeper message goes as a stub.
 */
export const SDK_MESSAGE_MAX_DEPTH = LOCAL_MAX_DEPTH - 4

const message = (e: unknown) => String(e instanceof Error ? e.message : e).slice(0, 2000)

export async function runSession(deps: {
  channel: SessionChannel
  query: QueryFn
  guards: QueryGuards
  cwd: string
  env: NodeJS.ProcessEnv
}): Promise<void> {
  const { channel } = deps
  let ended = false
  const emit = (event: SessionEvent): void | Promise<void> => {
    if (ended) return
    if (event.type === 'finished' || event.type === 'failed') ended = true
    return channel.send({ type: 'event', event })
  }

  let q: ReturnType<QueryFn> | null = null
  let stopping = false
  /** An interrupt that came before the query existed: applied as soon as it does. */
  let interruptPending = false
  const abort = new AbortController()
  let resolveRun!: (config: RunConfig) => void
  const runConfig = new Promise<RunConfig>((r) => (resolveRun = r))
  let gotRun = false

  const halt = async () => {
    if (q === null) {
      interruptPending = true
      return
    }
    try {
      await q.interrupt()
    } catch {
      // interrupt() needs the streaming prompt (PR 2); until then a refused interrupt falls back to the abort signal.
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
    } else {
      stopping = true
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

  const config = await Promise.race([
    runConfig,
    new Promise<null>((r) => abort.signal.addEventListener('abort', () => r(null), { once: true })),
  ])
  if (config === null || ended) return
  // A stop that came with the run (or while it was being read): end it without calling query().
  if (stopping) return emit({ type: 'failed', reason: 'stopped', message: 'stopped before the query started' })

  const options = deps.guards.apply(baseOptions(config, deps.cwd, cliEnv(deps.env), abort), config)
  let result: Extract<SDKMessage, { type: 'result' }> | null = null
  try {
    q = deps.query({ prompt: config.prompt, options })
    // A stop or interrupt that came while the query was being set up.
    if (stopping || interruptPending) void halt()
    for await (const m of q) {
      if (ended) break
      // Capped here as well as in the root, so an honest session never sends a line over the channel's cap.
      const raw = m as unknown as Record<string, unknown>
      const stub = (why: 'tooDeep' | 'unencodable') => ({ message: { type: String(raw.type).slice(0, 64), [why]: true }, truncated: true })
      const capped = deeperThan(raw, SDK_MESSAGE_MAX_DEPTH) ? stub('tooDeep') : (capSdkMessage(raw, SDK_MESSAGE_MAX_BYTES) ?? stub('unencodable'))
      if (m.type === 'result') result = m
      // Backpressure: while the root isn't reading, the next SDK message waits rather than piling up in this heap.
      await emit({ type: 'sdk', ...capped })
    }
  } catch (e) {
    // A stop or interrupt that raced the SDK's result: the run did finish, and its cost and usage are kept.
    if (result !== null && (stopping || abort.signal.aborted)) return emitFinished(result)
    // An interrupt that fell back to the abort signal makes the SDK throw an AbortError: that's an interrupt, not an
    // SDK fault.
    if (stopping) emit({ type: 'failed', reason: 'stopped', message: 'stopped' })
    else if (abort.signal.aborted) emit({ type: 'failed', reason: 'interrupted', message: 'interrupted' })
    else emit({ type: 'failed', reason: 'sdk_error', message: message(e) })
    return
  }
  // A result was seen: the run finished, even when a stop raced its end.
  if (result !== null) emitFinished(result)
  else if (stopping) emit({ type: 'failed', reason: 'stopped', message: 'stopped' })
  else emit({ type: 'failed', reason: abort.signal.aborted ? 'interrupted' : 'sdk_error', message: 'the query ended without a result' })

  function emitFinished(result: Extract<SDKMessage, { type: 'result' }>) {
    emit({
      type: 'finished',
      subtype: result.subtype,
      isError: result.is_error,
      numTurns: result.num_turns,
      costUsd: result.total_cost_usd,
      usage: result.usage as unknown as Record<string, unknown>,
    })
  }
}
