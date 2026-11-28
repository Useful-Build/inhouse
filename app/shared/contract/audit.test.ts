// The audit arguments can't carry a person's name or email (decision Q3, p2-design.md section 8). Ways it can fail,
// written down first:
//  1. an action's field takes a name or an email (a member id field, a role, a key, a route);
//  2. an extra field slips through (a `name` or `email` next to the member id);
//  3. a setting that isn't audit-safe keeps its value, or an audit-safe one hides it, or the scope doesn't match the key;
//  4. an action has no shape (the closed list and the union drift apart).
import { fc, test } from '@fast-check/vitest'
import { describe, expect, it } from 'vitest'
import { AuditActionSchema, AuditArgsSchema, LibraryTypeSchema } from './audit.ts'
import type { AuditAction, AuditArgs, ConnectOutcome } from './audit.ts'
import type { HubErrorCode } from '../../hub/index/contract.ts'
import { settingSpec } from './settings.ts'
import { FILE_CAPS } from '../../server/files-io/caps.ts'
import { INHOUSE_BRAND_WRITES } from '../../server/testing/inhouse-brand-writes.ts'

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
  'agent.paused': { action: 'agent.paused' },
  'agent.resumed': { action: 'agent.resumed' },
  'support.attach': { action: 'support.attach', grantId: g, runId: 'r_AAAAAAAAAAAAAAAAAAAAAA' },
  'memory.forgotten': { action: 'memory.forgotten', memoryId: 'mem_AAAAAAAAAAAAAAAAAAAAAA' },
  'memory.restored': { action: 'memory.restored', memoryId: 'mem_AAAAAAAAAAAAAAAAAAAAAA' },
  'ops_task_revive': { action: 'ops_task_revive', kind: 'deferred-hook', id: 'deferred-hook:q_AAAAAAAAAAAAAAAAAAAAAA', result: 'revived', by: 'release' },
  'routine.created': { action: 'routine.created', routineId: 'rt_AAAAAAAAAAAAAAAAAAAAAA', need: 1 },
  'routine.updated': { action: 'routine.updated', routineId: 'rt_AAAAAAAAAAAAAAAAAAAAAA', changed: ['schedule'] },
  'routine.enabled': { action: 'routine.enabled', routineId: 'routine-morning-check', on: false },
  'routine.deleted': { action: 'routine.deleted', routineId: 'rt_AAAAAAAAAAAAAAAAAAAAAA' },
  'routine.restored': { action: 'routine.restored', routineId: 'rt_AAAAAAAAAAAAAAAAAAAAAA' },
  'routine.run_now': { action: 'routine.run_now', routineId: 'rt_AAAAAAAAAAAAAAAAAAAAAA', slotKey: 'now|rt_AAAAAAAAAAAAAAAAAAAAAA|ck_12345678' },
  'library.uploaded': { action: 'library.uploaded', fileId: 'f_AAAAAAAAAAAAAAAAAAAAAA', contentType: 'application/pdf', bytes: 2048 },
  'library.deleted': { action: 'library.deleted', fileIds: ['f_AAAAAAAAAAAAAAAAAAAAAA'] },
  'library.restored': { action: 'library.restored', fileIds: ['f_AAAAAAAAAAAAAAAAAAAAAA', 'f_BBBBBBBBBBBBBBBBBBBBBB'] },
  'today.set_aside': { action: 'today.set_aside', itemId: 'p_AAAAAAAAAAAAAAAAAAAAAA', reason: 'snoozed' },
  'restore.confirmed': { action: 'restore.confirmed', restoreId: '20261122T191611123Z-0a1b2c3d', backupId: '20261121T020000000Z-ffee0011', approvedBy: m },
  'privacy.requested': { action: 'privacy.requested', requestId: 'pr_AAAAAAAAAAAAAAAAAAAAAA', topic: 'customers/redact', parsed: true },
  'privacy.closed': { action: 'privacy.closed', requestId: 'pr_AAAAAAAAAAAAAAAAAAAAAA', topic: 'shop/redact', by: 'release' },
  'restore.member_placeholder': { action: 'restore.member_placeholder', memberId: m, restoreId: '20261122T191611123Z-0a1b2c3d' },
  // P5 (p5-w1)
  'tools.connect_start': { action: 'tools.connect_start', accountId: 'slack:workspace' },
  'tools.connect': { action: 'tools.connect', accountId: 'slack:workspace', outcome: 'scope_mismatch' },
  // P5 (p5-w3)
  'tools.pause': { action: 'tools.pause', accountId: 'slack:workspace', paused: false },
  'tools.disconnect': { action: 'tools.disconnect', accountId: 'shopify:store', revoked: false },
  // P5 (p5-w4)
  'notify.send': { action: 'notify.send', source: 'agent', runId: 'r_AAAAAAAAAAAAAAAAAAAAAA', kind: 'slack', target: 'C0TEST0001', outcome: 'posted', textLength: 5, noticeSha256: '0'.repeat(64) },
  'notify.channels': { action: 'notify.channels', added: ['C0TEST0001'], removed: [], alerts: null },
  'memory.approved': { action: 'memory.approved', memoryId: 'mem_AAAAAAAAAAAAAAAAAAAAAA', rev: 3 },
  'memory.rejected': { action: 'memory.rejected', memoryId: 'mem_AAAAAAAAAAAAAAAAAAAAAA', rev: 1 },
  'team_request.created': { action: 'team_request.created', requestId: 'tr_AAAAAAAAAAAAAAAAAAAAAA', kind: 'tool' },
  'team_request.status': { action: 'team_request.status', requestId: 'tr_AAAAAAAAAAAAAAAAAAAAAA', status: 'done' },
  'brand_skill.created': { action: 'brand_skill.created', skillId: 'bs_AAAAAAAAAAAAAAAAAAAAAA' },
  'brand_skill.changed': { action: 'brand_skill.changed', skillId: 'bs_AAAAAAAAAAAAAAAAAAAAAA' },
  'brand_skill.deleted': { action: 'brand_skill.deleted', skillId: 'bs_AAAAAAAAAAAAAAAAAAAAAA' },
  'data.exported': { action: 'data.exported', scope: 'brand', stores: 24, items: 1234 },
  'permission.granted': { action: 'permission.granted', permissionId: 'pg_AAAAAAAAAAAAAAAAAAAAAA', operation: 'slack.channel.post', accountId: 'slack:workspace', scopeKey: 'channelId=C0123ABCD', holder: 'member', perDay: 50, actionId: 'ac_AAAAAAAAAAAAAAAAAAAAAA' },
  'permission.revoked': { action: 'permission.revoked', permissionId: 'pg_AAAAAAAAAAAAAAAAAAAAAA', operation: 'shopify.order.tag_add', reason: 'member_removed' },
  'action.requested': { action: 'action.requested', actionId: 'ac_AAAAAAAAAAAAAAAAAAAAAA', operation: 'shopify.order.tag_add', verdict: 'exact', guardrail: 'bulk', origin: 'chat', records: 6, units: 6 },
  'action.answered': { action: 'action.answered', actionId: 'ac_AAAAAAAAAAAAAAAAAAAAAA', choice: 'always', permissionId: 'pg_AAAAAAAAAAAAAAAAAAAAAA' },
  'action.undone': { action: 'action.undone', actionId: 'ac_AAAAAAAAAAAAAAAAAAAAAA', released: true },
  'action.withdrawn': { action: 'action.withdrawn', actionId: 'ac_AAAAAAAAAAAAAAAAAAAAAA', by: 'agent' },
  'action.lapsed': { action: 'action.lapsed', actionId: 'ac_AAAAAAAAAAAAAAAAAAAAAA', reason: 'paused', released: true },
  'action.sent': { action: 'action.sent', actionId: 'ac_AAAAAAAAAAAAAAAAAAAAAA', attempt: 1 },
  'action.failed': { action: 'action.failed', actionId: 'ac_AAAAAAAAAAAAAAAAAAAAAA', attempt: 1, code: 'upstream_rejected', released: true },
  'action.needs_check': { action: 'action.needs_check', actionId: 'ac_AAAAAAAAAAAAAAAAAAAAAA', attempt: 1, why: 'timeout' },
  'action.resolved': { action: 'action.resolved', actionId: 'ac_AAAAAAAAAAAAAAAAAAAAAA', outcome: 'failed', released: true },
  'question.asked': { action: 'question.asked', questionId: 'q_AAAAAAAAAAAAAAAAAAAAAA', askedOf: 'owner', options: 3 },
  'question.answered': { action: 'question.answered', questionId: 'q_AAAAAAAAAAAAAAAAAAAAAA' },
  'question.expired': { action: 'question.expired', questionId: 'q_AAAAAAAAAAAAAAAAAAAAAA' },
  'ceiling.changed': { action: 'ceiling.changed', operation: 'shopify.order.tag_add', old: { enabled: false, perDayMax: 50, unitsMax: 1, bulkThreshold: 5, batchMax: 500 }, new: { enabled: true, perDayMax: 200, unitsMax: 100, bulkThreshold: 5, batchMax: 500 } },
  // Stage 1 M4 (M4-A)
  'connection.prepared': { action: 'connection.prepared', accountId: 'mcp:helpdesk', transport: 'https', path: 'signin', generation: 1 },
  'connection.changed': { action: 'connection.changed', accountId: 'mcp:helpdesk', changed: ['admin_may_sign_in'] },
  'connection.trusted': { action: 'connection.trusted', accountId: 'mcp:helpdesk', trusted: true, policyRev: 4 },
  'connection.credential': { action: 'connection.credential', accountId: 'mcp:helpdesk', kind: 'key', outcome: 'ok' },
  'connection.tools_confirmed': { action: 'connection.tools_confirmed', accountId: 'mcp:helpdesk', generation: 1, policyRev: 3, read: 2, write: 1, off: 0 },
  'connection.tool_changed': { action: 'connection.tool_changed', accountId: 'mcp:helpdesk', tool: 'helpdesk_search', defHash: 'a'.repeat(64), change: 'changed' },
  'connection.removed': { action: 'connection.removed', accountId: 'mcp:helpdesk', revoked: false },
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

describe('P3 lines (W1 first PR)', () => {
  it('take every P3 brand_data GET pattern and nothing concrete', () => {
    for (const route of ['/api/chats', '/api/chats/:id', '/api/runs/active', '/api/traces/:id', '/api/socket', '/api/chats/:id/files', '/api/files/:fileId', '/api/memory']) {
      expect(ok({ action: 'support.access', grantId: g, method: 'GET', route }), route).toBe(true)
    }
    for (const route of ['/api/chats/c1', '/api/chats?limit=5', '/api/usage', '/api/pause']) expect(ok({ action: 'support.access', grantId: g, method: 'GET', route }), route).toBe(false)
  })
  it('support.attach names a grant and a run id only', () => {
    expect(ok({ action: 'support.attach', grantId: g, runId: 'r_AAAAAAAAAAAAAAAAAAAAAA' })).toBe(true)
    expect(ok({ action: 'support.attach', grantId: g, runId: 'chat-1' })).toBe(false)
    expect(ok({ action: 'support.attach', grantId: g, runId: 'r_AAAAAAAAAAAAAAAAAAAAAA', chatId: 'c1' })).toBe(false)
    expect(ok({ action: 'agent.paused', by: m })).toBe(false)
  })
})

describe('P3 memory lines (W6, item 19)', () => {
  const GET_ROUTES = ['/api/members', '/api/members/:id/photo', '/api/audit', '/api/audit/export.csv', '/api/chats', '/api/chats/:id', '/api/runs/active', '/api/traces/:id', '/api/socket', '/api/chats/:id/files', '/api/files/:fileId', '/api/memory']
  const FORGET = '/api/memory/brand/:id/forgotten'
  it('support.access pairs PUT with the team-fact forget only, and GET with the read routes only', () => {
    expect(ok({ action: 'support.access', grantId: g, method: 'PUT', route: FORGET })).toBe(true)
    expect(ok({ action: 'support.access', grantId: g, method: 'GET', route: FORGET })).toBe(false)
    for (const route of GET_ROUTES) {
      expect(ok({ action: 'support.access', grantId: g, method: 'GET', route }), route).toBe(true)
      expect(ok({ action: 'support.access', grantId: g, method: 'PUT', route }), route).toBe(false)
    }
    for (const method of ['POST', 'DELETE', 'get', 'PATCH', 1, null]) expect(ok({ action: 'support.access', grantId: g, method, route: FORGET }), String(method)).toBe(false)
    for (const route of ['/api/memory/brand/mem_x/forgotten', '/api/memory/personal/:id/forgotten', 1, null]) expect(ok({ action: 'support.access', grantId: g, method: 'PUT', route }), String(route)).toBe(false)
    expect(ok({ action: 'support.access', grantId: g, method: 'PUT', route: FORGET, memoryId: 'mem_AAAAAAAAAAAAAAAAAAAAAA' })).toBe(false)
  })
  it('memory.forgotten and memory.restored name a memory id only, never its text or a person', () => {
    for (const action of ['memory.forgotten', 'memory.restored']) {
      expect(ok({ action, memoryId: 'mem_AAAAAAAAAAAAAAAAAAAAAA' })).toBe(true)
      expect(ok({ action, memoryId: 'We restock on Fridays' })).toBe(false)
      expect(ok({ action })).toBe(false)
      expect(ok({ action, memoryId: 'mem_AAAAAAAAAAAAAAAAAAAAAA', text: 'We restock on Fridays' })).toBe(false)
      expect(ok({ action, memoryId: 'mem_AAAAAAAAAAAAAAAAAAAAAA', memberId: m })).toBe(false)
    }
  })
})

// P4 (wave-4 PR0, p4-orchestrator.md section 2). Ways it can fail, written down first:
//  5. a P4 brand_data GET pattern is missing (Inhouse under a live grant then gets 503, "no line, no data"), or a
//     concrete path, a write pattern or a query gets in;
//  6. a P4 line takes a name, a routine name, an instruction, a file name or an item title where an id, a count or a
//     closed list belongs (failure 1 covers names and emails; these are the P4-shaped texts);
//  7. a count or a list goes out of its bounds (need 0 to 2, 1 to 3 changes each once, 1 to 100 files, bytes 1 to the cap);
//  8. the Library's type list drifts from P3's chat file type list.
describe('P4 lines (wave-4 PR0)', () => {
  const P4_GET = ['/api/routines', '/api/today', '/api/activity', '/api/library', '/api/library/:id/download', '/api/routines/:id/runs']
  const rt = 'rt_AAAAAAAAAAAAAAAAAAAAAA'
  const f = 'f_AAAAAAAAAAAAAAAAAAAAAA'
  const texts = ['Morning check', 'Check refunds every morning and tell me', 'Q3 invoices.pdf', 'Refund spike on order 1001', 'routine morning check']

  it('support.access takes the six P4 read patterns with GET only, and nothing concrete (failure 5)', () => {
    for (const route of P4_GET) {
      expect(ok({ action: 'support.access', grantId: g, method: 'GET', route }), route).toBe(true)
      expect(ok({ action: 'support.access', grantId: g, method: 'PUT', route }), route).toBe(false)
    }
    for (const route of ['/api/routines/rt_AAAAAAAAAAAAAAAAAAAAAA', '/api/library/f_AAAAAAAAAAAAAAAAAAAAAA/download', '/api/routines/rt_AAAAAAAAAAAAAAAAAAAAAA/runs', '/api/library?kind=images', '/api/routines/:id', '/api/library/:id', '/api/today/:id/aside']) {
      expect(ok({ action: 'support.access', grantId: g, method: 'GET', route }), route).toBe(false)
    }
  })

  it('routine lines take a routine id (rt_ or a system id), never its name or instruction (failure 6)', () => {
    for (const routineId of [rt, 'routine-morning-check']) expect(ok({ action: 'routine.deleted', routineId }), routineId).toBe(true)
    for (const routineId of [...texts, 'rt_short', 'Routine-morning-check', 'routine-', `rt_${'A'.repeat(23)}`, '']) {
      for (const action of ['routine.deleted', 'routine.restored']) expect(ok({ action, routineId }), `${action} ${routineId}`).toBe(false)
    }
    expect(ok({ action: 'routine.created', routineId: rt, need: 0, name: 'Morning check' })).toBe(false)
    expect(ok({ action: 'routine.updated', routineId: rt, changed: ['instruction'], instruction: 'Check refunds' })).toBe(false)
  })

  it('routine.created: a new line has no need; an old line\'s need is a whole number 0 to 2 (failure 7)', () => {
    expect(ok({ action: 'routine.created', routineId: rt })).toBe(true)
    for (const need of [0, 1, 2]) expect(ok({ action: 'routine.created', routineId: rt, need }), String(need)).toBe(true)
    for (const need of [-1, 3, 1.5, '1', null]) expect(ok({ action: 'routine.created', routineId: rt, need }), String(need)).toBe(false)
  })

  it('routine.updated: changed is 1 to 3 of instruction, schedule and missed, each once (failure 7)', () => {
    for (const changed of [['instruction'], ['schedule', 'missed'], ['missed', 'instruction', 'schedule']]) {
      expect(ok({ action: 'routine.updated', routineId: rt, changed }), changed.join()).toBe(true)
    }
    for (const changed of [[], ['name'], ['schedule', 'schedule'], ['instruction', 'schedule', 'missed', 'instruction'], 'schedule']) {
      expect(ok({ action: 'routine.updated', routineId: rt, changed }), String(changed)).toBe(false)
    }
  })

  it('routine.enabled takes a boolean; routine.run_now a slot key of either shape, never free text', () => {
    expect(ok({ action: 'routine.enabled', routineId: rt, on: true })).toBe(true)
    for (const on of ['true', 1, null]) expect(ok({ action: 'routine.enabled', routineId: rt, on }), String(on)).toBe(false)
    for (const [routineId, slotKey] of [
      [rt, `${rt}|2026-11-21|06:00`], ['routine-morning-check', 'routine-morning-check|2026-11-21|06:00'],
      [rt, `now|${rt}|ck_12345678`], ['routine-morning-check', 'now|routine-morning-check|AbC-123_xyz'],
    ]) {
      expect(ok({ action: 'routine.run_now', routineId, slotKey }), slotKey).toBe(true)
    }
    for (const slotKey of [...texts, `${rt}|21-11-2026|06:00`, `${rt}|2026-11-21`, `now|${rt}|short`, `now|${rt}|has space here`, `now|Morning check|ck_12345678`, `${rt}|2026-11-21|06:00|x`]) {
      expect(ok({ action: 'routine.run_now', routineId: rt, slotKey }), slotKey).toBe(false)
    }
  })

  it("routine.run_now: the slot key names the line's own routine (review fold)", () => {
    const other = 'rt_BBBBBBBBBBBBBBBBBBBBBB'
    for (const slotKey of [`now|${other}|ck_12345678`, `${other}|2026-11-21|06:00`, 'routine-morning-check|2026-11-21|06:00', 'now|routine-morning-check|ck_12345678']) {
      expect(ok({ action: 'routine.run_now', routineId: rt, slotKey }), slotKey).toBe(false)
    }
  })

  it('library.uploaded: a file id, a type from the list and bytes 1 to 20 MiB; never a file name (failures 6 and 7)', () => {
    for (const bytes of [1, 20_971_520]) expect(ok({ action: 'library.uploaded', fileId: f, contentType: 'text/csv', bytes }), String(bytes)).toBe(true)
    for (const bytes of [0, 20_971_521, 2.5, '2048']) expect(ok({ action: 'library.uploaded', fileId: f, contentType: 'text/csv', bytes }), String(bytes)).toBe(false)
    for (const contentType of ['text/html', 'image/svg+xml', 'application/octet-stream', 'video/mp4', 'TEXT/CSV']) {
      expect(ok({ action: 'library.uploaded', fileId: f, contentType, bytes: 10 }), contentType).toBe(false)
    }
    for (const fileId of ['Q3 invoices.pdf', 'library/f_AAAAAAAAAAAAAAAAAAAAAA', 'f_short']) expect(ok({ action: 'library.uploaded', fileId, contentType: 'text/csv', bytes: 10 }), fileId).toBe(false)
    expect(ok({ action: 'library.uploaded', fileId: f, contentType: 'text/csv', bytes: 10, name: 'Q3 invoices.pdf' })).toBe(false)
  })

  it('library.deleted and library.restored: 1 to 100 file ids (failure 7)', () => {
    const ids = (n: number) => Array.from({ length: n }, (_, i) => `f_${String(i).padStart(22, 'A')}`)
    for (const action of ['library.deleted', 'library.restored']) {
      expect(ok({ action, fileIds: ids(1) }), action).toBe(true)
      expect(ok({ action, fileIds: ids(100) }), action).toBe(true)
      expect(ok({ action, fileIds: [] }), action).toBe(false)
      expect(ok({ action, fileIds: ids(101) }), action).toBe(false)
      expect(ok({ action, fileIds: ['Q3 invoices.pdf'] }), action).toBe(false)
      expect(ok({ action, fileIds: f }), action).toBe(false)
    }
  })

  it('today.set_aside: an item id (problem or status card) and a closed reason or null, never the item title (failure 6)', () => {
    for (const itemId of [
      'p_AAAAAAAAAAAAAAAAAAAAAA', 'p_check_2026-11-21_incomplete_AbCdEfGh', 'p_check_2026-11-21_failed_AAAAAAAAAAAAAAAAAAAAAA', 'p_check_2026-11-21_off_A1b2C3d4',
      // Review fold: the not_run card (its tail hashes `<routineId>|<local date>`) and the quiet not_connected card.
      'p_check_2026-11-21_not_run_Zz09-_Zz', 'p_check_2026-11-21_not_connected_AbCdEfGhIjKlMnOpQrStUv',
    ]) {
      expect(ok({ action: 'today.set_aside', itemId, reason: 'dismissed' }), itemId).toBe(true)
    }
    for (const itemId of [...texts, 'p_short', 'p_check_2026-11-21_unknown_AbCdEfGh', 'p_check_today_failed_AbCdEfGh', 'p_check_2026-11-21_failed_x', 'p_check_2026-11-21_not_run_short', 'p_check_2026-11-21_notrun_AbCdEfGh', 'p_check_2026-11-21_not_connected_has space']) {
      expect(ok({ action: 'today.set_aside', itemId, reason: 'dismissed' }), itemId).toBe(false)
    }
    for (const reason of ['snoozed', 'dismissed', 'declined', null]) expect(ok({ action: 'today.set_aside', itemId: 'p_AAAAAAAAAAAAAAAAAAAAAA', reason }), String(reason)).toBe(true)
    for (const reason of ['done', 'Snoozed', undefined, '']) expect(ok({ action: 'today.set_aside', itemId: 'p_AAAAAAAAAAAAAAAAAAAAAA', reason }), String(reason)).toBe(false)
    expect(ok({ action: 'today.set_aside', itemId: 'p_AAAAAAAAAAAAAAAAAAAAAA', reason: null, title: 'Refund spike' })).toBe(false)
  })

  it("the Library's type list is P3's chat file type list (failure 8)", () => {
    expect([...LibraryTypeSchema.options].sort()).toEqual([...FILE_CAPS.allowedTypes].sort())
  })

  it('appends its block after P3\'s, in this order', () => {
    const all = AuditActionSchema.options
    // P5 W1 and P6a PR0 append their blocks after this one, so the check ends at P4's last action rather than at the list's end.
    expect(all.slice(all.indexOf('ops_task_revive'), all.indexOf('today.set_aside') + 1)).toEqual([
      'ops_task_revive',
      'routine.created', 'routine.updated', 'routine.enabled', 'routine.deleted', 'routine.restored', 'routine.run_now',
      'library.uploaded', 'library.deleted', 'library.restored',
      'today.set_aside',
    ])
    const restore = all.indexOf('restore.confirmed')
    expect(restore).toBeGreaterThan(all.indexOf('today.set_aside'))
    expect(all.slice(restore, restore + 4)).toEqual([
      'restore.confirmed', 'restore.member_placeholder',
      'privacy.requested', 'privacy.closed',
    ])
  })
})

// Review fold (#237, high 2): Inhouse writes P4's brand data under a live grant, so support.access takes P4's write rows
// as closed pairs (PUT with the PUT list, POST with the POST list) or the request answers 503 ("no line, no data").
describe('support.access write pairs (P4 review fold)', () => {
  const access = (method: unknown, route: unknown) => ok({ action: 'support.access', grantId: g, method, route })
  /** Every write pair, written out here: P3's forget, then P4's from the briefs' route tables. */
  const WRITES = [
    ['PUT', '/api/memory/brand/:id/forgotten'],
    ['PUT', '/api/routines/:id/enabled'], ['POST', '/api/routines/:id/run'], ['POST', '/api/routines/:id/delete'], ['POST', '/api/routines/:id/restore'],
    ['PUT', '/api/today/:id/aside'],
    ['POST', '/api/library/delete'], ['POST', '/api/library/restore'],
    // P6a PR0: approving or rejecting a waiting team fact (route 78).
    ['PUT', '/api/memory/brand/:id/approved'],
  ] as const
  const READS = ['/api/members', '/api/memory', '/api/routines', '/api/today', '/api/activity', '/api/library', '/api/library/:id/download', '/api/memory/waiting', '/api/routines/:id/runs', '/api/data-access/export', '/api/data-access/export/check']

  it('takes each write pair, and its route with no other method', () => {
    for (const [method, route] of WRITES) {
      expect(access(method, route), `${method} ${route}`).toBe(true)
      for (const other of ['GET', 'PUT', 'POST'].filter(m => m !== method)) expect(access(other, route), `${other} ${route}`).toBe(false)
    }
  })

  it('POST pairs with no other route: no read, no PUT route, no upload, no concrete path', () => {
    for (const route of [...READS, '/api/memory/brand/:id/forgotten', '/api/routines/:id/enabled', '/api/today/:id/aside', '/api/library/uploads', '/api/routines', '/api/routines/rt_AAAAAAAAAAAAAAAAAAAAAA/run', '/api/approvals/:id/check']) {
      expect(access('POST', route), route).toBe(false)
    }
  })

  it('GET and PUT pairings are otherwise unchanged', () => {
    for (const route of READS) {
      expect(access('GET', route), route).toBe(true)
      expect(access('PUT', route), route).toBe(false)
    }
    for (const method of ['DELETE', 'PATCH', 'post', null]) expect(access(method, '/api/library/delete'), String(method)).toBe(false)
  })

  it('INHOUSE_BRAND_WRITES is exactly the write pairs support.access takes', () => {
    expect([...INHOUSE_BRAND_WRITES].sort()).toEqual(WRITES.map(([m, r]) => `${m} ${r}`).sort())
  })
})

describe('P5 (p5-w1): connect lines carry an account id and a closed outcome only', () => {
  it("appends its block after P4's, in this order", () => {
    const all = AuditActionSchema.options
    // Later phases append their blocks after this one, so the check ends at P5's last action rather than at the list's end.
    expect(all.slice(all.indexOf('today.set_aside'), all.indexOf('notify.channels') + 1)).toEqual(['today.set_aside', 'tools.connect_start', 'tools.connect', 'tools.pause', 'tools.disconnect', 'notify.send', 'notify.channels'])
  })

  it("refuses a pause or disconnect line with free text, a non-boolean or an extra field (P5 W3)", () => {
    expect(ok({ action: 'tools.pause', accountId: 'slack:workspace', paused: true })).toBe(true)
    expect(ok({ action: 'tools.disconnect', accountId: 'slack:workspace', revoked: false })).toBe(true)
    expect(ok({ action: 'tools.pause', accountId: 'slack:workspace', paused: 'yes' })).toBe(false)
    expect(ok({ action: 'tools.disconnect', accountId: 'Slack Workspace', revoked: true })).toBe(false)
    expect(ok({ action: 'tools.disconnect', accountId: 'slack:workspace', revoked: true, reason: 'x' })).toBe(false)
  })

  it('refuses free text, an unknown outcome and an extra field', () => {
    expect(ok({ action: 'tools.connect_start', accountId: 'slack:workspace' })).toBe(true)
    expect(ok({ action: 'tools.connect', accountId: 'shopify:store', outcome: 'ok' })).toBe(true)
    expect(ok({ action: 'tools.connect_start', accountId: 'Slack Workspace' })).toBe(false)
    expect(ok({ action: 'tools.connect', accountId: 'slack:workspace', outcome: 'invalid_code from slack' })).toBe(false)
    expect(ok({ action: 'tools.connect', accountId: 'slack:workspace', outcome: 'ok', code: 'abc' })).toBe(false)
    expect(ok({ action: 'tools.connect_start', accountId: 'slack:workspace', memberId: m, email: 'a@example.com' })).toBe(false)
  })
})

// Review fold (#251): ConnectOutcomeSchema is the hub's HubErrorCode plus `ok`, both ways, so a new hub code can't
// silently become `internal` at route B. A type check: tsc fails here on any drift.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false
const outcomesAreHubCodes: Same<Exclude<ConnectOutcome, 'ok'>, HubErrorCode> = true
describe('P5 (p5-w1): ConnectOutcomeSchema and HubErrorCode', () => {
  it('match both ways (checked by the type above)', () => expect(outcomesAreHubCodes).toBe(true))
})

describe('P5 (p5-w4): notice lines carry ids, closed codes, a length and a hash only', () => {
  const okLine = (a: unknown) => AuditArgsSchema.safeParse(a).success
  const send = { action: 'notify.send', source: 'agent', runId: 'r_AAAAAAAAAAAAAAAAAAAAAA', kind: 'slack', target: 'C0TEST0001', outcome: 'refused', detail: 'not_listed', textLength: 40, noticeSha256: '0'.repeat(64) }
  it('takes a well-formed line', () => {
    expect(okLine(send)).toBe(true)
    expect(okLine({ ...send, source: 'approvals', runId: undefined, systemKey: 'p6:n_1:2026112109', noticeKind: 'approval_waiting', kind: 'bell', target: 'admins', outcome: 'posted', detail: undefined })).toBe(true)
    expect(okLine({ action: 'notify.channels', added: ['C0TEST0001'], removed: ['C0TEST0002'], alerts: null })).toBe(true)
  })
  it('takes the M2-F details (channel_to_bell, slack_off) and still the stage-era ones on old lines', () => {
    for (const detail of ['channel_to_bell', 'slack_off', 'to_bell', 'below_act']) expect(okLine({ ...send, detail }), detail).toBe(true)
    expect(okLine({ ...send, detail: 'at_watch' })).toBe(false)
  })
  it("takes 'unlisted' as a target, never the agent's channel name", () => {
    expect(okLine({ ...send, target: 'unlisted' })).toBe(true)
    expect(okLine({ ...send, target: 'unlisted', kind: 'bell' })).toBe(false)
    expect(okLine({ ...send, target: 'unlisted', outcome: 'posted', detail: undefined })).toBe(false)
    expect(okLine({ ...send, target: '#design' })).toBe(false)
    expect(okLine({ ...send, target: 'design' })).toBe(false)
    expect(okLine({ ...send, target: 'unlisted:#design' })).toBe(false)
  })
  it('refuses text, a DM or user id as a target, free-text detail and extra fields', () => {
    expect(okLine({ ...send, text: 'hello' })).toBe(false)
    expect(okLine({ ...send, title: 'Stock' })).toBe(false)
    expect(okLine({ ...send, target: 'U0TEST0001' })).toBe(false)
    expect(okLine({ ...send, target: 'D0TEST0001' })).toBe(false)
    expect(okLine({ ...send, detail: 'channel_not_found from slack' })).toBe(false)
    expect(okLine({ ...send, noticeSha256: 'xyz' })).toBe(false)
    expect(okLine({ ...send, systemKey: 'has spaces in it' })).toBe(false)
    expect(okLine({ action: 'notify.channels', added: ['general'], removed: [] })).toBe(false)
  })
})

// P6a PR0 (docs/plans/2026-11-22-p6a-memory-skills.md, "PR0"). Ways it can fail, written down first:
//  9. memory.approved or memory.rejected takes the fact's text, a person, or a revision out of bounds, or no revision
//     (the line must say which wording was decided);
// 10. a team_request line takes the request's text or subject, a kind or status outside the closed lists, or `open`
//     as a status change (a request is created open; a change only moves it to done, declined or withdrawn);
// 11. support.access misses the waiting list (GET) or the approve route (PUT): Inhouse under a live grant then gets
//     503 ("no line, no data"); or pairs either with another method, or takes a concrete path;
// 12. the block lands anywhere but after P4's, or in another order.
describe('P6a lines (PR0)', () => {
  const mem = 'mem_AAAAAAAAAAAAAAAAAAAAAA'
  const tr = 'tr_AAAAAAAAAAAAAAAAAAAAAA'
  const access = (method: unknown, route: unknown) => ok({ action: 'support.access', grantId: g, method, route })

  it('memory.approved and memory.rejected name a memory id and the revision decided, never the text (failure 9)', () => {
    for (const action of ['memory.approved', 'memory.rejected']) {
      for (const rev of [1, 2, 999_999_999]) expect(ok({ action, memoryId: mem, rev }), `${action} ${rev}`).toBe(true)
      for (const rev of [0, -1, 1.5, '2', null, 1_000_000_000]) expect(ok({ action, memoryId: mem, rev }), `${action} ${String(rev)}`).toBe(false)
      expect(ok({ action, memoryId: mem }), `${action} no rev`).toBe(false)
      expect(ok({ action, rev: 1 }), `${action} no id`).toBe(false)
      for (const memoryId of ['We restock on Fridays', 'mem_short', `mem_${'A'.repeat(23)}`, '']) expect(ok({ action, memoryId, rev: 1 }), `${action} ${memoryId}`).toBe(false)
      expect(ok({ action, memoryId: mem, rev: 1, text: 'We restock on Fridays' })).toBe(false)
      expect(ok({ action, memoryId: mem, rev: 1, memberId: m })).toBe(false)
    }
  })

  it('team_request.created takes a request id and a closed kind, never the text or subject (failure 10)', () => {
    for (const kind of ['tool', 'job', 'change', 'bug', 'feedback']) expect(ok({ action: 'team_request.created', requestId: tr, kind }), kind).toBe(true)
    for (const kind of ['skill', 'Tool', '', null]) expect(ok({ action: 'team_request.created', requestId: tr, kind }), String(kind)).toBe(false)
    for (const requestId of ['Connect our wholesale tool', 'tr_short', `tr_${'A'.repeat(23)}`, 'rt_AAAAAAAAAAAAAAAAAAAAAA', '']) {
      expect(ok({ action: 'team_request.created', requestId, kind: 'job' }), requestId).toBe(false)
    }
    expect(ok({ action: 'team_request.created', requestId: tr, kind: 'tool', subject: 'shopify' })).toBe(false)
    expect(ok({ action: 'team_request.created', requestId: tr, kind: 'tool', text: 'Please connect it' })).toBe(false)
  })

  it('team_request.status takes done, declined or withdrawn only (failure 10)', () => {
    for (const status of ['done', 'declined', 'withdrawn']) expect(ok({ action: 'team_request.status', requestId: tr, status }), status).toBe(true)
    for (const status of ['open', 'Done', 'closed', '', null]) expect(ok({ action: 'team_request.status', requestId: tr, status }), String(status)).toBe(false)
    expect(ok({ action: 'team_request.status', requestId: tr, status: 'done', text: 'Done, connected' })).toBe(false)
  })

  it('support.access pairs GET with the waiting list and PUT with the approve route, and nothing concrete (failure 11)', () => {
    expect(access('GET', '/api/memory/waiting')).toBe(true)
    expect(access('PUT', '/api/memory/brand/:id/approved')).toBe(true)
    for (const method of ['PUT', 'POST']) expect(access(method, '/api/memory/waiting'), method).toBe(false)
    for (const method of ['GET', 'POST', 'DELETE']) expect(access(method, '/api/memory/brand/:id/approved'), method).toBe(false)
    for (const route of [`/api/memory/brand/${mem}/approved`, '/api/memory/personal/:id/approved', '/api/memory/waiting?limit=5']) {
      for (const method of ['GET', 'PUT']) expect(access(method, route), `${method} ${route}`).toBe(false)
    }
    // Team requests are baseline (the Inhouse team needs no grant), so no support.access line names them.
    for (const route of ['/api/team-requests', '/api/team-requests/:id/status']) {
      for (const method of ['GET', 'PUT', 'POST']) expect(access(method, route), `${method} ${route}`).toBe(false)
    }
  })

  it('brand skill lines take the skill id only, never its name or text; support.access names the skill page read (GET only)', () => {
    const bs = 'bs_AAAAAAAAAAAAAAAAAAAAAA'
    for (const action of ['brand_skill.created', 'brand_skill.changed', 'brand_skill.deleted']) {
      expect(ok({ action, skillId: bs }), action).toBe(true)
      for (const skillId of ['weekly-report', 'bs_short', `bs_${'A'.repeat(23)}`, 'tr_AAAAAAAAAAAAAAAAAAAAAA', '']) expect(ok({ action, skillId }), `${action} ${skillId}`).toBe(false)
      expect(ok({ action, skillId: bs, name: 'weekly-report' }), action).toBe(false)
      expect(ok({ action, skillId: bs, body: 'Read the orders.' }), action).toBe(false)
    }
    expect(access('GET', '/api/skills')).toBe(false)
    expect(access('GET', '/api/skills/:name')).toBe(true)
    for (const method of ['PUT', 'POST']) for (const route of ['/api/skills', '/api/skills/:name', '/api/skills/brand/:id/delete']) expect(access(method, route), `${method} ${route}`).toBe(false)
    expect(access('GET', '/api/skills/weekly-report')).toBe(false)
  })

  it("appends its block after P4's, in this order (failure 12)", () => {
    // After P4's, not right after: P5's block (fleet/connectors) lands between the two when P5 merges.
    const all = AuditActionSchema.options
    const at = all.indexOf('memory.approved')
    expect(at).toBeGreaterThan(all.indexOf('today.set_aside'))
    expect(all.slice(at, at + 4)).toEqual([
      'memory.approved', 'memory.rejected', 'team_request.created', 'team_request.status',
    ])
  })
})

describe('M2-R: the restore hold\'s needs-check line', () => {
  const id = 'ac_AAAAAAAAAAAAAAAAAAAAAA'
  it('takes a restore line with or without an attempt, and refuses any other line without one', () => {
    expect(ok({ action: 'action.needs_check', actionId: id, why: 'restore' })).toBe(true)
    expect(ok({ action: 'action.needs_check', actionId: id, attempt: 2, why: 'restore' })).toBe(true)
    for (const why of ['timeout', 'unknown', 'thrown', 'bad_result', 'stale']) {
      expect(ok({ action: 'action.needs_check', actionId: id, why }), why).toBe(false)
      expect(ok({ action: 'action.needs_check', actionId: id, attempt: 1, why }), why).toBe(true)
    }
    expect(ok({ action: 'action.needs_check', actionId: id, attempt: 0, why: 'restore' })).toBe(false)
    expect(ok({ action: 'action.needs_check', actionId: id, why: 'restored' })).toBe(false)
  })
})

describe('Stage 1 M3 (N25, N26): the ceiling line and who could answer', () => {
  const values = { enabled: true, perDayMax: 200, unitsMax: 100, bulkThreshold: 5, batchMax: 500 }
  const line = (o: Record<string, unknown>) => ({ action: 'ceiling.changed', operation: 'shopify.order.tag_add', old: null, new: values, ...o })
  it('takes switches and counts only, inside the ceiling bounds', () => {
    expect(ok(line({}))).toBe(true)
    expect(ok(line({ old: { ...values, enabled: false } }))).toBe(true)
    expect(ok(line({ operation: 'shopify.order.cancel' }))).toBe(false)
    expect(ok(line({ new: { ...values, bulkThreshold: 6 } }))).toBe(false)
    expect(ok(line({ new: { ...values, batchMax: 501 } }))).toBe(false)
    expect(ok(line({ new: { ...values, unitsMax: 0 } }))).toBe(false)
    expect(ok(line({ new: { ...values, note: 'why' } }))).toBe(false)
    expect(ok(line({ actorName: 'Dana' }))).toBe(false)
    expect(ok(line({ old: undefined }))).toBe(false)
  })
  it('reads an answer written before M3 (no approverKind) and one after', () => {
    const answered = { action: 'action.answered', actionId: 'ac_AAAAAAAAAAAAAAAAAAAAAA', choice: 'approve' }
    expect(ok(answered)).toBe(true)
    expect(ok({ ...answered, approverKind: 'admins' })).toBe(true)
    expect(ok({ ...answered, approverKind: 'person' })).toBe(true)
    expect(ok({ ...answered, approverKind: 'role:admin' })).toBe(false)
  })
})

// Stage 1 M4 (M4-A). Ways the connection lines can go wrong, written first: a line takes an address, a typed name, a
// server's tool name or a key; an account id that isn't a connection's; an edit that lists a part twice or none; a
// confirm past the tool caps; the new hub codes missing from a connect's outcome.
describe('Stage 1 M4 (M4-A): connection lines carry an account id, revisions, closed codes and counts only', () => {
  const acct = 'mcp:helpdesk'
  it('takes each line as written', () => {
    expect(ok({ action: 'connection.prepared', accountId: acct, transport: 'connector', path: 'key', generation: 2 })).toBe(true)
    expect(ok({ action: 'connection.changed', accountId: acct, changed: ['name', 'about', 'admin_may_sign_in', 'settings'] })).toBe(true)
    expect(ok({ action: 'connection.credential', accountId: acct, kind: 'client', outcome: 'client_fault' })).toBe(true)
    expect(ok({ action: 'connection.tool_changed', accountId: acct, tool: 'helpdesk_reply', defHash: 'f'.repeat(64), change: 'gone' })).toBe(true)
    // P5's sign-in, pause and disconnect lines take a connection's account id as they are.
    expect(ok({ action: 'tools.connect', accountId: acct, outcome: 'needs_key' })).toBe(true)
    expect(ok({ action: 'tools.disconnect', accountId: acct, revoked: true })).toBe(true)
  })
  it('refuses an address, a typed name, a server name, a key or an account that is not a connection', () => {
    expect(ok({ action: 'connection.prepared', accountId: 'slack:workspace', transport: 'https', path: 'none', generation: 1 })).toBe(false)
    expect(ok({ action: 'connection.prepared', accountId: acct, transport: 'https', path: 'none', generation: 1, url: 'https://mcp.example.com/mcp' })).toBe(false)
    expect(ok({ action: 'connection.changed', accountId: acct, changed: ['name'], name: 'Helpdesk' })).toBe(false)
    expect(ok({ action: 'connection.changed', accountId: acct, changed: ['name', 'name'] })).toBe(false)
    expect(ok({ action: 'connection.changed', accountId: acct, changed: [] })).toBe(false)
    expect(ok({ action: 'connection.credential', accountId: acct, kind: 'key', outcome: 'ok', key: 'sk_live_abc' })).toBe(false)
    expect(ok({ action: 'connection.tool_changed', accountId: acct, tool: 'Search Tickets', defHash: 'f'.repeat(64), change: 'new' })).toBe(false)
    expect(ok({ action: 'connection.tool_changed', accountId: acct, tool: 'helpdesk_search', defHash: 'F'.repeat(64), change: 'new' })).toBe(false)
    expect(ok({ action: 'connection.tools_confirmed', accountId: acct, generation: 1, policyRev: 1, read: 201, write: 0, off: 0 })).toBe(false)
    expect(ok({ action: 'connection.trusted', accountId: acct, trusted: true, policyRev: 0 })).toBe(false)
  })
})
