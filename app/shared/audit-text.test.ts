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
  'agent.paused': { action: 'agent.paused' },
  'agent.resumed': { action: 'agent.resumed' },
  'support.attach': { action: 'support.attach', grantId: 'g_1', runId: 'r_AAAAAAAAAAAAAAAAAAAAAA' },
  'memory.forgotten': { action: 'memory.forgotten', memoryId: 'mem_AAAAAAAAAAAAAAAAAAAAAA' },
  'memory.restored': { action: 'memory.restored', memoryId: 'mem_AAAAAAAAAAAAAAAAAAAAAA' },
  'ops_task_revive': { action: 'ops_task_revive', kind: 'deferred-hook', id: 'deferred-hook:q_AAAAAAAAAAAAAAAAAAAAAA', result: 'revived', by: 'release' },
  'routine.created': { action: 'routine.created', routineId: 'rt_AAAAAAAAAAAAAAAAAAAAAA', need: 1 },
  'routine.updated': { action: 'routine.updated', routineId: 'rt_AAAAAAAAAAAAAAAAAAAAAA', changed: ['schedule'] },
  'routine.enabled': { action: 'routine.enabled', routineId: 'rt_AAAAAAAAAAAAAAAAAAAAAA', on: true },
  'routine.deleted': { action: 'routine.deleted', routineId: 'rt_AAAAAAAAAAAAAAAAAAAAAA' },
  'routine.restored': { action: 'routine.restored', routineId: 'rt_AAAAAAAAAAAAAAAAAAAAAA' },
  'routine.run_now': { action: 'routine.run_now', routineId: 'rt_AAAAAAAAAAAAAAAAAAAAAA', slotKey: 'now|rt_AAAAAAAAAAAAAAAAAAAAAA|ck_12345678' },
  'library.uploaded': { action: 'library.uploaded', fileId: 'f_AAAAAAAAAAAAAAAAAAAAAA', contentType: 'application/pdf', bytes: 2048 },
  'library.deleted': { action: 'library.deleted', fileIds: ['f_AAAAAAAAAAAAAAAAAAAAAA'] },
  'library.restored': { action: 'library.restored', fileIds: ['f_AAAAAAAAAAAAAAAAAAAAAA'] },
  'today.set_aside': { action: 'today.set_aside', itemId: 'p_AAAAAAAAAAAAAAAAAAAAAA', reason: 'snoozed' },
  'memory.approved': { action: 'memory.approved', memoryId: 'mem_AAAAAAAAAAAAAAAAAAAAAA', rev: 3 },
  'memory.rejected': { action: 'memory.rejected', memoryId: 'mem_AAAAAAAAAAAAAAAAAAAAAA', rev: 1 },
  'team_request.created': { action: 'team_request.created', requestId: 'tr_AAAAAAAAAAAAAAAAAAAAAA', kind: 'tool' },
  'team_request.status': { action: 'team_request.status', requestId: 'tr_AAAAAAAAAAAAAAAAAAAAAA', status: 'done' },
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

describe('P3 lines (W1 first PR: the support.access routes of p3-design section 3, pause and socket attach)', () => {
  const access = (route: string) => auditText({ action: 'support.access', grantId: 'g_1', method: 'GET', route } as AuditArgs, names)
  it('names each P3 brand_data read', () => {
    const expected: [string, string][] = [
      ['/api/chats', 'The chat list'], ['/api/chats/:id', 'A chat'], ['/api/runs/active', 'The running answers'],
      ['/api/traces/:id', "An answer's steps"], ['/api/socket', 'A live answer'], ['/api/chats/:id/files', "A chat's files"],
      ['/api/files/:fileId', 'A file'], ['/api/memory', 'Memory'],
    ]
    for (const [route, detail] of expected) expect(access(route), route).toEqual({ what: 'looked at brand data', detail })
  })
  it('says what a pause, a resume and a socket attach did, with no id in the text', () => {
    expect(auditText({ action: 'agent.paused' }, names)).toEqual({ what: 'paused the agent', detail: '' })
    expect(auditText({ action: 'agent.resumed' }, names)).toEqual({ what: 'resumed the agent', detail: '' })
    const t = auditText({ action: 'support.attach', grantId: 'g_1', runId: 'r_AAAAAAAAAAAAAAAAAAAAAA' }, names)
    expect(t).toEqual({ what: 'watched a live answer', detail: '' })
  })
})

describe('P3 memory lines (W6, item 19)', () => {
  it('says what happened to a team fact, and an Inhouse forget reads as a change, not a look', () => {
    expect(auditText({ action: 'memory.forgotten', memoryId: 'mem_AAAAAAAAAAAAAAAAAAAAAA' }, names)).toEqual({ what: 'forgot a team memory', detail: '' })
    expect(auditText({ action: 'memory.restored', memoryId: 'mem_AAAAAAAAAAAAAAAAAAAAAA' }, names)).toEqual({ what: 'brought back a team memory', detail: 'It waits for an admin’s OK' })
    expect(auditText({ action: 'ops_task_revive', kind: 'deferred-hook', id: 'deferred-hook:q_A', result: 'revived', by: 'release' }, names)).toEqual({ what: 'restarted a stuck background task', detail: 'deferred-hook: restarted (release job)' })
    expect(auditText({ action: 'ops_task_revive', kind: 'routine-end', id: 'x', result: 'not_quarantined', by: 'release' }, names)).toEqual({ what: 'restarted a stuck background task', detail: 'routine-end: wasn’t stuck (release job)' })
    expect(auditText({ action: 'support.access', grantId: 'g_1', method: 'PUT', route: '/api/memory/brand/:id/forgotten' }, names)).toEqual({ what: 'changed brand data', detail: 'Team memory' })
    expect(auditText({ action: 'support.access', grantId: 'g_1', method: 'GET', route: '/api/memory' }, names)).toEqual({ what: 'looked at brand data', detail: 'Memory' })
  })
})

describe('P4 lines (wave-4 PR0): literal texts, and no id in any of them', () => {
  const rt = 'rt_AAAAAAAAAAAAAAAAAAAAAA'
  const f = 'f_AAAAAAAAAAAAAAAAAAAAAA'
  it('names each P4 brand_data read', () => {
    for (const [route, detail] of [
      ['/api/routines', 'Routines'], ['/api/today', 'Today'], ['/api/activity', 'Activity'], ['/api/library', 'The Library'],
      ['/api/library/:id/download', 'A Library file'],
    ] as const) expect(auditText({ action: 'support.access', grantId: 'g_1', method: 'GET', route }, names), route).toEqual({ what: 'looked at brand data', detail })
  })
  it('says what happened to a routine', () => {
    expect(auditText({ action: 'routine.created', routineId: rt, need: 0 }, names)).toEqual({ what: 'set up a routine', detail: 'Needs the Watch stage' })
    expect(auditText({ action: 'routine.created', routineId: rt, need: 1 }, names)).toEqual({ what: 'set up a routine', detail: 'Needs the Act stage' })
    expect(auditText({ action: 'routine.created', routineId: rt, need: 2 }, names)).toEqual({ what: 'set up a routine', detail: 'Needs the Run stage' })
    expect(auditText({ action: 'routine.updated', routineId: rt, changed: ['schedule'] }, names)).toEqual({ what: 'changed a routine', detail: 'Schedule' })
    expect(auditText({ action: 'routine.updated', routineId: rt, changed: ['missed', 'instruction'] }, names)).toEqual({ what: 'changed a routine', detail: 'Instructions, missed runs' })
    expect(auditText({ action: 'routine.updated', routineId: rt, changed: ['missed', 'schedule', 'instruction'] }, names)).toEqual({ what: 'changed a routine', detail: 'Instructions, schedule, missed runs' })
    expect(auditText({ action: 'routine.enabled', routineId: rt, on: true }, names)).toEqual({ what: 'turned a routine on', detail: '' })
    expect(auditText({ action: 'routine.enabled', routineId: rt, on: false }, names)).toEqual({ what: 'turned a routine off', detail: '' })
    expect(auditText({ action: 'routine.deleted', routineId: rt }, names)).toEqual({ what: 'deleted a routine', detail: '' })
    expect(auditText({ action: 'routine.restored', routineId: rt }, names)).toEqual({ what: 'brought back a routine', detail: '' })
    expect(auditText({ action: 'routine.run_now', routineId: rt, slotKey: `now|${rt}|ck_12345678` }, names)).toEqual({ what: 'ran a routine now', detail: '' })
  })
  it('says what happened in the Library, with the type and size of an upload', () => {
    expect(auditText({ action: 'library.uploaded', fileId: f, contentType: 'application/pdf', bytes: 2048 }, names)).toEqual({ what: 'added a file to the Library', detail: 'PDF, 2 KB' })
    expect(auditText({ action: 'library.uploaded', fileId: f, contentType: 'text/csv', bytes: 900 }, names)).toEqual({ what: 'added a file to the Library', detail: 'CSV, 900 B' })
    expect(auditText({ action: 'library.uploaded', fileId: f, contentType: 'image/png', bytes: 1_572_864 }, names)).toEqual({ what: 'added a file to the Library', detail: 'PNG image, 1.5 MB' })
    expect(auditText({ action: 'library.uploaded', fileId: f, contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', bytes: 20_971_520 }, names)).toEqual({ what: 'added a file to the Library', detail: 'Spreadsheet, 20 MB' })
    expect(auditText({ action: 'library.deleted', fileIds: [f] }, names)).toEqual({ what: 'deleted Library files', detail: '1 file' })
    expect(auditText({ action: 'library.restored', fileIds: [f, 'f_BBBBBBBBBBBBBBBBBBBBBB'] }, names)).toEqual({ what: 'brought back Library files', detail: '2 files' })
  })
  it('says what happened to an item on Today', () => {
    expect(auditText({ action: 'today.set_aside', itemId: 'p_AAAAAAAAAAAAAAAAAAAAAA', reason: 'snoozed' }, names)).toEqual({ what: 'snoozed an item on Today', detail: '' })
    expect(auditText({ action: 'today.set_aside', itemId: 'p_AAAAAAAAAAAAAAAAAAAAAA', reason: 'dismissed' }, names)).toEqual({ what: 'dismissed an item on Today', detail: '' })
    expect(auditText({ action: 'today.set_aside', itemId: 'p_AAAAAAAAAAAAAAAAAAAAAA', reason: 'declined' }, names)).toEqual({ what: 'declined an item on Today', detail: '' })
    expect(auditText({ action: 'today.set_aside', itemId: 'p_AAAAAAAAAAAAAAAAAAAAAA', reason: null }, names)).toEqual({ what: 'put back an item on Today', detail: '' })
  })
  it('never shows an id', () => {
    for (const action of ['routine.created', 'routine.updated', 'routine.enabled', 'routine.deleted', 'routine.restored', 'routine.run_now', 'library.uploaded', 'library.deleted', 'library.restored', 'today.set_aside'] as const) {
      const t = auditText(sample[action], names)
      expect(`${t.what} ${t.detail}`, action).not.toMatch(/rt_|f_A|p_A|now\|/)
    }
  })
})

describe('support.access writes (P4 review fold): a write reads as a change, never a look', () => {
  it('names each P4 write route', () => {
    for (const [method, route, detail] of [
      ['PUT', '/api/routines/:id/enabled', 'A routine'], ['POST', '/api/routines/:id/run', 'A routine'],
      ['POST', '/api/routines/:id/delete', 'A routine'], ['POST', '/api/routines/:id/restore', 'A routine'],
      ['PUT', '/api/today/:id/aside', 'An item on Today'],
      ['POST', '/api/library/delete', 'The Library'], ['POST', '/api/library/restore', 'The Library'],
    ] as const) expect(auditText({ action: 'support.access', grantId: 'g_1', method, route }, names), `${method} ${route}`).toEqual({ what: 'changed brand data', detail })
  })
})

// P6a PR0. Ways it can fail, written down first: a P6a line has no text or the wrong one; a text shows an id, a
// revision number or an em dash (the house voice); the waiting list or the approve route reads as the raw pattern.
describe('P6a lines (PR0): literal texts, no id and no em dash', () => {
  const mem = 'mem_AAAAAAAAAAAAAAAAAAAAAA'
  const tr = 'tr_AAAAAAAAAAAAAAAAAAAAAA'
  it('says what happened to a waiting team fact', () => {
    expect(auditText({ action: 'memory.approved', memoryId: mem, rev: 3 }, names)).toEqual({ what: 'approved a team memory', detail: '' })
    expect(auditText({ action: 'memory.rejected', memoryId: mem, rev: 1 }, names)).toEqual({ what: 'rejected a team memory', detail: '' })
  })
  it('says what kind of request went to the Inhouse team', () => {
    for (const [kind, detail] of [
      ['tool', 'New tool'], ['job', 'New job'], ['change', 'Change something'], ['bug', 'Bug report'], ['feedback', 'Feedback'],
    ] as const) expect(auditText({ action: 'team_request.created', requestId: tr, kind }, names), kind).toEqual({ what: 'sent the Inhouse team a request', detail })
  })
  it("says what happened to a request's status", () => {
    expect(auditText({ action: 'team_request.status', requestId: tr, status: 'done' }, names)).toEqual({ what: 'marked a request done', detail: '' })
    expect(auditText({ action: 'team_request.status', requestId: tr, status: 'declined' }, names)).toEqual({ what: 'declined a request', detail: '' })
    expect(auditText({ action: 'team_request.status', requestId: tr, status: 'withdrawn' }, names)).toEqual({ what: 'withdrew a request', detail: '' })
  })
  it('names the waiting list and the approve route in support.access', () => {
    expect(auditText({ action: 'support.access', grantId: 'g_1', method: 'GET', route: '/api/memory/waiting' }, names)).toEqual({ what: 'looked at brand data', detail: 'Team memory waiting for an OK' })
    expect(auditText({ action: 'support.access', grantId: 'g_1', method: 'PUT', route: '/api/memory/brand/:id/approved' }, names)).toEqual({ what: 'changed brand data', detail: 'Team memory' })
  })
  it('never shows an id, a revision or an em dash', () => {
    for (const action of ['memory.approved', 'memory.rejected', 'team_request.created', 'team_request.status'] as const) {
      const t = `${auditText(sample[action], names).what} ${auditText(sample[action], names).detail}`
      expect(t, action).not.toMatch(/mem_|tr_|\d|\u2014/)
    }
  })
})
