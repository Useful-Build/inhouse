// The trace's cost while a model call is open (Q2's sandbox, 2026-11-21: 42 cents showed for a call still running, then 0
// once it was refused). Ways it could fail, written first: an open call's worst case reads as money spent; a closed or
// refused call, or a tool step whose detail happens to say "in progress", reads "up to"; the amount itself changes.
import { describe, expect, test } from 'vitest'
import { fmtTraceCost } from './format'

const d = { timeZone: 'UTC', locale: 'en-US' }
const cost = { minor: 42, currency: 'USD' }
const step = (kind: string, detail: string) => ({ kind, detail })

describe('fmtTraceCost', () => {
  test('an open model call: "up to" the same amount', () => {
    expect(fmtTraceCost({ cost, steps: [step('root', '1 question'), step('model', 'claude-sonnet-5-5 · in progress')] }, d)).toBe('up to $0.42')
    expect(fmtTraceCost({ cost, steps: [step('model', 'claude-sonnet-5-5 · in progress · 10 in · 2 out so far')] }, d)).toBe('up to $0.42')
  })
  test('closed, refused and non-model steps: the amount alone', () => {
    expect(fmtTraceCost({ cost, steps: [step('model', '1200 in · 300 out'), step('model', 'claude-sonnet-5-5 · refused by the model service'), step('tool', 'Bash · in progress')] }, d)).toBe('$0.42')
  })
})
