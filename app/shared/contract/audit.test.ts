// The audit arguments can't carry a person's name or email (decision Q3, p2-design.md section 8). Ways it can fail,
// written down first:
//  1. an action's field takes a name or an email (a member id field, a role, a key, a route);
//  2. an extra field slips through (a `name` or `email` next to the member id);
//  3. a setting that isn't audit-safe keeps its value, or an audit-safe one hides it, or the scope doesn't match the key;
//  4. an action has no shape (the closed list and the union drift apart).
import { fc, test } from '@fast-check/vitest'
import { describe, expect, it } from 'vitest'
import { AuditActionSchema, AuditArgsSchema } from './audit.ts'
import type { AuditAction, AuditArgs } from './audit.ts'
import { settingSpec } from './settings.ts'

const m = 'm_0123456789abcdef0123456789abcdef'
const g = 'g_0123456789abcdef'
const hash = '0123456789abcdef0123456789abcdef'
/** One valid line per action. Typed so a missing action fails the type check. */
const VALID: { [A in AuditAction]: Extract<AuditArgs, { action: A }> } = {
  'member.invited': { action: 'member.invited', memberId: m, role: 'member' },
  'member.reinvited': { action: 'member.reinvited', memberId: m, role: 'admin' },
  'member.bound': { action: 'member.bound', memberId: m, replaces: 'm_old' },
  'member.restored': { action: 'member.restored', memberId: m },
  'member.role_changed': { action: 'member.role_changed', memberId: m, from: 'admin', to: 'member' },
  'member.removed': { action: 'member.removed', memberId: m },
  'inhouse.first_sign_in': { action: 'inhouse.first_sign_in', memberId: m },
  'setting.changed': { action: 'setting.changed', scope: 'personal', key: 'g:theme', value: 'Dark' },
  'photo.changed': { action: 'photo.changed', type: 'image/png', size: 2048 },
  'photo.removed': { action: 'photo.removed' },
  'grant.created': { action: 'grant.created', grantId: g, hours: 4 },
  'grant.ended': { action: 'grant.ended', grantId: g },
  'grant.expired': { action: 'grant.expired', grantId: g },
  'support.access': { action: 'support.access', grantId: g, method: 'GET', route: '/api/members/:id/photo' },
}
const word = fc.stringMatching(/^[A-Z][a-z]{1,11}$/)
const name = fc.oneof(word, fc.tuple(word, word).map(([a, b]) => `${a} ${b}`))
const personal = fc.oneof(name, fc.emailAddress())
const ok = (v: unknown) => AuditArgsSchema.safeParse(v).success

describe('every action', () => {
  it('has a shape, and its valid line parses (failure 4)', () => {
    expect(Object.keys(VALID).sort()).toEqual([...AuditActionSchema.options].sort())
    for (const v of Object.values(VALID)) expect(ok(v), v.action).toBe(true)
  })

  test.prop([fc.constantFrom(...AuditActionSchema.options), personal])('no field takes a name or an email (failure 1)', (action, value) => {
    for (const field of Object.keys(VALID[action]).filter(f => f !== 'action')) expect(ok({ ...VALID[action], [field]: value }), `${action}.${field}`).toBe(false)
  })

  test.prop([fc.constantFrom(...AuditActionSchema.options), fc.constantFrom('name', 'email', 'who', 'token', 'detail', 'bytes'), personal])(
    'no extra field gets in (failure 2)', (action, field, value) => {
      expect(ok({ ...VALID[action], [field]: value })).toBe(false)
    })
})

describe('setting.changed (failure 3)', () => {
  const redacted = { len: 9, hash }
  /**
   * Every key whose value isn't a closed list of options or a switch: free text, the money field, an approver. The
   * free-text ones must be redacted; the others must refuse a name or an email by their value schema. `n:channel` and
   * `g:mode` stay redacted until the server holds closed lists for them (p2-design.md section 6, departure in #94).
   */
  const NON_ENUM = ['g:name', 'n:channel', 't:signs', 'g:mode', 's:cap', 'a:0'] as const
  it('covers the four free-text keys, all redacted', () => {
    for (const k of ['g:name', 'n:channel', 't:signs', 'g:mode'] as const) {
      expect(NON_ENUM, k).toContain(k)
      expect(settingSpec(k)!.auditSafe, k).toBe(false)
    }
  })
  test.prop([fc.constantFrom(...NON_ENUM), personal])('no key keeps a name or an email as its value', (key, v) => {
    const scope = settingSpec(key)!.scope
    expect(ok({ action: 'setting.changed', scope, key, value: v }), `${key} ${v}`).toBe(false)
    expect(ok({ action: 'setting.changed', scope, key, value: v, redacted }), `${key} ${v}`).toBe(false)
  })
  test.prop([fc.oneof(personal, fc.string({ minLength: 1, maxLength: 80 }))])('a key that is not audit-safe keeps no value, only its length and hash', v => {
    expect(ok({ action: 'setting.changed', scope: 'personal', key: 'g:name', value: v })).toBe(false)
    expect(ok({ action: 'setting.changed', scope: 'technical', key: 't:signs', value: v })).toBe(false)
    expect(ok({ action: 'setting.changed', scope: 'personal', key: 'g:name', value: v, redacted })).toBe(false)
  })
  it('records a reset of any key as null, with no length or hash', () => {
    expect(ok({ action: 'setting.changed', scope: 'technical', key: 't:signs', value: null })).toBe(true)
    expect(ok({ action: 'setting.changed', scope: 'personal', key: 'g:name', value: null })).toBe(true)
    expect(ok({ action: 'setting.changed', scope: 'technical', key: 't:signs', value: null, redacted })).toBe(false)
    expect(ok({ action: 'setting.changed', scope: 'technical', key: 't:signs', value: 'Sam' })).toBe(false)
    expect(ok({ action: 'setting.changed', scope: 'technical', key: 't:signs' })).toBe(false)
  })
  it('takes the length and hash for a key that is not audit-safe, and not for one that is', () => {
    expect(ok({ action: 'setting.changed', scope: 'personal', key: 'g:name', redacted })).toBe(true)
    expect(ok({ action: 'setting.changed', scope: 'personal', key: 'g:theme', redacted })).toBe(false)
    expect(ok({ action: 'setting.changed', scope: 'personal', key: 'g:name', redacted: { len: 9, hash: 'Dana Kim' } })).toBe(false)
  })
  it("keeps an audit-safe value only when it is the key's value, or null for a reset", () => {
    expect(ok({ action: 'setting.changed', scope: 'personal', key: 'g:theme', value: null })).toBe(true)
    expect(ok({ action: 'setting.changed', scope: 'personal', key: 'g:theme', value: 'Purple' })).toBe(false)
    expect(ok({ action: 'setting.changed', scope: 'personal', key: 'g:theme' })).toBe(false)
  })
  it("refuses a scope that isn't the key's, and a key that isn't a setting", () => {
    expect(ok({ action: 'setting.changed', scope: 'brand', key: 'g:theme', value: 'Dark' })).toBe(false)
    expect(ok({ action: 'setting.changed', scope: 'brand', key: 'p:sam', value: 'Admin' })).toBe(false)
    expect(ok({ action: 'setting.changed', scope: 'brand', key: 'd:support', value: true })).toBe(false)
  })
})
