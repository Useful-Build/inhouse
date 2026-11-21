// A refused send in the person's words, against literal text. Ways this can fail, written first: a reason the server
// sends falls through to the generic "couldn't finish" line; an unknown reason says something specific.
import { describe, expect, test } from 'vitest'
import { sendFailureText } from './turn-text'

describe('sendFailureText', () => {
  test.each([
    [{ code: 'conflict', reason: 'provider_changed' }, "This chat was started with a different AI provider, so it can't go on here. Start a new chat to keep asking."],
    [{ code: 'conflict', reason: 'waiting_answer' }, 'This chat is waiting for an answer from you first.'],
    [{ code: 'rate_limited' }, 'Too many messages at once. Ask again in a minute.'],
    [{ code: 'conflict', reason: 'something_new' }, "Your Inhouse agent couldn't finish this answer. Nothing was changed."],
  ])('%o', (e, text) => {
    expect(sendFailureText(e)).toBe(text)
  })
})
