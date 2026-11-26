// Fetch leak check API spec (M1-G, N8): read an order through the hub, then fetch a listed host with its order id in
// the query; the egress refuses it with `leak` before any DNS or page request. Needs a container (`needsContainer()`).
import { expect, test } from '@playwright/test'
import { WEBFETCH_LEAK_REFUSED_ANSWER } from '../../test/scripted-model/scenarios/leak-check.ts'
import { answerOf, createChat, needsContainer, send, textOf } from './chat-kit.ts'
import { actor, call, putSetting } from './kit.ts'

const dana = actor('memberA')
const inhouse = actor('inhouse')

test('read an order through the hub, then fetch a listed host with its id in the query: refused leak', async ({ request }) => {
  needsContainer()
  const before = await call(request, inhouse, 'GET', '/api/settings/technical')
  const prev = (before.json?.values as Record<string, unknown> | undefined)?.['t:webfetch']
  await putSetting(request, inhouse, 'technical', 't:webfetch', 'example.com')
  try {
    const chat = await createChat(request, dana)
    const sent = await send(request, dana, chat, 'scenario:webfetch-leak read order and check page')
    const answer = await answerOf(request, dana, chat, sent.turnId)
    expect(textOf(answer)).toBe(WEBFETCH_LEAK_REFUSED_ANSWER)
  } finally {
    await putSetting(request, inhouse, 'technical', 't:webfetch', typeof prev === 'string' ? prev : '')
  }
})
