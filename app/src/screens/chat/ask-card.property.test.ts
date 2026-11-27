// What an action's card offers and how its hold counts down (Stage 1 M2-H, N15, N18). Invariants, written first:
//  1. A button shows only where the card's `can` allows it, and in the state it belongs to: an answer only while waiting,
//     Undo only in the hold, the two "Needs a check" answers only there. A card with every `can` false offers nothing.
//  2. Always allow is never offered on an exact card (its `can.alwaysAllow` is false there) and never twice; when the
//     server nudges it, it comes first and is the primary; otherwise Allow once is the primary.
//  3. The hold's countdown comes from the server's clock: at the moment of reading it is `sendAt - serverNow`, whatever the
//     browser's clock says; it never grows as time passes, never goes below 0, and is null outside the hold.
//  4. The words never carry an em or en dash.
import { fc, test } from '@fast-check/vitest'
import { describe, expect } from 'vitest'
import type { ActionCard, ActionState } from '../../agent/types'
import { AgentError } from '../../agent/types'
import { GUARDRAIL_TEXT, answeredToast, buttonsOf, factsOf, holdLeftMs, holdText, kickerOf, outcomeOf, refusalOf } from './ask-card'

const STATES: ActionState[] = ['waiting', 'approved', 'sending', 'sent', 'failed', 'needs_check', 'undone', 'denied', 'withdrawn', 'expired']
const instant = (ms: number) => ({ iso: new Date(ms).toISOString(), ms })

const cardArb: fc.Arbitrary<ActionCard> = fc.record({
  state: fc.constantFrom(...STATES),
  kind: fc.constantFrom('ask' as const, 'exact' as const),
  can: fc.record({ allowOnce: fc.boolean(), alwaysAllow: fc.boolean(), approve: fc.boolean(), deny: fc.boolean(), undo: fc.boolean(), resolve: fc.boolean(), withdraw: fc.boolean() }),
  nudgeAlways: fc.boolean(),
  serverNow: fc.integer({ min: 1_700_000_000_000, max: 1_900_000_000_000 }),
  hold: fc.integer({ min: -5000, max: 20_000 }),
  records: fc.integer({ min: 0, max: 5000 }),
  reachesCustomer: fc.boolean(),
  reversible: fc.boolean(),
  guardrail: fc.option(fc.constantFrom(...(Object.keys(GUARDRAIL_TEXT) as (keyof typeof GUARDRAIL_TEXT)[])), { nil: undefined }),
  result: fc.option(fc.string({ minLength: 1 }), { nil: undefined }),
  lapsed: fc.option(fc.string({ minLength: 1 }), { nil: undefined }),
}).map(r => ({
  id: 'ac_AAAAAAAAAAAAAAAAAAAAAA', rev: 1, kind: r.kind, state: r.state, title: 'Add a tag to order 9001', lines: ['Tag: vip'],
  tool: { accountId: 'shopify:store', label: 'Shopify' }, records: r.records, reachesCustomer: r.reachesCustomer, reversible: r.reversible,
  ...(r.guardrail ? { guardrail: r.guardrail } : {}), chatId: null, askedBy: 'm_A', askedAt: instant(r.serverNow - 1000),
  ...(r.state === 'approved' ? { sendAt: instant(r.serverNow + r.hold) } : {}), serverNow: instant(r.serverNow),
  ...(r.result ? { result: r.result } : {}), ...(r.lapsed ? { lapsed: r.lapsed } : {}),
  // The server never sets Always allow on an exact card (card.ts); the arbitrary keeps to what it can send.
  can: { ...r.can, alwaysAllow: r.kind === 'exact' ? false : r.can.alwaysAllow }, nudgeAlways: r.nudgeAlways && r.kind === 'ask' && r.can.alwaysAllow,
  approverKind: 'person' as const,
}))

describe('buttons follow can and state (1, 2)', () => {
  test.prop([cardArb])('each button is allowed by can, in its own state', card => {
    for (const b of buttonsOf(card)) {
      if (b.kind === 'answer') {
        expect(card.state).toBe('waiting')
        const key = { once: 'allowOnce', always: 'alwaysAllow', approve: 'approve', deny: 'deny' } as const
        expect(card.can[key[b.choice]]).toBe(true)
      } else if (b.kind === 'undo') {
        expect([card.state, card.can.undo]).toEqual(['approved', true])
      } else {
        expect([card.state, card.can.resolve]).toEqual(['needs_check', true])
      }
    }
  })
  test.prop([cardArb])('nothing is offered with every can false', card => {
    const none = { allowOnce: false, alwaysAllow: false, approve: false, deny: false, undo: false, resolve: false, withdraw: false }
    expect(buttonsOf({ ...card, can: none, nudgeAlways: false })).toEqual([])
  })
  test.prop([cardArb])('Always allow: never on an exact card, at most once, first and primary when nudged', card => {
    const bs = buttonsOf(card)
    const always = bs.filter(b => b.kind === 'answer' && b.choice === 'always')
    expect(always.length).toBeLessThanOrEqual(1)
    if (card.kind === 'exact') expect(always).toEqual([])
    if (always.length === 1 && card.nudgeAlways) expect(bs[0]).toEqual(always[0])
    expect(bs.filter(b => b.primary).length).toBeLessThanOrEqual(1)
  })
})

describe('the hold counts down from the server clock (3)', () => {
  test.prop([cardArb, fc.integer({ min: 0, max: 60_000 }), fc.integer({ min: 0, max: 60_000 })])('never grows, never below 0, null outside the hold', (card, a, b) => {
    const [early, late] = a <= b ? [a, b] : [b, a]
    const l1 = holdLeftMs(card, early), l2 = holdLeftMs(card, late)
    if (card.state !== 'approved') { expect(l1).toBeNull(); return }
    expect(l1).not.toBeNull()
    expect(l2!).toBeLessThanOrEqual(l1!)
    expect(l2!).toBeGreaterThanOrEqual(0)
    expect(holdLeftMs(card, 0)).toBe(Math.max(0, card.sendAt!.ms - card.serverNow.ms))
  })
  test('the browser clock plays no part at the moment of reading: only the gap the server gave', () => {
    const card = { ...fc.sample(cardArb, 1)[0]!, state: 'approved' as const, sendAt: instant(1_800_000_008_000), serverNow: instant(1_800_000_000_000) }
    expect(holdLeftMs(card, 0)).toBe(8000)
    expect(holdText(8000)).toBe('Goes out in 8 seconds')
    expect(holdText(1)).toBe('Goes out in 1 second')
    expect(holdText(0)).toBe('Going out now')
  })
})

describe('words (4)', () => {
  test.prop([cardArb])('no em or en dash in what the card says', card => {
    const words = [kickerOf(card), outcomeOf(card) ?? '', ...factsOf(card), ...buttonsOf(card).map(b => b.label)].join(' ')
    expect(words).not.toMatch(/[–—]/)
  })
  test('every toast and refusal is plain', () => {
    for (const c of ['once', 'always', 'approve', 'deny', 'undo', 'sent', 'failed'] as const) expect(answeredToast(c)).not.toMatch(/[–—!]/)
    expect(refusalOf(new AgentError('conflict', 'x')).current).toBeNull()
    expect(refusalOf(new AgentError('forbidden', 'x')).text).toBe("You can't answer this one.")
    expect(refusalOf(new Error('boom')).text).toBe('Something went wrong. Try again.')
  })
  test('facts name the tool, then what makes the action sensitive, each once', () => {
    const base = fc.sample(cardArb, 1)[0]!
    const card = { ...base, records: 3, reachesCustomer: true, reversible: false, guardrail: 'customer' as const }
    expect(factsOf(card)).toEqual(['Shopify', '3 records', "Can't be taken back", 'Reaches customers'])
  })
})
