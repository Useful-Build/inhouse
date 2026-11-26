import type { Scenario, ScriptedTurn } from '../index.ts'

type Check = NonNullable<ScriptedTurn['expect']>

export const LONG_JOB_READY = 'The post-checkpoint file is written. Holding the turn open.'
export const LONG_JOB_DONE = 'Saved outputs/job-result.txt.'

/** Use a fresh scenario marker per phase so a partial transcript cannot shift the scripted reply index. */
export function jobScenarios(mainLoop: (tool?: string) => Check, resultIs: (id: string, error: boolean) => Check): Record<string, Scenario> {
  const bash = (id: string, command: string, description: string, after?: string, text?: string): ScriptedTurn => ({
    content: [
      ...(text === undefined ? [] : [{ type: 'text' as const, text }]),
      { type: 'tool_use', id, name: 'Bash', input: { command, description } },
    ],
    expect: after === undefined ? mainLoop('Bash') : resultIs(after, false),
  })
  const done = (id: string, text: string): ScriptedTurn => ({ content: [{ type: 'text', text }], expect: resultIs(id, false) })
  const seed = 'toolu_job_seed'
  const tail = 'toolu_job_tail'
  const hold = 'toolu_job_hold'
  const work = 'toolu_job_work'
  const result = 'toolu_job_result'
  return {
    'long-job': {
      turns: [bash(seed, "printf 'checkpoint\\n' > outputs/job-seed.txt", 'Write the checkpoint file'), done(seed, 'Saved outputs/job-seed.txt.')],
    },
    'long-job-work': {
      turns: [
        bash(tail, "printf 'partial\\n' > outputs/job-tail.txt", 'Write a post-checkpoint file'),
        bash(hold, 'sleep 45 && echo first-step', 'Hold the turn in its first step', tail, LONG_JOB_READY),
        bash(work, 'sleep 5 && echo second-step', 'Run the second step', hold),
        done(work, 'Completed the long turn.'),
      ],
    },
    'long-job-resume': {
      turns: [
        bash(result, "test -f outputs/job-seed.txt && { cat outputs/job-seed.txt; if test -f outputs/job-tail.txt; then cat outputs/job-tail.txt; else echo tail-missing; fi; } > outputs/job-result.txt", 'Build a result from the surviving files'),
        done(result, LONG_JOB_DONE),
      ],
    },
  }
}
