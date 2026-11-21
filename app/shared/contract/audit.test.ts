// The audit arguments can't carry a person's name or email (decision Q3, p2-design.md section 8). Ways it can fail,
// written down first:
//  1. an action's field takes a name or an email (a member id field, a role, a key, a route);
//  2. an extra field slips through (a `name` or `email` next to the member id);
//  3. a setting that isn't audit-safe keeps its value, or an audit-safe one hides it, or the scope doesn't match the key;
//  4. an action has no shape (the closed list and the union drift apart).
import { fc, test } from '@fast-check/vitest'
import { describe, expect, it } from 'vitest'
import { AuditActionSchema, AuditArgsSchema, LibraryTypeSchema } from './audit.ts'
import type { AuditAction, AuditArgs } from './audit.ts'
import { settingSpec } from './settings.ts'
import { FILE_CAPS } from '../../server/files-io/caps.ts'

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
  const P4_GET = ['/api/routines', '/api/today', '/api/activity', '/api/library', '/api/library/:id/download']
  const rt = 'rt_AAAAAAAAAAAAAAAAAAAAAA'
  const f = 'f_AAAAAAAAAAAAAAAAAAAAAA'
  const texts = ['Morning check', 'Check refunds every morning and tell me', 'Q3 invoices.pdf', 'Refund spike on order 1001', 'routine morning check']

  it('support.access takes the five P4 read patterns with GET only, and nothing concrete (failure 5)', () => {
    for (const route of P4_GET) {
      expect(ok({ action: 'support.access', grantId: g, method: 'GET', route }), route).toBe(true)
      expect(ok({ action: 'support.access', grantId: g, method: 'PUT', route }), route).toBe(false)
    }
    for (const route of ['/api/routines/rt_AAAAAAAAAAAAAAAAAAAAAA', '/api/library/f_AAAAAAAAAAAAAAAAAAAAAA/download', '/api/library?kind=images', '/api/routines/:id', '/api/library/:id', '/api/today/items/:id/set-aside']) {
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

  it('routine.created: need is a whole number 0 to 2 (failure 7)', () => {
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
    for (const slotKey of [`${rt}|2026-11-21|06:00`, 'routine-morning-check|2026-11-21|06:00', `now|${rt}|ck_12345678`, 'now|routine-morning-check|AbC-123_xyz']) {
      expect(ok({ action: 'routine.run_now', routineId: rt, slotKey }), slotKey).toBe(true)
    }
    for (const slotKey of [...texts, `${rt}|21-11-2026|06:00`, `${rt}|2026-11-21`, `now|${rt}|short`, `now|${rt}|has space here`, `now|Morning check|ck_12345678`, `${rt}|2026-11-21|06:00|x`]) {
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
    for (const itemId of ['p_AAAAAAAAAAAAAAAAAAAAAA', 'p_check_2026-11-21_incomplete_AbCdEfGh', 'p_check_2026-11-21_failed_AAAAAAAAAAAAAAAAAAAAAA', 'p_check_2026-11-21_off_A1b2C3d4']) {
      expect(ok({ action: 'today.set_aside', itemId, reason: 'dismissed' }), itemId).toBe(true)
    }
    for (const itemId of [...texts, 'p_short', 'p_check_2026-11-21_unknown_AbCdEfGh', 'p_check_today_failed_AbCdEfGh', 'p_check_2026-11-21_failed_x']) {
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
    expect(all.slice(all.indexOf('ops_task_revive'))).toEqual([
      'ops_task_revive',
      'routine.created', 'routine.updated', 'routine.enabled', 'routine.deleted', 'routine.restored', 'routine.run_now',
      'library.uploaded', 'library.deleted', 'library.restored',
      'today.set_aside',
    ])
  })
})
