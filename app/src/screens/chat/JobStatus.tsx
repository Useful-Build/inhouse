// A chat's long job above the composer (Stage 1 M1-D, N3): while it runs, a progress row with Cancel; once it ends, a
// result card that says how it ended, how long it ran and what it cost. It reads the stored job (route 100) when the chat
// opens and again when this tab's events move it, so a reload or a closed tab shows the same thing. job-status.ts decides
// what shows; job-text.ts holds the words. The bell's notice (server-side) is the same outcome in its own words.
import { useEffect, useId, useState } from 'react'
import { agent } from '../../agent'
import type { Job } from '../../agent/types'
import { AgentError } from '../../agent/types'
import { NOT_FOUND } from '../../../shared/contract/error-codes'
import { cn } from '@/lib/utils'
import { fmtMoney } from '@/lib/format'
import { display } from '../../state/display'
import { AgentMark, Button, Icon } from '../../ui'
import { useOpenChatMessages } from './open-messages'
import { jobShown } from './job-status'
import type { ChatView } from './view'
import {
  JOB_CANCEL, JOB_CANCEL_FAILED, JOB_CANCELLING, JOB_END_TEXT, JOB_RUNNING_TEXT, JOB_RUNNING_TITLE, JOB_WAITING_TEXT, helpersText, jobEndTitle, jobFacts,
} from './job-text'

const BOX = 'flex items-start gap-3 rounded-xl border border-border bg-card px-3 py-2.5 text-sm text-foreground'

export function JobStatus({ chatId, view }: { chatId: string | null; view: ChatView | undefined }) {
  const live = view?.job ?? null
  const [stored, setStored] = useState<{ chatId: string; job: Job | null } | null>(null)
  const [cancel, setCancel] = useState<{ jobId: string; state: 'busy' | 'failed' } | null>(null)
  const messages = useOpenChatMessages()
  const titleId = useId()

  // Read again when the chat changes and whenever this tab's events start or end a job.
  const liveKey = live === null ? '' : `${live.jobId}:${live.state}`
  useEffect(() => {
    if (chatId === null) return
    let gone = false
    agent.job(chatId).then(
      job => { if (!gone) setStored({ chatId, job }) },
      (e: unknown) => {
        // Not the person's chat (yet): nothing to show. Anything else is a fault worth seeing, and the row stays as the events say.
        if (e instanceof AgentError && e.code === NOT_FOUND) { if (!gone) setStored({ chatId, job: null }) } else console.warn('Inhouse: could not read the chat\'s job.', e)
      },
    )
    return () => { gone = true }
  }, [chatId, liveKey])

  if (chatId === null) return null
  const shown = jobShown(live, stored?.chatId === chatId ? stored.job : null, messages)
  if (shown === null) return null

  if (shown.kind === 'running') {
    const busy = cancel?.jobId === shown.jobId && cancel.state === 'busy'
    const failed = cancel?.jobId === shown.jobId && cancel.state === 'failed'
    const onCancel = () => {
      if (busy) return
      setCancel({ jobId: shown.jobId, state: 'busy' })
      agent.cancelJob(shown.jobId).then(
        job => { setStored({ chatId, job }); setCancel(null) },
        (e: unknown) => { console.warn('Inhouse: the job was not cancelled.', e); setCancel({ jobId: shown.jobId, state: 'failed' }) },
      )
    }
    const detail = shown.waiting ? JOB_WAITING_TEXT : shown.label ?? JOB_RUNNING_TEXT
    return (
      <section data-job-status="running" aria-labelledby={titleId} className={cn(BOX, 'mb-2 items-center')}>
        <span aria-hidden="true" className="flex size-6 flex-none items-center justify-center"><AgentMark live /></span>
        <div className="min-w-0 flex-1">
          <h2 id={titleId} className="text-sm font-medium">{JOB_RUNNING_TITLE}</h2>
          <p className="text-muted-foreground">
            {detail}
            {shown.helpers > 0 && <span> · {helpersText(shown.helpers)}</span>}
          </p>
          {failed && <p role="alert" className="text-destructive">{JOB_CANCEL_FAILED}</p>}
        </div>
        <Button variant="soft" size="sm" className="flex-none" disabled={busy} onClick={onCancel}>{busy ? JOB_CANCELLING : JOB_CANCEL}</Button>
      </section>
    )
  }

  const done = shown.outcome === 'done'
  const facts = jobFacts(shown.durationMs, shown.cost === null ? null : fmtMoney(shown.cost, display(), { cents: 'always' }))
  return (
    <section data-job-status="ended" data-job-outcome={shown.outcome} aria-labelledby={titleId} className={cn(BOX, 'mb-2')}>
      <Icon name={done ? 'check_circle' : 'info'} size={19} className={cn('mt-0.5 flex-none', done ? 'text-success' : 'text-muted-foreground')} />
      <div className="min-w-0 flex-1">
        <h2 id={titleId} className="text-sm font-medium">{jobEndTitle(shown.outcome)}</h2>
        <p className="text-muted-foreground">{JOB_END_TEXT[shown.outcome]}</p>
        {facts && <p className="text-muted-foreground">{facts}</p>}
      </div>
    </section>
  )
}
