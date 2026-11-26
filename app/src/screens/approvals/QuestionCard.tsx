// A question the agent asked this person (Stage 1 M2-H, N16): the question, its 2 to 4 options as buttons, and what
// happened once answered. The answer is the option's text, exactly. Answered by someone else, expired or withdrawn:
// the card says so. Kept but not delivered (503): the same answer can be sent again.
import { useId, useRef, useState } from 'react'
import { agent } from '../../agent'
import type { Question } from '../../agent/types'
import { AgentError } from '../../agent/types'
import { NOT_FOUND } from '../../../shared/contract/error-codes'
import { useUi } from '../../state/store'
import { cn } from '@/lib/utils'
import { Button, Icon } from '../../ui'
import { CONFIRMATION_SHEET } from '../../ui/agent'
import { questionOutcome } from './question-words'
import { readAsks } from '../../shell/asks-count'

export function QuestionCard({ question, onOpenChat }: { question: Question; onOpenChat?: (chatId: string) => void }) {
  const [q, setQ] = useState(question)
  const [mine, setMine] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  // Set at once on a press (state lags a render), so a double click can't send twice.
  const pressing = useRef(false)
  const [error, setError] = useState<{ text: string; retry: string | null } | null>(null)
  const showToast = useUi(s => s.showToast)
  const titleId = useId()
  const headingRef = useRef<HTMLHeadingElement>(null)

  const answer = (choice: string) => {
    if (pressing.current) return
    pressing.current = true
    setBusy(choice)
    setError(null)
    agent.answerQuestion(q.id, choice).then(next => {
      setMine(true)
      setQ(next)
      // The option buttons are gone once answered: keep the keyboard on the card.
      headingRef.current?.focus()
      void readAsks()
      showToast('Answer sent. Your Inhouse agent carries on.', { icon: 'check', ms: 4000 })
    }, (e: unknown) => {
      // A conflict: answered by someone else, expired or withdrawn, so it no longer waits on this person.
      if (e instanceof AgentError && e.code === 'conflict') void readAsks()
      if (e instanceof AgentError && e.code === 'conflict' && e.current) setQ(e.current as unknown as Question)
      else if (e instanceof AgentError && e.code === 'unavailable') setError({ text: "Your answer is saved, but the chat couldn't be reached.", retry: choice })
      else if (e instanceof AgentError && e.code === NOT_FOUND) setError({ text: "This question isn't there any more.", retry: null })
      else setError({ text: e instanceof AgentError ? e.message : 'Something went wrong. Try again.', retry: null })
    }).finally(() => { pressing.current = false; setBusy(null) })
  }

  const outcome = questionOutcome(q, mine)
  return (
    <div role="group" aria-labelledby={titleId} data-question={q.state} className={cn(CONFIRMATION_SHEET, 'flex w-full flex-col')}>
      <div className="flex items-start gap-3">
        <span aria-hidden="true" className="flex size-10 flex-none items-center justify-center rounded-full border border-border bg-draft-kind text-foreground-3">
          <Icon name="forum" size={20} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-sm text-muted-foreground">Your Inhouse agent asks</div>
          <h3 id={titleId} ref={headingRef} tabIndex={-1} className="text-md font-strong tracking-card whitespace-pre-line wrap-anywhere outline-none">{q.question}</h3>
        </div>
        {onOpenChat && q.chatId && (
          <button type="button" onClick={() => onOpenChat(q.chatId!)} aria-label={`Open the chat: ${q.question}`}
            className="flex flex-none items-center gap-0.5 self-center text-base text-foreground-3 hover:text-foreground">
            Open<Icon name="chevron_right" size={18} />
          </button>
        )}
      </div>
      {q.state === 'open' && (
        <div className="mt-3 flex flex-wrap gap-2">
          {q.options.map(o => (
            <Button key={o} variant="soft" disabled={busy !== null} onClick={() => answer(o)} className="h-auto min-h-8 py-1.5 text-left whitespace-normal wrap-anywhere">{o}</Button>
          ))}
        </div>
      )}
      {outcome && <p className="m-0 mt-3 text-sm font-strong text-foreground-2 wrap-anywhere">{outcome}</p>}
      {error && (
        <div role="alert" className="mt-3 flex flex-wrap items-center gap-2 text-sm text-destructive-text">
          <span className="min-w-0 flex-1">{error.text}</span>
          {error.retry !== null && <Button variant="outline" size="sm" disabled={busy !== null} onClick={() => answer(error.retry!)}>Try again</Button>}
        </div>
      )}
    </div>
  )
}
