// The job engine's test fakes (M1-B): the texts port, the owner's membership read, the settings read and the bell
// notice, each a field a test sets, with what the engine asked for recorded. `wireJobs(h)` wires them on a harness's
// engine (again after every `restart()`, as index.ts does on every start).
import type { Harness } from './core-harness.ts'
import type { JobDeps, JobNotice, JobTurnSettings } from '../../do/brand-agent/jobs/types.ts'

export interface FakeJobDeps extends JobDeps {
  /** Every notice the engine sent, in order (a repeat with the same id is recorded too: dedupe is the store's). */
  sent: JobNotice[]
  member: { active: boolean; throws: boolean }
  settingsAnswer: JobTurnSettings | { refused: 'model_off' | 'invalid' }
  notifyThrows: { on: boolean }
}

export const CARRY_ON = (n: number) => `carry on ${n}`
export const AFTER_CUT_OFF = (n: number) => `after cut off ${n}`

export function fakeJobDeps(): FakeJobDeps {
  const d: FakeJobDeps = {
    sent: [],
    member: { active: true, throws: false },
    settingsAnswer: {
      model: 'claude-sonnet-5-5', pickerId: 'sonnet', effort: 'medium', sideModel: 'claude-haiku-5-5', maxTurns: 25,
      webFetchDomains: [], webSearch: false,
    },
    notifyThrows: { on: false },
    texts: { carryOn: CARRY_ON, afterCutOff: AFTER_CUT_OFF },
    async memberActive() {
      if (d.member.throws) throw new Error('members read failed')
      return d.member.active
    },
    async settings() { return d.settingsAnswer },
    async notify(n) {
      if (d.notifyThrows.on) throw new Error('notice write failed')
      d.sent.push(n)
    },
  }
  return d
}

/** Wires `deps` on the harness's engine; returns them. */
export function wireJobs(h: Harness, deps: FakeJobDeps = fakeJobDeps()): FakeJobDeps {
  h.core.setJobs(deps)
  return deps
}

export interface JobRowView {
  job_id: string; chat_id: string; owner_id: string; root_turn_id: string; last_turn_id: string | null
  state: 'running' | 'waiting' | 'ended'; outcome: string | null; gen: number; pending_n: number
  started_at_ms: number; deadline_ms: number; infra_retries: number; idle_steps: number; ended_at_ms: number | null
  result_sent: number
}

export const jobsOf = (h: Harness): JobRowView[] =>
  h.sql.exec<JobRowView & Record<string, SqlStorageValue>>('SELECT * FROM jobs ORDER BY started_at_ms, job_id').toArray().map(r => ({ ...r }))

/** Every stored chat event of the object, across runs, in order. */
export const allEvents = (h: Harness): { type: string; [k: string]: unknown }[] =>
  h.sql.exec<{ json: string }>('SELECT json FROM events ORDER BY run_id, seq').toArray().map(r => JSON.parse(r.json) as { type: string })
