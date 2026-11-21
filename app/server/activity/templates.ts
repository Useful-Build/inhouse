// Activity's fixed lines (p4-w4 section 1, revisions 3.1 and 3.2): a literal table, one row per `ActivityTemplateId`.
// A row names its fields (counts and fixed codes) and fills its `{actor}`, `{subject}` and `{field}` slots at read time
// (render.ts, PR 2) with the members table and the stored fields. No model or person text is ever a template, a field
// or a slot: a team routine's name or instruction appears only through the item or routine a line links to.
import type { FieldSpec } from './fields.ts'
import { slotsOf } from './fields.ts'

export type ActivityKind = 'read' | 'change' | 'needs' | 'problem'

export interface ActivityTemplate {
  kind: ActivityKind
  /** The producer's source: a template belongs to one (W2 `routine-slot` and `routine`, W3 `today-aside`, W5 `library`). */
  source: 'routine-slot' | 'routine' | 'today-aside' | 'library'
  /** The line's headline. */
  text: string
  /** Why it happened. */
  why: string
  /** What came of it. */
  result: string
  /** The line's `who` when no member did it: the agent or the system. A template with `{actor}` is a person's line. */
  who: string
  /** Declared fields, all required. `routine` is a system routine's id, `code` a gap or failure code. */
  fields: FieldSpec
}

export const ACTIVITY_TEMPLATES = {
  // W2 (p4-w2.md 6, 8): a team routine's run reads "Ran a routine" (its trace opens the steps); the closes `lost` and
  // `missed` and a failure are problem lines keyed `slot_key|lost`, `slot_key|missed`, `slot_key`.
  routine_ran: {
    kind: 'read', source: 'routine-slot',
    text: 'Ran a routine', why: 'Its time came', result: 'It finished', who: 'Your Inhouse agent',
    fields: {},
  },
  routine_missed: {
    kind: 'problem', source: 'routine-slot',
    text: 'A routine missed its time', why: 'The agent was busy or unavailable at its time', result: 'It didn\'t run', who: 'Your Inhouse agent',
    fields: {},
  },
  routine_lost: {
    kind: 'problem', source: 'routine-slot',
    text: 'A routine stopped without an end', why: 'No end came in time', result: 'Its result was not saved', who: 'Your Inhouse agent',
    fields: {},
  },
  routine_failed: {
    kind: 'problem', source: 'routine-slot',
    text: 'A routine failed', why: 'It stopped with {code}', result: 'Nothing was saved', who: 'Your Inhouse agent',
    fields: { code: 'code' },
  },
  // W3: the system routine's name is ours, so "Ran the morning check" is fine (p4-w2.md 8).
  morning_check_ran: {
    kind: 'read', source: 'routine-slot',
    text: 'Ran the morning check and found {items} things', why: 'Its time came', result: 'Found {items}', who: 'Your Inhouse agent',
    fields: { items: 'number' },
  },
  routine_made: {
    kind: 'change', source: 'routine',
    text: '{actor} set up a routine', why: '{actor} asked for it', result: 'It runs on its schedule', who: '{actor}',
    fields: {},
  },
  routine_changed: {
    kind: 'change', source: 'routine',
    text: '{actor} changed a routine', why: '{actor} asked for it', result: 'The new settings apply from its next run', who: '{actor}',
    fields: {},
  },
  routine_deleted: {
    kind: 'change', source: 'routine',
    text: '{actor} deleted a routine', why: '{actor} asked for it', result: 'It won\'t run again', who: '{actor}',
    fields: {},
  },
  // W3 (p4-w3.md 6): "<person> set aside an item on Today", the person as `actorId`.
  today_set_aside: {
    kind: 'change', source: 'today-aside',
    text: '{actor} set aside an item on Today', why: '{actor} chose to', result: 'It leaves Today\'s list', who: '{actor}',
    fields: {},
  },
  // W5: the uploader as `actorId`.
  library_uploaded: {
    kind: 'change', source: 'library',
    text: '{actor} added {files} files to the Library', why: '{actor} uploaded them', result: 'The agent can use them', who: '{actor}',
    fields: { files: 'number' },
  },
  library_deleted: {
    kind: 'change', source: 'library',
    text: '{actor} deleted a file from the Library', why: '{actor} asked for it', result: 'The agent can\'t use it any more', who: '{actor}',
    fields: {},
  },
  library_restored: {
    kind: 'change', source: 'library',
    text: '{actor} brought a file back to the Library', why: '{actor} restored it', result: 'The agent can use it again', who: '{actor}',
    fields: {},
  },
} as const satisfies Record<string, ActivityTemplate>

export type ActivityTemplateId = keyof typeof ACTIVITY_TEMPLATES

export const isActivityTemplate = (id: string): id is ActivityTemplateId => Object.hasOwn(ACTIVITY_TEMPLATES, id)

/** Which member slots a template uses, from its texts. */
export function memberSlots(t: ActivityTemplate): { actor: boolean; subject: boolean } {
  const slots = new Set([t.text, t.why, t.result, t.who].flatMap(slotsOf))
  return { actor: slots.has('actor'), subject: slots.has('subject') }
}
