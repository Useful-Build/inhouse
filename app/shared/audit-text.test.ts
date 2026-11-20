// What a line says (shared/audit-text.ts). Ways it can fail, written down first:
//  1. an action has no text (a new action added without one) or empty text;
//  2. a redacted setting's text shows something of its value;
//  3. a member named by id shows the id, or nothing, when the name is unknown (it must read "Former member");
//  4. an approver's member id shows as the id instead of the member's name.
import { describe, expect, it } from 'vitest'
import { AuditActionSchema } from './contract/audit.ts'
import type { AuditArgs } from './contract/audit.ts'
import { auditText } from './audit-text.ts'

const sample: Record<AuditArgs['action'], AuditArgs> = {
  'member.invited': { action: 'member.invited', memberId: 'm_a', role: 'admin' },
  'member.reinvited': { action: 'member.reinvited', memberId: 'm_a', role: 'member' },
  'member.bound': { action: 'member.bound', memberId: 'm_a', replaces: 'm_b' },
  'member.restored': { action: 'member.restored', memberId: 'm_a' },
  'member.role_changed': { action: 'member.role_changed', memberId: 'm_a', from: 'member', to: 'admin' },
  'member.removed': { action: 'member.removed', memberId: 'm_a' },
  'inhouse.first_sign_in': { action: 'inhouse.first_sign_in', memberId: 'm_a' },
  'setting.changed': { action: 'setting.changed', scope: 'brand', key: 'g:tz', value: 'Europe/Paris' },
  'photo.changed': { action: 'photo.changed', type: 'image/png', size: 10 },
  'photo.removed': { action: 'photo.removed' },
  'grant.created': { action: 'grant.created', grantId: 'g_1', hours: 4 },
  'grant.ended': { action: 'grant.ended', grantId: 'g_1' },
  'grant.expired': { action: 'grant.expired', grantId: 'g_1' },
  'support.access': { action: 'support.access', grantId: 'g_1', method: 'GET', route: '/api/audit' },
}
const names = (id: string) => ({ m_a: 'Ada Example' } as Record<string, string>)[id] ?? null

describe('auditText', () => {
  it('says something for every action (failure 1)', () => {
    for (const action of AuditActionSchema.options) expect(auditText(sample[action], names).what, action).not.toBe('')
  })
  it('never shows a redacted value (failure 2)', () => {
    const t = auditText({ action: 'setting.changed', scope: 'personal', key: 'n:channel', redacted: { len: 9, hash: 'ab'.repeat(16) } }, names)
    expect(t.detail).toBe('Send alerts to: changed (not shown)')
    expect(JSON.stringify(t)).not.toContain('ab'.repeat(16))
  })
  it('names members by current name, else "Former member", never by id (failure 3)', () => {
    expect(auditText(sample['member.removed'], names).detail).toBe('Ada Example')
    const t = auditText({ action: 'member.removed', memberId: 'm_gone' }, names)
    expect(t.detail).toBe('Former member')
    expect(JSON.stringify(t)).not.toContain('m_gone')
  })
  it("shows an approver's name, and anyone as it is (failure 4)", () => {
    expect(auditText({ action: 'setting.changed', scope: 'brand', key: 'a:0', value: 'm_a' }, names).detail).toBe('Approver for rule 1: Ada Example')
    expect(auditText({ action: 'setting.changed', scope: 'brand', key: 'a:0', value: 'anyone' }, names).detail).toBe('Approver for rule 1: anyone')
    expect(auditText({ action: 'setting.changed', scope: 'brand', key: 'm:ask', value: null }, names).detail).toBe('Ask before saving a team rule: reset')
  })
})

describe('setting names and values under the registry as it is now (fix round 1)', () => {
  it("uses the page's label where the key has one, the raw key otherwise", () => {
    expect(auditText({ action: 'setting.changed', scope: 'brand', key: 'm:ask', value: true }, names).detail).toBe('Ask before saving a team rule: on')
    expect(auditText({ action: 'setting.changed', scope: 'technical', key: 'tm:fable:effort', value: 'High' }, names).detail).toBe('Effort for fable: High')
    expect(auditText({ action: 'setting.changed', scope: 'brand', key: 'x:gone', value: null }, names).detail).toBe('x:gone: reset')
  })
  it('shows no value for a key the registry no longer knows or no longer marks audit-safe', () => {
    for (const key of ['x:gone', 'n:channel']) {
      const t = auditText({ action: 'setting.changed', scope: 'personal', key, value: 'Secret Value' }, names)
      expect(t.detail).toMatch(/: changed \(not shown\)$/)
      expect(JSON.stringify(t)).not.toContain('Secret')
    }
  })
})
