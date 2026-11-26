// M1-B's continuation-safe scripted job (`long-job-chain`, test/scripted-model/scenarios/jobs.ts), proved against the
// scripted model itself: it can only run in a container on the deployed test build. A real job's continuation is the
// server's own text with no `scenario:` marker, so the scenario must read its next step from the transcript. Ways it
// could fail, written first:
//  - a continuation with no marker, or the CLI's own extra messages, shifts it to the wrong step or a miss;
//  - a step cut by the server (an error result) counts as done, or runs again under the same tool call id;
//  - it answers "done" before every step has a successful result, or never does;
//  - a step's hold is one the CLI's Bash guard refuses (the spike's `sleep 45`): the command is pinned below.
import { describe, expect, test } from 'vitest'
import { createScriptedModel, SCENARIOS } from '../../test/scripted-model/index.ts'
import { HARNESS_MODEL } from '../../test/scripted-model/scenarios.ts'
import { JOB_CHAIN_DONE, JOB_CHAIN_STEPS, JOB_HOLD_SECONDS } from '../../test/scripted-model/scenarios/jobs.ts'

type Msg = { role: 'user' | 'assistant' | 'system'; content: unknown }
type Tool = { type: 'tool_use'; id: string; name: string; input: { command: string } }

const ask = async (messages: Msg[]) => {
  const model = createScriptedModel(SCENARIOS)
  const res = await model.handle(new Request('http://scripted.invalid/v1/messages', {
    method: 'POST', body: JSON.stringify({ model: HARNESS_MODEL, tools: [{ name: 'Bash' }], messages }),
  }), 'long-job-chain')
  expect(model.misses).toEqual([])
  return (await res.json() as { content: ({ type: 'text'; text: string } | Tool)[] }).content
}
const toolOf = (content: Awaited<ReturnType<typeof ask>>): Tool => content.find((b): b is Tool => b.type === 'tool_use')!
const result = (id: string, error = false): Msg => ({ role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: error ? 'interrupted' : 'ok', ...(error ? { is_error: true } : {}) }] })

describe('long-job-chain', () => {
  test('a job made of a cut root and two marker-less continuations finishes every step once', async () => {
    const convo: Msg[] = [{ role: 'user', content: 'scenario:long-job-chain Do the three steps.' }]
    // The root: step 1 done, step 2 cut by the server (its result an error).
    const s1 = toolOf(await ask(convo))
    expect(s1.input.command).toBe(`sleep ${JOB_HOLD_SECONDS} && echo step-1 >> outputs/job-chain.txt`)
    convo.push({ role: 'assistant', content: [s1] }, result(s1.id))
    const s2 = toolOf(await ask(convo))
    expect(s2.input.command).toContain('step-2')
    convo.push({ role: 'assistant', content: [s2] }, result(s2.id, true))
    // The CLI's own message after a cut, then the server's continuation: no marker.
    convo.push({ role: 'assistant', content: [{ type: 'text', text: '[Request interrupted by user]' }] })
    convo.push({ role: 'user', content: 'An automatic note from Inhouse: carry on with the job.' })
    const again = toolOf(await ask(convo))
    expect(again.input.command).toContain('step-2')
    expect(again.id).not.toBe(s2.id)
    convo.push({ role: 'assistant', content: [again] }, result(again.id))
    const s3 = toolOf(await ask(convo))
    expect(s3.input.command).toContain(`step-${JOB_CHAIN_STEPS}`)
    convo.push({ role: 'assistant', content: [s3] }, result(s3.id))
    expect(await ask(convo)).toEqual([{ type: 'text', text: JOB_CHAIN_DONE }])
  })

  test('a step lost with a killed container (the SDK\'s own error result) runs again after the retry text', async () => {
    const convo: Msg[] = [{ role: 'user', content: 'scenario:long-job-chain Do the three steps.' }]
    const s1 = toolOf(await ask(convo))
    convo.push({ role: 'assistant', content: [s1] }, result(s1.id, true))
    convo.push({ role: 'user', content: 'An automatic note from Inhouse: the last step was cut off. Check the files before relying on them.' })
    const retry = toolOf(await ask(convo))
    expect(retry.input.command).toContain('step-1')
    expect(retry.id).not.toBe(s1.id)
  })
})
