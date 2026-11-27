// Questions mid-turn (Stage 1 M2-Q, N16; P6 acceptance item 10), through the real routes on the sandbox deploy (each
// case runs a turn, so `needsContainer()`). Oracles: N16 and the scripted scenarios (app/test/scripted-model/scenarios/
// questions.ts): a lone `question_ask` ends the turn waiting; the question is listed for the chat's owner only; it
// waits across a hard kill of every runner; the owner's answer resumes the turn, and the call run again returns the
// option chosen; a question asked beside another call is not asked, and the agent asks again on its own.
// M2-J adds a routine's question (scenarios/acceptance.ts `routine-create-question`): a routine's run asks its creator,
// who sees it in their questions (Approvals' Questions section, the inbox) with no chat to open (a routine's chat is the
// system's); another member never sees it; the run waits, across a kill of every runner, until the creator answers, then
// finishes.
import { expect, test } from '@playwright/test'
import type { APIRequestContext } from '@playwright/test'
import { QUESTION_ASKED, QUESTION_REPLY } from '../../test/scripted-model/scenarios/questions.ts'
import { QUESTION_ROUTINE_CREATED } from '../../test/scripted-model/scenarios/acceptance.ts'
import { answerOf, createChat, needsContainer, send, textOf } from './chat-kit.ts'
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

/** The chat's agent text once it holds `needle`. On a timeout the error carries what the chat and its turns' traces hold. */
async function agentSays(request: APIRequestContext, who: Actor, chatId: string, needle: string): Promise<string> {
  let text = ''
  let messages: { role: string; turnId: string; part?: { type: string; text?: string } }[] = []
  try {
    await expect.poll(async () => {
      const r = await call(request, who, 'GET', `/api/chats/${chatId}`)
      expect(r.status, r.text).toBe(200)
      messages = r.json.messages
      text = messages.filter(m => m.role === 'agent' && m.part?.type === 'text').map(m => m.part!.text ?? '').join('\n')
      return text.includes(needle)
    }, { timeout: 180_000, message: `the agent saying "${needle}" in chat ${chatId}` }).toBe(true)
  } catch (e) {
    // What the chat holds, and each turn's steps, so a failure on the sandbox says where the resume stopped.
    const turns = [...new Set(messages.map(m => m.turnId))]
    const traces: unknown[] = []
    for (const t of turns) {
      const r = await call(request, who, 'GET', `/api/traces/${t}`)
      traces.push({ turn: t, status: r.status, steps: r.json?.steps, outcome: r.json?.outcome, failure: r.json?.failure })
    }
    throw new Error(`${(e as Error).message}\nmessages: ${JSON.stringify(messages).slice(0, 4000)}\ntraces: ${JSON.stringify(traces).slice(0, 6000)}`)
  }
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

test("a routine's question goes to its creator's inbox with no chat; the run waits for the answer, then finishes", async ({ request }) => {
  needsContainer()
  test.setTimeout(600_000)
  // A routine made in Dana's chat (so she is its creator), named for this run.
  const name = `m2j-question-${Date.now().toString(36)}`
  const chatId = await createChat(request, dana)
  const made = await send(request, dana, chatId, `scenario:routine-create-question routine-name:${name}`)
  expect(textOf(await answerOf(request, dana, chatId, made.turnId, 180_000))).toBe(QUESTION_ROUTINE_CREATED)
  const list = await call(request, dana, 'GET', '/api/routines')
  expect(list.status, list.text).toBe(200)
  const routine = (list.json.routines as { id: string; name: string }[]).find(r => r.name === name)
  expect(routine, `the routine ${name} is listed`).toBeDefined()
  const runs = async () => {
    const r = await call(request, dana, 'GET', `/api/routines/${routine!.id}/runs`)
    expect(r.status, r.text).toBe(200)
    return r.json.runs as { outcome: string; manual: boolean }[]
  }

  // Questions already open for Dana (other cases' leftovers) aren't this run's.
  const before = new Set(((await call(request, dana, 'GET', '/api/questions')).json.items as Q[]).map(q => q.id))
  const run = await call(request, dana, 'POST', `/api/routines/${routine!.id}/run`, { json: { clientKey: `m2jq${Date.now().toString(36)}` } })
  expect(run.status, run.text).toBe(200)

  // The run asks its creator: the question is in her list, with no chat she could open.
  let q: Q | undefined
  await expect.poll(async () => {
    const r = await call(request, dana, 'GET', '/api/questions')
    expect(r.status, r.text).toBe(200)
    q = (r.json.items as Q[]).find(x => !before.has(x.id) && x.question === QUESTION_ASKED.question)
    return q !== undefined
  }, { timeout: 240_000, message: "the routine's question in its creator's list" }).toBe(true)
  expect(q).toMatchObject({ state: 'open', options: QUESTION_ASKED.options, chatId: null, answer: null })
  // Another member never sees it, nor can answer it.
  expect(((await call(request, leo, 'GET', '/api/questions')).json.items as Q[]).map(x => x.id)).not.toContain(q!.id)
  expect((await call(request, leo, 'POST', `/api/questions/${q!.id}/answer`, { json: { choice: QUESTION_ASKED.options[0] } })).status).toBe(404)
  // The run waits on the answer, across a hard kill of every runner (P6 acceptance 10).
  expect((await runs())[0]).toMatchObject({ outcome: 'running', manual: true })
  await killRunners(request)

  const answered = await call(request, dana, 'POST', `/api/questions/${q!.id}/answer`, { json: { choice: QUESTION_ASKED.options[0] } })
  expect(answered.status, answered.text).toBe(200)
  expect(answered.json).toMatchObject({ id: q!.id, state: 'answered', answer: QUESTION_ASKED.options[0] })
  // The run resumes with the answer and finishes.
  await expect.poll(async () => (await runs())[0]?.outcome, { timeout: 300_000, intervals: [2_000], message: "the routine's run finishes" }).toBe('done')
})
