// Stage 1 M2-Q (N16): the question's input, its stored row and how a person sees it.
import { z } from 'zod'
import { QUESTION_MAX_CHARS, QUESTION_OPTION_MAX_CHARS, QuestionSchema } from '../../shared/contract/questions.ts'
import type { Question } from '../../shared/contract/questions.ts'

/** A question waits this long for an answer, then it expires (N16). A job's 8-hour cap comes first (N3). */
export const QUESTION_TTL_MS = 7 * 24 * 60 * 60_000

/**
 * `question_ask`'s input: the question and 2 to 4 distinct options. The same schema checks the deferred call's input
 * (`onDeferred`) and the call the SDK runs again on the resume, so a question the tool would refuse is never asked.
 */
export const QuestionAskInputSchema = z.object({
  question: z.string().trim().min(1).max(QUESTION_MAX_CHARS).describe('The question, in plain words, with what the person needs to know to answer it. At most 1000 characters.'),
  options: z.array(z.string().trim().min(1).max(QUESTION_OPTION_MAX_CHARS)).min(2).max(4)
    .refine(o => new Set(o).size === o.length, { message: 'An option is listed twice' })
    .describe('2 to 4 short, distinct answers the person can pick from. At most 200 characters each.'),
})
export type QuestionAskInput = z.infer<typeof QuestionAskInputSchema>

/** Who a question is for: the chat's owner; a routine's creator; or, when the creator isn't an active member, every admin. */
export type AskedAs = 'owner' | 'creator' | 'admins'

export interface QuestionRow {
  [k: string]: string | number | null
  id: string; chat_id: string; turn_id: string; tool_use_id: string
  /** A member id, or `admins`. */
  asked_of: string; asked_as: AskedAs
  question: string; options_json: string
  state: Question['state']
  answer: string | null; answered_by: string | null; answered_at_ms: number | null
  created_at_ms: number; expires_at_ms: number; ended_at_ms: number | null; delivered_at_ms: number | null
}

/** The person looking: their member id and role. */
export interface QuestionViewer { memberId: string; role: 'member' | 'admin' }

/** The question is this viewer's to see and answer: asked of them, or of every admin and they are one. */
export const askedOfViewer = (row: Pick<QuestionRow, 'asked_of'>, v: QuestionViewer): boolean =>
  row.asked_of === v.memberId || (row.asked_of === 'admins' && v.role === 'admin')

const instant = (ms: number) => ({ iso: new Date(ms).toISOString(), ms })

export const optionsOf = (row: Pick<QuestionRow, 'options_json'>): string[] => JSON.parse(row.options_json) as string[]

/**
 * The contract's question for this viewer. `chatId` only for the chat's owner: an admin or a routine's creator asked
 * about a routine sees the question, never a chat (N16).
 */
export function toQuestion(row: QuestionRow): Question {
  return QuestionSchema.parse({
    id: row.id, state: row.state, question: row.question, options: optionsOf(row),
    chatId: row.asked_as === 'owner' ? row.chat_id : null,
    askedAt: instant(row.created_at_ms), expiresAt: instant(row.expires_at_ms),
    answer: row.answer, answeredBy: row.answered_by, answeredAt: row.answered_at_ms === null ? null : instant(row.answered_at_ms),
  })
}
