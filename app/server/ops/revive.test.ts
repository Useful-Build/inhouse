// Route 51, `POST /api/ops/tasks/revive` (W1 PR 6, A7): the handler on the real BrandAgent and real D1 stores. The access
// row (release only, class open) is proven by the matrix oracle (auth/matrix.test.ts) and the e2e kit's case. Ways it
// can fail, written down first:
//  1. no audit line, two lines, a line with another actor or other arguments than `{ kind, id, result }`;
//  2. the revive replaces the payload, or revives a task of another kind;
//  3. an unregistered kind or a bad body reaches the object, or writes a line.
// Expected lines and bodies are literals here.
import { runInDurableObject } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'
import { openStores } from '../db/stores.ts'
import { ctx, lastLineId, reqId } from '../db/test-support.ts'
import type { Principal } from '../auth/index.ts'
import type { HandlerContext } from '../routes.ts'
import { brandAgent } from '../do/brand-agent/client.ts'
import { reviveTask } from './revive.ts'

const db = env.DB
const stores = openStores(env)
const release = (): Principal => ({ kind: 'service', name: 'release', requestId: reqId() })
const call = async (body: unknown) => {
  const { c } = ctx(stores, release(), { method: 'POST', path: '/api/ops/tasks/revive', body })
  const res = await reviveTask({ ...c, env, ctx: {} as ExecutionContext } as HandlerContext)
  return { status: res.status, body: await res.json() }
}
let mark = 0
beforeEach(async () => { mark = await lastLineId(db) })
const lines = async () => (await db.prepare("SELECT actor_id, action, target_kind, target_id, args_json FROM audit_log WHERE id > ? ORDER BY id").bind(mark).all()).results

const PAYLOAD = '{"questionId":"q_AAAAAAAAAAAAAAAAAAAAAA","chatId":"c-rev"}'
const task = (id: string) => runInDurableObject(brandAgent(env), (_i, s) =>
  s.storage.sql.exec<{ kind: string; state: string; attempts: number; payload_json: string | null }>('SELECT kind, state, attempts, payload_json FROM due_tasks WHERE id = ?', id).toArray()[0] ?? null)
const quarantine = (id: string, kind: string) => runInDurableObject(brandAgent(env), (_i, s) => {
  s.storage.sql.exec(`INSERT INTO due_tasks (id, kind, gen, due_at_ms, payload_json, attempts, state, last_error)
    VALUES (?, ?, 999999, 0, ?, 10, 'quarantined', 'd1 down') ON CONFLICT(id) DO UPDATE SET state = 'quarantined', attempts = 10`, id, kind, PAYLOAD)
})

describe('route 51: revive one quarantined task (failures 1, 2)', () => {
  it('revives it with its payload kept and writes ONE line: m_system, { kind, id, result }', async () => {
    const id = 'deferred-hook:q_AAAAAAAAAAAAAAAAAAAAAA'
    await quarantine(id, 'deferred-hook')
    expect(await call({ kind: 'deferred-hook', id })).toEqual({ status: 200, body: { result: 'revived' } })
    expect(await task(id)).toMatchObject({ kind: 'deferred-hook', state: 'ready', attempts: 0, payload_json: PAYLOAD })
    expect(await lines()).toEqual([{
      actor_id: 'm_system', action: 'ops_task_revive', target_kind: null, target_id: null,
      args_json: '{"kind":"deferred-hook","id":"deferred-hook:q_AAAAAAAAAAAAAAAAAAAAAA","result":"revived","by":"release"}',
    }])
  })

  it('a task not quarantined, or of another kind, changes nothing and still writes its one line', async () => {
    const id = 'deferred-hook:q_BBBBBBBBBBBBBBBBBBBBBB'
    await quarantine(id, 'deferred-hook')
    expect(await call({ kind: 'deferred-hook', id })).toEqual({ status: 200, body: { result: 'revived' } })
    expect(await call({ kind: 'deferred-hook', id })).toEqual({ status: 200, body: { result: 'not_quarantined' } })
    expect(await call({ kind: 'flush-turn', id })).toEqual({ status: 200, body: { result: 'not_found' } })
    expect((await lines()).map(l => JSON.parse(l.args_json as string))).toEqual([
      { kind: 'deferred-hook', id, result: 'revived', by: 'release' },
      { kind: 'deferred-hook', id, result: 'not_quarantined', by: 'release' },
      { kind: 'flush-turn', id, result: 'not_found', by: 'release' },
    ])
  })
})

describe('route 51: refused before the object (failure 3)', () => {
  it('an unregistered kind and a bad body are 400 invalid, with no line', async () => {
    const id = 'mystery:x1'
    await quarantine(id, 'mystery')
    expect(await call({ kind: 'mystery', id })).toEqual({ status: 400, body: { error: { code: 'invalid' } } })
    expect(await task(id)).toMatchObject({ state: 'quarantined', attempts: 10 })
    for (const body of [{}, { kind: 'deferred-hook' }, { kind: 'deferred-hook', id: 'x', extra: 1 }, { kind: 'Bad Kind', id: 'x' }, { kind: 'deferred-hook', id: 'has space' }]) {
      expect(await call(body), JSON.stringify(body)).toEqual({ status: 400, body: { error: { code: 'invalid' } } })
    }
    expect(await lines()).toEqual([])
  })
})
