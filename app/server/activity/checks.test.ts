// The writers' rules without a database (p4-w4 tests 8 and 9, the pure part). Ways it can fail, written down first:
//  1. a field the template doesn't declare (or an inherited key such as toString), a missing field, a value with a
//     capital, a space, an @ or an m_ prefix, a negative or fractional count gets through;
//  2. a template names a slot nobody fills (a field it doesn't declare), or a table row carries a name slot;
//  3. an activity line with a missing actor or subject, the wrong source or kind, or a notice with a wrong audience
//     pair gets through;
//  4. a body is accepted on a template that doesn't allow one, missing where it's required, or over its maximum
//     (counted in code points, never truncated).
//  5. a trace, minStage, icon, link id, audience or body (a NUL) outside its shape gets through, or a link's extra keys
//     are stored; an actor or person the template has no slot for is accepted.
// The oracles are literal lists and patterns written here, not read from the code under test.
import { fc, test } from '@fast-check/vitest'
import { describe, expect, it } from 'vitest'
import { checkFields, slotsOf, TemplateError } from './fields.ts'
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
    for (const k of ['toString', 'constructor', '__proto__', 'hasOwnProperty'])
      expect(() => checkFields('t', spec, JSON.parse(`{"items":1,"code":"a","${k}":"X Y"}`)), k).toThrow(/doesn't declare/)
  })
  test.prop([fc.stringMatching(/^[a-z0-9][a-z0-9_.:|-]{0,63}$/)], { numRuns })('a lowercase code is accepted unless it starts m_', s => {
    let accepted = true
    try { checkFields('t', { v: 'code' }, { v: s }) } catch { accepted = false }
    expect(accepted).toBe(!s.startsWith('m_'))
  })
  test.prop([fc.stringMatching(/^[a-z0-9][a-z0-9_.:|-]{0,10}$/), fc.constantFrom('A', ' ', '@', '/', '\n', 'é', '\0'), fc.string({ maxLength: 5 })], { numRuns })('a code with a capital, space, @, slash or other character is refused', (a, bad, c) => {
    expect(() => checkFields('t', { v: 'code' }, { v: a + bad + c.toLowerCase().replace(/[^a-z0-9]/g, '') })).toThrow()
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
      'library_deleted', 'library_restored', 'library_uploaded', 'morning_check_ran', 'routine_changed', 'routine_deleted', 'routine_failed',
      'routine_lost', 'routine_made', 'routine_missed', 'routine_ran', 'routine_restored', 'today_set_aside',
    ])
  })
  it("every notice row fills only declared field slots and person; P4's own rows take no body", () => {
    for (const [id, t] of Object.entries(NOTICE_TEMPLATES)) {
      const allowed = new Set([...Object.keys(t.fields), 'person'])
      for (const s of slotsOfRow([t.text, t.who])) expect(allowed.has(s), `${id} slot ${s}`).toBe(true)
    }
    for (const id of ['morning_check_found', 'routine_failed', 'privacy_customer_redact', 'privacy_data_request', 'privacy_shop_redact']) expect(NOTICE_TEMPLATES[id]!.body, id).toBeUndefined()
    // P5 W4's eleven rows (p5-w4 section 3) carry a body; its own test checks them against a hand-copied list.
    expect(Object.keys(NOTICE_TEMPLATES).sort()).toEqual([
      'approval_expired', 'approval_failed', 'approval_lapsed', 'approval_sent', 'approval_waiting', 'morning_check_found',
      'needs_check', 'notify_message', 'notify_report', 'question_closed', 'question_waiting', 'privacy_customer_redact', 'privacy_data_request', 'privacy_shop_redact', 'restore_reconciled', 'routine_failed',
    ])
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
  it('refuses an actor on a template with no {actor} slot, a bad minStage and a bad trace (failure 5)', () => {
    expect(() => checkActivity({ template: 'routine_ran', fields: {}, kind: 'read', actorId: 'm_dana', atMs: 1 }, { source: 'routine-slot', key: 'k' })).toThrow(/doesn't take an actor/)
    for (const minStage of [3, -1, 1.5] as never[]) expect(() => checkActivity({ ...made, minStage }, at), String(minStage)).toThrow(/minStage/)
    for (const minStage of [0, 1, 2] as const) expect(() => checkActivity({ ...made, minStage }, at)).not.toThrow()
    for (const trace of ['', 'a b', 'r/1', 'x'.repeat(65), '<run>']) expect(() => checkActivity({ ...made, trace }, at), trace).toThrow(/trace/)
    expect(() => checkActivity({ ...made, trace: 'run_1-A' }, at)).not.toThrow()
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
    expect(() => checkNotice(table, { ...base, audience: 'member', audienceMemberId: 'm_dana' })).not.toThrow()
    expect(() => checkNotice(table, { ...base, template: 'nope' })).toThrow(/unknown notice template/)
    expect(() => checkNotice(table, { ...base, fields: { items: 1, name: 'Dana' } })).toThrow(/doesn't declare/)
    expect(() => checkNotice(table, { ...base, link: { to: 'page', page: 'nowhere' } as never })).toThrow(TemplateError)
    expect(() => checkNotice(table, { ...base, id: '' })).toThrow(/needs an id/)
  })
  test.prop([fc.string({ minLength: 1, maxLength: 400 })], { numRuns })('a system-kind body is accepted iff it is 1 to 300 code points', s => {
    let ok = true
    try { checkNotice(table, { ...base, template: 'needs_check', fields: {}, body: s }) } catch { ok = false }
    expect(ok).toBe([...s].length <= 300)
  })
  it('refuses a body with a NUL, a bad audience, an empty icon, a bad link and a person without a slot (failure 5)', () => {
    expect(() => checkNotice(table, { ...base, template: 'approval_sent', fields: {}, body: 'a\0b' })).toThrow(/NUL/)
    expect(() => checkNotice(table, { ...base, audience: 'everyone' as never })).toThrow(/audience/)
    expect(() => checkNotice(table, { ...base, icon: '' })).toThrow(/icon/)
    for (const link of [{ to: 'chat', id: 'a b' }, { to: 'chat', id: '' }, { to: 'tool', key: 'x'.repeat(65) }, { to: 'tool', key: '<k>' }, { to: 'nope' }] as never[])
      expect(() => checkNotice(table, { ...base, link }), JSON.stringify(link)).toThrow(TemplateError)
    expect(() => checkNotice(table, { ...base, personId: 'm_dana' })).toThrow(/doesn't take a personId/)
    const withPerson = { ...table, p: { source: 's', text: '{person} did it', who: 'W', fields: {} } }
    expect(() => checkNotice(withPerson, { ...base, template: 'p', fields: {} })).toThrow(/needs a personId/)
    expect(() => checkNotice(withPerson, { ...base, template: 'p', fields: {}, personId: 'm_dana' })).not.toThrow()
  })
  it('returns the parsed link: extra keys are dropped', () => {
    const link = { to: 'chat', id: 'c_1', secret: 'x' } as never
    expect(checkNotice(table, { ...base, link }).link).toEqual({ to: 'chat', id: 'c_1' })
  })
})
