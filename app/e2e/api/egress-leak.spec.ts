// Fetch leak check API spec (M1-G, N8): the scripted turn reads order #1001 through the hub, fetches a clean control page
// on the listed host (it must go through), then the same host with #1001 in the query, which the egress refuses with
// `leak` before any DNS or page request. The scenario (test/scripted-model/scenarios/leak-check.ts) misses, and the turn
// gets no answer, if the read didn't carry #1001, the control was refused or the leak fetch went out. Needs a container
// (`needsContainer()`).
import { expect, test } from '@playwright/test'
import { WEBFETCH_LEAK_REFUSED_ANSWER } from '../../test/scripted-model/scenarios/leak-check.ts'
import { answerOf, createChat, needsContainer, send, textOf } from './chat-kit.ts'
import { actor, call, putSetting } from './kit.ts'

const dana = actor('memberA')
const inhouse = actor('inhouse')

test('read order #1001 through the hub, then fetch a listed host: a clean page goes through, #1001 in the query is refused (leak)', async ({ request }) => {
  needsContainer()
  const before = await call(request, inhouse, 'GET', '/api/settings/technical')
  // The list as it was (the seed's `example.com`), put back after: the settings list answers `items`, and reading a
  // missing `values` reset it to none for every later WebFetch spec (runs.spec.ts's webfetch-allowed, M1-P's sandbox run).
  expect(before.status, before.text).toBe(200)
  const prev = (before.json.items as { key: string; value: unknown }[]).find(i => i.key === 't:webfetch')?.value
  await putSetting(request, inhouse, 'technical', 't:webfetch', 'example.com')
  try {
    const chat = await createChat(request, dana)
    const sent = await send(request, dana, chat, 'scenario:webfetch-leak read order and check page')
    const answer = await answerOf(request, dana, chat, sent.turnId)
    expect(textOf(answer)).toBe(WEBFETCH_LEAK_REFUSED_ANSWER)
    // The control and the refused fetch: two web page steps in the turn's trace.
    const steps = (await call(request, dana, 'GET', `/api/traces/${sent.turnId}`)).json.steps as { kind: string; detail: string }[]
    expect(steps.filter(s => s.kind === 'tool' && s.detail === 'WebFetch')).toHaveLength(2)
  } finally {
    await putSetting(request, inhouse, 'technical', 't:webfetch', typeof prev === 'string' ? prev : '')
  }
})
