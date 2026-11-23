// Memory search matches word forms on the real D1 (migration 0142, eval R02). D1's docs list FTS5 but don't name its
// porter tokenizer, so the unit tests (workerd's local D1) can't prove the sandbox's D1 has it: this spec does. A scripted
// turn saves "Zorblats are accepted within 45 days." through the agent's memory_save (no route makes a fact), and a second
// chat's scripted turn runs memory_search for "zorblat". The word is made up, so whatever else the sandbox's D1 holds,
// only the saved fact's stem can match it, and only under porter (unicode61 alone keeps "zorblats" and "zorblat" apart).
// The scripted model answers `hits=<n> match=<yes|no>` for what the search returned (app/test/scripted-model/scenarios.ts,
// `memory-recall-stem`), so a failure says what it saw. Needs a container: it runs on the per-PR test deployment
// (E2E_TEST_BUILD_REMOTE) and skips elsewhere.
import { expect, test } from '@playwright/test'
import type { APIRequestContext } from '@playwright/test'
import { actor, call } from './kit.ts'
import { answerOf, createChat, needsContainer, send, textOf } from './chat-kit.ts'

const dana = actor('memberA')
// Literals, not imports: the oracle is what the scenarios are written to say.
const FACT = 'Zorblats are accepted within 45 days.'

/** Forgets every active line of Dana's that holds FACT, so each run starts from none (the sandbox's D1 outlives a run). */
async function forgetFact(request: APIRequestContext): Promise<number> {
  const page = await call(request, dana, 'GET', '/api/memory')
  expect(page.status, page.text).toBe(200)
  const lines = (page.json.personal as { key: string; text: string; rev: number }[]).filter(l => l.text === FACT)
  for (const l of lines) {
    const r = await call(request, dana, 'PUT', `/api/memory/personal/${l.key}/forgotten`, { json: { forgotten: true, ifRev: l.rev } })
    expect(r.status, r.text).toBe(200)
  }
  return lines.length
}

test('memory search for "zorblat" finds the one saved "Zorblats" fact', async ({ request }) => {
  needsContainer()
  test.setTimeout(300_000)
  await forgetFact(request)

  const saveChat = await createChat(request, dana)
  const saved = await send(request, dana, saveChat, 'scenario:memory-save-stem remember the zorblats window')
  expect(textOf(await answerOf(request, dana, saveChat, saved.turnId, 150_000))).toBe('Saved.')

  const askChat = await createChat(request, dana)
  const asked = await send(request, dana, askChat, 'scenario:memory-recall-stem what is the zorblat window?')
  expect(textOf(await answerOf(request, dana, askChat, asked.turnId, 150_000))).toBe('hits=1 match=yes')

  expect(await forgetFact(request), 'the save made one line').toBe(1)
})
