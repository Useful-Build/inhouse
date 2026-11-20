// A member's title has one form for "no title" (null, or left out of an invite). Ways it can fail, written down first:
//  1. '' (or only spaces) parses as a title, so "no title" has two forms;
//  2. null stops meaning "no title" on the record.
import { describe, expect, it } from 'vitest'
import { InviteInputSchema, MemberRecordSchema } from './members.ts'

const record = { id: 'm_abc123', name: 'Sam Lee', email: 'sam@example.test', title: 'Buyer', role: 'member', status: 'active', photo: null, rev: 1 }
const invite = { name: 'Sam Lee', email: 'sam@example.test', role: 'member' }

describe('the title', () => {
  it("refuses '' and blank text (failure 1)", () => {
    for (const title of ['', '   ']) {
      expect(MemberRecordSchema.safeParse({ ...record, title }).success, `record ${JSON.stringify(title)}`).toBe(false)
      expect(InviteInputSchema.safeParse({ ...invite, title }).success, `invite ${JSON.stringify(title)}`).toBe(false)
    }
  })
  it('takes null on the record and no title on an invite (failure 2)', () => {
    expect(MemberRecordSchema.safeParse({ ...record, title: null }).success).toBe(true)
    expect(InviteInputSchema.safeParse(invite).success).toBe(true)
    expect(InviteInputSchema.safeParse({ ...invite, title: 'Buyer' }).success).toBe(true)
  })
})
