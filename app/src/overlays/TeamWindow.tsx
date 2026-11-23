import { useState } from 'react'
import { agent, demo } from '../agent'
import type { RequestType } from '../state/store'
import { useCtx, useUi } from '../state/store'
import { teamRequests, userName } from '../state/derive'
import type { TeamRow } from '../state/derive'
import { instantOf } from '../lib/format'
import { nowOf } from '../state/display'
import { Badge } from '@/components/ui/badge'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import { Button, EmptyState, Icon, IconButton, IconTile, Segmented, Window } from '../ui'

const RT: Record<RequestType, [icon: string, label: string, placeholder: string]> = {
  tool: ['add_link', 'New tool', 'Which tool, and what should your Inhouse agent do with it?'],
  job: ['work', 'New job', 'Describe the job. For example: every Friday, check wholesale orders against stock.'],
  change: ['tune', 'Change something', 'What should work differently?'],
  bug: ['bug_report', 'Report a bug', 'What happened, and what did you expect?'],
  feedback: ['campaign', 'Feedback', 'What would make Inhouse better for you?'],
}
const KINDS = Object.keys(RT) as RequestType[]

/** The title the team sees (`subject`, 64 on the server), and the request in full (1000). The counter shows from 900. */
const TITLE_MAX = 64
const TEXT_MAX = 1000
const TEXT_COUNT_FROM = 900

/** A title made from the details when none was typed: the first 60 characters, cut at a word and never inside one. */
const titleOf = (text: string) => {
  if (text.length <= 60) return text
  const cut = text.slice(0, 57)
  return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), 20)).trimEnd()}…`
}

export function TeamWindow() {
  const pop = useUi(s => s.pop)
  const patch = useUi(s => s.patch)
  if (pop !== 'team') return null
  const close = () => patch({ pop: null })
  return (
    <Window onClose={close} label="Your Inhouse team" size="md" className="w-today-column max-w-screen-gutter">
      <TeamBody onClose={close} />
    </Window>
  )
}

function TeamBody({ onClose }: { onClose: () => void }) {
  const withdrawn = useUi(s => s.teamWithdrawn)
  const ctx = useCtx()
  const [tab, setTab] = useState<'new' | 'mine'>('new')
  const { open, closed } = teamRequests(ctx, nowOf(), demo !== null, withdrawn)
  return (
    <>
      <div className="flex items-start gap-3.5 pt-6 pr-4.5 pl-7 max-sm:pl-5">
        <IconTile icon="support_agent" iconSize={22} size="xl" tone="outline" />
        <div className="min-w-0 flex-1 pt-px">
          <h2 className="text-xl font-semibold tracking-section">Your Inhouse team</h2>
          <p className="mt-1 text-sm text-muted-foreground">They build, connect and run your Inhouse agent.</p>
        </div>
        <IconButton icon="close" label="Close" onClick={onClose} />
      </div>
      <div className="px-7 pt-5 max-sm:px-5">
        <Segmented label="Team window" value={tab} onChange={setTab} className="w-full *:flex-1"
          options={[['new', 'New request'], ['mine', <span key="mine">Your requests <span className="ml-1 text-xs text-muted-foreground tabular-nums">{open.length}</span></span>]]} />
      </div>
      {tab === 'new' ? <NewRequest onSent={onClose} /> : <YourRequests open={open} closed={closed} />}
    </>
  )
}

function NewRequest({ onSent }: { onSent: () => void }) {
  const team = useUi(s => s.team)
  const patch = useUi(s => s.patch)
  const showToast = useUi(s => s.showToast)
  const phone = useUi(s => s.phone)
  const ctx = useCtx()
  const isBug = team.type === 'bug'
  // The sender is the signed-in person, by the name in Settings.
  const sender = userName(ctx)
  const title = team.title.trim(), text = team.text.trim()
  // Whitespace alone is empty: Send waits for a title or details.
  const empty = !title && !text
  const set = (p: Partial<typeof team>) => patch({ team: { ...team, ...p } })
  const send = () => {
    if (empty) return
    agent.sendTeamRequest({
      icon: RT[team.type][0], title: title || titleOf(text), sub: `${RT[team.type][1]} · ${sender}`, at: instantOf(nowOf()), status: 'With the team',
      ...(text ? { text } : {}),
    })
    showToast(isBug ? 'Bug sent to your Inhouse team. Thank you.' : 'Request sent. Your Inhouse team replies within one working day.')
    onSent()
    patch({ team: { ...team, title: '', text: '' } })
  }
  return (
    <>
      <div className="min-h-0 flex-1 overflow-auto px-7 pt-6 pb-2 max-sm:px-5 max-sm:pt-5">
        <fieldset>
          <legend className="mb-2 text-sm font-semibold">What do you need?</legend>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
            {KINDS.map(k => {
              const on = team.type === k
              return (
                <label key={k} className={cn('flex cursor-pointer flex-col items-start justify-between gap-2 rounded-xl border bg-card p-3.5 pb-3 text-sm transition-colors has-focus-visible:shadow-halo',
                  phone ? 'min-h-18' : 'h-23',
                  on ? 'border-foreground font-semibold text-foreground shadow-selected' : 'border-border font-medium text-foreground-2 hover:border-border-strong')}>
                  <input type="radio" name="team-kind" value={k} checked={on} onChange={() => set({ type: k })} className="sr-only" />
                  <Icon name={RT[k][0]} size={20} weight={400} className={on ? 'text-foreground' : 'text-foreground-3'} />
                  <span className="leading-card">{RT[k][1]}</span>
                </label>
              )
            })}
          </div>
        </fieldset>
        <Label htmlFor="team-title" className="mt-5.5 mb-2 block text-sm font-semibold">Title</Label>
        <Input id="team-title" value={team.title} maxLength={TITLE_MAX} autoComplete="off" onChange={e => set({ title: e.target.value })}
          placeholder={isBug ? 'What went wrong?' : 'A few words the team will see first'} />
        <Label htmlFor="team-text" className="mt-4.5 mb-2 block text-sm font-semibold">Details</Label>
        <Textarea id="team-text" value={team.text} maxLength={TEXT_MAX} placeholder={RT[team.type][2]} onChange={e => set({ text: e.target.value })}
          aria-describedby={team.text.length >= TEXT_COUNT_FROM ? 'team-text-count' : undefined}
          className={cn('max-h-60 resize-none rounded-lg px-3.5 py-3 leading-prose', phone ? 'min-h-24' : 'min-h-32')} />
        {team.text.length >= TEXT_COUNT_FROM && (
          <p id="team-text-count" className="mt-1.5 text-right text-xs text-muted-foreground tabular-nums">{TEXT_MAX - team.text.length} characters left</p>
        )}
        {isBug && (
          <div className="mt-3 flex items-center gap-2.5 text-sm text-foreground-2">
            <Checkbox id="team-shot" checked={team.shot} onCheckedChange={v => set({ shot: v === true })} className="size-4.5" />
            <Label htmlFor="team-shot" className="text-sm leading-normal font-normal">Attach a screenshot of this page and what I was doing</Label>
          </div>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-3 px-7 pt-4 pb-5.5 max-sm:px-5">
        <span className="grow basis-45 text-sm text-muted-foreground">{isBug ? 'Goes straight to the team, with the page you were on.' : 'Every tool and job is included in your plan.'}</span>
        <Button size="lg" disabled={empty} onClick={send}>Send to the team</Button>
      </div>
    </>
  )
}

function YourRequests({ open, closed }: { open: TeamRow[]; closed: TeamRow[] }) {
  const [show, setShow] = useState<'open' | 'closed'>('open')
  const rows = show === 'open' ? open : closed
  return (
    <div className="min-h-0 flex-1 overflow-auto px-7 pt-5 pb-6.5 max-sm:px-5">
      <Segmented label="Show requests" value={show} onChange={setShow}
        options={[['open', `Open · ${open.length}`], ['closed', `Closed · ${closed.length}`]]} />
      {rows.length === 0
        ? <EmptyState className="mt-3.5">{show === 'open' ? 'No open requests. Ask for a tool, a job or a change.' : 'Nothing closed yet.'}</EmptyState>
        : (
          <ul aria-label={show === 'open' ? 'Open requests' : 'Closed requests'} className="m-0 mt-3.5 list-none rounded-2xl border border-border bg-card p-0">
            {rows.map((q, i) => <RequestRow key={q.key} q={q} first={i === 0} />)}
          </ul>
        )}
    </div>
  )
}

function RequestRow({ q, first }: { q: TeamRow; first: boolean }) {
  const [expanded, setExpanded] = useState(false)
  const withdrawn = useUi(s => s.teamWithdrawn)
  const patch = useUi(s => s.patch)
  const showToast = useUi(s => s.showToast)
  const clearToast = useUi(s => s.clearToast)
  const phone = useUi(s => s.phone)
  const id = `team-req-${q.key.replace(/[^\w-]/g, '-')}`
  const chip = <Badge variant={q.closed ? 'status' : q.dated ? 'brand' : 'muted'} size="lg" className="flex-none">{q.status}</Badge>
  const withdraw = () => {
    patch({ teamWithdrawn: [...withdrawn, q.key] })
    showToast('Request withdrawn.', { icon: 'undo', undo: () => { patch({ teamWithdrawn: useUi.getState().teamWithdrawn.filter(k => k !== q.key) }); clearToast() } })
  }
  return (
    <li className={cn(!first && 'border-t border-divider')}>
      <button type="button" aria-expanded={expanded} aria-controls={expanded ? id : undefined} onClick={() => setExpanded(x => !x)}
        className={cn('flex w-full gap-3.5 rounded-2xl px-4.5 py-4 text-left transition-colors hover:bg-accent', phone ? 'items-start' : 'items-center')}>
        <IconTile icon={q.icon} size="md" tone="fill" />
        <span className="min-w-0 flex-1">
          <span className="block text-md font-semibold">{q.title}</span>
          <span className="mt-0.5 block text-sm text-muted-foreground">{q.kind} · <span className="whitespace-nowrap">{q.who}, {q.when}</span></span>
          {phone && <span className="mt-1.5 block">{chip}</span>}
        </span>
        {!phone && chip}
        <Icon name={expanded ? 'expand_less' : 'expand_more'} size={20} className="flex-none text-muted-foreground" />
      </button>
      {expanded && (
        <div id={id} className="pr-4.5 pb-4 pl-16.5 max-sm:pl-4.5">
          <p className="text-base leading-prose text-pretty text-foreground-2">{q.text ?? q.title}</p>
          {q.mine && !q.closed && (
            <Button variant="ghost" className="mt-3 -ml-3" onClick={withdraw}>Withdraw request</Button>
          )}
        </div>
      )}
    </li>
  )
}
