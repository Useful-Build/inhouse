import { agent } from '../agent'
import type { RequestType } from '../state/store'
import { useCtx, useUi } from '../state/store'
import { goingLive, userName } from '../state/derive'
import { Badge } from '@/components/ui/badge'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import { Button, ChoiceChips, Icon, IconTile, Window, WindowHeader } from '../ui'

const RT: Record<RequestType, [icon: string, label: string, placeholder: string]> = {
  tool: ['add_link', 'New tool', 'Which tool, and what should your Inhouse agent do with it?'],
  job: ['work', 'New job', 'Describe the job. For example: every Friday, check wholesale orders against stock.'],
  change: ['tune', 'Change something', 'What should work differently?'],
  bug: ['bug_report', 'Report a bug', 'What happened, and what did you expect?'],
  feedback: ['campaign', 'Feedback', 'What would make Inhouse better for you?'],
}

const SEEDED_STYLE: Record<number, { variant: 'muted' | 'secondary' }> = { 0: { variant: 'muted' }, 1: { variant: 'secondary' } }

/** A date in a request's line ("Nov 9", "Wed, Nov 11"): it never breaks inside itself. */
const DATE = /((?:(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), )?(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{1,2})/
const wholeDates = (text: string) => text.split(DATE).map((part, i) => (i % 2 ? <span key={i} className="whitespace-nowrap">{part}</span> : part))

export function TeamWindow() {
  const pop = useUi(s => s.pop)
  const team = useUi(s => s.team)
  const patch = useUi(s => s.patch)
  const showToast = useUi(s => s.showToast)
  const phone = useUi(s => s.phone)
  const ctx = useCtx()
  const { agent: st, data } = ctx
  if (pop !== 'team') return null

  const close = () => patch({ pop: null })
  const isBug = team.type === 'bug'
  // The tool being connected takes its date from tools.json; on First day (nothing live yet) its request isn't listed.
  const live = goingLive(ctx)
  const seeded = data.notifications.teamRequests.flatMap((q, i) => {
    const tool = /^Connect (.+)$/.exec(q.title)?.[1]
    if (tool && live?.name !== tool) return []
    return [{
      icon: q.sub.startsWith('New job') ? 'work' : 'add_link', title: q.title, sub: q.sub, status: tool && live ? `Live by ${live.by}` : q.status,
      ...(SEEDED_STYLE[i] ?? SEEDED_STYLE[1]),
    }]
  })
  const requests = [
    ...st.teamRequests.map(q => ({ ...q, ...SEEDED_STYLE[1] })),
    ...seeded,
  ]
  // The sender is the signed-in person, by the name in Settings.
  const sender = userName(ctx)
  // Whitespace alone is empty: Send waits for words.
  const empty = !team.text.trim()
  const send = () => {
    const txt = team.text.trim()
    if (!txt) return
    agent.sendTeamRequest({ icon: RT[team.type][0], title: txt.length > 60 ? `${txt.slice(0, 57)}…` : txt, sub: `${RT[team.type][1]} · sent by ${sender}, just now`, status: 'Sent' })
    showToast(isBug ? 'Bug sent to your Inhouse team. Thank you.' : 'Request sent. Your Inhouse team replies within one working day.')
    patch({ pop: null, team: { ...team, text: '' } })
  }

  return (
    <Window onClose={close} label="Your Inhouse team" size="md">
      <WindowHeader title="Your Inhouse team" description="Alex and the team build, connect and run your Inhouse agent. They reply within one working day."
        leading={<IconTile icon="support_agent" iconSize={20} size="lg" tone="outline" />} onClose={close} />
      <div className="flex-1 overflow-auto px-5.5 pt-3 pb-5.5">
        <h3 className="mt-1.5 mb-2 text-base font-strong text-foreground-2">Open requests</h3>
        <div className="rounded-2xl border border-border bg-card px-4">
          {/* On a phone the status goes under the title, so the title keeps the row's width. */}
          {requests.map((q, i) => (
            <div key={`${q.title}|${q.sub}|${i}`} className={cn('flex min-h-13.5 gap-3 border-t', i === 0 ? 'border-transparent' : 'border-divider', phone ? 'items-start py-2' : 'items-center')}>
              <Icon name={q.icon} size={18} className={cn('text-foreground-3', phone && 'mt-0.75')} />
              <div className="min-w-0 flex-1">
                <div className="ellipsis text-base font-strong">{q.title}</div>
                <div className="text-xs text-muted-foreground">{wholeDates(q.sub)}</div>
                {phone && <Badge variant={q.variant} size="lg" className="mt-1">{q.status}</Badge>}
              </div>
              {!phone && <Badge variant={q.variant} size="lg">{q.status}</Badge>}
            </div>
          ))}
        </div>
        {/* On a phone the window is short: a little less room around the form keeps the card whole on screen. */}
        <h3 className={cn('mb-2 text-base font-strong text-foreground-2', phone ? 'mt-4' : 'mt-5')}>New request</h3>
        <div className={cn('rounded-2xl border border-border bg-card px-4', phone ? 'py-3' : 'py-3.5')}>
          <ChoiceChips label="Request type" value={team.type} options={(Object.keys(RT) as RequestType[]).map(k => [k, RT[k][1], RT[k][0]])}
            onChange={type => patch({ team: { ...team, type } })} />
          <Textarea aria-label="Your request" value={team.text} placeholder={RT[team.type][2]} onChange={e => patch({ team: { ...team, text: e.target.value } })}
            className={cn('mt-3 resize-y rounded-xl bg-muted px-3.5 py-3 leading-normal', phone ? 'min-h-18' : 'min-h-27.5')} />
          {isBug && (
            <div className="mt-2.5 flex items-center gap-2.5 text-sm text-foreground-2">
              <Checkbox id="team-shot" checked={team.shot} onCheckedChange={v => patch({ team: { ...team, shot: v === true } })} className="size-4.5" />
              <Label htmlFor="team-shot" className="text-sm leading-normal font-normal">Attach a screenshot of this page and what I was doing</Label>
            </div>
          )}
          <div className="mt-3.5 flex flex-wrap items-center gap-2.5">
            <span className="grow basis-45 text-xs text-muted-foreground">{isBug ? 'Goes straight to the team, with the page you were on.' : 'Every tool and job is included in your plan.'}</span>
            <Button size="lg" disabled={empty} onClick={send}>Send to the team</Button>
          </div>
        </div>
      </div>
    </Window>
  )
}
