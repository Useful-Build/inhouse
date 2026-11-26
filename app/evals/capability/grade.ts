// End-state grading rules for the M1-H capability eval skeleton.
// Each case is graded on its stored file content or source facts, never on the word "done".
import { shortName } from '../grade.ts'
import type { ChatResult } from '../types.ts'

export const CAP_01_FILE_PATH = /supplier-summary\.md$/i
export const CAP_01_FILE_CONTENT = /norda ceramics[\s\S]*6\s*weeks[\s\S]*120/i
export const CAP_02_SUBAGENT_TYPE = /^researcher$/i
export const CAP_02_FACTS: RegExp[] = [/moss/i, /fern/i, /60\s*(?:euro|eur|€)/i]
export const CAP_03_SOURCE_URL = /https?:\/\/\S+/i
export const CAP_03_FACTS: RegExp[] = [/15\s*%/i]
export const BARE_DONE_RE = /^\s*done\.?\s*$/i

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
    const fileContents = [
      ...storedFiles.filter((f) => CAP_01_FILE_PATH.test(f.path)).map((f) => f.content),
      ...result.toolCalls
        .filter((c) => {
          const n = shortName(c.name)
          return (n === 'Write' || n === 'Edit') && typeof c.input.file_path === 'string' && CAP_01_FILE_PATH.test(c.input.file_path)
        })
        .map((c) => (typeof c.input.content === 'string' ? c.input.content : typeof c.input.new_string === 'string' ? c.input.new_string : '')),
    ]
    if (fileContents.length === 0) return { pass: false, reason: 'missing_stored_file' }
    if (!fileContents.some((text) => CAP_01_FILE_CONTENT.test(text))) return { pass: false, reason: 'missing_file_facts' }
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
    const webCalls = result.toolCalls.filter((c) => {
      const n = shortName(c.name)
      return n === 'WebFetch' || n === 'WebSearch'
    })
    if (webCalls.length === 0) return { pass: false, reason: 'missing_web_research' }
    if (!CAP_03_SOURCE_URL.test(result.answer)) return { pass: false, reason: 'missing_source_url' }
    if (!CAP_03_FACTS.every((re) => re.test(result.answer))) return { pass: false, reason: 'missing_source_facts' }
    return { pass: true }
  }

  return { pass: false, reason: `unknown_capability_case:${caseId}` }
}
