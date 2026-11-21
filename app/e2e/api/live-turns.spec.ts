// A turn that is live (p3-design 4.3 and 4.11; acceptance 1 and 9): pause, interrupt and stop act on the right turn, by id,
// and each ending is what the stream shows live and what a reload shows after. Every test needs a container (the per-PR
// deployment, `needsContainer()`), and plays the scripted model's `slow-bash` scenario: one Bash call that sleeps 20 s, so the
// turn stays live while the test acts. No real model is called.
// Oracles, from the design and the projection's contract (projection.ts `endRow`), not from a response captured first:
//   - interrupt and stop answer `{ ok: true }` on a live turn and 409 `turn_ended` once it is fenced; the stream's `turn.finished`
//     carries outcome `interrupted` or `stopped`; the stored history keeps the person's message and an end row `<turnId>.x`
//     (an event message whose `end` is `{ outcome }`), and the one agent part the turn said before its Bash call (`<turnId>.0`,
//     "Waiting a while."): the turn never reached its answer, so nothing says "Done waiting.";
//   - stopping a queued turn by its id ends that turn only: the live one carries on until its own stop;
//   - pause fences a live turn with `turn.cancelled { why: 'paused' }` (and a `paused` notice), never `turn.finished`; a send
//     while paused is 403 `paused`; a turn that went live and was cancelled keeps its user and agent rows but no end row; resume
//     starts nothing.
// Each test sets a 180 s timeout: the api project's 60 s cap is shorter than the first wait (a cold container start).
import { expect, test } from '@playwright/test'
import type { APIRequestContext } from '@playwright/test'
import { actor, call, expectError } from './kit.ts'
import { Tab, createChat, needsContainer, send, sendTurn } from './chat-kit.ts'
import type { Sent } from './chat-kit.ts'

const dana = actor('memberA')
const admin = actor('admin')
test.describe.configure({ mode: 'serial' })

interface Stored { id: string; role: string; turnId: string; end?: Record<string, unknown>; part?: unknown }
const stored = async (request: APIRequestContext, chat: string): Promise<Stored[]> => {
  const r = await call(request, dana, 'GET', `/api/chats/${chat}`)
  expect(r.status, r.text).toBe(200)
  return r.json.messages as Stored[]
}

/** What a test holds while it runs, filled in as it goes, so a setup that throws halfway still closes the tab and stops the turns. */
interface Ctx { chat?: string; tab?: Tab; turns: string[] }
const newCtx = (): Ctx => ({ turns: [] })

/** Opens a chat and a tab, sends a `slow-bash` turn and waits until it is live: its tool step reached the tab. */
async function liveTurn(request: APIRequestContext, ctx: Ctx, text = 'scenario:slow-bash wait for me'): Promise<{ chat: string; tab: Tab; sent: Sent }> {
  const chat = (ctx.chat = await createChat(request, dana))
  const tab = (ctx.tab = await Tab.open(dana))
  const sent = await send(request, dana, chat, text)
  ctx.turns.push(sent.turnId)
  tab.attach(sent.runId, 0)
  await tab.until(() => tab.frames(sent.runId).some(f => f.event.type === 'step' && f.event.turnId === sent.turnId), 'the turn to run its Bash call', 120_000)
  return { chat, tab, sent }
}

const finishedOutcome = (tab: Tab, turnId: string): unknown => tab.frames().find(f => f.event.type === 'turn.finished' && f.event.turnId === turnId)?.event.outcome

/** What every test leaves behind must not run on into the next: stop whatever it started (a stop on an ended turn is a harmless 409). */
const cleanup = async (request: APIRequestContext, ctx: Ctx) => {
  ctx.tab?.close()
  for (const t of ctx.turns) await call(request, dana, 'POST', `/api/turns/${t}/stop`, { json: {} })
  await call(request, admin, 'POST', '/api/resume', { json: {} })
}

/** The turn's agent rows: the one thing a `slow-bash` turn says before its Bash call. */
const agentRows = (rows: Stored[], turnId: string) => rows.filter(m => m.role === 'agent' && m.turnId === turnId)
const SAID = { id: expect.stringMatching(/\.0$/), role: 'agent', part: { type: 'text', text: 'Waiting a while.' } }

for (const action of ['stop', 'interrupt'] as const) {
  const outcome = action === 'stop' ? 'stopped' : 'interrupted'
  test(`${action} on a live turn answers { ok: true }, the stream says ${outcome}, a second ${action} is turn_ended, and a reload keeps the end row`, async ({ request }) => {
    needsContainer()
    test.setTimeout(180_000)
    const ctx = newCtx()
    try {
      const { chat, tab, sent } = await liveTurn(request, ctx)
      const r = await call(request, dana, 'POST', `/api/turns/${sent.turnId}/${action}`, { json: {} })
      expect(r.status, r.text).toBe(200)
      expect(r.json).toEqual({ ok: true })
      await tab.until(() => tab.turnFinished(sent.turnId), `the turn to finish ${outcome}`, 120_000)
      expect(finishedOutcome(tab, sent.turnId)).toBe(outcome)
      expectError(await call(request, dana, 'POST', `/api/turns/${sent.turnId}/${action}`, { json: {} }), 409, 'conflict', 'turn_ended')
      // After a reload: the person's message, and the end row of how it ended; the turn never answered, so no agent part.
      await expect.poll(async () => (await stored(request, chat)).some(m => m.id === `${sent.turnId}.x`), { timeout: 60_000, message: 'the stored end row' }).toBe(true)
      const rows = await stored(request, chat)
      expect(rows.find(m => m.id === `${sent.turnId}.x`)).toMatchObject({ role: 'event', turnId: sent.turnId, end: { outcome } })
      expect(rows.find(m => m.id === `${sent.turnId}.u`)).toMatchObject({ role: 'user', text: 'scenario:slow-bash wait for me' })
      // The one part it said before its Bash call is stored as `<turnId>.0`; the answer after the call never came.
      expect(agentRows(rows, sent.turnId)).toEqual([expect.objectContaining({ ...SAID, id: `${sent.turnId}.0` })])
      expect(JSON.stringify(rows)).not.toContain('Done waiting.')
    } finally {
      await cleanup(request, ctx)
    }
  })
}

test('stopping a queued turn by its id ends that turn only: the live turn carries on until its own stop', async ({ request }) => {
  needsContainer()
  test.setTimeout(180_000)
  const ctx = newCtx()
  try {
    const { chat, tab, sent: live } = await liveTurn(request, ctx)
    const queued = await send(request, dana, chat, 'scenario:slow-bash and then me')
    ctx.turns.push(queued.turnId)
    expect(queued).toMatchObject({ runId: live.runId, position: 'queued' })
    const r = await call(request, dana, 'POST', `/api/turns/${queued.turnId}/stop`, { json: {} })
    expect(r.status, r.text).toBe(200)
    expect(r.json).toEqual({ ok: true })
    await tab.until(() => tab.turnFinished(queued.turnId), 'the queued turn to finish', 60_000)
    expect(finishedOutcome(tab, queued.turnId)).toBe('stopped')
    // The live turn did not end with it, and its own id still stops it.
    expect(tab.turnFinished(live.turnId)).toBe(false)
    const own = await call(request, dana, 'POST', `/api/turns/${live.turnId}/stop`, { json: {} })
    expect(own.status, own.text).toBe(200)
    await tab.until(() => tab.turnFinished(live.turnId), 'the live turn to finish', 120_000)
    expect(finishedOutcome(tab, live.turnId)).toBe('stopped')
    await expect.poll(async () => (await stored(request, chat)).filter(m => m.role === 'event').length, { timeout: 60_000, message: 'both end rows' }).toBe(2)
    const rows = await stored(request, chat)
    for (const id of [live.turnId, queued.turnId]) expect(rows.find(m => m.id === `${id}.x`)).toMatchObject({ role: 'event', end: { outcome: 'stopped' } })
  } finally {
    await cleanup(request, ctx)
  }
})

test('pause fences a live turn with turn.cancelled paused, refuses sends while paused, and resuming starts nothing', async ({ request }) => {
  needsContainer()
  test.setTimeout(180_000)
  const ctx = newCtx()
  try {
    const { chat, tab, sent } = await liveTurn(request, ctx)
    const paused = await call(request, admin, 'POST', '/api/pause', { json: {} })
    expect(paused.status, paused.text).toBe(200)
    expect(paused.json.paused).toBe(true)
    expect((await call(request, dana, 'GET', '/api/pause')).json.paused).toBe(true)
    // The stream: a `paused` notice, then the turn cancelled for that reason: it never finishes as a normal end.
    await tab.until(() => tab.frames(sent.runId).some(f => f.event.type === 'turn.cancelled' && f.event.turnId === sent.turnId), 'the turn to be cancelled', 60_000)
    const cancelled = tab.frames(sent.runId).find(f => f.event.type === 'turn.cancelled' && f.event.turnId === sent.turnId)!
    expect(cancelled.event).toMatchObject({ type: 'turn.cancelled', turnId: sent.turnId, why: 'paused' })
    expect(tab.frames(sent.runId).some(f => f.event.type === 'notice' && f.event.code === 'paused')).toBe(true)
    expect(tab.turnFinished(sent.turnId)).toBe(false)
    // Nothing new while paused.
    expectError(await sendTurn(request, dana, chat, 'scenario:hello are you there?'), 403, 'forbidden', 'paused')
    // The history after a reload: the person's message and the part it said before the Bash call, and no end row (a turn that
    // went live and was cancelled keeps none, projection.ts endRow).
    await expect.poll(async () => (await stored(request, chat)).some(m => m.id === `${sent.turnId}.u`), { timeout: 60_000, message: 'the turn\'s stored rows' }).toBe(true)
    const rows = await stored(request, chat)
    expect(rows.filter(m => m.turnId === sent.turnId).map(m => m.role).sort()).toEqual(['agent', 'user'])
    expect(rows.some(m => m.id === `${sent.turnId}.x`)).toBe(false)
    expect(agentRows(rows, sent.turnId)).toEqual([expect.objectContaining({ ...SAID, id: `${sent.turnId}.0` })])
    // Resume starts nothing: the refused send was not kept, and no run of this chat comes back.
    expect((await call(request, admin, 'POST', '/api/resume', { json: {} })).json.paused).toBe(false)
    const after = await stored(request, chat)
    expect(after.filter(m => m.role === 'user')).toHaveLength(1)
    await expect.poll(async () => ((await call(request, dana, 'GET', `/api/chats/${chat}`)).json.runs as { live: boolean }[]).some(r => r.live), { timeout: 60_000, message: 'the cancelled turn\'s run to stop being live' }).toBe(false)
  } finally {
    await cleanup(request, ctx)
  }
})
