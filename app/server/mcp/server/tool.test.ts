// The tool answer's shape (Stage 1 M2-G). Ways it can fail, written first: the CLI (2.1.328) hands the model a tool's
// `structuredContent` in place of its text, so words missing from it never reach the real model; a data field named
// `message` silently replaces them.
import { describe, expect, it } from 'vitest'
import { answer, refusal } from './tool.ts'

describe('answer and refusal carry the words in structuredContent', () => {
  it('answer: the words as `message`, then the data; the text blocks unchanged', () => {
    expect(answer('Saved.', { memory_id: 'mem_1', created: true })).toEqual({
      content: [{ type: 'text', text: 'Saved.' }, { type: 'text', text: '{"memory_id":"mem_1","created":true}' }],
      structuredContent: { message: 'Saved.', memory_id: 'mem_1', created: true },
    })
  })
  it('refusal: the code and its words', () => {
    expect(refusal('not_found', 'No such fact.')).toEqual({ content: [{ type: 'text', text: 'No such fact.' }], structuredContent: { error: 'not_found', message: 'No such fact.' }, isError: true })
  })
  it('a data field named `message` is refused loud', () => {
    expect(() => answer('Hi.', { message: 'other words' })).toThrow(/its own `message`/)
  })
})
