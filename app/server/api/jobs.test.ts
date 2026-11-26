// Routes 100 and 101 (Stage 1 M1-B, N3) through their handlers, on the real migrations and the real BrandAgent, with a
// job row written into its SQLite as the engine leaves one (no texts port exists yet, so no turn becomes a job on its
// own). Ways they can fail, written down first:
//  1. another person's chat or job answers anything but 404, or reaches `requireObject`; a malformed id isn't 404;
//  2. a chat with no job doesn't answer `{ job: null }`; the stored job doesn't parse as the contract's `ChatJob`;
//  3. Cancel leaves the job running, ends it twice, or answers a second Cancel with anything but the ended job.
import { runInDurableObject } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'
import { openStores } from '../db/stores.ts'
import { ctx, person, personPrincipal, reset } from '../db/test-support.ts'
import type { HandlerContext } from '../routes.ts'
import type { Principal } from '../auth/index.ts'
import { brandAgent } from '../do/brand-agent/client.ts'
import { ChatJobSchema } from '../../shared/contract/jobs.ts'
import { cancelJob, getChatJob } from './jobs.ts'

const db = env.DB
const stores = openStores(env)
const T = 1_800_000_000_000
let u = 0
const uniq = () => `${++u}${Math.random().toString(36).slice(2, 7)}`

let alice: string
let bob: string
beforeEach(async () => {
  await reset(db)
  alice = await person(stores, { email: `a-${uniq()}@example.test`, subject: `sa-${uniq()}`, role: 'member' })
  bob = await person(stores, { email: `b-${uniq()}@example.test`, subject: `sb-${uniq()}`, role: 'member' })
})

const call = async (h: (c: HandlerContext) => Promise<Response>, principal: Principal, init: { method?: string; path: string; body?: unknown; params?: Record<string, string> }) => {
  const { c, objects } = ctx(stores, principal, init)
  const res = await h({ ...c, env, ctx: {} as ExecutionContext } as HandlerContext)
  return { status: res.status, body: await res.json() as Record<string, unknown>, objects }
}
const chat = (id: string, owner: string) =>
  db.prepare('INSERT INTO chats (id, owner_id, title, created_at_ms, last_at_ms, deleted_at_ms) VALUES (?, ?, ?, ?, ?, NULL)').bind(id, owner, 'A chat', T, T).run()

const ROOT = 't_rootAAAAAAAAAAAAAAAAAA'

/** A running job of `owner` in `chatId`, with the run its events go to. */
async function job(chatId: string, owner: string): Promise<string> {
  const jobId = `j_${uniq().padEnd(22, 'A').slice(0, 22)}`
  await runInDurableObject(brandAgent(env), (_i, s) => {
    const sql = s.storage.sql
    sql.exec("INSERT INTO runs (run_id, chat_id, owner_id, state, last_seq, started_at_ms) VALUES (?, ?, ?, 'live', 0, ?)", `r_${uniq()}`, chatId, owner, T)
    sql.exec(`INSERT INTO jobs (job_id, chat_id, owner_id, root_turn_id, last_turn_id, state, gen, pending_n, started_at_ms, deadline_ms)
      VALUES (?, ?, ?, ?, ?, 'running', 0, 1, ?, ?)`, jobId, chatId, owner, ROOT, ROOT, T, T + 8 * 3_600_000)
  })
  return jobId
}

describe('route 100: GET /api/chats/:id/job', () => {
  it('the owner reads the chat\'s job (or null); another person and a malformed id are 404 before the object check', async () => {
    const id = `c-${uniq()}`
    await chat(id, alice)
    const none = await call(getChatJob, personPrincipal(alice, 'member'), { path: `/api/chats/${id}/job`, params: { id } })
    expect(none).toMatchObject({ status: 200, body: { job: null }, objects: [{ ownerId: alice }] })
    const jobId = await job(id, alice)
    const r = await call(getChatJob, personPrincipal(alice, 'member'), { path: `/api/chats/${id}/job`, params: { id } })
    expect(r.status).toBe(200)
    expect(ChatJobSchema.parse(r.body).job).toMatchObject({ jobId, chatId: id, state: 'running', outcome: null, endedAt: null, cost: null })
    const asBob = await call(getChatJob, personPrincipal(bob, 'member'), { path: `/api/chats/${id}/job`, params: { id } })
    expect(asBob).toMatchObject({ status: 404, objects: [] })
    expect((await call(getChatJob, personPrincipal(alice, 'member'), { path: '/api/chats/x/job', params: { id: '../x' } })).status).toBe(404)
  })
})

describe('route 101: POST /api/jobs/:id/cancel', () => {
  it('another person is 404 before the object check; the owner cancels once, and again answers the ended job', async () => {
    const id = `c-${uniq()}`
    await chat(id, alice)
    const jobId = await job(id, alice)
    const path = `/api/jobs/${jobId}/cancel`
    const asBob = await call(cancelJob, personPrincipal(bob, 'member'), { method: 'POST', path, params: { id: jobId }, body: {} })
    expect(asBob).toMatchObject({ status: 404, objects: [] })
    expect((await call(cancelJob, personPrincipal(alice, 'member'), { method: 'POST', path: '/api/jobs/j_x/cancel', params: { id: 'j_x' }, body: {} })).status).toBe(404)
    const own = await call(cancelJob, personPrincipal(alice, 'member'), { method: 'POST', path, params: { id: jobId }, body: {} })
    expect(own).toMatchObject({ status: 200, objects: [{ ownerId: alice }] })
    expect(ChatJobSchema.parse(own.body).job).toMatchObject({ jobId, state: 'ended', outcome: 'cancelled', cost: { minor: 0, currency: 'USD' } })
    const again = await call(cancelJob, personPrincipal(alice, 'member'), { method: 'POST', path, params: { id: jobId }, body: {} })
    expect(again.body).toEqual(own.body)
    const ended = await runInDurableObject(brandAgent(env), (_i, s) =>
      s.storage.sql.exec<{ json: string }>("SELECT json FROM events WHERE json LIKE '%job.ended%'").toArray().map(r => JSON.parse(r.json) as { jobId: string }).filter(e => e.jobId === jobId))
    expect(ended).toHaveLength(1)
  })
})
