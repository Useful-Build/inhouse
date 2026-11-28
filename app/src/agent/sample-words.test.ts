// What the demo's sample data may say (the review's High 1 and #751). It shows only what the product can do, so no sentence
// in it drafts, sends or approves an act the product can't take (a purchase order, an email, a ticket reply, a PDF to a
// supplier), and no word names a stage (as e2e/real/no-stages.spec.ts for the product). Ways it could break, written first:
//  1. a sample sentence says an email, a PO or a ticket reply was drafted, sent or approved;
//  2. a skill, a routine, a tool, a Library file, an Activity row or the bell promises such a draft on Approvals;
//  3. a stage word ("Watch", "Act", "Run", "stage") is shown.
// The data's own notes (`note`, `fieldGuide`, `usedBy`) and the patterns that match what a person types (`match`) are not shown.
import { describe, expect, test } from 'vitest'
import activity from '@sample/activity.json'
import chatScript from '@sample/chat-script.json'
import chats from '@sample/chats.json'
import help from '@sample/help.json'
import library from '@sample/library.json'
import memory from '@sample/memory.json'
import notifications from '@sample/notifications.json'
import people from '@sample/people-and-rules.json'
import problems from '@sample/problems.json'
import routines from '@sample/routines.json'
import skillBodies from '@sample/skill-bodies.json'
import skills from '@sample/skills.json'
import tools from '@sample/tools.json'

const FILES: Record<string, unknown> = { activity, 'chat-script': chatScript, chats, help, library, memory, notifications, 'people-and-rules': people, problems, routines, 'skill-bodies': skillBodies, skills, tools }
const UNSHOWN = new Set(['note', 'fieldGuide', 'usedBy', 'match', 'trace'])

/** Every string a screen can show, with where it is. */
function strings(v: unknown, path: string, out: [string, string][] = []): [string, string][] {
  if (typeof v === 'string') out.push([path, v])
  else if (Array.isArray(v)) v.forEach((x, i) => strings(x, `${path}[${i}]`, out))
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) if (!UNSHOWN.has(k)) strings(x, `${path}.${k}`, out)
  return out
}
const ALL = Object.entries(FILES).flatMap(([name, v]) => strings(v, name))

/** An act the product can't take, as a sentence would say it was drafted, sent or approved. */
const REMOVED_ACTS: [string, RegExp][] = [
  ['a drafted email, PO, chase or ticket reply', /\bdraft(s|ed|ing)?\b[^.]{0,40}\b(purchase order|PO\b|reorders?|chase|e-?mail|repl(y|ies)|ticket)/i],
  ['a PO or a note sent to a supplier', /\b(sent|went|goes|send) to (Kestrel|Mei)\b|purchase order went|\bChase sent\b|\bChased Kestrel\b|\bAsked ShipBob\b/i],
  ['a purchase order as a PDF', /purchase orders? as a PDF/i],
  ['customer or supplier emails sent by the agent', /\b(customer|supplier) e-?mails? (wait|still wait|go|are sent)\b|\bemailed\b|\bEmails sent\b|\bwrite (a|an) (short, polite )?e-?mail\b/i],
  ['a draft on Approvals that is not a Shopify change or a Slack post', /\b(email|reply|purchase order|PO)\b[^.]{0,30}\bon Approvals\b|\bin Approvals\b/i],
]
const STAGE_NAME = /\b(Watch|Act|Run)\b(?! now)/
const STAGE_WORD = /\bstages?\b/i

type ActRow = { text: string; result?: string; by?: { text: string } }
type Problem = { id: string; draft: { lines: unknown[]; body?: string; items?: unknown[] } } & Record<string, unknown>
const PROBLEMS = (problems as unknown as { problems: Problem[] }).problems
const isDraft = (p: Problem) => p.draft.lines.length > 0 || !!p.draft.body || !!p.draft.items?.length
/** Run-only fields: what the agent did by itself, what waited and the sentences for a handled problem. */
const RUN_FIELDS = ['done', 'wait', 'partial', 'partialShort', 'runDoneText', 'isDraft']

describe('the sample data shows only what the product can do', () => {
  test('there are strings to check', () => expect(ALL.length).toBeGreaterThan(1000))
  for (const [what, re] of REMOVED_ACTS) {
    test(`no sentence says ${what}`, () => {
      expect(ALL.filter(([, s]) => re.test(s)).map(([p, s]) => `${p}: ${s.slice(0, 120)}`)).toEqual([])
    })
  }
  test('a finding (a problem with no draft) carries no Run-only field that names an act: what it did, what waits, a draft flag (issue 751)', () => {
    for (const p of PROBLEMS.filter(x => !isDraft(x))) expect(RUN_FIELDS.filter(k => k in p), p.id).toEqual([])
  })
  test("the Library's Approvals place holds only what a real draft made: no purchase order, and every file's problem has a draft", () => {
    const files = (library as { files: { id: string; place: string; madeByAgent?: boolean; doc?: { tag?: string }; link?: { to: string; id?: string } }[] }).files
    expect(files.filter(f => f.madeByAgent && f.doc?.tag === 'Purchase order').map(f => f.id)).toEqual([])
    for (const f of files.filter(x => x.place === 'approvals' || x.link?.to === 'approval')) {
      const p = PROBLEMS.find(x => x.id === f.link?.id)
      expect(p && isDraft(p), `${f.id} links to ${String(f.link?.id)}, which has no draft`).toBe(true)
    }
  })
  // Only an Admin may approve what the server's operation marks `memberMay: false` (a refund: shopify-refund-create.ts), so no
  // Activity row or bell line says a Member approved one (the review of round 3, part of issue 761).
  test('every approval of a refund in Activity or the bell names an Admin', () => {
    const admins = new Set((people as { members: { name: string; role: string }[] }).members.filter(m => m.role === 'Admin').map(m => m.name))
    const rows = [...(activity as { today: ActRow[] }).today, ...(activity as { earlier: ActRow[] }).earlier]
    const refunds = rows.filter(r => /refund/i.test(`${r.text} ${r.result ?? ''}`) && /approved by/.test(r.by?.text ?? ''))
    expect(refunds.length, 'there is a refund approval to check').toBeGreaterThan(0)
    for (const r of refunds) expect(admins.has(/approved by ([^,.]+?) at/.exec(r.by!.text)?.[1] ?? ''), r.text).toBe(true)
    const bell = (notifications as { notifications: { text?: string; who: string }[] }).notifications.filter(n => /approved/i.test(n.text ?? '') && /refund/i.test(n.text ?? ''))
    expect(bell.length, 'there is a refund notice to check').toBeGreaterThan(0)
    for (const n of bell) expect(admins.has(n.who), n.text).toBe(true)
  })
  test('no word names a stage', () => {
    expect(ALL.filter(([, s]) => STAGE_NAME.test(s) || STAGE_WORD.test(s)).map(([p, s]) => `${p}: ${s.slice(0, 120)}`)).toEqual([])
  })
})
