// The questions tool (agent-tools "3. Questions", Stage 1 M2-Q, N16): `question_ask`. The question itself is made when
// the runner defers the main agent's lone call (server/questions/ask.ts): the turn ends waiting, and on the person's
// answer the SDK runs this same call again (the same `tool_use_id`), which reads the stored question and returns the
// option the person chose. So this handler never asks: it only reads, by the call's id in its own chat, and one call
// is one question however often it runs. A call that wasn't deferred (beside another call in the same reply, or not
// seen as alone in time) has no question; it is told to ask on its own. Its name and description are the registry's.
import { questionStore } from '../../../questions/store.ts'
import { QuestionAskInputSchema } from '../../../questions/types.ts'
import type { QuestionRow } from '../../../questions/types.ts'
import { answer, refusal, tool } from '../../server/tool.ts'
import type { InhouseToolName, ToolHandler, ToolResult } from '../../server/tool.ts'

export const ASK_ALONE_TEXT =
  "The question wasn't asked: a question goes to the person only when question_ask is the only tool call in your reply. "
  + 'Call question_ask again on its own, with no other tool call beside it, and nothing after it. The turn then waits, and the '
  + "person's choice comes back as this call's result."
export const EXPIRED_TEXT =
  'Nobody answered within 7 days, so the question was closed. Carry on without the answer if you can, and say what you '
  + "assumed; otherwise stop and say what you'd need. Don't ask it again unless the person brings it up."
export const CLOSED_TEXT =
  'The question was withdrawn before anyone answered it, so there is no answer. Carry on without it, or stop and say what '
  + "you'd need. Don't ask it again unless the person brings it up."
export const NOT_YET_TEXT = "The question has no answer yet. Don't ask it again: end your reply and say you're waiting for the answer."

/** What the call returns for its stored question. */
function result(row: QuestionRow): ToolResult {
  const data = { question_id: row.id, state: row.state, answer: row.answer }
  if (row.answer !== null) return answer(`The person chose: "${row.answer}".`, data)
  if (row.state === 'expired') return refusal('question_expired', EXPIRED_TEXT)
  if (row.state === 'closed') return refusal('question_closed', CLOSED_TEXT)
  return refusal('not_answered', NOT_YET_TEXT)
}

export const handlers: Partial<Record<InhouseToolName, ToolHandler>> = {
  question_ask: tool({
    input: QuestionAskInputSchema,
    async call(_args, scope, deps) {
      const row = scope.toolUseId === undefined ? null : await questionStore({ db: deps.db }).byToolUse(scope.chatId, scope.toolUseId)
      return row === null ? refusal('ask_alone', ASK_ALONE_TEXT) : result(row)
    },
  }),
}
