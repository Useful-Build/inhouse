// The audit page's names (routes 19 and 20) on real D1. Ways it can fail, written down first:
//  - a member a line's text names (shared/audit-text.ts `auditText`) isn't looked up for the page, so the JSON page
//    (50 lines) says "Former member" where the CSV (200 lines) names them, whenever no other line on the page names
//    them too: a bell notice's recipient and a restore's approver were such ids (found by e2e/api/audit.spec.ts
//    "the CSV is the page" once M3-X's admin cards rang admins' bells).
import { env } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'
import { auditText } from '../../shared/audit-text.ts'
import type { AuditArgs } from '../../shared/contract/audit.ts'
import { auditReader, memberIdsIn } from './audit-read.ts'

const db = env.DB
const ACTOR = 'm_ar_actor'
const BELL = 'm_ar_bell'
const APPROVER = 'm_ar_approver'

/** Every line kind whose text names a member, each naming one only it names (audit-text.ts `who(...)`). */
const NAMING: AuditArgs[] = [
  { action: 'member.invited', memberId: 'm_ar_1', role: 'member' },
  { action: 'member.reinvited', memberId: 'm_ar_2', role: 'admin' },
  { action: 'member.role_changed', memberId: 'm_ar_3', from: 'member', to: 'admin' },
  { action: 'member.removed', memberId: 'm_ar_4' },
  { action: 'setting.changed', key: 'a:1', value: 'm_ar_5' } as AuditArgs,
  { action: 'restore.confirmed', restoreId: '20261122T191611123Z-0a1b2c3d', backupId: '20261121T020000000Z-ffee0011', approvedBy: 'm_ar_6' },
  { action: 'restore.member_placeholder', memberId: 'm_ar_7', restoreId: '20261122T191611123Z-0a1b2c3d' },
  { action: 'notify.send', source: 'approvals', systemKey: 'approval-waiting:ac_x', noticeKind: 'approval_waiting', kind: 'bell', target: 'm_ar_8', outcome: 'posted', textLength: 0, noticeSha256: 'ab'.repeat(32) },
]

describe('memberIdsIn', () => {
  it('collects every member id the line\'s text reads', () => {
    for (const args of NAMING) {
      const read: string[] = []
      auditText(args, id => { read.push(id); return 'X' })
      expect(read.length, args.action).toBeGreaterThan(0)
      expect(memberIdsIn(args), args.action).toEqual(expect.arrayContaining(read))
    }
  })

  it('never collects a Slack channel or the admins\' bell', () => {
    const base = { action: 'notify.send', source: 'approvals', systemKey: 'k', noticeKind: 'approval_waiting', outcome: 'posted', textLength: 0, noticeSha256: 'ab'.repeat(32) } as const
    expect(memberIdsIn({ ...base, kind: 'slack', target: 'C0TEST0001' })).toEqual([])
    expect(memberIdsIn({ ...base, kind: 'bell', target: 'admins' })).toEqual([])
  })
})

describe('the page names whom its lines name', () => {
  const line = (args: AuditArgs, atMs: number) => {
    const { action, ...rest } = args
    return db.prepare('INSERT INTO audit_log (at_ms, actor_id, action, target_kind, target_id, args_json, req_id) VALUES (?, ?, ?, NULL, NULL, ?, ?)')
      .bind(atMs, ACTOR, action, JSON.stringify(rest), `req_ar_${atMs}`).run()
  }
  beforeEach(async () => {
    for (const [id, name] of [[ACTOR, 'Actor'], [BELL, 'Bea Bell'], [APPROVER, 'Abe Approver']] as const) {
      await db.prepare("INSERT INTO members (id, kind, role, status, name, created_at_ms) VALUES (?, 'person', 'admin', 'active', ?, 1) ON CONFLICT (id) DO UPDATE SET name = excluded.name")
        .bind(id, name).run()
    }
  })

  it('a bell notice\'s recipient and a restore\'s approver, named only on their own line', async () => {
    await line({ action: 'notify.send', source: 'approvals', systemKey: 'approval-waiting:ac_y', noticeKind: 'approval_waiting', kind: 'bell', target: BELL, outcome: 'posted', textLength: 0, noticeSha256: 'cd'.repeat(32) }, 9_000_000_000_001)
    await line({ action: 'restore.confirmed', restoreId: '20261122T191611123Z-0a1b2c3d', backupId: '20261121T020000000Z-ffee0011', approvedBy: APPROVER }, 9_000_000_000_002)
    const page = await auditReader({ db }).page({ limit: 2, beforeId: null })
    expect(page.lines.map(l => l.args.action)).toEqual(['restore.confirmed', 'notify.send'])
    expect(page.names).toMatchObject({ [BELL]: 'Bea Bell', [APPROVER]: 'Abe Approver' })
    expect(page.lines.map(l => auditText(l.args, id => page.names[id] ?? null).detail)).toEqual(['Approved by Abe Approver', 'Bea Bell’s bell'])
  })
})
