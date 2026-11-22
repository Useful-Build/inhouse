// Memory search matches word forms on the real D1 (migration 0142, eval R02). D1's docs list FTS5 but don't name its
// porter tokenizer, so the unit tests (workerd's local D1) can't prove the sandbox's D1 has it: this spec does. A scripted
// turn saves "Returns are accepted within 45 days." through the agent's memory_save (no route makes a fact), and a second
// chat's scripted turn runs memory_search for "return". The scripted model answers `From memory: <fact>` only when that
// search returned exactly that one fact (app/test/scripted-model/scenarios.ts, `memory-recall-returns`). Needs a
// container: it runs on the per-PR test deployment (E2E_TEST_BUILD_REMOTE) and skips elsewhere.
import { expect, test } from '@playwright/test'
import type { APIRequestContext } from '@playwright/test'
import { actor, call } from './kit.ts'
import { answerOf, createChat, needsContainer, send, textOf } from './chat-kit.ts'

const dana = actor('memberA')
// Literals, not imports: the oracle is what the scenarios are written to say.
const FACT = 'Returns are accepted within 45 days.'

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

test('memory search for "return" finds the one saved "Returns" fact', async ({ request }) => {
  needsContainer()
  test.setTimeout(300_000)
  await forgetFact(request)

  const saveChat = await createChat(request, dana)
  const saved = await send(request, dana, saveChat, 'scenario:memory-save-returns remember our returns window')
  expect(textOf(await answerOf(request, dana, saveChat, saved.turnId, 150_000))).toBe('Saved.')

  const askChat = await createChat(request, dana)
  const asked = await send(request, dana, askChat, 'scenario:memory-recall-returns what is the return window policy?')
  expect(textOf(await answerOf(request, dana, askChat, asked.turnId, 150_000))).toBe(`From memory: ${FACT}`)

  expect(await forgetFact(request), 'the save made one line').toBe(1)
})
