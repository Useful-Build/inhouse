// Routes 7 to 12 against the real migrations. Ways they can fail, written down first:
//  1. a key from one scope is accepted on another scope's route, or `p:`, `photo:`, `d:support` anywhere;
//  2. a personal setting is read or written without the owner check, or the check comes after the write;
//  3. two writes with the same ifRev both apply (two tabs); a reset to null then a set lets an old ifRev match again;
//  4. a value of a key that isn't audit-safe reaches the audit log (names, emails, long text), or a line misses its hash;
//  5. a write that applied writes no line, or a refused or conflicting write writes one; an actor that isn't a member id;
//  6. a failed audit line leaves the setting changed;
//  7. an approver that isn't a person, or a model or job id nobody knows, is written.
import { fc, test } from '@fast-check/vitest'
import { env } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'
import { settingSpec } from '../../shared/contract/settings.ts'
import { objectGate } from '../auth/index.ts'
import type { AccessRow } from '../auth/matrix.ts'
import type { SettingScope } from '../../shared/contract/settings.ts'
import { redact } from '../db/audit.ts'
import { openStores } from '../db/stores.ts'
import type { Stores } from '../db/stores.ts'
import { brokenAudit, ctx, lastLineId, linesSince, person, personPrincipal, reset, snapshot } from '../db/test-support.ts'
import { getBrandSettings, getPersonalSettings, getTechnicalSettings, putBrandSetting, putPersonalSetting, putTechnicalSetting } from './settings.ts'

const db = env.DB
const stores = openStores(env)
const HASH_KEY = (env as unknown as { AUDIT_HASH_KEY: string }).AUDIT_HASH_KEY
const PUT = { personal: putPersonalSetting, brand: putBrandSetting, technical: putTechnicalSetting }
const GET = { personal: getPersonalSettings, brand: getBrandSettings, technical: getTechnicalSettings }

let u = 0
const uniq = () => `${++u}-${Math.random().toString(36).slice(2, 7)}`
let admin: string
let member: string
let inhouse: string

beforeEach(async () => {
  await reset(db)
  const k = uniq()
  admin = await person(stores, { email: `adm-${k}@example.test`, subject: `sadm-${k}`, role: 'admin' })
  member = await person(stores, { email: `mem-${k}@example.test`, subject: `smem-${k}`, role: 'member' })
  inhouse = (await stores.members.resolveInhouse({ subject: `sinh-${k}`, email: `inh-${k}@example.test`, requestId: `r-${k}`, nowMs: 1_800_000_000_000 })).memberId
})

const put = (scope: SettingScope, key: string, body: unknown, who = admin, role: 'member' | 'admin' = 'admin', s: Stores = stores) => {
  const { c, objects } = ctx(s, personPrincipal(who, role), { method: 'PUT', path: `/api/settings/${scope}/${encodeURIComponent(key)}`, params: { key }, body })
  return { res: PUT[scope](c), objects }
}
const inhousePut = (key: string, body: unknown, s: Stores = stores) => {
  const { c, objects } = ctx(s, { kind: 'inhouse', memberId: inhouse, subject: 'sub-inhouse', grant: null, requestId: `r-${uniq()}`, expMs: 4_102_444_800_000 }, { method: 'PUT', path: `/api/settings/technical/${key}`, params: { key }, body })
  return { res: putTechnicalSetting(c), objects }
}
const json = async (r: Response | Promise<Response>) => {
  const res = await r
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}

describe('scopes (failure 1)', () => {
  const samples: Record<SettingScope, [string, unknown]> = { personal: ['g:theme', 'Dark'], brand: ['g:tz', 'Europe/Paris'], technical: ['stage', 'Act'] }
  it('refuses a key on any other scope with 404 wrong_scope', async () => {
    for (const route of ['personal', 'brand', 'technical'] as const) {
      for (const [scope, [key, value]] of Object.entries(samples)) {
        if (scope === route) continue
        expect(await json(put(route, key, { value, ifRev: 0 }).res)).toEqual({ status: 404, body: { error: { code: 'not_found', reason: 'wrong_scope' } } })
      }
    }
  })
  test.prop([fc.constantFrom('personal' as const, 'brand' as const, 'technical' as const), fc.oneof(fc.constant('d:support'), fc.stringMatching(/^(p|photo):[A-Za-z0-9_-]{1,10}$/))])(
    'refuses p:, photo: and d:support on every route', async (route, key) => {
      expect(await json(put(route, key, { value: 'admin', ifRev: 0 }).res)).toEqual({ status: 404, body: { error: { code: 'not_found', reason: 'wrong_scope' } } })
    },
  )
  it('refuses an unknown key, a model or job id nobody knows (failure 7) with 404', async () => {
    for (const key of ['nope', 'tm:gpt-x:on', 'l:unknownjob', 'r:daily']) expect((await json(inhousePut(key, { value: 'off', ifRev: 0 }).res)).status).toBe(404)
    expect((await json(inhousePut('tm:fable:on', { value: 'off', ifRev: 0 }).res)).status).toBe(200)
    expect((await json(inhousePut('l:returns', { value: true, ifRev: 0 }).res)).status).toBe(200)
  })
})

describe('the owner check (failure 2)', () => {
  it('a personal read and write call requireObject with the caller as owner, before the write', async () => {
    const { res, objects } = put('personal', 'g:theme', { value: 'Dark', ifRev: 0 }, member, 'member')
    expect((await json(res)).status).toBe(200)
    expect(objects).toEqual([{ ownerId: member }])
    const read = ctx(stores, personPrincipal(member, 'member'), { path: '/api/settings/personal' })
    const list = await json(getPersonalSettings(read.c))
    expect(read.objects).toEqual([{ ownerId: member }])
    expect(list.body.items).toEqual(expect.arrayContaining([expect.objectContaining({ key: 'g:theme', value: 'Dark', rev: 1, updatedBy: member })]))
  })
  it('a refused owner check writes nothing', async () => {
    const before = await snapshot(db)
    const { c } = ctx(stores, personPrincipal(member, 'member'), { method: 'PUT', path: '/api/settings/personal/g:theme', params: { key: 'g:theme' }, body: { value: 'Dark', ifRev: 0 } })
    c.access.requireObject = () => { throw new Error('refused') }
    await expect(putPersonalSetting(c)).rejects.toThrow('refused')
    expect(await snapshot(db)).toEqual(before)
  })
  it('a technical write hands the matrix the key and the parsed value', async () => {
    const { res, objects } = inhousePut('tm:opus:on', { value: 'off', ifRev: 0 })
    expect((await json(res)).status).toBe(200)
    expect(objects).toEqual([{ settingKey: 'tm:opus:on', value: 'off' }])
  })
})

describe('with the real object gate (failure 2)', () => {
  const personalRow: AccessRow = { method: 'PUT', pattern: '/api/settings/personal/:key', class: 'personal', allow: ['member', 'admin'] }
  const technicalRow: AccessRow = { method: 'PUT', pattern: '/api/settings/technical/:key', class: 'technical', allow: ['inhouse', 'admin'], adminWrite: true }
  const gated = (row: AccessRow, who: string, key: string, value: unknown, scope: 'personal' | 'technical') => {
    const principal = personPrincipal(who, 'admin')
    const gate = objectGate(principal, row, 1_800_000_000_000)
    const { c } = ctx(stores, principal, { method: 'PUT', path: `/api/settings/${scope}/${key}`, params: { key }, body: { value, ifRev: 0 } })
    c.access = { requireObject: gate.requireObject }
    return { run: () => PUT[scope](c), gate }
  }
  it('an Admin may only switch a model off or back on; anything else is refused before it is written', async () => {
    for (const [key, value] of [['tm:sonnet:on', 'off'], ['tm:fable:on', 'on']] as const) {
      const g = gated(technicalRow, admin, key, value, 'technical')
      expect((await g.run()).status).toBe(200)
      expect(g.gate.passed).toBe(true)
    }
    // Which hosts WebFetch may read is the Inhouse team's alone (P8a S): an Admin can't list one. The web search and
    // reading switches are brand settings since M1-F (an Admin's, route 10), so they aren't technical keys any more.
    for (const [key, value] of [['tm:haiku:on', null], ['tm:haiku:effort', 'High'], ['stage', 'Run'], ['t:webfetch', 'evil.example.com']] as const) {
      const before = await snapshot(db)
      const g = gated(technicalRow, admin, key, value, 'technical')
      await expect(g.run()).rejects.toThrow()
      expect(g.gate.refusal?.reason).toBe('admin_read_only')
      expect(await snapshot(db)).toEqual(before)
    }
  })
  it('web search and reading web pages are brand switches (M1-F): an Admin flips them on route 10, only a switch value is taken, and route 12 has neither', async () => {
    for (const key of ['t:websearch', 't:webfetch_on']) {
      expect((await json(inhousePut(key, { value: true, ifRev: 0 }).res)).body, key).toEqual({ error: { code: 'not_found', reason: 'wrong_scope' } })
      expect((await put('brand', key, { value: true, ifRev: 0 }).res).status, key).toBe(200)
      expect((await put('brand', key, { value: 'on', ifRev: 1 }).res).status, key).toBe(400)
      expect((await put('brand', key, { value: false, ifRev: 1 }).res).status, key).toBe(200)
    }
  })
  it("the owner rule: a person's own settings only (the handler names the caller as owner)", async () => {
    const g = gated(personalRow, admin, 'g:theme', 'Light', 'personal')
    expect((await g.run()).status).toBe(200)
    expect(g.gate.passed).toBe(true)
  })
})

describe('ifRev (failure 3)', () => {
  test.prop([fc.constantFrom(['brand', 's:alert', '80%', '90%'] as const, ['personal', 'n:channel', '#ops', '#all'] as const, ['personal', 'g:name', 'Ann Example', 'Bo Example'] as const)], { numRuns: 6 })(
    'two writes with the same ifRev: one applies, the other is a conflict with the current record', async ([scope, key, a, b]) => {
      const who = scope === 'personal' ? member : admin
      const role = scope === 'personal' ? 'member' : 'admin'
      const start = key === 'g:name' ? (await stores.members.get(who))!.rev : 0
      const first = await json(put(scope, key, { value: a, ifRev: start }, who, role).res)
      expect(first.status).toBe(200)
      const second = await json(put(scope, key, { value: b, ifRev: start }, who, role).res)
      expect(second).toEqual({ status: 409, body: { error: { code: 'conflict', current: first.body } } })
    },
  )
  it('a reset to null bumps rev, and an old ifRev never matches again', async () => {
    const w = (value: unknown, ifRev: number) => json(put('brand', 'm:ask', { value, ifRev }).res)
    expect((await w(true, 0)).body).toMatchObject({ value: true, rev: 1 })
    expect((await w(null, 1)).body).toMatchObject({ value: null, rev: 2 })
    expect((await w(false, 0)).status).toBe(409)
    expect((await w(false, 1)).status).toBe(409)
    expect((await w(false, 2)).body).toMatchObject({ value: false, rev: 3 })
  })
  it('a missing ifRev or a bad value is 400 invalid', async () => {
    for (const body of [{ value: true }, { value: 'yes', ifRev: 0 }, { ifRev: 0 }, { value: true, ifRev: -1 }, { value: true, ifRev: 0, extra: 1 }]) {
      expect(await json(put('brand', 'm:ask', body).res)).toEqual({ status: 400, body: { error: { code: 'invalid' } } })
    }
  })
})

describe('redaction (failure 4)', () => {
  const redactedKeys = [['personal', 'g:name'], ['personal', 'n:channel'], ['technical', 't:signs'], ['technical', 'g:mode']] as const
  const valueArb = fc.oneof(fc.string({ minLength: 1, maxLength: 80 }), fc.emailAddress().filter(e => e.length <= 80), fc.constantFrom('Dana Kim', 'dana@northline.example'))
    .filter(v => v.trim().length > 0)
  test.prop([fc.constantFrom(...redactedKeys), valueArb], { numRuns: 60 })('a key that is not audit-safe keeps only its length and hash', async ([scope, key], raw) => {
    expect(settingSpec(key)!.auditSafe).toBe(false)
    const before = await lastLineId(db)
    const ifRev = key === 'g:name' ? (await stores.members.get(member))!.rev : (await stores.settings.list(scope === 'personal' ? member : 'brand', scope)).find(r => r.key === key)?.rev ?? 0
    const res = scope === 'personal' ? put(scope, key, { value: raw, ifRev }, member, 'member').res : inhousePut(key, { value: raw, ifRev }).res
    const out = await json(res)
    expect(out.status).toBe(200)
    const value = out.body.value as string
    const lines = await linesSince(db, before)
    expect(lines).toHaveLength(1)
    const args = JSON.parse(lines[0].args_json)
    const expected = { scope, key, redacted: await redact(HASH_KEY, value) }
    expect(args).toEqual(expected)
    // The raw text must not appear in the line, unless it's already part of the line's own parts (the value "name" is in
    // the key "g:name", a hex value can be in the hash): the toEqual above already rules out any extra field.
    const needle = JSON.stringify(value).slice(1, -1)
    if (value.length >= 4 && !JSON.stringify(expected).includes(needle)) expect(lines[0].args_json).not.toContain(needle)
  })
  it('no email appears in any line', async () => {
    const rows = await linesSince(db, 0)
    for (const l of rows) expect(l.args_json).not.toMatch(/@example\.test/)
  })
})

describe('one write, one line (failure 5)', () => {
  type W = { scope: SettingScope; key: string; value: unknown; stale: boolean; as: 'admin' | 'member' }
  const writeArb: fc.Arbitrary<W> = fc.oneof(
    fc.record({ scope: fc.constant('brand' as const), key: fc.constantFrom('m:ask', 's:alert', 'a:0'), value: fc.constantFrom<unknown>(true, '80%', 'anyone', 'm_nobody', null, 'bad'), stale: fc.boolean(), as: fc.constantFrom('admin' as const, 'member' as const) }),
    fc.record({ scope: fc.constant('personal' as const), key: fc.constantFrom('g:theme', 'n:channel', 'g:name'), value: fc.constantFrom<unknown>('Dark', '#ops', 'Lee Example', null, 7), stale: fc.boolean(), as: fc.constant('member' as const) }),
  )
  test.prop([fc.array(writeArb, { minLength: 1, maxLength: 10 })], { numRuns: 40 })('the log grows by one line per change that applied, none otherwise; the actor is the writer', async writes => {
    for (const w of writes) {
      const who = w.as === 'admin' ? admin : member
      const owner = w.scope === 'personal' ? who : 'brand'
      const current = w.key === 'g:name' ? (await stores.members.get(who))!.rev : (await stores.settings.list(owner, w.scope)).find(r => r.key === w.key)?.rev ?? 0
      const before = await lastLineId(db)
      const out = await json(put(w.scope, w.key, { value: w.value, ifRev: w.stale ? current + 1 : current }, who, w.as).res)
      const lines = await linesSince(db, before)
      expect(lines).toHaveLength(out.status === 200 ? 1 : 0)
      if (out.status === 200) expect(lines[0]).toMatchObject({ actor_id: who, action: 'setting.changed', target_id: w.key })
    }
  })
})

describe('one transaction (failure 6)', () => {
  it('a failed audit line leaves every setting write unapplied', async () => {
    const broken = openStores(env, brokenAudit)
    await put('brand', 's:alert', { value: '80%', ifRev: 0 }).res
    const cases: (() => Promise<Response>)[] = [
      () => put('brand', 's:alert', { value: '90%', ifRev: 1 }, admin, 'admin', broken).res,
      () => put('brand', 'g:tz', { value: 'Europe/Paris', ifRev: 0 }, admin, 'admin', broken).res,
      () => put('personal', 'g:name', { value: 'Never Example', ifRev: 2 }, member, 'member', broken).res,
      () => inhousePut('stage', { value: 'Run', ifRev: 0 }, broken).res,
    ]
    for (const run of cases) {
      const before = await snapshot(db)
      await expect(run()).rejects.toThrow()
      expect(await snapshot(db)).toEqual(before)
    }
  })
})

describe('approvers (failure 7)', () => {
  it('takes anyone or an open person row, nothing else', async () => {
    expect((await json(put('brand', 'a:0', { value: member, ifRev: 0 }).res)).status).toBe(200)
    expect(await json(put('brand', 'a:1', { value: 'm_nobody', ifRev: 0 }).res)).toEqual({ status: 400, body: { error: { code: 'invalid' } } })
    expect(await json(put('brand', 'a:1', { value: 'm_system', ifRev: 0 }).res)).toEqual({ status: 400, body: { error: { code: 'invalid' } } })
    expect((await json(put('brand', 'a:1', { value: 'anyone', ifRev: 0 }).res)).status).toBe(200)
  })
})

describe('reads', () => {
  it('brand and technical share an owner but list only their own scope', async () => {
    await put('brand', 'g:tz', { value: 'Europe/Paris', ifRev: 0 }).res
    await inhousePut('stage', { value: 'Act', ifRev: 0 }).res
    const brand = await json(GET.brand(ctx(stores, personPrincipal(member, 'member'), { path: '/api/settings/brand' }).c))
    const tech = await json(GET.technical(ctx(stores, personPrincipal(member, 'member'), { path: '/api/settings/technical' }).c))
    expect((brand.body.items as { key: string }[]).map(i => i.key)).toEqual(['g:tz'])
    expect((tech.body.items as { key: string }[]).map(i => i.key)).toEqual(['stage'])
  })
})
