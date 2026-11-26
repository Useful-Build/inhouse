// End-state grading rules for the M1-H capability eval skeleton.
// Each case is graded on its stored file content or source facts, never on the word "done".
import { shortName } from '../grade.ts'
import type { ChatResult } from '../types.ts'

export const CAP_01_FILE_PATH = /supplier-summary\.md$/i
export const CAP_01_FILE_FACTS: RegExp[] = [/\bnorda ceramics\b/i, /\b6\s*weeks\b/i, /\b120\b/]
export const CAP_02_SUBAGENT_TYPE = /^researcher$/i
export const CAP_02_FACTS: RegExp[] = [
  /\bmoss\b[^.\n]*\bdiscontinu/i,
  /(?:\boffer\s+fern\b|\bfern\b[^.\n]*\breplacement\b|\bfern\s+instead\b)/i,
  /\b60\s*(?:euro|eur|€)/i,
]
export const CAP_03_SOURCE_HOST = 'europa.eu'
// Host-anchored: labels are [a-z0-9-] only, and europa.eu must end the host (no `europa.eu.evil.test`,
// no `evil.test?.europa.eu`). The end-state grader below also parses with URL.
export const CAP_03_FETCH_URL = /^https?:\/\/(?:[a-z0-9-]+\.)*europa\.eu(?::\d+)?(?:[/?#]|$)/i
export const CAP_03_ANSWER_URL = /https?:\/\/(?:[a-z0-9-]+\.)*europa\.eu(?::\d+)?(?=[/?#\s)]|[.,;:!](?:\s|$)|$)/i
export const CAP_03_FACTS: RegExp[] = [/\b15\s*%/i]
export const BARE_DONE_RE = /^\s*done\.?\s*$/i

export const CAPABILITY_IDS = new Set(['CAP-01', 'CAP-02', 'CAP-03'])

/** True when `raw` parses as an http(s) URL whose host is `host` or one of its subdomains. */
export function isOnHost(raw: string, host: string): boolean {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return false
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return false
  const h = u.hostname.toLowerCase()
  return h === host || h.endsWith(`.${host}`)
}

/** URLs cited in free text (trailing sentence punctuation trimmed). */
function citedUrls(text: string): string[] {
  return (text.match(/https?:\/\/[^\s<>()"']+/gi) ?? []).map((u) => u.replace(/[.,;:!?]+$/, ''))
}

/**
 * The file's content after replaying every Write and Edit to it, in order. An Edit applies only to content a Write
 * established earlier and only when its `old_string` is present; otherwise the content is unknown (undefined).
 */
function replayFile(result: ChatResult, path: RegExp): string | undefined {
  let content: string | undefined
  let touched = false
  for (const c of result.toolCalls) {
    const n = shortName(c.name)
    if ((n !== 'Write' && n !== 'Edit') || typeof c.input.file_path !== 'string' || !path.test(c.input.file_path)) continue
    touched = true
    if (n === 'Write') {
      content = typeof c.input.content === 'string' ? c.input.content : undefined
      continue
    }
    const from = c.input.old_string
    const to = c.input.new_string
    if (content === undefined || typeof from !== 'string' || typeof to !== 'string' || !content.includes(from)) {
      content = undefined
      continue
    }
    content = c.input.replace_all === true ? content.split(from).join(to) : content.replace(from, () => to)
  }
  return touched ? (content ?? '') : undefined
}

export interface StoredFile {
  path: string
  content: string
}

export interface CapabilityVerdict {
  pass: boolean
  reason?: string
}

/**
 * Grades a capability run's end state directly (stored file content or source facts).
 * Rejects bare "done" responses even if tool calls occurred.
 */
export function gradeCapabilityEndState(
  caseId: string,
  result: ChatResult,
  storedFiles: readonly StoredFile[] = [],
): CapabilityVerdict {
  if (!result.runOk) return { pass: false, reason: 'run_not_ok' }
  if (BARE_DONE_RE.test(result.answer)) return { pass: false, reason: 'bare_done_answer' }

  if (caseId === 'CAP-01') {
    const stored = storedFiles.findLast((f) => CAP_01_FILE_PATH.test(f.path))
    const finalContent = stored?.content ?? replayFile(result, CAP_01_FILE_PATH)
    if (finalContent === undefined) return { pass: false, reason: 'missing_stored_file' }
    if (!CAP_01_FILE_FACTS.every((re) => re.test(finalContent))) return { pass: false, reason: 'missing_file_facts' }
    if (!CAP_01_FILE_FACTS.slice(1).every((re) => re.test(result.answer))) return { pass: false, reason: 'missing_answer_facts' }
    return { pass: true }
  }

  if (caseId === 'CAP-02') {
    const helperCalls = result.toolCalls.filter(
      (c) => shortName(c.name) === 'Agent' && typeof c.input.subagent_type === 'string' && CAP_02_SUBAGENT_TYPE.test(c.input.subagent_type),
    )
    if (helperCalls.length === 0) return { pass: false, reason: 'missing_researcher_helper' }
    if (!CAP_02_FACTS.every((re) => re.test(result.answer))) return { pass: false, reason: 'missing_source_facts' }
    return { pass: true }
  }

  if (caseId === 'CAP-03') {
    const fetchCalls = result.toolCalls.filter((c) => shortName(c.name) === 'WebFetch')
    if (fetchCalls.length === 0) return { pass: false, reason: 'missing_webfetch' }
    const fetchedOfficial = fetchCalls.some((c) => typeof c.input.url === 'string' && isOnHost(c.input.url, CAP_03_SOURCE_HOST))
    if (!fetchedOfficial) return { pass: false, reason: 'foreign_source_url' }
    if (!citedUrls(result.answer).some((u) => isOnHost(u, CAP_03_SOURCE_HOST))) return { pass: false, reason: 'missing_source_url' }
    if (!CAP_03_FACTS.every((re) => re.test(result.answer))) return { pass: false, reason: 'missing_source_facts' }
    return { pass: true }
  }

  return { pass: false, reason: `unknown_capability_case:${caseId}` }
}
