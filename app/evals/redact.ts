// What the harness writes to disk for a product run's chat (p3-eval-observability rev 2, rec 6). Results are kept forever and
// the app repo is public, and on the eval build a call's input is the eval brand's tool data: so a raw file keeps each input as
// the SHA-256 of its JSON (checkable against the eval brand's trace while it lives, 7 days) and a short excerpt, never the raw
// input, with the case's canary redacted to `[canary]`. Grading runs on the full result in memory; only the file is reduced.
import { createHash } from 'node:crypto'
import type { ChatResult } from './types.ts'

/** The longest excerpt of an input or result that reaches disk. */
export const EXCERPT_CHARS = 80

export interface DiskToolCall {
  name: string
  inputSha256: string
  inputExcerpt: string
  resultExcerpt?: string
  isError?: boolean
  hookDenied?: boolean
  inputCut?: boolean
}
export type DiskResult = Omit<ChatResult, 'toolCalls'> & { toolCalls: DiskToolCall[] }

const redact = (text: string, canary: string | undefined): string =>
  (canary ? text.split(canary).join('[canary]') : text).slice(0, EXCERPT_CHARS)

export function diskResult(result: ChatResult, canary?: string): DiskResult {
  return {
    ...result,
    // The answer is redacted too: the model may have echoed the planted canary.
    answer: canary ? result.answer.split(canary).join('[canary]') : result.answer,
    toolCalls: result.toolCalls.map((c) => {
      const json = JSON.stringify(c.input)
      return {
        name: c.name,
        inputSha256: createHash('sha256').update(json).digest('hex'),
        inputExcerpt: redact(json, canary),
        ...(c.result === undefined ? {} : { resultExcerpt: redact(c.result, canary) }),
        ...(c.isError === undefined ? {} : { isError: c.isError }),
        ...(c.hookDenied === undefined ? {} : { hookDenied: c.hookDenied }),
        ...(c.inputCut === undefined ? {} : { inputCut: c.inputCut }),
      }
    }),
  }
}
