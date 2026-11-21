// The runs signals through the real BrandAgent (the rules and their edges: do/brand-agent/runs-read.test.ts). Ways it
// can fail: a signal reads another field than its name says, or a quarantined task leaves `scheduler` green.
import { runInDurableObject } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { brandAgent } from '../../do/brand-agent/client.ts'
import { RUNS_SIGNALS } from './runs.ts'

const check = async () => {
  const out: Record<string, unknown> = {}
  for (const s of RUNS_SIGNALS) out[s.name] = await s.check({ env, stores: undefined as never })
  return out
}

describe('the runs signals', () => {
  it('name each count, and a quarantined task turns scheduler red', async () => {
    const before = await check()
    expect(Object.keys(before)).toEqual(['runs_failed', 'runs_stuck', 'session_damaged', 'scheduler'])
    expect(before.runs_stuck).toEqual({ ok: true, detail: '0 stuck' })
    expect(before.scheduler).toEqual({ ok: true, detail: '0 quarantined' })
    await runInDurableObject(brandAgent(env), (_i, state) => {
      state.storage.sql.exec("INSERT INTO due_tasks (id, kind, gen, due_at_ms, payload_json, attempts, state, last_error) VALUES ('x:1', 'x', 1, 0, 'null', 10, 'quarantined', 'boom')")
    })
    expect((await check()).scheduler).toEqual({ ok: false, detail: '1 quarantined' })
  })
})
