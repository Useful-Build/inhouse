// The review window for a problem with no real draft: the server's morning-check placeholder (no lines, no text, no
// items, `cta: 'Approve'`, see server/today/problem.ts). Ways this could fail, written down before the tests:
//  1. at Act or Run the placeholder reads as a draft waiting for you, so the window offers Edit, Approve and Don't send
//     that the product refuses;
//  2. a real draft (lines, text, items or run lines alone) is taken for a placeholder and loses its Approve;
//  3. an approved or handled problem goes back to Watch because its draft is empty;
//  4. a refused Approve still reads as approved: the store's `approve` resolves as done, so the window steps on;
//  5. the Today card or the Approvals queue still offers Approve for it, which the product refuses.
import { describe, expect, test, vi } from 'vitest'
import fc from 'fast-check'

// The UI store reads the browser at import (window, storage, matchMedia): the smallest stand-ins that let it load under Node.
vi.hoisted(() => {
  const storage = { getItem: () => null, setItem: () => undefined, removeItem: () => undefined, clear: () => undefined, key: () => null, length: 0 }
  const g = globalThis as Record<string, unknown>
  g.window = Object.assign(globalThis, { addEventListener: () => undefined, removeEventListener: () => undefined, matchMedia: () => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined }), localStorage: storage, sessionStorage: storage })
})
const { agent } = await import('../agent')
const { AgentError } = await import('../agent/types')
const { draftView, hasDraft, issueCards, pendingIds } = await import('./derive')
const { useUi } = await import('./store')
type Ctx = Parameters<typeof draftView>[0]
type Problem = Ctx['data']['problems'][number]

const sample = agent.read()
/** The server's Watch placeholder, on a sample problem's other fields. */
const placeholder = (p: Problem): Problem => ({ ...p, id: `${p.id}-placeholder`, draft: { title: p.next, lines: [], cta: 'Approve' } })
const ctxWith = (S: 0 | 1 | 2, problems: Problem[], over: Partial<Ctx['agent']> = {}): Ctx =>
  ({ S, agent: { ...agent.getSnapshot(), ...over }, data: { ...sample, problems } })

describe('a problem with no real draft', () => {
  const p = placeholder(sample.problems[0])

  test('reads as Watch at every stage, so the window shows the suggestion and Ask Inhouse, not a draft', () => {
    expect(hasDraft(p)).toBe(false)
    for (const S of [0, 1, 2] as const) expect(draftView(ctxWith(S, [p]), p.id).mode).toBe('watch')
  })

  test('the sample findings have no draft, every other sample draft is a real one, and any one of lines, text, items or run lines makes it real', () => {
    // #726: what the product can't do yet is a finding (noticed, with a suggested next step), never a draft to approve.
    const FINDINGS = ['oversell', 'stock', 'po']
    expect(sample.problems.filter(q => !hasDraft(q)).map(q => q.id)).toEqual(FINDINGS)
    for (const q of sample.problems) {
      expect(draftView(ctxWith(1, sample.problems), q.id).mode === 'watch', q.id).toBe(FINDINGS.includes(q.id))
    }
    const item = { name: 'Ridge 30L Pack', qty: 1, each: { minor: 100, currency: 'USD' } }
    fc.assert(fc.property(fc.boolean(), fc.boolean(), fc.boolean(), fc.boolean(), (lines, body, items, runLines) => {
      const draft = {
        ...p.draft,
        lines: lines ? [['To', 'Kestrel'] as [string, string]] : [],
        ...(body ? { body: 'Hi Kestrel,' } : {}),
        ...(items ? { items: [item] } : {}),
        ...(runLines ? { runLines: [['To', 'Kestrel'] as [string, string]] } : {}),
      }
      expect(hasDraft({ ...p, draft })).toBe(lines || body || items || runLines)
    }))
  })

  test('the Today card offers no Approve and the approval queue leaves it out, at every stage', () => {
    for (const S of [1, 2] as const) {
      const ctx = ctxWith(S, [p, ...sample.problems])
      expect(issueCards(ctx).find(c => c.problem.id === p.id)?.primary ?? null, `S${S}`).toBeNull()
      expect(pendingIds(ctx), `S${S}`).not.toContain(p.id)
    }
    // A real draft still waits for approval at Act.
    expect(pendingIds(ctxWith(1, sample.problems))).toContain(sample.problems.find(hasDraft)!.id)
  })

  test('approved stays approved even with an empty draft', () => {
    const at = { iso: new Date(0).toISOString(), ms: 0 }
    const approved = { [p.id]: { at, by: 'sam', loggedAt: at, title: p.draft.title, doneText: 'Done', partial: false } }
    expect(draftView(ctxWith(1, [p], { approved } as Partial<Ctx['agent']>), p.id).mode).toBe('approved')
  })
})

describe("the store's approve", () => {
  test('resolves with why it was refused, never as approved', async () => {
    const spy = vi.spyOn(agent, 'approve').mockReturnValueOnce(Promise.reject(new AgentError('unavailable', 'Not connected yet.')))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await expect(useUi.getState().approve('stock')).resolves.toBe('Not connected yet.')
    spy.mockRestore(); warn.mockRestore()
  })

  test('resolves with null once approved', async () => {
    const at = { iso: new Date(0).toISOString(), ms: 0 }
    const record = { at, by: 'sam', loggedAt: at, title: 'Reorder', doneText: 'Done', partial: false }
    const spy = vi.spyOn(agent, 'approve').mockReturnValueOnce(Promise.resolve({ record, held: false, doneText: 'Done' }))
    await expect(useUi.getState().approve('stock')).resolves.toBeNull()
    spy.mockRestore()
  })
})
