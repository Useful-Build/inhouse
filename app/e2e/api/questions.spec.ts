// Questions mid-turn (Stage 1 M2-Q, N16; P6 acceptance item 10), through the real routes on the sandbox deploy (each
// case runs a turn, so `needsContainer()`). Oracles: N16 and the scripted scenarios (app/test/scripted-model/scenarios/
// questions.ts): a lone `question_ask` ends the turn waiting; the question is listed for the chat's owner only; it
// waits across a hard kill of every runner; the owner's answer resumes the turn, and the call run again returns the
// option chosen; a question asked beside another call is not asked, and the agent asks again on its own.
import { expect, test } from '@playwright/test'
import type { APIRequestContext } from '@playwright/test'
import { QUESTION_ASKED, QUESTION_REPLY } from '../../test/scripted-model/scenarios/questions.ts'
import { createChat, needsContainer, send } from './chat-kit.ts'
import { killRunners } from './job-kit.ts'
import { actor, call } from './kit.ts'
import type { Actor } from './kit.ts'

const dana = actor('memberA')
const leo = actor('memberB')
// `killRunners` is brand-global (job-kit.ts): the cases run one at a time.
test.describe.configure({ mode: 'serial' })

interface Q { id: string; state: string; question: string; options: string[]; chatId: string | null; answer: string | null }

/** The open question of this chat in the owner's list, once it is there. */
async function questionOf(request: APIRequestContext, who: Actor, chatId: string): Promise<Q> {
  let found: Q | undefined
  await expect.poll(async () => {
    const r = await call(request, who, 'GET', '/api/questions')
    expect(r.status, r.text).toBe(200)
    found = (r.json.items as Q[]).find(q => q.chatId === chatId)
    return found !== undefined
  }, { timeout: 120_000, message: `the question of chat ${chatId}` }).toBe(true)
  return found!
}

/** The chat's agent text once it holds `needle`. */
async function agentSays(request: APIRequestContext, who: Actor, chatId: string, needle: string): Promise<string> {
  let text = ''
  await expect.poll(async () => {
    const r = await call(request, who, 'GET', `/api/chats/${chatId}`)
    expect(r.status, r.text).toBe(200)
    text = (r.json.messages as { role: string; part?: { type: string; text?: string } }[])
      .filter(m => m.role === 'agent' && m.part?.type === 'text').map(m => m.part!.text ?? '').join('\n')
    return text.includes(needle)
  }, { timeout: 180_000, message: `the agent saying "${needle}" in chat ${chatId}` }).toBe(true)
  return text
}

test('a lone question waits across a container restart, and the answer resumes the turn with the option chosen', async ({ request }) => {
  needsContainer()
  test.setTimeout(420_000)
  const chatId = await createChat(request, dana)
  await send(request, dana, chatId, 'scenario:question Should we restock?')
  const q = await questionOf(request, dana, chatId)
  expect(q).toMatchObject({ state: 'open', question: QUESTION_ASKED.question, options: QUESTION_ASKED.options, answer: null })
  // Another member never sees it, nor can answer it.
  expect(((await call(request, leo, 'GET', '/api/questions')).json.items as Q[]).map(x => x.id)).not.toContain(q.id)
  expect((await call(request, leo, 'POST', `/api/questions/${q.id}/answer`, { json: { choice: QUESTION_ASKED.options[1] } })).status).toBe(404)
  // The chat waits: a plain message is refused until the question is answered.
  const blocked = await call(request, dana, 'POST', `/api/chats/${chatId}/turns`, { json: { clientTurnKey: 'k-q-blocked-0001', text: 'hello?', model: 'sonnet' } })
  expect(blocked.json?.error, blocked.text).toMatchObject({ code: 'conflict', reason: 'waiting_answer' })
  // Every runner hard-killed: the wait lives in the BrandAgent and the store, not in a container.
  await killRunners(request)
  const answered = await call(request, dana, 'POST', `/api/questions/${q.id}/answer`, { json: { choice: QUESTION_ASKED.options[1] } })
  expect(answered.status, answered.text).toBe(200)
  expect(answered.json).toMatchObject({ id: q.id, state: 'answered', answer: QUESTION_ASKED.options[1] })
  const said = await agentSays(request, dana, chatId, QUESTION_REPLY)
  expect(said).toContain(QUESTION_ASKED.options[1])
  // Answering again with the same choice changes nothing; another choice is a conflict.
  expect((await call(request, dana, 'POST', `/api/questions/${q.id}/answer`, { json: { choice: QUESTION_ASKED.options[1] } })).status).toBe(200)
  expect((await call(request, dana, 'POST', `/api/questions/${q.id}/answer`, { json: { choice: QUESTION_ASKED.options[0] } })).status).toBe(409)
})

test('a question beside another call is not asked; the agent asks again on its own, and that one waits and resumes', async ({ request }) => {
  needsContainer()
  test.setTimeout(300_000)
  const chatId = await createChat(request, dana)
  await send(request, dana, chatId, 'scenario:question-beside Should we restock?')
  const q = await questionOf(request, dana, chatId)
  const answered = await call(request, dana, 'POST', `/api/questions/${q.id}/answer`, { json: { choice: QUESTION_ASKED.options[0] } })
  expect(answered.status, answered.text).toBe(200)
  expect(await agentSays(request, dana, chatId, QUESTION_REPLY)).toContain(QUESTION_ASKED.options[0])
})
