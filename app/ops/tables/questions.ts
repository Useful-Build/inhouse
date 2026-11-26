// Stage 1 M2-Q's store (N16): the questions the agent asked a person. A question names who it was asked of (a member
// id, or `admins`) and who answered; the agent's words and the chosen option are the chat's content. An open question
// never goes by age: retention ages a question by when it left `open` (N1).
import type { TableEntry } from './types.ts'

export const questionTables: readonly TableEntry[] = [
  { kind: 'd1', name: 'questions', retention: 'retention_period', personKeys: ['asked_of', 'answered_by'], export: true },
]
