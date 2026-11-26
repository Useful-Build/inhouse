// Stage 1 M2 (frozen by W0-A; M2-Q builds it, N16): a question the agent asked a person, with 2 to 4 options. Admins
// asked about a routine see the question, never a private chat (`chatId` is null for them).
import { z } from 'zod'
import { InstantSchema } from './common.ts'
import { ChatIdSchema } from './chat-ids.ts'
import { MemberIdSchema } from './members.ts'

/** A question's id: `q_` + 128 random bits (the deferred question's id shape, P3). */
export const QuestionIdSchema = z.string().regex(/^q_[A-Za-z0-9_-]{22}$/)
export type QuestionId = z.infer<typeof QuestionIdSchema>

export const QUESTION_MAX_CHARS = 1000
export const QUESTION_OPTION_MAX_CHARS = 200

export const QuestionStateSchema = z.enum(['open', 'answered', 'expired', 'closed'])
export type QuestionState = z.infer<typeof QuestionStateSchema>

export const QuestionSchema = z.object({
  id: QuestionIdSchema,
  state: QuestionStateSchema,
  question: z.string().min(1).max(QUESTION_MAX_CHARS),
  /** Distinct, so a choice's text names one option. */
  options: z.array(z.string().min(1).max(QUESTION_OPTION_MAX_CHARS)).min(2).max(4)
    .refine(o => new Set(o).size === o.length, { message: 'An option is listed twice' }),
  /** Null for a viewer who may not open the chat. */
  chatId: ChatIdSchema.nullable(),
  askedAt: InstantSchema,
  expiresAt: InstantSchema,
  /** The option chosen, once answered. */
  answer: z.string().nullable(),
  answeredBy: MemberIdSchema.nullable(),
  answeredAt: InstantSchema.nullable(),
})
export type Question = z.infer<typeof QuestionSchema>

/** `questions()`: the open questions asked of this person, oldest first. */
export const QuestionsListSchema = z.object({ items: z.array(QuestionSchema) })
export type QuestionsList = z.infer<typeof QuestionsListSchema>

/** `answerQuestion(id, choice)`: `choice` is one of the question's options, exactly. */
export const AnswerQuestionInputSchema = z.object({ choice: z.string().min(1).max(QUESTION_OPTION_MAX_CHARS) }).strict()
export type AnswerQuestionInput = z.infer<typeof AnswerQuestionInputSchema>
