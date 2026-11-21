// The writers' rules without a database (p4-w4 tests 8 and 9, the pure part). Ways it can fail, written down first:
//  1. a field the template doesn't declare, a missing field, a value that looks like a member id or a name, a negative
//     or fractional count gets through;
//  2. a template names a slot nobody fills (a field it doesn't declare), or a table row carries a name slot;
//  3. an activity line with a missing actor or subject, the wrong source or kind, or a notice with a wrong audience
//     pair gets through;
//  4. a body is accepted on a template that doesn't allow one, missing where it's required, or over its maximum
//     (counted in code points, never truncated).
// The oracles are literal lists written here, not read from the code under test.
import { fc, test } from '@fast-check/vitest'
import { describe, expect, it } from 'vitest'
import { checkFields, slotsOf } from './fields.ts'
import { ACTIVITY_TEMPLATES, memberSlots } from './templates.ts'
import type { ActivityInput } from './store.ts'
import { checkActivity } from './store.ts'
import { checkNotice } from '../notices/store.ts'
import type { NoticeInput } from '../notices/store.ts'
import { NOTICE_TEMPLATES } from '../notices/templates.ts'
import type { NoticeTemplate } from '../notices/templates.ts'

const numRuns = Number(import.meta.env.VITE_PROP_RUNS) || 100
const spec = { items: 'number', code: 'code' } as const

describe('checkFields (failure 1)', () => {
  it('accepts exactly the declared fields', () => {
    expect(() => checkFields('t', spec, { items: 3, code: 'gap.refunds' })).not.toThrow()
    expect(() => checkFields('t', spec, { items: 3 })).toThrow(/needs field code/)
    expect(() => checkFields('t', spec, { items: 3, code: 'x', extra: 1 })).toThrow(/doesn't declare field extra/)
  })
  it('refuses member ids, names, free text and bad counts', () => {
    for (const code of ['m_abc123', 'Dana Kim', 'dana kim', 'Dana', '', 'a'.repeat(65), 'x\ny'])
      expect(() => checkFields('t', spec, { items: 1, code }), code).toThrow(/fixed code/)
    for (const items of [-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 2])
      expect(() => checkFields('t', spec, { items, code: 'a' }), String(items)).toThrow(/count/)
    expect(() => checkFields('t', spec, { items: '3', code: 'a' })).toThrow(/count/)
    expect(() => checkFields('t', spec, { items: 1, code: 7 })).toThrow(/fixed code/)
  })
  test.prop([fc.string()], { numRuns })('a code value is accepted only when it matches the code shape and isn\'t m_-prefixed', s => {
    const ok = /^[a-z0-9][a-z0-9_.:|-]{0,63}$/.test(s) && !s.startsWith('m_')
    let accepted = true
    try { checkFields('t', { v: 'code' }, { v: s }) } catch { accepted = false }
    expect(accepted).toBe(ok)
  })
  test.prop([fc.stringMatching(/^m_[A-Za-z0-9_-]{1,64}$/)], { numRuns })('a member id is never a field value', id => {
    expect(() => checkFields('t', { v: 'code' }, { v: id })).toThrow()
  })
})

describe('the tables (failure 2)', () => {
  const slotsOfRow = (texts: string[]) => new Set(texts.flatMap(slotsOf))
  it('every activity row fills only declared field slots, actor and subject; none declares a name slot', () => {
    for (const [id, t] of Object.entries(ACTIVITY_TEMPLATES)) {
      const allowed = new Set([...Object.keys(t.fields), 'actor', 'subject'])
      for (const s of slotsOfRow([t.text, t.why, t.result, t.who])) expect(allowed.has(s), `${id} slot ${s}`).toBe(true)
      for (const f of Object.keys(t.fields)) expect(['name', 'person', 'member', 'email', 'routine_name', 'title'], `${id}.${f}`).not.toContain(f)
    }
  })
  it('the activity template ids are the literal list', () => {
    expect(Object.keys(ACTIVITY_TEMPLATES).sort()).toEqual([
      'library_deleted', 'library_restored', 'library_uploaded', 'routine_changed', 'routine_deleted', 'routine_failed', 'routine_made',
      'routine_missed', 'routine_ran', 'system_routine_ran', 'today_aside',
    ])
  })
  it('every notice row fills only declared field slots and person; none takes a body today', () => {
    for (const [id, t] of Object.entries(NOTICE_TEMPLATES)) {
      const allowed = new Set([...Object.keys(t.fields), 'person'])
      for (const s of slotsOfRow([t.text, t.who])) expect(allowed.has(s), `${id} slot ${s}`).toBe(true)
      expect(t.body, id).toBeUndefined()
    }
    expect(Object.keys(NOTICE_TEMPLATES).sort()).toEqual(['morning_check_found', 'routine_failed'])
  })
})

describe('checkActivity (failure 3)', () => {
  const made: ActivityInput = { template: 'routine_made', fields: {}, kind: 'change', actorId: 'm_dana', atMs: 1 }
  const at = { source: 'routine', key: 'k1' }
  it('accepts a well-formed line', () => expect(() => checkActivity(made, at)).not.toThrow())
  it('refuses a missing actor, a stray subject, the wrong source or kind, an unknown template and a bad id', () => {
    expect(() => checkActivity({ ...made, actorId: undefined }, at)).toThrow(/needs an actor/)
    expect(() => checkActivity({ ...made, subjectId: 'm_lee' }, at)).toThrow(/subject/)
    expect(() => checkActivity(made, { source: 'library', key: 'k' })).toThrow(/belongs to source routine/)
    expect(() => checkActivity({ ...made, kind: 'problem' }, at)).toThrow(/is a change line/)
    expect(() => checkActivity({ ...made, template: 'nope' as never }, at)).toThrow(/unknown activity template/)
    expect(() => checkActivity({ ...made, actorId: 'Dana Kim' }, at)).toThrow(/member ids/)
    expect(() => checkActivity(made, { source: 'routine', key: '' })).toThrow(/needs a key/)
    expect(() => checkActivity({ ...made, fields: { name: 'Dana' } }, at)).toThrow(/doesn't declare/)
  })
  it('a template with a {subject} slot needs a subject', () => {
    const withSubject = { ...ACTIVITY_TEMPLATES.routine_made, text: '{actor} gave {subject} a routine' }
    expect(memberSlots(withSubject)).toEqual({ actor: true, subject: true })
    expect(memberSlots(ACTIVITY_TEMPLATES.routine_ran)).toEqual({ actor: false, subject: false })
  })
})

describe('checkNotice (failures 3 and 4)', () => {
  const body = (max: number): NoticeTemplate => ({ source: 'test', text: 'T', who: 'W', fields: {}, body: { max } })
  // The eleven P5 kinds and their maximums, as a literal list (p5-w4.md section 3), plus P4's own two.
  const P5: [string, number][] = [
    ['notify_message', 1622], ['notify_report', 1622],
    ...['approval_waiting', 'approval_lapsed', 'approval_sent', 'approval_failed', 'needs_check', 'approval_expired', 'restore_reconciled', 'question_waiting', 'question_closed'].map(k => [k, 300] as [string, number]),
  ]
  const table: Record<string, NoticeTemplate> = { ...NOTICE_TEMPLATES, ...Object.fromEntries(P5.map(([k, max]) => [k, body(max)])) }
  const base: NoticeInput = { id: 'n1', audience: 'team', template: 'morning_check_found', fields: { items: 2 }, icon: 'x', link: { to: 'page', page: 'today' }, atMs: 1 }

  it('accepts a body exactly on the eleven kinds, at the maximum, and refuses it everywhere else', () => {
    for (const template of Object.keys(table)) {
      const p5 = P5.find(([k]) => k === template)
      const fields: Record<string, string | number> = template === 'routine_failed' ? { code: 'x' } : template === 'morning_check_found' ? { items: 1 } : {}
      const n: NoticeInput = { ...base, template, fields }
      if (p5) {
        expect(() => checkNotice(table, { ...n, body: 'a'.repeat(p5[1]) }), template).not.toThrow()
        expect(() => checkNotice(table, { ...n, body: 'a'.repeat(p5[1] + 1) }), template).toThrow(/code points/)
        expect(() => checkNotice(table, { ...n, body: '' }), template).toThrow(/code points/)
        expect(() => checkNotice(table, n), template).toThrow(/needs a body/)
      } else {
        expect(() => checkNotice(table, { ...n, body: 'hello' }), template).toThrow(/takes no body/)
        expect(() => checkNotice(table, n), template).not.toThrow()
      }
    }
  })
  it('counts code points, not UTF-16 units', () => {
    const n = { ...base, template: 'approval_sent', fields: {} }
    expect(() => checkNotice(table, { ...n, body: '😀'.repeat(300) })).not.toThrow()
    expect(() => checkNotice(table, { ...n, body: '😀'.repeat(301) })).toThrow(/code points/)
  })
  it('refuses a wrong audience pair, a bad id and an unknown template', () => {
    expect(() => checkNotice(table, { ...base, audience: 'member' })).toThrow(/audienceMemberId/)
    expect(() => checkNotice(table, { ...base, audienceMemberId: 'm_dana' })).toThrow(/audienceMemberId/)
    expect(() => checkNotice(table, { ...base, audience: 'member', audienceMemberId: 'Dana' })).toThrow(/member ids/)
    expect(() => checkNotice(table, { ...base, audience: 'member', audienceMemberId: 'm_dana', personId: 'm_lee' })).not.toThrow()
    expect(() => checkNotice(table, { ...base, template: 'nope' })).toThrow(/unknown notice template/)
    expect(() => checkNotice(table, { ...base, fields: { items: 1, name: 'Dana' } })).toThrow(/doesn't declare/)
    expect(() => checkNotice(table, { ...base, link: { to: 'page', page: 'nowhere' } as never })).toThrow()
    expect(() => checkNotice(table, { ...base, id: '' })).toThrow(/needs an id/)
  })
  test.prop([fc.string({ minLength: 1, maxLength: 400 })], { numRuns })('a system-kind body is accepted iff it is 1 to 300 code points', s => {
    let ok = true
    try { checkNotice(table, { ...base, template: 'needs_check', fields: {}, body: s }) } catch { ok = false }
    expect(ok).toBe([...s].length <= 300)
  })
  it('a body holding markup and a URL is stored as those literal characters (the writer never rewrites it)', () => {
    const text = '<b>x</b> **x** https://example.com/a?b=1'
    const n = { ...base, template: 'notify_message', fields: {}, body: text }
    expect(() => checkNotice(table, n)).not.toThrow()
    expect(n.body).toBe(text)
  })
})
