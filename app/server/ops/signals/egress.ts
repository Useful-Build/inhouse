import { brandAgent } from '../../do/brand-agent/client.ts'
import type { Signal } from './types.ts'

const RECENT_MS = 60 * 60 * 1_000

/** Amber prompts monitor follow-up without blocking a release that could fix the write. */
export const egressRecordSignal: Signal = {
  name: 'egress_record_failed',
  async check({ env }) {
    const lastFailure = await brandAgent(env).lastEgressRecordFailure()
    if (lastFailure !== null && Date.now() - lastFailure < RECENT_MS) {
      return { ok: true, amber: true, detail: 'record write failed in the last hour' }
    }
    return { ok: true }
  },
}
