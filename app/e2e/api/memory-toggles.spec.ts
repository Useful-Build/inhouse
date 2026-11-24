// The two memory switches honoured by the server (P6a acceptance 2 and 3). Oracles are the plan's text, written out here:
//  - `m:learn` (a person's own setting) off: the agent's person save is refused, so the Memory page stays empty; on again
//    (or reset to unset, which means on), it saves. Brand facts don't follow `m:learn`.
//  - `m:ask` (the brand's setting) on or unset: every brand save by a person's agent waits for an admin. Off: it is active at
//    once. A routine's brand save always waits, an admin's restore (route 45's undo) always waits, and turning `m:ask` off
//    approves nothing that already waits.
// The facts are made by the agent's own tool through scripted scenarios (app/test/scripted-model/scenarios.ts), so the
// checks read the pages (routes 43 and 77), never the scenario's fixed answer text. The turns need containers (the per-PR
// deployment, or the local multi-config build for the routine and the restore, which also read the local D1).
import { expect, test } from '@playwright/test'
import type { APIRequestContext } from '@playwright/test'
import { actor, call, putSetting, me } from './kit.ts'
import type { Actor } from './kit.ts'
import { readSql, writeSql } from './db.ts'
import { answerOf, createChat, needsContainer, send, textOf } from './chat-kit.ts'
import { MEMORY_REWORD_CHANGED_ANSWER, MEMORY_REWORD_LEARNING_OFF_ANSWER, MEMORY_REWORD_PERSON_ID, MEMORY_REWORD_PERSON_TEXT, MEMORY_REWORD_TEAM_ID, MEMORY_REWORD_TEAM_TEXT } from '../../test/scripted-model/scenarios.ts'
import { memberIdOf, needsLocalD1, needsWatchBuild, retireRoutines, seedRoutine } from './watch-kit.ts'
import { randomBytes } from 'node:crypto'

const dana = actor('memberA')
const admin = actor('admin')
test.describe.configure({ mode: 'serial' })

// Literals, not imports: the oracle is what the scenarios are written to save.
const PERSON_FACT = 'Likes the weekly stock report as a table.'
const TEAM_FACT = 'We restock on Fridays.'

const put = async (request: APIRequestContext, who: Actor, scope: 'personal' | 'brand', key: string, value: boolean | null) => {
  const r = await putSetting(request, who, scope, key, value)
  expect(r.status, r.text).toBe(200)
}
const personalTexts = async (request: APIRequestContext): Promise<string[]> => {
  const r = await call(request, dana, 'GET', '/api/memory')
  expect(r.status, r.text).toBe(200)
  return (r.json.personal as { text: string }[]).map(l => l.text)
}
const teamLines = async (request: APIRequestContext, text: string): Promise<{ key: string; rev: number }[]> => {
  const r = await call(request, admin, 'GET', '/api/memory')
  expect(r.status, r.text).toBe(200)
  return (r.json.team as { lines: { key: string; text: string; rev: number }[] }[]).flatMap(g => g.lines).filter(l => l.text === text)
}
const waitingLines = async (request: APIRequestContext, text: string): Promise<{ key: string; rev: number }[]> => {
  const r = await call(request, admin, 'GET', '/api/memory/waiting')
  expect(r.status, r.text).toBe(200)
  return (r.json.facts as { key: string; text: string; rev: number }[]).filter(l => l.text === text)
}

/** Each run starts and ends with none of the scenarios' facts anywhere (the sandbox's D1 outlives a run, and a duplicate would answer the first). */
async function clean(request: APIRequestContext): Promise<void> {
  const page = await call(request, dana, 'GET', '/api/memory')
  for (const l of (page.json.personal as { key: string; text: string; rev: number }[]).filter(x => x.text === PERSON_FACT)) {
    const r = await call(request, dana, 'PUT', `/api/memory/personal/${l.key}/forgotten`, { json: { forgotten: true, ifRev: l.rev } })
    expect(r.status, r.text).toBe(200)
  }
  for (const l of [...(await teamLines(request, TEAM_FACT)), ...(await waitingLines(request, TEAM_FACT))]) {
    const r = await call(request, admin, 'PUT', `/api/memory/brand/${l.key}/forgotten`, { json: { forgotten: true, ifRev: l.rev } })
    expect(r.status, r.text).toBe(200)
  }
}
const reset = async (request: APIRequestContext): Promise<void> => {
  await put(request, dana, 'personal', 'm:learn', null)
  await put(request, admin, 'brand', 'm:ask', null)
  await clean(request)
}
/** One scripted turn as Dana, run to its answer. */
async function turn(request: APIRequestContext, scenario: string): Promise<string> {
  const chat = await createChat(request, dana)
  const sent = await send(request, dana, chat, `scenario:${scenario} please remember that`)
  return textOf(await answerOf(request, dana, chat, sent.turnId, 150_000))
}
const factRow = (id: string) => readSql<{ status: string; rev: number; text: string }>('SELECT status, rev, text FROM memories WHERE id = ?', id)[0]
function seedFact(id: string, scope: 'brand' | 'person', owner: string | null, body: string, by: string): void {
  const now = Date.now()
  writeSql('DELETE FROM memories WHERE id = ?', id)
  writeSql('INSERT INTO memories (id, scope, owner_id, text, status, created_by, created_at_ms, updated_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', id, scope, owner, body, 'active', by, now, now)
}

test('`m:learn` off: the agent\'s person save is refused and the Memory page stays empty; on again it saves; reset to unset means on', async ({ request }) => {
  needsContainer()
  test.setTimeout(400_000)
  await reset(request)
  try {
    await put(request, dana, 'personal', 'm:learn', false)
    await turn(request, 'memory-save')
    expect(await personalTexts(request), 'a refused save leaves nothing on the page').not.toContain(PERSON_FACT)

    await put(request, dana, 'personal', 'm:learn', true)
    await turn(request, 'memory-save')
    expect((await personalTexts(request)).filter(t => t === PERSON_FACT), 'on again, it saves once').toHaveLength(1)
    await clean(request)

    await put(request, dana, 'personal', 'm:learn', null)
    await turn(request, 'memory-save')
    expect((await personalTexts(request)).filter(t => t === PERSON_FACT), 'unset means on').toHaveLength(1)
  } finally {
    await reset(request)
  }
})

test('`m:learn` off leaves team facts alone: they follow `m:ask`, so the agent\'s team save still waits', async ({ request }) => {
  needsContainer()
  test.setTimeout(300_000)
  await reset(request)
  try {
    await put(request, dana, 'personal', 'm:learn', false)
    await turn(request, 'memory-save-team')
    expect(await waitingLines(request, TEAM_FACT)).toHaveLength(1)
    expect(await teamLines(request, TEAM_FACT)).toHaveLength(0)
  } finally {
    await reset(request)
  }
})

test('`m:ask` on or unset: a person\'s agent\'s team save waits; turning it off approves nothing already waiting; off, the next save is active at once', async ({ request }) => {
  needsContainer()
  test.setTimeout(400_000)
  await reset(request)
  try {
    // Unset (the default) is on.
    await turn(request, 'memory-save-team')
    const [waited] = await waitingLines(request, TEAM_FACT)
    expect(waited, 'unset: the team fact waits').toBeTruthy()
    expect(waited!.rev).toBe(1)
    expect(await teamLines(request, TEAM_FACT), 'a waiting fact is on no page').toHaveLength(0)

    // Turning it off changes nothing that waits.
    await put(request, admin, 'brand', 'm:ask', false)
    expect(await waitingLines(request, TEAM_FACT)).toEqual([waited])
    expect(await teamLines(request, TEAM_FACT)).toHaveLength(0)
    await clean(request)

    // Off: active at once, on the page for a Member, not waiting.
    await turn(request, 'memory-save-team')
    expect(await waitingLines(request, TEAM_FACT)).toHaveLength(0)
    const page = await call(request, dana, 'GET', '/api/memory')
    expect((page.json.team as { lines: { text: string }[] }[]).flatMap(g => g.lines).filter(l => l.text === TEAM_FACT)).toHaveLength(1)
    await clean(request)

    // On explicitly: waits again.
    await put(request, admin, 'brand', 'm:ask', true)
    await turn(request, 'memory-save-team')
    expect(await waitingLines(request, TEAM_FACT)).toHaveLength(1)
    expect(await teamLines(request, TEAM_FACT)).toHaveLength(0)
  } finally {
    await reset(request)
  }
})

test('`m:ask` off: a routine\'s team save still waits', async ({ request }) => {
  needsWatchBuild()
  test.setTimeout(400_000)
  await reset(request)
  const creator = await memberIdOf(request, dana)
  const id = seedRoutine({ creatorId: creator, hour: 6, minute: 0, instruction: 'scenario:memory-save-team Remember that for the team.', need: 0 })
  try {
    await put(request, admin, 'brand', 'm:ask', false)
    const run = await call(request, dana, 'POST', `/api/routines/${id}/run`, { json: { clientKey: randomBytes(16).toString('hex') } })
    expect(run.status, run.text).toBe(200)
    // Wait for the fact in either list, then say which: a wrong active save fails at once, not after the timeout.
    await expect.poll(async () => (await waitingLines(request, TEAM_FACT)).length + (await teamLines(request, TEAM_FACT)).length, { timeout: 180_000, message: 'the routine saved the fact' }).toBe(1)
    expect(await teamLines(request, TEAM_FACT), 'the switch being off does not make a routine\'s fact active').toHaveLength(0)
    expect(await waitingLines(request, TEAM_FACT)).toHaveLength(1)
  } finally {
    retireRoutines()
    await reset(request)
  }
})

test('`m:ask` off: an admin\'s restore (route 45\'s undo) still waits', async ({ request }) => {
  needsLocalD1()
  await reset(request)
  const danaId = (await me(request, dana)).memberId as string
  const key = `mem_${randomBytes(16).toString('base64url')}`
  const now = Date.now()
  writeSql('INSERT INTO memories (id, scope, owner_id, text, status, created_by, created_at_ms, updated_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', key, 'brand', null, 'E2E toggles restore: returns within 45 days.', 'active', danaId, now, now)
  try {
    await put(request, admin, 'brand', 'm:ask', false)
    const forgot = await call(request, admin, 'PUT', `/api/memory/brand/${key}/forgotten`, { json: { forgotten: true, ifRev: 1 } })
    expect(forgot.status, forgot.text).toBe(200)
    const undone = await call(request, admin, 'PUT', `/api/memory/brand/${key}/forgotten`, { json: { forgotten: false, ifRev: 2 } })
    expect(undone.status, undone.text).toBe(200)
    expect(readSql<{ status: string; rev: number }>('SELECT status, rev FROM memories WHERE id = ?', key)[0]).toEqual({ status: 'waiting', rev: 3 })
    const waiting = await call(request, admin, 'GET', '/api/memory/waiting')
    expect((waiting.json.facts as { key: string }[]).map(f => f.key)).toContain(key)
  } finally {
    await put(request, admin, 'brand', 'm:ask', null)
    writeSql('DELETE FROM memories WHERE id = ?', key)
  }
})

test('`m:learn` off: the agent\'s person reword is refused with learning_off and the fact stays as it was; forgetting still works; on, the reword applies', async ({ request }) => {
  needsWatchBuild()
  test.setTimeout(400_000)
  await reset(request)
  const danaId = (await me(request, dana)).memberId as string
  const old = 'E2E toggles person fact: prefers a table.'
  seedFact(MEMORY_REWORD_PERSON_ID, 'person', danaId, old, danaId)
  try {
    await put(request, dana, 'personal', 'm:learn', false)
    expect(await turn(request, 'memory-save-reword-person'), 'the tool said learning_off').toBe(MEMORY_REWORD_LEARNING_OFF_ANSWER)
    expect(factRow(MEMORY_REWORD_PERSON_ID)).toEqual({ status: 'active', rev: 1, text: old })
    // Forgetting still works with learning off.
    const forgot = await call(request, dana, 'PUT', `/api/memory/personal/${MEMORY_REWORD_PERSON_ID}/forgotten`, { json: { forgotten: true, ifRev: 1 } })
    expect(forgot.status, forgot.text).toBe(200)
    const undone = await call(request, dana, 'PUT', `/api/memory/personal/${MEMORY_REWORD_PERSON_ID}/forgotten`, { json: { forgotten: false, ifRev: 2 } })
    expect(undone.status, undone.text).toBe(200)

    await put(request, dana, 'personal', 'm:learn', true)
    expect(await turn(request, 'memory-save-reword-person')).toBe(MEMORY_REWORD_CHANGED_ANSWER)
    expect(factRow(MEMORY_REWORD_PERSON_ID)).toMatchObject({ status: 'active', text: MEMORY_REWORD_PERSON_TEXT })
  } finally {
    await reset(request)
    writeSql('DELETE FROM memories WHERE id = ?', MEMORY_REWORD_PERSON_ID)
  }
})

test('`m:ask` off: a person\'s agent\'s team reword is active at once; a routine\'s reword still waits', async ({ request }) => {
  needsWatchBuild()
  test.setTimeout(400_000)
  await reset(request)
  const danaId = (await me(request, dana)).memberId as string
  const old = 'E2E toggles team fact: we restock on Fridays.'
  const id = seedRoutine({ creatorId: danaId, hour: 6, minute: 0, instruction: 'scenario:memory-save-reword-team Change that team fact.', need: 0 })
  try {
    await put(request, admin, 'brand', 'm:ask', false)
    seedFact(MEMORY_REWORD_TEAM_ID, 'brand', null, old, danaId)
    await turn(request, 'memory-save-reword-team')
    expect(factRow(MEMORY_REWORD_TEAM_ID), 'a person\'s agent\'s reword is active with the switch off').toEqual({ status: 'active', rev: 2, text: MEMORY_REWORD_TEAM_TEXT })

    seedFact(MEMORY_REWORD_TEAM_ID, 'brand', null, old, danaId)
    const run = await call(request, dana, 'POST', `/api/routines/${id}/run`, { json: { clientKey: randomBytes(16).toString('hex') } })
    expect(run.status, run.text).toBe(200)
    await expect.poll(() => factRow(MEMORY_REWORD_TEAM_ID)!.text, { timeout: 180_000, message: 'the routine reworded the fact' }).toBe(MEMORY_REWORD_TEAM_TEXT)
    expect(factRow(MEMORY_REWORD_TEAM_ID), 'a routine\'s reword waits whatever the switch says').toMatchObject({ status: 'waiting', rev: 2 })
  } finally {
    retireRoutines()
    await reset(request)
    writeSql('DELETE FROM memories WHERE id = ?', MEMORY_REWORD_TEAM_ID)
  }
})
