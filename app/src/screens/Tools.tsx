// Tools list and the single tool page.
import { cn } from '@/lib/utils'
import { agent } from '../agent'
import { keepUnitsTogether } from '../agent/clock'
import { STAGE_TAGS, toolCounts, toolDetail, toolView } from '../state/derive'
import type { ToolState } from '../state/derive'
import { useCtx, useUi } from '../state/store'
import { useState } from 'react'
import type { ReactNode } from 'react'
import { Badge } from '@/components/ui/badge'
import { Separator } from '@/components/ui/separator'
import { Button, CardGrid, DetailList, Dot, EmptyState, Icon, LogoTile, Page, PageHeader, SectionHeader, StageTag } from '../ui'
import { SearchBox, TAP } from '../ui/fields'

const AMBER_DOT = 'bg-warning'
const GREY_DOT = 'bg-faint'
const INK_DOT = 'bg-foreground'
/** A tool's dot: amber while it can't be read (being connected, login expired), grey while a person paused it. */
const DOT_OF: Record<ToolState, string> = { connecting: AMBER_DOT, disconnected: AMBER_DOT, paused: GREY_DOT, connected: INK_DOT }

const SECTION_HEAD = 'mb-1.5'
const rule = <Separator className="my-4.5 bg-border" />
const NAME = 'text-md font-strong'
const DESC = 'text-sm text-pretty text-muted-foreground'
const ROW = 'flex w-full items-center gap-3.5 rounded-xl p-3 text-left transition-colors hover:bg-card'
const LABEL = 'mt-7 mb-2.5'
const CARD = 'rounded-2xl border border-border bg-card'

export function Tools() {
  const ctx = useCtx()
  const { S, agent: st, data } = ctx
  const { tools } = data
  const openTool = useUi(s => s.openTool)
  const showToast = useUi(s => s.showToast)
  const clearToast = useUi(s => s.clearToast)
  const openTeam = useUi(s => s.openTeam)
  const tap = useUi(s => s.phone) ? TAP : undefined
  const [query, setQuery] = useState('')
  const needle = query.trim().toLowerCase()
  const hit = (name: string, desc: string) => !needle || `${name} ${desc}`.toLowerCase().includes(needle)
  const connected = tools.connected.filter(k => hit(toolDetail(data, k).name, toolDetail(data, k).desc))
  const beingConnected = tools.beingConnected.filter(k => hit(toolDetail(data, k).name, toolDetail(data, k).desc))
  const catalog = tools.catalog.filter(c => hit(c.name, c.desc))

  // Each row's state and line come from the agent's data (toolView), so the list, the count and the tool page agree (M17).
  const row = (k: string) => {
    const v = toolView(ctx, k)
    return { k, d: toolDetail(data, k), bad: v.state === 'disconnected', dot: DOT_OF[v.state], last: v.listLine }
  }
  const counts = toolCounts(ctx)
  // "5 of 6" while a tool is paused or disconnected: Connected never claims a tool the agent can't read now.
  const connectedCount = needle || counts.reading === counts.connected ? connected.length : `${counts.reading} of ${counts.connected}`
  // Where the team hears from the agent (Slack, from Act): connected, but not a tool it reads (decision D6).
  const channels = tools.channels.filter(c => hit(c.name, c.desc))
  const requestCustom = () => openTeam('tool')

  return (
    <Page>
      <PageHeader title="Tools" description="The tools your Inhouse agent works with. Every tool you use is included, and we connect them one at a time." />
      <div className="mt-5.5 flex gap-2.5">
        <SearchBox value={query} onChange={setQuery} placeholder="Search tools" label="Search tools" />
        <Button size="lg" onClick={requestCustom}>
          <Icon name="add" size={18} />Request a tool
        </Button>
      </div>
      <Separator className="mt-6.5 mb-4.5 bg-border" />

      {needle && connected.length + channels.length + beingConnected.length + catalog.length === 0 && (
        <EmptyState variant="inline">No tools match "{query.trim()}". Use Request a tool and your Inhouse team builds the connection.</EmptyState>
      )}
      {connected.length > 0 && <>
      <SectionHeader title="Connected" count={connectedCount} className={SECTION_HEAD} />
      <CardGrid size="lg" variant="rows">
        {connected.map(k => {
          const r = row(k)
          return (
            <button key={k} type="button" data-tool-row onClick={() => openTool(k)} className={ROW}>
              <LogoTile k={k} />
              <span className="min-w-0 flex-1">
                <span className={`block ${NAME}`}>{r.d.name}</span>
                <span className={`block ${DESC}`}>{r.d.desc}</span>
              </span>
              <span className={`flex items-center gap-1.5 text-xs whitespace-nowrap ${r.bad ? 'text-warning-text' : 'text-muted-foreground'}`}>
                <Dot className={r.dot} size={6} />{r.last}
              </span>
              <Icon name="chevron_right" size={18} className="text-faint" />
            </button>
          )
        })}
      </CardGrid>
      {(channels.length > 0 || beingConnected.length > 0 || catalog.length > 0) && rule}
      </>}

      {channels.length > 0 && <>
      <SectionHeader title="Channels" count={channels.length} className={SECTION_HEAD} />
      <CardGrid size="lg" variant="rows" className={channels.length === 1 ? 'grid-cols-1' : undefined}>
        {channels.map(c => {
          const locked = S < c.need
          return (
            <div key={c.key} data-channel-row className="flex items-center gap-3.5 rounded-xl p-3">
              <LogoTile k={c.key} className={locked ? 'grayscale' : undefined} />
              <span className="min-w-0 flex-1">
                <span className={`flex items-center gap-2 ${NAME} ${locked ? 'text-foreground-3' : ''}`}>{c.name}{locked && <StageTag tag={STAGE_TAGS[c.need]} />}</span>
                <span className={`block ${DESC}`}>{c.desc}</span>
              </span>
              <span className="flex items-center gap-1.5 text-xs whitespace-nowrap text-muted-foreground">
                {locked ? `Included from ${STAGE_TAGS[c.need]}` : <><Dot className={INK_DOT} size={6} />Connected {c.since}</>}
              </span>
              {/* No page, so no chevron: the space it takes keeps the status lined up with the rows above. */}
              <span aria-hidden="true" className="size-4.5 flex-none" />
            </div>
          )
        })}
      </CardGrid>
      {(beingConnected.length > 0 || catalog.length > 0) && rule}
      </>}

      {beingConnected.length > 0 && <>
      <SectionHeader title="Being connected" count={beingConnected.length} className={SECTION_HEAD} />
      <CardGrid size="lg" variant="rows">
        {beingConnected.map(k => {
          const r = row(k)
          return (
            <button key={k} type="button" data-tool-row onClick={() => openTool(k)} className={ROW}>
              <LogoTile k={k} />
              <span className="min-w-0 flex-1">
                <span className={`block ${NAME}`}>{r.d.name}</span>
                <span className={`block ${DESC}`}>{r.d.desc}</span>
              </span>
              <Badge variant="muted">{r.last}</Badge>
            </button>
          )
        })}
      </CardGrid>
      {catalog.length > 0 && rule}
      </>}

      {catalog.length > 0 && <>
      <SectionHeader title="Add a tool" className={SECTION_HEAD} />
      <CardGrid size="lg" variant="rows">
        {catalog.map(c => {
          const need = c.need ?? 0
          const locked = S < need
          const req = !!st.requestedTools[c.k]
          const ask = () => {
            agent.requestTool(c.k, true)
            showToast(`Request sent to your Inhouse team: connect ${c.name}`, { undo: () => { agent.requestTool(c.k, false); clearToast() } })
          }
          return (
            <div key={c.k} className="flex items-center gap-3.5 rounded-xl p-3">
              <LogoTile k={c.k} className={locked ? 'grayscale' : undefined} />
              <div className="min-w-0 flex-1">
                <div className={`flex items-center gap-2 ${NAME} ${locked ? 'text-foreground-3' : ''}`}>{c.name}{locked && <StageTag tag={STAGE_TAGS[need]} />}</div>
                <div className={DESC}>{c.desc}</div>
              </div>
              <Button variant={req ? 'requested' : 'outline'} disabled={req} onClick={ask} className={cn('flex-none', tap)}>
                {req && <Icon name="check" size={17} />}{req ? 'Requested' : 'Request'}
              </Button>
            </div>
          )
        })}
      </CardGrid>
      </>}

    </Page>
  )
}

/** The Access row follows the tool's state: a paused or disconnected tool never claims the stage's access. */
const accessOf = (state: ToolState, S: number, paused: boolean) => {
  if (state === 'disconnected') return paused ? 'None. A person paused it, and the login needs renewing.' : 'None until the login is renewed.'
  if (state === 'paused') return 'None. A person paused it.'
  if (state === 'connecting') return 'None yet. Being connected.'
  return ['Read only', 'Read, plus drafts you approve', 'Read, drafts and agreed jobs within limits'][S]
}

export function ToolPage() {
  const ctx = useCtx()
  const { S, agent: st, data } = ctx
  const key = useUi(s => s.appKey)
  const go = useUi(s => s.go)
  const ask = useUi(s => s.ask)
  const newChat = useUi(s => s.newChat)
  const showToast = useUi(s => s.showToast)
  const clearToast = useUi(s => s.clearToast)
  const tap = useUi(s => s.phone) ? TAP : undefined
  const A = toolDetail(data, key)
  // Status, abilities, last read and suggested questions all follow the tool's state (M17).
  const view = toolView(ctx, key)
  const bad = view.state === 'disconnected'
  // A person's pause, even while the login is also broken: Pause access and Resume access follow it.
  const off = !!st.toolPaused[key]
  const pauseLabel = off ? 'Resume access' : 'Pause access'
  const reconnect = () => showToast("Reconnect isn't connected in this demo.", { icon: 'info', ms: 4000 })
  const onPause = () => {
    // The agent has already sent the person a notice if the save failed; this only keeps the rejection from going unhandled.
    agent.setToolPaused(key, !off).catch(() => {})
    if (off) { showToast(`Your Inhouse agent can read ${A.name} again`); return }
    showToast(`Access paused. Your Inhouse agent has stopped reading ${A.name}.`, { undo: () => { agent.setToolPaused(key, false).catch(() => {}); clearToast() } })
  }
  // An ability that is on keeps its tint; one the stage hasn't reached, or that can't run now (paused, off), is muted.
  const abilities = view.abilities.map(ab => ({ ...ab, on: !ab.locked && ab.tag === 'On',
    tone: ab.locked || ab.tag !== 'On' ? 'bg-fill text-muted-foreground' : ab.need === 0 ? 'bg-secondary text-foreground' : 'bg-brand-tint text-brand' }))
  const info: [string, ReactNode][] = [
    ['Connected', view.connectedRow],
    ['Access', accessOf(view.state, S, off)],
    ['Last read', view.lastRead],
    ['Where the data stays', `In your ${A.name} account. Your Inhouse agent reads what its jobs need.`],
    ['Website', <a key="site" href={`https://${A.site}`} target="_blank" rel="noopener noreferrer" className="underline underline-offset-3">{A.site} ↗</a>],
  ]

  return (
    <Page className="pt-4.5">
      <Button variant="quiet" onClick={() => go('apps')} className="gap-1">
        <Icon name="arrow_back" size={17} />Tools
      </Button>
      <PageHeader className="mt-4" title={A.name} description={A.desc}
        leading={<LogoTile k={key} size="xl" className="shadow-card" />}
        tag={<Badge variant="status" size="md"><Dot className={DOT_OF[view.state]} size={6} />{view.statusText}</Badge>}
        actions={(
          <Button variant="outline" size="lg" onClick={() => newChat(`In ${A.name}, `)}>
            <Icon name="chat_bubble" size={17} />Ask about {A.name}
          </Button>
        )} />

      {/* Suggested questions only while the agent can read the tool. */}
      {view.examples.length > 0 && <div className="relative mt-6 overflow-hidden rounded-3xl bg-fill-hover p-7">
        <div aria-hidden="true" className="absolute inset-0 bg-dot-grid-tool bg-size-(--app-dot-grid-size) mask-(--app-tool-hero-mask)" />
        <div className="relative mx-auto flex max-w-160 flex-col gap-2.5">
          {view.examples.map(t => (
            <button key={t} type="button" data-tool-example onClick={() => { void ask(t) }} className="flex w-full items-center gap-3 rounded-2xl bg-card/90 py-3 pr-3 pl-4 text-left shadow-card transition-colors hover:bg-card">
              <span className="min-w-0 flex-1 text-md text-pretty">{keepUnitsTogether(t)}</span>
              <span className="flex size-8.5 flex-none items-center justify-center rounded-full bg-fill">
                <Icon name="arrow_forward" size={18} />
              </span>
            </button>
          ))}
        </div>
      </div>}
      {view.state === 'paused' && <EmptyState className="mt-6">Access is paused. Resume it and you can ask about {A.name} again.</EmptyState>}

      <SectionHeader title={`What your Inhouse agent can do with ${A.name}`} className={LABEL} />
      <div className={`${CARD} px-5`}>
        {abilities.map((ab, i) => (
          <div key={ab.title} data-ability={ab.key} className={`flex items-center gap-3.5 py-4 ${i === 0 ? '' : 'border-t border-divider'}`}>
            <span className={`flex size-8.5 flex-none items-center justify-center rounded-lg ${ab.tone}`}>
              <Icon name={ab.icon} size={18} />
            </span>
            <div className="min-w-0 flex-1">
              <div className={cn(NAME, ab.locked && 'text-foreground-3')}>{ab.title}</div>
              <div className={DESC}>{ab.text}</div>
            </div>
            {ab.locked ? <StageTag tag={ab.tag} size="lg" /> : (
              <Badge variant="outline" size="lg" className="gap-1">
                {ab.on && <Icon name="check" size={13} />}{ab.tag}
              </Badge>
            )}
          </div>
        ))}
      </div>

      <SectionHeader title="Connection" className={LABEL} />
      <div className={`${CARD} flex flex-wrap items-center gap-3.5 px-5 py-4.5`}>
        <LogoTile k={key} />
        <div className="min-w-0 grow basis-55">
          <div className={NAME}>{A.conn}</div>
          <div className={DESC}>The login stays in your account. Remove access any time and your Inhouse agent stops.</div>
        </div>
        <div className="flex flex-wrap gap-2">
          {bad && <Button size="lg" className={tap} onClick={reconnect}>Reconnect</Button>}
          <Button variant="secondary" size="lg" className={tap} onClick={onPause}>{pauseLabel}</Button>
        </div>
      </div>

      <SectionHeader title="Details" className={LABEL} />
      <DetailList variant="relaxed" items={info} className={`${CARD} px-5 py-2.5 text-base`} />
    </Page>
  )
}
