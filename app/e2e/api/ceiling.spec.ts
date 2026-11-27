// Stage 1 M3-C (N26, N27) on the test build: routes 150 and 151, the Inhouse ceiling, through the real Worker and its
// access matrix. The test build is the one build that compiles the ceiling's edit switch in and turns it on; the
// product-shaped refusal (`writes_off`) is proven in server/api/ceiling.test.ts, where the build can be stood in for.
// It would fail if:
//  - a member read the ceiling, or an admin or a member changed it;
//  - the Inhouse team's change didn't land at its `rev`, a stale one changed anything, or a change left no line;
//  - lowering a value didn't raise `lowered_rev`, or raising one did;
//  - the Slack channel list didn't say whether posting is on, or showed a limit other than the smaller of the alerts
//    grant's own (50 a day) and the ceiling's daily maximum.
import type { APIRequestContext } from '@playwright/test'
import { expect, test } from '@playwright/test'
import { actor, call, expectConflict, expectError } from './kit.ts'
import { auditAfter, auditMax, readSql } from './db.ts'
import { hook } from './fakes-kit.ts'

test.describe.configure({ mode: 'serial' })

const inhouse = actor('inhouse')
const admin = actor('admin')
const member = actor('memberA')
/** An operation no other spec turns on, so this one's changes can't meet another's. */
const OP = 'shopify.draft_order.create'
const POST = 'slack.channel.post'
const values = (o: Record<string, unknown> = {}) => ({ enabled: true, perDayMax: 50, unitsMax: 1, bulkThreshold: 5, batchMax: 500, ...o })

/** Both operations back off (the hook's own write, which applies whatever the row's rev). */
async function off(request: APIRequestContext) {
  for (const operation of [OP, POST]) {
    const r = await hook(request, { op: 'ceiling', operation, enabled: false, perDayMax: 50 })
    expect(r.status, r.text).toBe(200)
  }
}
test.beforeAll(async ({ request }) => { await off(request) })
test.afterAll(async ({ request }) => { await off(request) })

/** The operation's row as route 150 shows it to `who`. */
async function rowOf(request: APIRequestContext, operation: string, who = inhouse) {
  const r = await call(request, who, 'GET', '/api/ceiling')
  expect(r.status, r.text).toBe(200)
  return (r.json.items as { operation: string; rev: number | null; enabled: boolean; perDayMax: number }[]).find(i => i.operation === operation)!
}
const put = (request: APIRequestContext, who: ReturnType<typeof actor>, operation: string, body: unknown) =>
  call(request, who, 'PUT', `/api/ceiling/${operation}`, { json: body })

test('the Inhouse team and admins read every operation; a member is refused', async ({ request }) => {
  const team = await call(request, inhouse, 'GET', '/api/ceiling')
  expect(team.status, team.text).toBe(200)
  expect(team.json).toMatchObject({ can: { edit: true }, writesOff: false })
  const ops = (team.json.items as { operation: string }[]).map(i => i.operation)
  expect(ops).toEqual(expect.arrayContaining([OP, POST, 'shopify.order.tag_add', 'shopify.order.tag_remove']))
  const forAdmin = await call(request, admin, 'GET', '/api/ceiling')
  expect(forAdmin.status, forAdmin.text).toBe(200)
  expect(forAdmin.json).toMatchObject({ can: { edit: false }, writesOff: false })
  expectError(await call(request, member, 'GET', '/api/ceiling'), 403, 'forbidden')
})

test('an admin and a member are refused a change, and nothing changes', async ({ request }) => {
  const before = await rowOf(request, OP)
  // A technical route: an admin reads it, so a write is refused as read-only; a member is refused outright.
  expectError(await put(request, admin, OP, { ...values(), ifRev: before.rev }), 403, 'forbidden', 'admin_read_only')
  expectError(await put(request, member, OP, { ...values(), ifRev: before.rev }), 403, 'forbidden')
  expect(await rowOf(request, OP)).toEqual(before)
})

test('the Inhouse team changes one operation at its rev; a stale rev changes nothing; each change has its line', async ({ request }) => {
  const { memberId } = (await call(request, inhouse, 'GET', '/api/me')).json as { memberId: string }
  const start = await rowOf(request, OP)
  const mark = auditMax()
  const on = await put(request, inhouse, OP, { ...values({ perDayMax: 40 }), ifRev: start.rev })
  expect(on.status, on.text).toBe(200)
  expect(on.json).toMatchObject({ operation: OP, enabled: true, perDayMax: 40, rev: start.rev! + 1, updatedBy: memberId })
  const stale = expectConflict(await put(request, inhouse, OP, { ...values({ enabled: false }), ifRev: start.rev }))
  expect(stale).toMatchObject({ enabled: true, perDayMax: 40, rev: start.rev! + 1 })
  expect(await rowOf(request, OP)).toMatchObject({ enabled: true, perDayMax: 40 })
  const lines = auditAfter(mark).filter(l => l.action === 'ceiling.changed')
  expect(lines.map(l => [l.actor_id, JSON.parse(l.args_json).operation, JSON.parse(l.args_json).new.perDayMax])).toEqual([[memberId, OP, 40]])
})

test('lowering a value raises lowered_rev; raising one does not', async ({ request }) => {
  const lowered = () => readSql<{ lowered_rev: number }>('SELECT lowered_rev FROM permission_ceiling WHERE operation = ?', OP)[0]!.lowered_rev
  let row = await rowOf(request, OP)
  const step = async (v: Record<string, unknown>) => {
    const r = await put(request, inhouse, OP, { ...values(v), ifRev: row.rev })
    expect(r.status, r.text).toBe(200)
    row = await rowOf(request, OP)
  }
  await step({ perDayMax: 40 })
  const base = lowered()
  await step({ perDayMax: 45 })
  expect(lowered()).toBe(base)
  await step({ perDayMax: 30 })
  expect(lowered()).toBe(base + 1)
  await step({ perDayMax: 30, enabled: false })
  expect(lowered()).toBe(base + 2)
})

test("the Slack channel list says whether posting is on, with the smaller of the grant's and the ceiling's daily limit", async ({ request }) => {
  const posting = async () => (await call(request, member, 'GET', '/api/notify/channels')).json.posting
  expect(await posting()).toEqual({ on: false })
  let rev = (await rowOf(request, POST)).rev
  for (const [perDayMax, shown] of [[30, 30], [200, 50]] as const) {
    const r = await put(request, inhouse, POST, { ...values({ perDayMax }), ifRev: rev })
    expect(r.status, r.text).toBe(200)
    rev = r.json.rev
    expect(await posting(), String(perDayMax)).toEqual({ on: true, perDay: shown })
  }
  const r = await put(request, inhouse, POST, { ...values({ enabled: false }), ifRev: rev })
  expect(r.status, r.text).toBe(200)
  expect(await posting()).toEqual({ on: false })
})
