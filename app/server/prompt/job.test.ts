// The job texts (M1-P, N3 and N20). Ways it can fail, written first: a text reads as the person's own message (no note
// that it is automatic); the cut-off text doesn't tell the agent to check its files (N4); a text asks the agent to stop
// and ask whether to go on (a job would stall); a text is too long for a turn's input; an em dash in model-facing copy.
import { describe, expect, it } from 'vitest'
import { SendTurnInputSchema } from '../../shared/contract/runs.ts'
import { JOB_NOTE_PREFIX, JOB_TEXTS } from './job.ts'

const texts = [JOB_TEXTS.carryOn(1), JOB_TEXTS.carryOn(7), JOB_TEXTS.afterCutOff(1), JOB_TEXTS.afterCutOff(3)]

describe('the job texts', () => {
  it('each says it is an automatic note from Inhouse, not a message from the person', () => {
    expect(JOB_NOTE_PREFIX).toBe('[Automatic note from Inhouse, not a message from the person]')
    for (const t of texts) expect(t.startsWith(`${JOB_NOTE_PREFIX} `)).toBe(true)
  })
  it('carry the task on from where it stopped, without starting over or asking whether to continue', () => {
    for (const t of texts) {
      expect(t).toMatch(/continue the person's last request from where you stopped\./i)
      expect(t).toContain("don't ask whether to continue")
      expect(t).toContain('give the person your final answer')
    }
  })
  it('after a cut-off, the agent checks its files before relying on them (N4: files since the last saved step may be lost)', () => {
    expect(JOB_TEXTS.afterCutOff(1)).toContain('files written since your last saved step may be missing: check the files')
    expect(JOB_TEXTS.carryOn(1)).not.toContain('may be missing')
    expect(JOB_TEXTS.carryOn(1)).not.toBe(JOB_TEXTS.afterCutOff(1))
  })
  it('is a valid turn input and has no em dash', () => {
    for (const t of texts) {
      expect(SendTurnInputSchema.safeParse({ clientTurnKey: 'job_j0b1d_1', text: t, priority: 'next', model: 'sonnet', attachments: [] }).success).toBe(true)
      expect(t).not.toContain('—')
    }
  })
})
