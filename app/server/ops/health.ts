// Route 1, `GET /api/health` (P2 plan, "The health route"; the `monitor` service token only): every signal of
// signals/index.ts, run in turn. 200 when all pass, else 503; JSON `{ version, ok, signals }`. A signal that throws
// fails with the error's name only (no message: it could carry data). No brand data in any detail.
import { apiJson } from '../http.ts'
import { storesOf } from '../db/handler-kit.ts'
import type { HandlerContext } from '../routes.ts'
import { versionOf } from './signals/core.ts'
import { signals as registered } from './signals/index.ts'
import type { Signal, SignalResult } from './signals/types.ts'

export interface HealthBody {
  version: string | null
  ok: boolean
  signals: ({ name: string } & SignalResult)[]
}

/** The handler over a list of signals (the registry by default; tests pass their own). */
export function healthHandler(signals: readonly Signal[] = registered) {
  return async (c: Pick<HandlerContext, 'env' | 'stores'>): Promise<Response> => {
    const stores = storesOf(c)
    const results: HealthBody['signals'] = []
    for (const s of signals) {
      try {
        const r = await s.check({ env: c.env, stores })
        results.push({ name: s.name, ok: r.ok, ...(r.ok && r.amber ? { amber: true as const } : {}), ...(r.detail === undefined ? {} : { detail: r.detail }) })
      } catch (err) {
        results.push({ name: s.name, ok: false, detail: err instanceof Error ? err.name : 'failed' })
      }
    }
    const ok = results.every(r => r.ok)
    const body: HealthBody = { version: versionOf(c.env), ok, signals: results }
    return apiJson(body, ok ? 200 : 503)
  }
}

export const health = healthHandler()
