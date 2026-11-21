// The loader (P5 W2, A.3): runs a script in a Dynamic Worker with no network, reaching Shopify only through a per-call
// RpcTarget passed as the entrypoint's argument (never in `env`, so the id depends on the code alone).
// Workers only (imports cloudflare:workers); the logic it leans on is in api.ts and script.ts.
// Docs read 2026-11-21: https://developers.cloudflare.com/dynamic-workers/ (getting-started, api-reference,
// usage/bindings, usage/limits, usage/egress-control, examples/codemode).
import { RpcTarget } from 'cloudflare:workers'
import type { HubResult } from '../index/contract'
import { DEADLINE_MS, LIMITS } from './caps'
import { CODEMODE_ACCOUNT } from './route'
import type { ScriptApi } from './api'
import { BAD_RETURN, errorText, readReturn, scriptId, workerCode } from './script'
import type { CodeMode, CodeModeOutcome } from './types'

/** The only thing a script can reach: one method. Its fields are private, so RPC exposes nothing else. */
class ShopBinding extends RpcTarget {
  readonly #api: ScriptApi
  constructor(api: ScriptApi) {
    super()
    this.#api = api
  }
  graphql(query: unknown, variables?: unknown): Promise<{ data: unknown }> {
    return this.#api.graphql(query, variables)
  }
}

export type CodeModeDeps = {
  loader: WorkerLoader
  bumpCounter: CodeMode['bumpCounter']
  now?: () => number
  /** The deadline's timer; tests inject one. Returns a cancel. */
  setTimer?: (ms: number, fn: () => void) => () => void
  /** Test spy: called each time the loader asks for a script's code. */
  onCodeRequested?: (id: string) => void
}

const realTimer = (ms: number, fn: () => void): (() => void) => {
  const t = setTimeout(fn, ms)
  return () => clearTimeout(t)
}

type Settled = { kind: 'value'; value: unknown } | { kind: 'error'; error: unknown } | { kind: 'timeout' }

/** Drops an RPC stub the sandbox may have returned instead of a string. */
function dispose(v: unknown): void {
  try {
    const d = (v as { [Symbol.dispose]?: unknown } | null)?.[Symbol.dispose]
    if (typeof d === 'function') d.call(v)
  } catch {
    // Nothing to keep.
  }
}

export function createCodeMode(deps: CodeModeDeps): CodeMode {
  const now = deps.now ?? (() => Date.now())
  const setTimer = deps.setTimer ?? realTimer
  return {
    bumpCounter: (key, limit, ttlMs) => deps.bumpCounter(key, limit, ttlMs),
    async run(code: string, api: ScriptApi): Promise<CodeModeOutcome> {
      const started = now()
      const id = await scriptId(code)
      let cancel: () => void = () => {}
      const deadline = new Promise<Settled>(resolve => {
        cancel = setTimer(DEADLINE_MS, () => {
          api.close()
          resolve({ kind: 'timeout' })
        })
      })
      let settled: Settled
      try {
        const worker = deps.loader.get(id, () => {
          deps.onCodeRequested?.(id)
          return workerCode(code)
        })
        const entry = worker.getEntrypoint('Script', { limits: { ...LIMITS } }) as unknown as { run(shop: unknown): Promise<unknown> }
        const call = (async () => entry.run(new ShopBinding(api)))().then(
          (value): Settled => ({ kind: 'value', value }),
          (error: unknown): Settled => ({ kind: 'error', error }),
        )
        settled = await Promise.race([call, deadline])
      } catch (error) {
        settled = { kind: 'error', error }
      } finally {
        cancel()
        api.close()
      }
      const base = { calls: api.calls, bytes: api.bytes, ms: now() - started }
      if (settled.kind === 'timeout') return { outcome: 'timeout', error: `Error: the script ran past ${DEADLINE_MS / 1000} s`, ...base }
      if (settled.kind === 'error') return { outcome: 'error', error: errorText(settled.error), ...base }
      const read = readReturn(settled.value)
      if (!read.ok) {
        dispose(settled.value)
        return { outcome: 'bad_return', error: `Error: ${BAD_RETURN}`, ...base }
      }
      return { outcome: 'ok', result: read.value, ...base }
    },
  }
}

/** The hub entry's code mode (orchestrator wiring in index.ts): the loader binding and the Shopify SignIn's counter. */
export function codeModeFor(env: { LOADER: WorkerLoader; SIGNIN: Env['SIGNIN'] }): CodeMode {
  const signIn = () => env.SIGNIN.get(env.SIGNIN.idFromName(CODEMODE_ACCOUNT))
  return createCodeMode({
    loader: env.LOADER,
    bumpCounter: async (key, limit, ttlMs) => (await signIn().bumpCounter(key, limit, ttlMs)) as HubResult<{ ok: boolean; count: number }>,
  })
}
