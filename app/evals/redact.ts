// What the harness writes to disk (p3-eval-observability rev 2, rec 6, decision 6). Results are kept forever and the app repo
// is public, and on the eval build a call's input is the eval brand's tool data, so nothing written holds a raw input, a raw
// answer, a URL or the case's canary:
//   - a tool call keeps the SHA-256 of its input's JSON (checkable against the eval brand's trace while it lives, 7 days)
//     and a short excerpt;
//   - an answer, a result, a bypass's detail and an error keep a short excerpt in which every URL is its host and a hash;
//   - the canary is redacted to `[canary]` in every form the grader finds (any case, percent-encoded, base64), and a text
//     that still holds it in a form not replaced is dropped whole; a row names its canary by id only (report.ts).
// Grading runs on the full result in memory; only what is written is reduced (report.ts `toRow`, write.ts).
import { createHash } from 'node:crypto'
import type { ChatResult } from './types.ts'

/** The longest excerpt of an input, an answer, a result or a detail that reaches disk. */
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

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex')
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const b64 = (s: string): string => Buffer.from(s).toString('base64')
const b64url = (s: string): string => b64(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

/** Percent-decodes up to three layers (a doubly encoded canary), keeping what can't be decoded. */
export function decodeAll(s: string): string {
  let cur = s
  for (let i = 0; i < 3; i++) {
    try {
      const next = decodeURIComponent(cur)
      if (next === cur) break
      cur = next
    } catch {
      break
    }
  }
  return cur
}

/** Every written form of the canary the grader finds: as is and percent-encoded (any case), base64 and base64url of it. */
function canaryPatterns(canary: string): RegExp[] {
  const anyCase = [canary, encodeURIComponent(canary)].map((f) => new RegExp(escapeRe(f), 'gi'))
  const exact = [canary, canary.toLowerCase(), canary.toUpperCase()].flatMap((v) => [b64(v), b64url(v)]).map((f) => new RegExp(escapeRe(f), 'g'))
  return [...anyCase, ...exact]
}

/** Whether `text` holds the canary in any of those forms, or after percent-decoding. */
export function carriesCanary(text: string, canary: string | undefined): boolean {
  if (!canary) return false
  const decoded = decodeAll(text)
  return canaryPatterns(canary).some((re) => re.test(text) || new RegExp(re.source, re.flags).test(decoded))
}

/** `text` with every form of the canary replaced by `[canary]`; a text that still holds it is dropped whole. */
export function redactText(text: string, canary: string | undefined): string {
  if (!canary) return text
  let out = text
  for (const re of canaryPatterns(canary)) out = out.replace(re, '[canary]')
  return carriesCanary(out, canary) ? '[redacted: it holds the canary in a form not replaced]' : out
}

export const excerpt = (text: string, canary: string | undefined): string => redactText(text, canary).slice(0, EXCERPT_CHARS)

const URL_IN_TEXT = /(?:https?:)?\/\/[^\s<>"')\]]+/gi
/** A URL as it may reach disk: its host and a short hash of the whole, never its path or query. */
export function urlNote(url: string): string {
  let host: string
  try { host = new URL(url.startsWith('//') ? `https:${url}` : url).host } catch { host = 'an unreadable URL' }
  return `${host} [url ${sha256(url).slice(0, 12)}]`
}

/** A line for disk: every URL as its host and hash, the canary redacted, at most EXCERPT_CHARS. */
export const redactDetail = (text: string, canary: string | undefined): string => excerpt(text.replace(URL_IN_TEXT, (u) => urlNote(u)), canary)

/**
 * The harness's own error on a row (a timeout, a status it got), for disk: URLs as hosts and the canary redacted like any
 * line, but kept to ERROR_CHARS rather than an excerpt, so the status at its end survives. It holds no tool data.
 */
export const ERROR_CHARS = 200
export const redactError = (text: string, canary: string | undefined): string => redactText(text.replace(URL_IN_TEXT, (u) => urlNote(u)), canary).slice(0, ERROR_CHARS)

/** How a row names its case-repeat's canary on disk. */
export const canaryId = (caseId: string, rep: number): string => `${caseId}-r${rep}`

export function diskResult(result: ChatResult, canary?: string): DiskResult {
  return {
    ...result,
    answer: redactDetail(result.answer, canary),
    toolCalls: result.toolCalls.map((c) => {
      const json = JSON.stringify(c.input)
      return {
        name: c.name,
        inputSha256: sha256(json),
        inputExcerpt: redactDetail(json, canary),
        ...(c.result === undefined ? {} : { resultExcerpt: redactDetail(c.result, canary) }),
        ...(c.isError === undefined ? {} : { isError: c.isError }),
        ...(c.hookDenied === undefined ? {} : { hookDenied: c.hookDenied }),
        ...(c.inputCut === undefined ? {} : { inputCut: c.inputCut }),
      }
    }),
  }
}
