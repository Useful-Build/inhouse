// Rendering a stored line or notice at read time (p4-w4 revision 3.2). Ways it can fail, written down first:
//  1. a former member (pseudonymised: no name; or gone) shows a name, or a removed member who still has a name shows as
//     former; the served actorId stops being the id;
//  2. a slot is left unfilled, or a value holding `{slot}` text is filled again (a name can't inject a template slot);
//  3. a name with braces breaks `by` (fmtProse throws on a token with no time);
//  4. a template renders with a stray brace or an undefined, for fields of its own declared types;
//  6. a template that names an actor or person on a row without one reads "A former member" instead of failing;
//  5. the bell shows a name for a former member's `person`, or drops the body, link or waiting flag.
import { fc, test } from '@fast-check/vitest'
import { describe, expect, it } from 'vitest'
import { fill, FORMER, renderLine } from './render.ts'
import type { LineRow } from './render.ts'
import { ACTIVITY_TEMPLATES } from './templates.ts'
import type { ActivityTemplateId } from './templates.ts'
import { renderNotice } from '../notices/render.ts'
import type { NoticeRow } from '../notices/read.ts'
import { NOTICE_TEMPLATES } from '../notices/templates.ts'

const numRuns = Number(import.meta.env.VITE_PROP_RUNS) || 100
const row = (o: Partial<LineRow> = {}): LineRow => ({
  n: 1, id: 'a_1', at_ms: 1_800_000_000_000, kind: 'change', min_stage: null, template: 'routine_made', fields_json: '{}', actor_id: 'm_ada', subject_id: null, trace: null, ...o,
})

describe('names at read (failure 1)', () => {
  it('shows the current name, A former member without one, and keeps the id on the line', () => {
    expect(renderLine(row(), new Map([['m_ada', 'Ada Example']]))).toMatchObject({ text: 'Ada Example set up a routine', who: 'Ada Example', actorId: 'm_ada' })
    expect(renderLine(row(), new Map())).toMatchObject({ text: `${FORMER} set up a routine`, who: FORMER, actorId: 'm_ada' })
    expect(FORMER).toBe('A former member')
  })
  it('a system line has no actorId and no name', () => {
    const line = renderLine(row({ template: 'routine_missed', actor_id: null, kind: 'problem' }), new Map())
    expect(line.actorId).toBeUndefined()
    expect(line).toMatchObject({ text: 'A routine missed its time', who: 'Your Inhouse agent' })
  })
  it('maps minStage and carries the trace and the time', () => {
    const line = renderLine(row({ min_stage: 2, trace: 'r_9', template: 'routine_ran', actor_id: null, kind: 'read' }), new Map())
    expect(line).toMatchObject({ minStage: 'Run', trace: 'r_9', at: { ms: 1_800_000_000_000 } })
    expect(renderLine(row({ min_stage: 0 }), new Map(), ).minStage).toBe('Watch')
  })
})

describe('slots (failures 2 and 3)', () => {
  it('fills in one pass: a value holding {items} stays text', () => {
    expect(fill('{actor} did {items}', { actor: '{items}', items: '3' })).toBe('{items} did 3')
    expect(() => fill('{missing}', {})).toThrow(/no value/)
  })
  it('a counted noun is singular for exactly 1 (0, 1 and 2)', () => {
    expect(fill('found {items:thing}', { items: '0' })).toBe('found 0 things')
    expect(fill('found {items:thing}', { items: '1' })).toBe('found 1 thing')
    expect(fill('found {items:thing}', { items: '2' })).toBe('found 2 things')
    for (const [files, text] of [[0, '0 files'], [1, '1 file'], [2, '2 files']] as const)
      expect(renderLine(row({ template: 'library_uploaded', fields_json: JSON.stringify({ files }) }), new Map([['m_ada', 'Ada']])).text).toBe(`Ada added ${text} to the Library`)
    for (const [items, text] of [[0, '0 things'], [1, '1 thing'], [2, '2 things']] as const) {
      expect(renderLine(row({ template: 'morning_check_ran', kind: 'read', actor_id: null, fields_json: JSON.stringify({ items }) }), new Map()).text).toBe(`Ran the morning check and found ${text}`)
      expect(renderNotice({ id: 'n', audience: 'team', template: 'morning_check_found', fields_json: JSON.stringify({ items }), body: null, icon: 'x', person_id: null, at_ms: 1, waiting: 0, link_json: '{"to":"page","page":"today"}', unread: 1 }, new Map()).text).toBe(`The morning check found ${text}`)
    }
  })
  it('a member named "{read} Kim" renders without the braces, so no text holds a demo placeholder', () => {
    const line = renderLine(row(), new Map([['m_ada', '{read} Kim']]))
    expect(line).toMatchObject({ text: 'read Kim set up a routine', who: 'read Kim' })
    const notice = renderNotice({ id: 'n', audience: 'team', template: 'shown', fields_json: '{}', body: null, icon: 'x', person_id: 'm_ada', at_ms: 1, waiting: 0, link_json: '{"to":"page","page":"today"}', unread: 1 },
      new Map([['m_ada', '{read} Kim']]), { shown: { source: 't', text: '{person} did it', who: 'W', fields: {} } })
    expect(notice).toMatchObject({ text: 'read Kim did it', person: '{read} Kim' })
  })
  it('a template that names {actor} on a row with no actor fails loud, never "A former member" (failure 6)', () => {
    expect(() => renderLine(row({ actor_id: null }), new Map())).toThrow(/no value/)
    expect(() => renderNotice({ id: 'n', audience: 'team', template: 'shown', fields_json: '{}', body: null, icon: 'x', person_id: null, at_ms: 1, waiting: 0, link_json: '{"to":"page","page":"today"}', unread: 1 },
      new Map(), { shown: { source: 't', text: '{person} did it', who: 'W', fields: {} } })).toThrow(/no value/)
  })
  it('a name with braces can\'t break `by` (the prose the screen formats)', () => {
    const line = renderLine(row(), new Map([['m_ada', 'Ada {at:time} {x}']]))
    expect(line.by.text).toBe('Ada at:time x, at {at:time}')
    expect(Object.keys(line.by.times)).toEqual(['at'])
    // The headline has no braces either: a name can't carry a slot into any text.
    expect(line.text).toBe('Ada at:time x set up a routine')
  })
})

describe('every template renders (failure 4)', () => {
  const sample = (id: ActivityTemplateId) => Object.fromEntries(Object.entries(ACTIVITY_TEMPLATES[id].fields).map(([k, t]) => [k, t === 'number' ? 7 : 'run_failed']))
  test.prop([fc.constantFrom(...(Object.keys(ACTIVITY_TEMPLATES) as ActivityTemplateId[])), fc.string({ maxLength: 20 })], { numRuns })('no stray brace or undefined', (id, name) => {
    const t = ACTIVITY_TEMPLATES[id]
    const line = renderLine(row({ template: id, kind: t.kind, fields_json: JSON.stringify(sample(id)), actor_id: 'm_ada' }), new Map([['m_ada', name.replace(/[{}]/g, '')]]))
    for (const s of [line.text, line.why, line.result, line.who]) { expect(s).not.toMatch(/[{}]/); expect(s).not.toContain('undefined') }
  })
  it('an unknown template fails loud', () => expect(() => renderLine(row({ template: 'nope' }), new Map())).toThrow(/unknown activity template/))
})

describe('notices (failure 5)', () => {
  const n = (o: Partial<NoticeRow> = {}): NoticeRow => ({
    id: 'n1', audience: 'team', template: 'morning_check_found', fields_json: '{"items":3}', body: null, icon: 'notifications', person_id: null, at_ms: 5, waiting: 0, link_json: '{"to":"page","page":"today"}', unread: 1, ...o,
  })
  const withPerson = { ...NOTICE_TEMPLATES, shown: { source: 't', text: '{person} did it', who: 'W', fields: {} } }
  it('renders text, who, link and unread from the row', () => {
    expect(renderNotice(n(), new Map())).toEqual({ id: 'n1', icon: 'notifications', text: 'The morning check found 3 things', who: 'Your Inhouse agent', at: { iso: '1970-01-01T00:00:00.005Z', ms: 5 }, unread: true, link: { to: 'page', page: 'today' } })
  })
  it('a person shows their name and avatar; a former member reads A former member and gets no avatar', () => {
    expect(renderNotice(n({ template: 'shown', fields_json: '{}', person_id: 'm_ada' }), new Map([['m_ada', 'Ada Example']]), withPerson)).toMatchObject({ text: 'Ada Example did it', person: 'Ada Example' })
    const gone = renderNotice(n({ template: 'shown', fields_json: '{}', person_id: 'm_ada' }), new Map(), withPerson)
    expect(gone.text).toBe('A former member did it')
    expect(gone.person).toBeUndefined()
  })
  it('waiting and body pass through; body is exactly the stored text', () => {
    const text = '<b>x</b> **x** https://example.com/a?b=1'
    expect(renderNotice(n({ waiting: 1, body: text }), new Map())).toMatchObject({ waiting: true, body: text })
    expect(renderNotice(n(), new Map()).waiting).toBeUndefined()
  })
  it('a stored link that is not a link fails loud', () => expect(() => renderNotice(n({ link_json: '{"to":"nowhere"}' }), new Map())).toThrow())
})
