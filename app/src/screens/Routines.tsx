import { useRef, useState } from 'react'
import { agent } from '../agent'
import { traceOf, useTraces } from './chat/traces'
import { keepUnitsTogether } from '../agent/clock'
import type { RoutineDef } from '../agent'
import { flags, lastRunLine, routineRuns, STAGE_TAGS, whenOf } from '../state/derive'
import type { Instant } from '../agent/types'
import { fmtWeekdayAt } from '../lib/format'
import { display, nowOf } from '../state/display'
import { useCtx, useUi } from '../state/store'
import { Badge } from '@/components/ui/badge'
import { DropdownMenu, DropdownMenuContent, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet'
import { cn } from '@/lib/utils'
import { Button, DetailList, EmptyState, Icon, IconButton, MenuItem, Page, PageHeader, StageTag, Switch } from '../ui'
import { Confirm, TAP } from '../ui/fields'
import { NO_MOTION } from '../ui/motion'
import { claimTrigger, rememberTrigger, restoreFocus, keepForToast } from '../ui/dialogs'

/** A routine as the page lists it: its id (the agent's), whether this stage has it, and whether it is switched on. */
interface Item { r: RoutineDef; id: string; locked: boolean; on: boolean; key: string }

export function Routines() {
  const ctx = useCtx()
  const { newChat, showToast, clearToast } = useUi.getState()
  const phone = useUi(s => s.phone)
  const { S, agent: st, data } = ctx
  const paused = flags(ctx).pausedEff
  const [openId, setOpenId] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<Item | null>(null)
  const all: RoutineDef[] = [
    ...data.routines,
    ...st.routinesExtra.map(r => ({ need: 1 as const, rev: 1, ...r, what: `Created in a chat: "${r.what}"` })),
  ]
  const list: Item[] = all.filter(r => !st.routinesDeleted[r.id] && !(r.inChat && S < r.need)).map(r => {
    const locked = S < r.need
    const key = `r:${r.id}`
    return { r, id: r.id, locked, key, on: !locked && (st.toggles[key] ?? true) }
  })
  const open = list.find(it => it.id === openId) ?? null

  const actions = {
    run: (it: Item) => {
      // Shown once the run is taken; a refused run (one still going, the stage) has its own notice from the agent instead.
      agent.runRoutine(it.id).then(() => showToast(`${it.r.name} is running now`, { icon: 'play_arrow', ms: 4000 }), () => {})
    },
    pause: (it: Item) => {
      agent.setToggle(it.key, !it.on)
      showToast(it.on ? `Paused ${it.r.name}` : `${it.r.name} is back on its schedule`, { icon: it.on ? 'pause' : 'play_arrow', ms: 4000 })
    },
    edit: (it: Item) => { setOpenId(null); newChat(`Change the "${it.r.name}" routine: `) },
    remove: (it: Item) => {
      // From the sheet, which closes: Cancel gives focus back to the routine's row. From the row's menu, to its button.
      if (openId) rememberTrigger(document.querySelector<HTMLElement>(`[data-routine-open="${CSS.escape(it.id)}"]`))
      setOpenId(null)
      setDeleting(it)
    },
  }
  const confirmDelete = () => {
    if (!deleting) return
    const { id, r } = deleting
    agent.deleteRoutine(id)
    setDeleting(null)
    showToast(`Deleted ${r.name}`, { icon: 'delete', undo: () => { agent.restoreRoutine(id); clearToast() } })
  }

  return (
    <Page>
      <PageHeader title="Routines" description="Jobs your Inhouse agent runs on a schedule. Ask for a new one in a chat."
        actions={(
          <Button size="lg" onClick={() => newChat('Every Monday at 7, ')}>
            <Icon name="add" size={18} />New routine
          </Button>
        )} />
      {S === 0 && (
        <div className="mt-5.5 flex items-center gap-2.5 rounded-xl border border-dashed border-border-strong px-4 py-3 text-sm text-foreground-3">
          <Icon name="lock" size={16} weight={400} />
          <span className="flex-1">In Watch only the morning check runs. Scheduled jobs start in Act.</span>
        </div>
      )}
      {list.length === 0 && (
        <EmptyState className="mt-6">{data.status === 'loading' ? 'Still reading your tools. Your routines show here in a moment.' : 'No routines yet. Ask for one in a chat.'}</EmptyState>
      )}
      <ul className="mt-6 flex list-none flex-col gap-2.5 p-0">
        {list.map(it => {
          const { r, locked, on } = it
          const mode = modeOf(r, S, locked)
          const next = !locked && paused ? 'Paused' : fmtWeekdayAt(r.next, display())
          return (
            <li key={it.id} className={cn('relative flex items-center rounded-2xl border border-border bg-card transition-colors hover:bg-accent', phone ? 'flex-wrap gap-x-3 px-4 py-4' : 'gap-4 px-5 py-4.5')}>
              <div className="min-w-0 flex-1">
                <div className={`flex flex-wrap items-center gap-2 text-md font-strong ${locked ? 'text-foreground-3' : ''}`}>
                  {/* The name opens the details; its tap area covers the whole row. */}
                  <button type="button" aria-haspopup="dialog" data-routine-open={it.id} onClick={() => { rememberTrigger(); setOpenId(it.id) }} className="text-left after:absolute after:inset-0 after:rounded-2xl">{r.name}</button>
                  {locked && <StageTag tag={STAGE_TAGS[r.need]} />}
                </div>
                <div className={`mt-px text-sm ${locked ? 'text-muted-foreground' : 'text-foreground-3'}`}>{r.what}</div>
                <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-sm text-muted-foreground">
                  <Badge variant="secondary">
                    <Icon name="schedule" size={16} />{whenOf(r)}
                  </Badge>
                  {mode && <span>{mode}</span>}
                </div>
                {!phone && !locked && <div className="mt-2 text-sm text-pretty text-muted-foreground">{keepUnitsTogether(lastOf(st.routineRuns, r, nowOf()) || 'Not run yet')}</div>}
              </div>
              <div className="relative flex flex-none flex-col items-end gap-2.5 text-right">
                {!phone && <div className="text-xs text-muted-foreground">Next run<span className={`block text-sm font-medium ${locked ? 'text-foreground-3' : 'text-foreground'}`}>{next}</span></div>}
                <div className="flex items-center gap-1.5">
                  {!locked && <RoutineMenu item={it} phone={phone} paused={paused} actions={actions} />}
                  {/* The server says who may switch it (`canManage`: its creator, an Admin, the Inhouse team); absent means yes. */}
                  <Switch on={on && !paused} label={`${r.name} on or off`} onChange={locked || !manages(it) ? undefined : () => agent.setToggle(it.key, !on)} />
                </div>
              </div>
              {/* A phone has no room beside the switch: the last run and the next run take the row's full width under it. */}
              {phone && (
                <div className="basis-full">
                  {!locked && <div className="mt-2 text-sm text-pretty text-muted-foreground">{keepUnitsTogether(lastOf(st.routineRuns, r, nowOf()) || 'Not run yet')}</div>}
                  {next && <div className="mt-2 text-xs text-muted-foreground">Next run <span className={`text-sm font-medium whitespace-nowrap ${locked ? 'text-foreground-3' : 'text-foreground'}`}>{next}</span></div>}
                </div>
              )}
            </li>
          )
        })}
      </ul>
      {open && <RoutineSheet item={open} phone={phone} paused={paused} actions={actions} onClose={() => setOpenId(null)} />}
      {deleting && (
        <Confirm label="Delete routine" title={`Delete ${deleting.r.name}?`} action="Delete" onCancel={() => setDeleting(null)} onConfirm={confirmDelete}>
          It stops running for everyone on the team. You can undo it right after.
        </Confirm>
      )}
    </Page>
  )
}

/** The routine's last-run line: the newest Run now from this session (the sheet's first line), else the agent's last run. */
const lastOf = (runs: { routine: string; at: Instant; result?: string }[], r: RoutineDef, now: number) => {
  const run = runs.find(x => x.routine === r.id) ?? r.last
  return run ? lastRunLine(run, now) : undefined
}

const modeOf = (r: RoutineDef, S: number, locked: boolean) =>
  r.need === 0 ? (S === 0 ? 'Read only' : 'Always on') : locked ? '' : S === 2 && !r.money ? 'Runs by itself, within limits' : 'Drafts wait for your approval'

type Actions = Record<'run' | 'pause' | 'edit' | 'remove', (it: Item) => void>

/** Whether this person may switch or delete it: the server's `canManage` (its creator, an Admin, the Inhouse team); absent means yes. */
const manages = (it: Item) => it.r.canManage !== false

function RoutineMenu({ item, phone, paused, actions }: { item: Item; phone: boolean; paused: boolean; actions: Actions }) {
  const items: [string, string, () => void, boolean?][] = [
    ['play_arrow', 'Run now', () => actions.run(item), paused],
    [item.on ? 'pause' : 'play_circle', item.on ? 'Pause' : 'Resume', () => actions.pause(item), !manages(item)],
    ['edit', 'Edit in a chat', () => actions.edit(item)],
  ]
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <IconButton icon="more_horiz" label={`Actions for ${item.r.name}`} size={18} className={cn(phone && TAP)} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" collisionPadding={16} aria-label="Routine actions" aria-labelledby={undefined} className="w-menu-message max-w-screen-gutter border-input">
        {items.map(([icon, t, go, disabled]) => (
          <MenuItem key={t} disabled={disabled} onSelect={go}>
            <Icon name={icon} size={18} />{t}
          </MenuItem>
        ))}
        <DropdownMenuSeparator className="mx-0 my-1" />
        <MenuItem variant="destructive" disabled={!manages(item)} onSelect={() => actions.remove(item)}>
          <Icon name="delete" size={18} />Delete
        </MenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function RoutineSheet({ item, phone, paused, actions, onClose }: { item: Item; phone: boolean; paused: boolean; actions: Actions; onClose: () => void }) {
  useTraces()
  const ctx = useCtx()
  const { openTrace, go } = useUi.getState()
  const { r, locked, on } = item
  const runs = routineRuns(ctx, r)
  // Closing gives focus back to the row that opened the sheet, as Window does.
  const before = useRef<HTMLElement | null>(null)
  // It opens with focus on the sheet itself, so Close shows no focus ring or tooltip until someone tabs to it.
  const panel = useRef<HTMLDivElement>(null)
  const status = locked ? `Starts in ${STAGE_TAGS[r.need]}` : paused ? 'Paused with your Inhouse agent' : on ? 'On' : 'Paused'
  return (
    <Sheet open onOpenChange={o => { if (!o) onClose() }}>
      <SheetContent ref={panel} side={phone ? 'bottom' : 'right'} showCloseButton={false} aria-describedby={undefined}
        onPointerDownOutside={keepForToast} onInteractOutside={keepForToast}
        overlayProps={{ className: NO_MOTION }}
        onOpenAutoFocus={e => { before.current = claimTrigger(); e.preventDefault(); panel.current?.focus() }}
        // Unless something the sheet opened (the steps window) has taken focus already.
        onCloseAutoFocus={e => { e.preventDefault(); if (document.activeElement === document.body) restoreFocus(before.current) }}
        data-surface="window"
        className={cn('gap-0 overflow-hidden rounded-2xl border bg-window-surface shadow-menu', NO_MOTION, phone ? 'inset-2.5 h-auto w-auto' : 'inset-y-2.5 right-2.5 h-auto w-problem-panel sm:max-w-none')}>
        <div className="flex items-center gap-2 pt-3.5 pr-3.5 pl-6 text-xs text-muted-foreground">
          <Icon name="event_repeat" size={16} />Routine
          <div className="flex-1" />
          <IconButton icon="close" label="Close" onClick={onClose} className={cn(phone && TAP)} />
        </div>
        <div className="min-h-0 flex-1 overflow-auto px-6 pt-3 pb-6">
          <div className="flex flex-wrap items-center gap-2">
            <SheetTitle className="text-2xl leading-heading font-medium tracking-heading">{r.name}</SheetTitle>
            {locked && <StageTag tag={STAGE_TAGS[r.need]} />}
          </div>
          <p className="mt-2 text-base text-foreground-3">{r.what}</p>
          {!locked && (
            <div className="mt-5 flex flex-wrap gap-2">
              <Button size="lg" disabled={paused} onClick={() => actions.run(item)}><Icon name="play_arrow" size={18} />Run now</Button>
              <Button variant="outline" size="lg" disabled={!manages(item)} onClick={() => actions.pause(item)}>{on ? 'Pause' : 'Resume'}</Button>
              <Button variant="outline" size="lg" onClick={() => actions.edit(item)}><Icon name="edit" size={17} />Edit in a chat</Button>
              <Button variant="outline" size="lg" disabled={!manages(item)} onClick={() => actions.remove(item)}><Icon name="delete" size={17} />Delete</Button>
            </div>
          )}
          <h3 className="mono-label mt-6">Schedule</h3>
          <DetailList variant="ruled" className="mt-1 text-sm" items={([
            ['When', whenOf(r)],
            ['Next run', locked ? '' : paused ? 'Paused' : fmtWeekdayAt(r.next, display())],
            ['Status', status],
            ['How it works', modeOf(r, ctx.S, locked)],
          ] as [string, string][]).filter(([, v]) => v)} />
          <h3 className="mono-label mt-6">Last runs</h3>
          {runs.length === 0 ? <p className="mt-2 text-sm text-foreground-3">Not run yet.</p> : (
            <ul aria-label="Last runs" className="m-0 mt-1 list-none p-0">
              {runs.map(l => {
                const trace = l.trace && traceOf(l.trace) ? l.trace : undefined
                return (
                  <li key={l.key} data-run-line className="flex min-h-11.25 items-center gap-3 border-b border-divider py-1 text-sm">
                    <Icon name="check_circle" size={18} className="flex-none text-done" />
                    {runs.some(x => x.t) && <span className="w-run-when flex-none whitespace-nowrap text-foreground-3 tabular-nums">{l.t ? (l.day === 'Today' ? l.t : `${l.day.replace(/^\w+day /, '')}, ${l.t}`) : ''}</span>}
                    <span className="min-w-0 flex-1">{l.text}</span>
                    {trace
                      ? <Button variant="link" className="flex-none text-sm" onClick={() => { onClose(); openTrace(trace) }}>Steps →</Button>
                      : l.inActivity && <Button variant="link" className="flex-none text-sm" onClick={() => { onClose(); go('activity') }}>Activity →</Button>}
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}
