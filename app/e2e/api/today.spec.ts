// Today (P4 W3 routes 57 and 58, p4-w3.md section 5; acceptance 2 and S1's server side). Two groups:
//   1. the routes without a run: who may read and write, the body each write refuses, and an id that names nothing;
//   2. the morning check fills Today (needs the multi-config test build, `needsWatchBuild`): Run now on the system routine
//      reads the recorded store through the hub and returns the scripted `morning-check` scenario's one item, which the
//      server validates and saves; setting it aside, undoing it and a stale revision follow the brief's rules.
// Group 2 relies on the test build's scripted-model route (test/scripted-model/routes.ts): the system routine's prompt carries
// no `scenario:` marker, and the route plays `morning-check` for it; without the route the run ends `invalid_result` and the
// spec fails loud on the first check. The set-aside case reads the record's current revision first, so a D1 that earlier
// runs touched works too. The screens (Today, the problem panel) are the ship specs'. Expected answers are written here from
// the brief.
import { randomBytes } from 'node:crypto'
import { expect, test } from '@playwright/test'
import { actor, call, endLiveGrants, expectConflict, expectError, me } from './kit.ts'
import { auditWhere } from './db.ts'
import { needsWatchBuild, slotWhere } from './watch-kit.ts'
import { caseFor } from './cases.ts'

const dana = actor('memberA')
const leo = actor('memberB')
const admin = actor('admin')
const inhouse = actor('inhouse')

/** A Today item id of the right shape (`p_` + 22) that names nothing. */
const NO_ITEM = 'p_e2eNobodyAAAAAAAAAAAAA'

test.describe('routes 57 and 58 without a run', () => {
  test.describe.configure({ mode: 'serial' })
  test.beforeAll(async ({ request }) => { await endLiveGrants(request) })
  test.afterAll(async ({ request }) => { await endLiveGrants(request) })

  test('without a JWT, or with a garbage one, both routes are 401', async ({ request }) => {
    for (const key of [{ method: 'GET', pattern: '/api/today' }, { method: 'PUT', pattern: '/api/today/:id/aside' }]) {
      const c = caseFor(key)
      for (const token of [null, 'not-a-jwt']) expectError(await call(request, dana, key.method, c.path, { token, ...(c.json === undefined ? {} : { json: c.json }) }), 401, 'unauthorized')
    }
  })

  test('every Member and the Admin read the same Today, shaped { items, aside }; Inhouse needs a live grant; a query string is invalid', async ({ request }) => {
    const reads = []
    for (const who of [dana, leo, admin]) {
      const r = await call(request, who, 'GET', '/api/today')
      expect(r.status, r.text).toBe(200)
      expect(Array.isArray(r.json.items)).toBe(true)
      expect(r.json.aside && typeof r.json.aside === 'object' && !Array.isArray(r.json.aside)).toBe(true)
      reads.push(r.json)
    }
    expect(reads[1]).toEqual(reads[0])
    expect(reads[2]).toEqual(reads[0])
    expectError(await call(request, inhouse, 'GET', '/api/today'), 403, 'forbidden', 'grant_required')
    expect((await call(request, admin, 'POST', '/api/grants', { json: { hours: 1 } })).status).toBe(201)
    const read = await call(request, inhouse, 'GET', '/api/today')
    expect(read.status, `a 503 here means support.access lacks the route pattern (PR0 #237): ${read.text}`).toBe(200)
    await endLiveGrants(request)
    const bad = await call(request, dana, 'GET', '/api/today?x=1')
    expect(bad.status).toBe(400)
    expect(bad.json.error.code).toBe('invalid')
  })

  test('setting aside: an id that names nothing is 404 for every role that may write; a body that is not exactly { reason, ifRev } is 400; `declined` is not Today\'s', async ({ request }) => {
    for (const who of [dana, leo, admin]) expectError(await call(request, who, 'PUT', `/api/today/${NO_ITEM}/aside`, { json: { reason: 'snoozed', ifRev: 0 } }), 404, 'not_found')
    expectError(await call(request, dana, 'PUT', '/api/today/not-an-id/aside', { json: { reason: 'snoozed', ifRev: 0 } }), 404, 'not_found')
    expectError(await call(request, inhouse, 'PUT', `/api/today/${NO_ITEM}/aside`, { json: { reason: 'snoozed', ifRev: 0 } }), 403, 'forbidden', 'grant_required')
    for (const json of [{}, { reason: 'snoozed' }, { ifRev: 0 }, { reason: 'declined', ifRev: 0 }, { reason: 'later', ifRev: 0 }, { reason: 'snoozed', ifRev: -1 }, { reason: 'snoozed', ifRev: 0, extra: 1 }]) {
      const r = await call(request, dana, 'PUT', `/api/today/${NO_ITEM}/aside`, { json })
      expect(r.status, JSON.stringify(json)).toBe(400)
      expect(r.json.error.code).toBe('invalid')
    }
  })
})

test.describe('the morning check fills Today (S1, server side)', () => {
  needsWatchBuild()
  test.describe.configure({ mode: 'serial', timeout: 900_000 })
  interface Card { id: string; title: string }
  let card: Card
  let danaId: string

  test.beforeAll(async ({ request }) => {
    await endLiveGrants(request)
    danaId = (await me(request, dana)).memberId as string
  })
  test.afterAll(async ({ request }) => { await endLiveGrants(request) })

  test('Run now on the morning check ends, and Today holds the scripted item with its sources, the same for every person', async ({ request }) => {
    const key = randomBytes(16).toString('hex')
    const run = await call(request, leo, 'POST', '/api/routines/routine-morning-check/run', { json: { clientKey: key } })
    expect(run.status, run.text).toBe(200)
    const slot = await slotWhere('routine-morning-check', 'the manual slot to end', s => s.slot_key === `now|routine-morning-check|${key}` && s.state === 'ended', 600_000)
    expect(slot.failure, 'the run ended clean: a result that did not validate would say invalid_result').toBeNull()
    for (const who of [dana, leo, admin]) {
      const r = await call(request, who, 'GET', '/api/today')
      expect(r.status, r.text).toBe(200)
      const found = (r.json.items as (Card & { sources?: { n: string }[] })[]).find(i => i.title === 'Orders waiting to ship')
      expect(found, 'the scripted item is on Today').toBeTruthy()
      expect(found!.sources?.map(s => s.n)).toContain('#1001')
      card = found!
    }
  })

  test('set aside: a snooze leaves Today for everyone, a stale revision is a 409 with the record as it is, an undo brings the card back, and each change is audited', async ({ request }) => {
    const before = auditWhere('today.set_aside').length
    // The record's revision as it is now (0: none yet), so the spec doesn't need a fresh D1.
    const rev0 = ((await call(request, dana, 'GET', '/api/today')).json.aside[card.id]?.rev as number | undefined) ?? 0
    const snooze = await call(request, dana, 'PUT', `/api/today/${card.id}/aside`, { json: { reason: 'snoozed', ifRev: rev0 } })
    expect(snooze.status, snooze.text).toBe(200)
    expect(snooze.json).toMatchObject({ reason: 'snoozed', rev: rev0 + 1, by: danaId })
    const seenByLeo = await call(request, leo, 'GET', '/api/today')
    expect((seenByLeo.json.items as Card[]).map(i => i.id)).not.toContain(card.id)
    expect(seenByLeo.json.aside[card.id]).toMatchObject({ reason: 'snoozed', rev: rev0 + 1 })

    const stale = expectConflict(await call(request, leo, 'PUT', `/api/today/${card.id}/aside`, { json: { reason: 'dismissed', ifRev: rev0 } }))
    expect(stale).toMatchObject({ reason: 'snoozed', rev: rev0 + 1 })

    const undo = await call(request, leo, 'PUT', `/api/today/${card.id}/aside`, { json: { reason: null, ifRev: rev0 + 1 } })
    expect(undo.status, undo.text).toBe(200)
    expect(undo.json).toMatchObject({ reason: null, rev: rev0 + 2 })
    expect(((await call(request, dana, 'GET', '/api/today')).json.items as Card[]).map(i => i.id)).toContain(card.id)
    const lines = auditWhere('today.set_aside').slice(before).map(l => JSON.parse(l.args_json) as { itemId: string; reason: string | null })
    expect(lines.map(l => [l.itemId, l.reason]), 'one line per accepted change, none for the conflict').toEqual([[card.id, 'snoozed'], [card.id, null]])
  })
})
