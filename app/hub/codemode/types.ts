// Code mode's seam on ToolContext (P5 W2). Built in the hub entry over env.LOADER (run.ts, an orchestrator wiring
// line in index.ts); the tool code never touches `env`.
import type { HubResult } from '../index/contract'
import type { ScriptApi } from './api'

export type CodeModeOutcome =
  | { outcome: 'ok'; result: unknown; calls: number; bytes: number; ms: number }
  /** `error` is the script's own error text, or a fixed message; never an upstream body. */
  | { outcome: 'error' | 'timeout' | 'bad_return'; error: string; calls: number; bytes: number; ms: number }

export type CodeMode = {
  /** The Shopify SignIn's counter (`cm:` + key): one read-increment-write; `ok` false past `limit`. */
  bumpCounter(key: string, limit: number, ttlMs: number): Promise<HubResult<{ ok: boolean; count: number }>>
  /** Runs `code` in a Dynamic Worker whose only reach is `api`. Closes `api` when it settles or times out. */
  run(code: string, api: ScriptApi): Promise<CodeModeOutcome>
}
