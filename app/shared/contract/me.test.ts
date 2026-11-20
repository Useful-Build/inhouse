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
})
