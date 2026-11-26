// What a question's card says once it is no longer open (Stage 1 M2-H, N16). QuestionCard.tsx draws it.
import type { Question } from '../../agent/types'

/** What a question that is no longer open says. */
export function questionOutcome(q: Question, mine: boolean): string | null {
  switch (q.state) {
    case 'open': return null
    case 'answered': return mine ? `You answered: ${q.answer ?? ''}` : `Someone answered first: ${q.answer ?? ''}`
    case 'expired': return 'No one answered in 7 days, so your Inhouse agent stopped waiting.'
    case 'closed': return 'Your Inhouse agent stopped waiting for this answer.'
  }
}
