// MeSchema's failure modes first: an unknown CanKey, a missing CanKey and a role outside the three must all fail.
import { describe, expect, it } from 'vitest'
import { fc, test } from '@fast-check/vitest'
import { CanKeySchema, MeSchema, RoleSchema } from './me.ts'

const keys = CanKeySchema.options
const allCan = (v: boolean) => Object.fromEntries(keys.map(k => [k, v]))
const at = Date.parse('2026-11-20T10:00:00.000Z')
const valid = {
  memberId: 'm_test',
  name: 'Test Person',
  email: 'person@example.test',
  role: 'admin',
  can: allCan(true),
  photoUrl: null,
  grant: null,
}

describe('MeSchema', () => {
  it('accepts a whole Me', () => {
    expect(MeSchema.safeParse(valid).success).toBe(true)
    expect(MeSchema.safeParse({ ...valid, role: 'inhouse', grant: { id: 'g_1', endsAt: { iso: new Date(at).toISOString(), ms: at } } }).success).toBe(true)
  })

  test.prop([fc.string().filter(s => !(keys as readonly string[]).includes(s) && s !== '__proto__')])(
    'rejects an unknown CanKey', extra => {
      expect(MeSchema.safeParse({ ...valid, can: { ...allCan(false), [extra]: true } }).success).toBe(false)
    })

  test.prop([fc.constantFrom(...keys)])('rejects a missing CanKey', missing => {
    const can: Record<string, boolean> = allCan(true)
    delete can[missing]
    expect(MeSchema.safeParse({ ...valid, can }).success).toBe(false)
  })

  test.prop([fc.string().filter(s => !(RoleSchema.options as readonly string[]).includes(s))])(
    'rejects a role outside the three', role => {
      expect(MeSchema.safeParse({ ...valid, role }).success).toBe(false)
    })

  it('rejects approver as a role (approving is a job, not a role)', () => {
    expect(MeSchema.safeParse({ ...valid, role: 'approver' }).success).toBe(false)
  })

  const grant = { id: 'g_1', endsAt: { iso: new Date(at).toISOString(), ms: at } }
  it('rejects a grant for anyone but the Inhouse team', () => {
    for (const role of ['member', 'admin']) expect(MeSchema.safeParse({ ...valid, role, grant }).success).toBe(false)
  })
  it('rejects wrong shapes of grant, photoUrl and email, and a malformed endsAt', () => {
    const inhouse = { ...valid, role: 'inhouse' }
    for (const g of [{}, { id: 'g_1' }, { ...grant, extra: 1 }, { id: '', endsAt: grant.endsAt }, 'g_1',
      { id: 'g_1', endsAt: { iso: 'not a date', ms: at } }, { id: 'g_1', endsAt: { iso: new Date(at).toISOString(), ms: at + 1 } },
      { id: 'g_1', endsAt: at }]) {
      expect(MeSchema.safeParse({ ...inhouse, grant: g }).success).toBe(false)
    }
    for (const photoUrl of [undefined, 5, {}]) expect(MeSchema.safeParse({ ...valid, photoUrl }).success).toBe(false)
    for (const email of [undefined, 5, {}]) expect(MeSchema.safeParse({ ...valid, email }).success).toBe(false)
  })
  it('rejects an unknown top-level key', () => {
    expect(MeSchema.safeParse({ ...valid, isAdmin: true }).success).toBe(false)
  })
})
