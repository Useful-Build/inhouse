// Test support for tool answers (Stage 1 M2-G). Tests only: never imported by deployable code.
import { expect } from 'vitest'

/**
 * A tool result's data, as an exact check reads it: its `structuredContent` with the words (`message`, the first text
 * block, tool.ts) checked and taken out. The words are always there and always the text's: a result whose
 * `structuredContent` lacks them, or says other words, fails here.
 */
export function dataOf(r: { structuredContent?: Record<string, unknown>; content?: { text?: string }[] }): Record<string, unknown> {
  const sc = r.structuredContent
  expect(sc, 'a tool result with no structuredContent').toBeDefined()
  expect(sc!.message, 'structuredContent.message is the result\'s first text block').toBe(r.content?.[0]?.text)
  const { message: _message, ...data } = sc!
  return data
}
