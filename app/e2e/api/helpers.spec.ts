// M1-P (N6) on the sandbox deploy: a scripted turn starts the `researcher` helper, the helper's own model call goes
// through the turn's egress grant, and its spend is on the ledger. The scenario (test/scripted-model/scenarios/
// subagents.ts) misses, and the turn gets no answer, if the helper isn't ours (not the server's researcher words, or
// offered the Agent tool). The helper's one call reports 100,000 input tokens (Sonnet 5.5: 20 cents), so it shows as
// its own model step in the turn's trace and moves the month's total by at least that much. Needs a container.
import { expect, test } from '@playwright/test'
import { HELPER_ANSWER, HELPER_USAGE } from '../../test/scripted-model/scenarios/subagents.ts'
import { answerOf, createChat, needsContainer, send, textOf } from './chat-kit.ts'
import { actor, call } from './kit.ts'

const dana = actor('memberA')
/** 100,000 input tokens at Sonnet 5.5's $2 per million, plus 7 output tokens at $10 per million: 20 cents rounded. */
const HELPER_CENTS = 20

const monthTotal = async (request: Parameters<typeof call>[0]): Promise<number> => {
  const r = await call(request, dana, 'GET', '/api/usage')
  expect(r.status, r.text).toBe(200)
  return (r.json.total as { minor: number }).minor
}

test('a scripted turn starts the researcher helper; its model call is on the turn\'s trace and its spend on the ledger', async ({ request }) => {
  needsContainer()
  test.setTimeout(180_000)
  const before = await monthTotal(request)
  const chat = await createChat(request, dana)
  const sent = await send(request, dana, chat, 'scenario:helper-research ask the researcher')
  const answer = await answerOf(request, dana, chat, sent.turnId)
  expect(textOf(answer)).toBe(HELPER_ANSWER)
  const trace = (await call(request, dana, 'GET', `/api/traces/${sent.turnId}`)).json as { cost: { minor: number }; steps: { kind: string; label: string; detail: string }[] }
  // The helper's own call: Sonnet 5.5 (the turn's subagent model; a Sonnet turn keeps its own) with the marked usage.
  const helperSteps = trace.steps.filter(s => s.kind === 'model' && s.detail === `${HELPER_USAGE.input_tokens} in · ${HELPER_USAGE.output_tokens} out`)
  expect(helperSteps.map(s => s.label)).toEqual(['claude-sonnet-5-5'])
  expect(trace.steps.filter(s => s.kind === 'tool' && ['Agent', 'Task'].includes(s.detail))).toHaveLength(1)
  expect(trace.cost.minor).toBeGreaterThanOrEqual(HELPER_CENTS)
  // The ledger: the month's total moves by at least the helper's spend once the turn is settled (other specs only add).
  await expect.poll(async () => (await monthTotal(request)) - before, { timeout: 60_000, message: 'the month total after the helper turn settles' })
    .toBeGreaterThanOrEqual(HELPER_CENTS)
})
