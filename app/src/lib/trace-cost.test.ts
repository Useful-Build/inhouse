// The trace's cost while a model call is open (Q2's sandbox, 2026-11-21: 42 cents showed for a call still running, then 0
// once it was refused). Ways it could fail, written first: an open call's worst case reads as money spent; a step the
// server didn't mark (a closed or refused call, any detail text) reads "up to"; the amount itself changes.
import { describe, expect, test } from 'vitest'
import { fmtTraceCost } from './format'

const d = { timeZone: 'UTC', locale: 'en-US' }
const cost = { minor: 42, currency: 'USD' }
const step = (kind: string, detail: string, costUpTo?: boolean) => ({ kind, detail, ...(costUpTo === undefined ? {} : { costUpTo }) })

describe('fmtTraceCost', () => {
  test('a step marked costUpTo (an open model call): "up to" the same amount', () => {
    expect(fmtTraceCost({ cost, steps: [step('root', '1 question'), step('model', 'claude-sonnet-5-5 · in progress', true)] }, d)).toBe('up to $0.42')
  })
  test('no step marked: the amount alone, whatever a detail says', () => {
    expect(fmtTraceCost({ cost, steps: [step('model', '1200 in · 300 out'), step('model', 'claude-sonnet-5-5 · in progress', false), step('tool', 'Bash · in progress')] }, d)).toBe('$0.42')
  })
})
