// A chat's long job above the composer (Stage 1 M1-D, N3): while it runs, a progress row with Cancel job; once it ends,
// a result card that says how it ended and how long it ran. It reads the stored job (route 100) when the chat opens, when
// this tab's events start or end a job, when the followed turn or run ends (a job parked on a question sends no job
// event), when the tab comes back into view, and every 30 seconds while a job runs that this tab follows no run of, so a
// reload, a closed tab or another tab shows the same thing. A polite status line says each change aloud; after Cancel job
// the focus moves to the card's heading. job-status.ts decides what shows; job-text.ts holds the words. The bell's notice
// (server-side) is the same outcome in its own words.
import { useEffect, useId, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { agent } from '../../agent'
import type { Job } from '../../agent/types'
import { AgentError } from '../../agent/types'
import { NOT_FOUND } from '../../../shared/contract/error-codes'
import { cn } from '@/lib/utils'
import { AgentMark, Button, Icon } from '../../ui'
import { useOpenChatMessages } from './open-messages'
import { jobShown, takeStored } from './job-status'
import type { StoredJob } from './job-status'
import type { ChatView } from './view'
import {
  JOB_CANCEL, JOB_CANCEL_FAILED, JOB_CANCELLING, JOB_END_TEXT, JOB_RUNNING_TEXT, JOB_RUNNING_TITLE, JOB_WAITING_TEXT, helpersText, jobAnnouncement,
  jobEndTitle, jobFacts,
} from './job-text'

const BOX = 'flex items-start gap-3 rounded-xl border border-border bg-card px-3 py-2.5 text-sm text-foreground'
/** How often a running job this tab follows no run of is read again. */
const POLL_MS = 30_000

export function JobStatus({ chatId, view }: { chatId: string | null; view: ChatView | undefined }) {
  const live = view?.job ?? null
  const [stored, setStored] = useState<StoredJob | null>(null)
  const [cancel, setCancel] = useState<{ jobId: string; state: 'busy' | 'failed' } | null>(null)
  const [reads, setReads] = useState(0)
  const messages = useOpenChatMessages()
  const titleId = useId()
  const heading = useRef<HTMLHeadingElement>(null)
  const focusEnd = useRef(false)
  /** Bumped by each Cancel answer: a read started before it is older than what the answer said, and is dropped. */
  const epoch = useRef(0)
  /** A job's end is final: an older read that still says running never takes it back (job-status.ts `takeStored`). */
  const take = (chatId: string, job: Job | null) => setStored(prev => takeStored(prev, { chatId, job }))

  // Read again on the chat, on this tab's job events, and when the followed turn or run ends.
  const liveKey = `${live?.jobId ?? ''}:${live?.state ?? ''}:${view?.live ?? ''}:${view?.openRuns.length ?? 0}`
  useEffect(() => {
    if (chatId === null) return
    let gone = false
    const started = epoch.current
    const fresh = () => !gone && started === epoch.current
    agent.job(chatId).then(
      job => { if (fresh()) take(chatId, job) },
      (e: unknown) => {
        // Not the person's chat (yet): nothing to show. Anything else is a fault worth seeing, and the row stays as it was.
        if (e instanceof AgentError && e.code === NOT_FOUND) { if (fresh()) take(chatId, null) } else console.warn("Inhouse: could not read the chat's job.", e)
      },
    )
    return () => { gone = true }
  }, [chatId, liveKey, reads])

  const shown = chatId === null ? null : jobShown(live, stored?.chatId === chatId ? stored.job : null, messages)
  const running = shown?.kind === 'running'
  const following = (view?.openRuns.length ?? 0) > 0

  // A running job this tab follows no run of (another tab started it, or its turn parked): read it again now and then,
  // and whenever the tab comes back into view.
  useEffect(() => {
    if (!running) return
    const again = () => { if (document.visibilityState === 'visible') setReads(n => n + 1) }
    document.addEventListener('visibilitychange', again)
    const timer = following ? undefined : window.setInterval(again, POLL_MS)
    return () => { document.removeEventListener('visibilitychange', again); if (timer !== undefined) window.clearInterval(timer) }
  }, [running, following])

  // After Cancel job the button is gone: the focus goes to the card that took its place.
  useEffect(() => {
    if (shown?.kind === 'ended' && focusEnd.current) { focusEnd.current = false; heading.current?.focus() }
  }, [shown?.kind])

  let said = ''
  let body: ReactNode = null
  if (shown?.kind === 'running') {
    const busy = cancel?.jobId === shown.jobId && cancel.state === 'busy'
    const failed = cancel?.jobId === shown.jobId && cancel.state === 'failed'
    const onCancel = () => {
      if (busy) return
      setCancel({ jobId: shown.jobId, state: 'busy' })
      agent.cancelJob(shown.jobId).then(
        job => { epoch.current++; focusEnd.current = true; take(chatId!, job); setCancel(null) },
        (e: unknown) => { console.warn('Inhouse: the job was not cancelled.', e); setCancel({ jobId: shown.jobId, state: 'failed' }) },
      )
    }
    const detail = shown.waiting ? JOB_WAITING_TEXT : shown.label ?? JOB_RUNNING_TEXT
    said = jobAnnouncement(JOB_RUNNING_TITLE, detail)
    body = (
      <section data-job-status="running" aria-labelledby={titleId} className={cn(BOX, 'mb-2 items-center')}>
        <span aria-hidden="true" className="flex size-6 flex-none items-center justify-center"><AgentMark live={!shown.waiting} /></span>
        <div className="min-w-0 flex-1">
          <h2 id={titleId} className="text-sm font-medium">{JOB_RUNNING_TITLE}</h2>
          <p className="text-muted-foreground">
            {detail}
            {shown.helpers > 0 && !shown.waiting && <span> · {helpersText(shown.helpers)}</span>}
          </p>
          {failed && <p role="alert" className="text-destructive">{JOB_CANCEL_FAILED}</p>}
        </div>
        <Button variant="soft" size="sm" className="flex-none" disabled={busy} onClick={onCancel}>{busy ? JOB_CANCELLING : JOB_CANCEL}</Button>
      </section>
    )
  } else if (shown?.kind === 'ended') {
    const done = shown.outcome === 'done'
    const facts = jobFacts(shown.durationMs)
    said = jobAnnouncement(jobEndTitle(shown.outcome), JOB_END_TEXT[shown.outcome])
    body = (
      <section data-job-status="ended" data-job-outcome={shown.outcome} aria-labelledby={titleId} className={cn(BOX, 'mb-2')}>
        <Icon name={done ? 'check_circle' : 'info'} size={19} className={cn('mt-0.5 flex-none', done ? 'text-success' : 'text-muted-foreground')} />
        <div className="min-w-0 flex-1">
          <h2 id={titleId} ref={heading} tabIndex={-1} className="text-sm font-medium outline-none">{jobEndTitle(shown.outcome)}</h2>
          <p className="text-muted-foreground">{JOB_END_TEXT[shown.outcome]}</p>
          {facts && <p className="text-muted-foreground">{facts}</p>}
        </div>
      </section>
    )
  }
  return (
    <>
      {/* Always there, so a screen reader hears the row appear, its progress change and the job end. */}
      <div role="status" className="sr-only" data-job-said>{said}</div>
      {body}
    </>
  )
}
