// M1-D's token chains (`long-job-run`, `long-job-soak`, test/scripted-model/scenarios/jobs.ts), proved against the
// scripted model itself. Ways they could fail, written first:
//  - a step's id doesn't carry the run's token, so a spec can't find its own job's running step in the session store;
//  - a continuation with no marker, or a step lost to a kill (an error result), shifts the chain or skips a step;
//  - a step's command is one the CLI's Bash guard refuses (a first `sleep` of 25 seconds or more) or one that outlasts
//    its default 2-minute timeout;
//  - the soak's sleeps add up to less than 2 hours, so it could "pass" short;
//  - a request with no token (the runner's shared checks send one) is a miss instead of the chain.
import { describe, expect, test } from 'vitest'
import { createScriptedModel, SCENARIOS } from '../../test/scripted-model/index.ts'
import { HARNESS_MODEL } from '../../test/scripted-model/scenarios.ts'
import { JOB_RUN_DONE, JOB_RUN_STEPS, SOAK_DONE, SOAK_STEP_SECONDS, SOAK_STEPS, stepIdPrefix } from '../../test/scripted-model/scenarios/jobs.ts'

type Msg = { role: 'user' | 'assistant'; content: unknown }
type Tool = { type: 'tool_use'; id: string; name: string; input: { command: string } }
type Answer = { content?: ({ type: 'text'; text: string } | Tool)[]; error?: { message: string } }

const ask = async (scenario: string, messages: Msg[]) => {
  const model = createScriptedModel(SCENARIOS)
  const res = await model.handle(new Request('http://scripted.invalid/v1/messages', {
    method: 'POST', body: JSON.stringify({ model: HARNESS_MODEL, tools: [{ name: 'Bash' }], messages }),
  }), scenario)
  return { answer: await res.json() as Answer, misses: model.misses }
}
const toolOf = (a: Answer): Tool => a.content!.find((b): b is Tool => b.type === 'tool_use')!
const result = (id: string, error = false): Msg => ({ role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: error ? 'interrupted' : 'ok', ...(error ? { is_error: true } : {}) }] })

/** Plays a chain to its end: every step succeeds except those in `lose` (their first try comes back as an error). */
async function play(scenario: string, token: string, lose: ReadonlySet<number> = new Set()) {
  const convo: Msg[] = [{ role: 'user', content: `scenario:${scenario} run=${token} Do every step.` }]
  const ids: string[] = []
  for (let i = 0; i < 400; i++) {
    const { answer, misses } = await ask(scenario, convo)
    expect(misses).toEqual([])
    const tool = answer.content!.find((b): b is Tool => b.type === 'tool_use')
    convo.push({ role: 'assistant', content: answer.content })
    if (!tool) return { ids, final: answer.content!.map(b => (b.type === 'text' ? b.text : '')).join('') }
    ids.push(tool.id)
    const n = Number(tool.id.slice(stepIdPrefix(scenario === 'long-job-run' ? 'run' : 'soak', token).length).split('_')[0])
    const lost = lose.has(n) && !ids.slice(0, -1).some(x => x.startsWith(`${stepIdPrefix(scenario === 'long-job-run' ? 'run' : 'soak', token)}${n}_`))
    convo.push(result(tool.id, lost))
  }
  throw new Error('the chain never ended')
}

describe('long-job-run', () => {
  test("every step's id carries the run's token; a lost step runs again under a fresh id; then the answer", async () => {
    const { ids, final } = await play('long-job-run', 'abc123xyz', new Set([2]))
    expect(ids).toEqual(['toolu_jobrun_abc123xyz_1_0', 'toolu_jobrun_abc123xyz_2_0', 'toolu_jobrun_abc123xyz_2_1', 'toolu_jobrun_abc123xyz_3_0'])
    expect(final).toBe(JOB_RUN_DONE)
    expect(JOB_RUN_STEPS).toBe(3)
  })
  test("a step's command is one the Bash guard allows and writes its line", async () => {
    const { answer } = await ask('long-job-run', [{ role: 'user', content: 'scenario:long-job-run run=abc123xyz Go.' }])
    expect(toolOf(answer).input.command).toBe('sleep 20; sleep 20; sleep 20; echo step-1 >> outputs/job-run.txt')
  })
  test('no run token: the chain still runs, under the token "none"', async () => {
    const { answer, misses } = await ask('long-job-run', [{ role: 'user', content: 'scenario:long-job-run Go.' }])
    expect(misses).toEqual([])
    expect(toolOf(answer).id).toBe('toolu_jobrun_none_1_0')
  })
})

describe('long-job-soak', () => {
  test('its sleeps alone add up to 2 hours, each first sleep under the guard and each step under the 2-minute timeout', async () => {
    expect(SOAK_STEPS * SOAK_STEP_SECONDS).toBeGreaterThanOrEqual(2 * 60 * 60)
    expect(SOAK_STEP_SECONDS).toBeLessThan(120)
    const { answer } = await ask('long-job-soak', [{ role: 'user', content: 'scenario:long-job-soak run=soak42ab Go.' }])
    expect(toolOf(answer)).toMatchObject({ id: 'toolu_jobsoak_soak42ab_1_0', input: { command: 'sleep 20; sleep 20; sleep 20; sleep 20; echo step-1 >> outputs/job-soak.txt' } })
  })
  test('it runs every step once, a lost one again, then answers', async () => {
    const { ids, final } = await play('long-job-soak', 'soak42ab', new Set([45]))
    expect(ids).toHaveLength(SOAK_STEPS + 1)
    expect(final).toBe(SOAK_DONE)
  })
})
