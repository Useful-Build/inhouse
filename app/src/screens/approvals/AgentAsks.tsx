// Approvals' Stage 1 M2-H sections: the questions the agent asked this person (N16) and the actions waiting on them, in
// their hold or needing a check (N11, N18). Each list is read when the page opens. Nothing shows until both are read and
// at least one holds something, so the demo (whose lists are empty) looks exactly as before. A card answered here stays
// on the page, showing where it got to, until the page is opened again. An admin also sees members' cards (their facts,
// no buttons, N15): those are listed apart, under "Waiting on your team", each saying whose it is.
import { useCallback, useEffect, useState } from 'react'
import { agent } from '../../agent'
import type { ActionCard, AgentErrorCode, Question } from '../../agent/types'
import { AgentError } from '../../agent/types'
import { useCtx, useUi } from '../../state/store'
import { SectionHeader } from '../../ui'
import { LoadError } from '../../ui/retry'
import { AskCard } from '../chat/AskCard'
import { OPEN_STATES, whoseCard } from '../chat/ask-card'
import { QuestionCard } from './QuestionCard'
import { publishAsks, useBrandPerson } from '../../shell/asks-count'

type Lists = { status: 'loading' } | { status: 'error'; error: AgentErrorCode } | { status: 'ready'; actions: ActionCard[]; questions: Question[] }

export function AgentAsks() {
  const openChat = useUi(s => s.openChat)
  const { data } = useCtx()
  // Only a brand person has any (routes 120 and 140): for the Inhouse team nothing is read and nothing shows.
  const brandPerson = useBrandPerson()
  const [lists, setLists] = useState<Lists>({ status: 'loading' })
  const read = useCallback(() => {
    Promise.all([agent.questions(), agent.actions({ states: OPEN_STATES })]).then(
      ([questions, actions]) => { setLists({ status: 'ready', actions, questions }); publishAsks(actions, questions) },
      (e: unknown) => setLists({ status: 'error', error: e instanceof AgentError ? e.code : 'unknown' }),
    )
  }, [])
  useEffect(() => { if (brandPerson) read() }, [brandPerson, read])

  if (!brandPerson || lists.status === 'loading') return null
  if (lists.status === 'error') return <LoadError what="what your Inhouse agent asked you" error={lists.error} onRetry={() => { setLists({ status: 'loading' }); read() }} />
  const { actions, questions } = lists
  const meId = agent.me()?.memberId
  const whose = (a: ActionCard) => whoseCard(a, meId, id => data.people.members.find(m => m.id === id)?.name)
  const mine = actions.filter(a => whose(a) === null)
  const team = actions.filter(a => whose(a) !== null)
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
      {mine.length > 0 && (
        <section aria-labelledby="agent-actions">
          <SectionHeader id="agent-actions" title="Actions for you" count={mine.length} className="mt-7.5 mb-3" />
          <div className="flex flex-col gap-3">
            {mine.map(a => <AskCard key={a.id} actionId={a.id} initial={a} onOpenChat={openChat} className="w-full" />)}
          </div>
        </section>
      )}
      {team.length > 0 && (
        <section aria-labelledby="agent-team-actions">
          <SectionHeader id="agent-team-actions" title="Waiting on your team" count={team.length} className="mt-7.5 mb-3" />
          <div className="flex flex-col gap-3">
            {team.map(a => <AskCard key={a.id} actionId={a.id} initial={a} whose={whose(a)} onOpenChat={openChat} className="w-full" />)}
          </div>
        </section>
      )}
    </>
  )
}
