// Stage 1 M2-J (M2 acceptance; N2, N14; P6 acceptance 1 and 12). Two parts:
//  1. On the local test build (CI's `test-build`, no container): the build every read spec runs on has no operation on
//     and seeds no permission, so "with zero grants every existing read test still passes" is the plain state of that
//     job; a write spec that turns an operation on turns it off again (each one's own teardown).
//  2. On the sandbox deploy (`needsContainer()`, the scripted model `action-late-answer` in
//     test/scripted-model/scenarios/acceptance.ts): the agent's write call waits 2 minutes for the person and then
//     returns "waiting" (the egress's poll, N14 step 4: 120 s); the turn ends saying so and nothing is sent. The person
//     answers late: the action goes out once after its hold and the server sends one resume turn into the chat (M2-G's
//     action texts), which the scripted turn accepts only if it is Inhouse's note naming the card as gone out.
// The oracles (the 120 s, the words) are the plan's, written out here; the operation is turned on only through the
// test-fakes hook (N2, N19) and off again after.
import { readdirSync, readFileSync } from 'node:fs'
import { expect, test } from '@playwright/test'
import type { APIRequestContext } from '@playwright/test'
import { LATE_DONE, LATE_STARTED, LATE_TAG, LATE_TITLE, LATE_WAITING } from '../../test/scripted-model/scenarios/acceptance.ts'
import { answerOf, createChat, needsContainer, send, textOf } from './chat-kit.ts'
import { readSql } from './db.ts'
import { hook, hubCall, setCeiling } from './fakes-kit.ts'
import { actor, call } from './kit.ts'

const dana = actor('memberA')
const TAG_ADD = 'shopify.order.tag_add'
/** N14 step 4: the egress waits at most this long for the person's answer. */
const WAIT_MAX_MS = 120_000
test.describe.configure({ mode: 'serial' })

const appRoot = new URL('../../', import.meta.url)
/** Every `.sql` and `.ts` file under `dir` (relative to app/), tests left out, as [path, text]. */
const filesUnder = (dir: string): [string, string][] =>
  (readdirSync(new URL(`${dir}/`, appRoot), { recursive: true }) as string[])
    .filter(f => (f.endsWith('.sql') || f.endsWith('.ts')) && !f.endsWith('.test.ts'))
    .map(f => [`${dir}/${f}`, readFileSync(new URL(`${dir}/${f}`, appRoot), 'utf8')] as [string, string])

test('zero grants: no migration or seed turns an operation on or makes a permission, and the read specs run with none on', () => {
  for (const [file, text] of [...filesUnder('server/migrations'), ...filesUnder('server/seed')]) {
    expect(text, `${file} seeds no ceiling row`).not.toMatch(/INSERT\s+(OR\s+\w+\s+)?INTO\s+permission_ceiling/i)
    expect(text, `${file} seeds no permission`).not.toMatch(/INSERT\s+(OR\s+\w+\s+)?INTO\s+permission_grants/i)
  }
  // The local D1 as the read specs find it: no operation on (a write spec's teardown turns its own off again) and no live
  // permission (this spec runs before any spec that makes one: the api project runs first, files in name order).
  expect(readSql('SELECT operation FROM permission_ceiling WHERE enabled = 1')).toEqual([])
  expect(readSql('SELECT id FROM permission_grants WHERE revoked_at_ms IS NULL')).toEqual([])
})

interface Card { id: string; rev: number; state: string; kind: string; askedAt: { ms: number } }
const cardsOf = async (request: APIRequestContext, chatId: string): Promise<Card[]> => {
  const r = await call(request, dana, 'GET', `/api/actions?chatId=${encodeURIComponent(chatId)}`)
  expect(r.status, r.text).toBe(200)
  return r.json.items as Card[]
}
const lateWrites = async (request: APIRequestContext): Promise<number> => {
  const r = await hook(request, { op: 'state' })
  expect(r.status, r.text).toBe(200)
  return (r.json.shopifyWrite as { writes: { variables: { tags?: string[] } }[] }).writes.filter(w => w.variables.tags?.includes(LATE_TAG)).length
}
interface Msg { role: string; turnId: string; pos: number; at: { ms: number }; part?: { type: string; text?: string } }
const messagesOf = async (request: APIRequestContext, chatId: string): Promise<Msg[]> => {
  const r = await call(request, dana, 'GET', `/api/chats/${chatId}`)
  expect(r.status, r.text).toBe(200)
  return r.json.messages as Msg[]
}

test.describe('the 2-minute wait and the late answer (sandbox)', () => {
  test.beforeAll(async ({ request }) => {
    if (!process.env.E2E_TEST_BUILD_REMOTE) return
    // The Shopify account answers a read (its grant), so the hub calls it active and the write path can use it.
    expect((await hubCall(request, 'callTool', 'orders_search', { first: 1 })).ok).toBe(true)
    // A run of this spec that was killed may have left a permission for this operation: none may skip the card.
    const perms = await call(request, dana, 'GET', '/api/permissions')
    expect(perms.status, perms.text).toBe(200)
    for (const p of perms.json.items as { id: string; rev: number; operation: string; can: { remove: boolean } }[]) {
      if (p.operation !== TAG_ADD || !p.can.remove) continue
      const r = await call(request, dana, 'POST', `/api/permissions/${p.id}/remove`, { json: { ifRev: p.rev } })
      expect(r.status, r.text).toBe(200)
    }
    await setCeiling(request, TAG_ADD, true)
  })
  test.afterAll(async ({ request }) => {
    if (!process.env.E2E_TEST_BUILD_REMOTE) return
    await setCeiling(request, TAG_ADD, false)
  })

  test('nobody answers for 2 minutes: the call returns "waiting" and nothing goes out; a late Allow once sends it once and resumes the chat', async ({ request }) => {
    needsContainer()
    test.setTimeout(600_000)
    const before = await lateWrites(request)
    const chat = await createChat(request, dana)
    const sent = await send(request, dana, chat, 'scenario:action-late-answer tag order 9001')

    // The card appears while the call waits. Nobody answers it.
    let card: Card | undefined
    await expect.poll(async () => (card = (await cardsOf(request, chat))[0]) !== undefined, { timeout: 120_000, intervals: [1_000], message: 'the card appears' }).toBe(true)
    expect(card).toMatchObject({ state: 'waiting', kind: 'ask' })

    // The turn ends only after the wait: its answer says it's waiting, and was written at least 2 minutes after the card.
    const answer = await answerOf(request, dana, chat, sent.turnId, 300_000)
    expect(textOf(answer)).toBe(`${LATE_STARTED}\n${LATE_WAITING}`)
    const stored = await messagesOf(request, chat)
    const writtenAt = Math.max(...stored.filter(m => m.turnId === sent.turnId && m.role === 'agent').map(m => m.at.ms))
    expect(writtenAt - card!.askedAt.ms).toBeGreaterThanOrEqual(WAIT_MAX_MS)
    expect((await cardsOf(request, chat)).map(c => [c.id, c.state])).toEqual([[card!.id, 'waiting']])
    expect(await lateWrites(request)).toBe(before)
    // The turn's stored messages carry the card's `ask` part.
    expect(stored.filter(m => m.turnId === sent.turnId && m.part?.type === 'ask').length).toBe(1)

    // The late answer: Allow once, after the turn has ended. It goes out once, after its hold.
    const allowed = await call(request, dana, 'POST', `/api/actions/${card!.id}/answer`, { json: { choice: 'once', ifRev: card!.rev } })
    expect(allowed.status, allowed.text).toBe(200)
    expect(allowed.json).toMatchObject({ state: 'approved', title: LATE_TITLE })
    await expect.poll(async () => (await cardsOf(request, chat))[0]?.state, { timeout: 90_000, intervals: [1_000], message: 'the card goes out' }).toBe('sent')
    expect(await lateWrites(request)).toBe(before + 1)

    // The server sends the result into the chat as one resume turn, and the agent answers it. The scripted turn accepts
    // only Inhouse's note that names the card and says it went out (scenarios/acceptance.ts `resumeNote`).
    let resumed: Msg[] = []
    await expect.poll(async () => {
      resumed = (await messagesOf(request, chat)).filter(m => m.role === 'agent' && m.turnId !== sent.turnId && m.part?.type === 'text')
      return resumed.map(m => m.part!.text)
    }, { timeout: 240_000, intervals: [2_000], message: 'the resume turn\'s answer' }).toEqual([LATE_DONE])
    // One resume turn, and nothing sent again.
    expect(new Set(resumed.map(m => m.turnId)).size).toBe(1)
    expect(await lateWrites(request)).toBe(before + 1)
  })
})
