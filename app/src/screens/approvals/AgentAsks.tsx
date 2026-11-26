// Approvals' Stage 1 M2-H sections: the questions the agent asked this person (N16) and the actions waiting on them, in
// their hold or needing a check (N11, N18). Each list is read when the page opens. Nothing shows until both are read and
// at least one holds something, so the demo (whose lists are empty) looks exactly as before. A card answered here stays
// on the page, showing where it got to, until the page is opened again.
import { useCallback, useEffect, useState } from 'react'
import { agent } from '../../agent'
import type { ActionCard, AgentErrorCode, Question } from '../../agent/types'
import { AgentError } from '../../agent/types'
import { useUi } from '../../state/store'
import { SectionHeader } from '../../ui'
import { LoadError } from '../../ui/retry'
import { AskCard } from '../chat/AskCard'
import { OPEN_STATES } from '../chat/ask-card'
import { QuestionCard } from './QuestionCard'
import { publishAsks } from '../../shell/asks-count'

type Lists = { status: 'loading' } | { status: 'error'; error: AgentErrorCode } | { status: 'ready'; actions: ActionCard[]; questions: Question[] }

export function AgentAsks() {
  const openChat = useUi(s => s.openChat)
  const [lists, setLists] = useState<Lists>({ status: 'loading' })
  const read = useCallback(() => {
    Promise.all([agent.questions(), agent.actions({ states: OPEN_STATES })]).then(
      ([questions, actions]) => { setLists({ status: 'ready', actions, questions }); publishAsks(actions, questions) },
      (e: unknown) => setLists({ status: 'error', error: e instanceof AgentError ? e.code : 'unknown' }),
    )
  }, [])
  useEffect(read, [read])

  if (lists.status === 'loading') return null
  if (lists.status === 'error') return <LoadError what="what your Inhouse agent asked you" error={lists.error} onRetry={() => { setLists({ status: 'loading' }); read() }} />
  const { actions, questions } = lists
  return (
    <>
      {questions.length > 0 && (
        <section aria-labelledby="agent-questions">
          <SectionHeader id="agent-questions" title="Questions for you" count={questions.length} className="mt-7.5 mb-3" />
          <div className="flex flex-col gap-3">
            {questions.map(q => <QuestionCard key={q.id} question={q} onOpenChat={openChat} />)}
          </div>
        </section>
      )}
      {actions.length > 0 && (
        <section aria-labelledby="agent-actions">
          <SectionHeader id="agent-actions" title="Actions for you" count={actions.length} className="mt-7.5 mb-3" />
          <div className="flex flex-col gap-3">
            {actions.map(a => <AskCard key={a.id} actionId={a.id} initial={a} onOpenChat={openChat} className="w-full" />)}
          </div>
        </section>
      )}
    </>
  )
}
