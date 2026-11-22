// Tools list and the single tool page.
import { cn } from '@/lib/utils'
import { agent, demo } from '../agent'
import { keepUnitsTogether } from '../agent/clock'
import { STAGE_TAGS, toolCounts, toolDetail, toolView } from '../state/derive'
import type { ToolState } from '../state/derive'
import { useCtx, useUi } from '../state/store'
import { useEffect, useState, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import type { ToolChannel } from '../agent/types'
import { fmtDay } from '../lib/format'
import { toolRoute } from '../shell/tool-route'
import { display } from '../state/display'
import { Badge } from '@/components/ui/badge'
import { Separator } from '@/components/ui/separator'
import { Button, CardGrid, DetailList, Dot, EmptyState, Icon, LogoTile, Page, PageHeader, SectionHeader, StageTag } from '../ui'
import { Confirm, SearchBox, TAP } from '../ui/fields'

const AMBER_DOT = 'bg-warning'
const GREY_DOT = 'bg-faint'
const INK_DOT = 'bg-foreground'
/** A tool's dot: amber while it can't be read (being connected, login expired), grey while a person paused it. */
const DOT_OF: Record<ToolState, string> = { connecting: AMBER_DOT, disconnected: AMBER_DOT, paused: GREY_DOT, connected: INK_DOT, off: GREY_DOT }

const SECTION_HEAD = 'mb-1.5'
// A section with one item gives it the full width, so its status sits at the right edge like the rows above and below.
const ONE = (n: number) => n === 1 ? 'grid-cols-1' : undefined
const rule = <Separator className="my-4.5 bg-border" />
const NAME = 'text-md font-strong'
const DESC = 'text-sm text-pretty text-muted-foreground'
const ROW = 'flex w-full items-center gap-3.5 rounded-xl p-3 text-left transition-colors hover:bg-card'
const LABEL = 'mt-7 mb-2.5'
const CARD = 'rounded-2xl border border-border bg-card'

/**
 * Who may change a tool here. The Inhouse team alone connects, pauses and disconnects (the server refuses every other role,
 * and `me().can.editTechnical` is its row's answer); an Admin sees the page with no controls and a line saying so; a Member
 * reads it. The demo shows the controls to everyone, as its sample Admin may do everything.
 */
function useToolControls() {
  const me = useSyncExternalStore(agent.subscribe, agent.me)
  const manage = demo !== null || !!me?.can.editTechnical
  // The Admin's line: a person who edits the brand's settings but not the technical ones (`can`, never the role's name).
  return { manage, adminLine: !manage && !!me?.can.editBrandSettings }
}

/**
 * Starts signing in at a tool and goes there. The agent has already told the person if it failed. In the demo the address is
 * this app's own: nothing to go to, so it says so, as every other action that isn't connected in the demo does.
 */
const CONNECT_FAILED = "We couldn't connect the tool. Try again."
/** Back from the tool's sign-in page can restore this page as it was (the browser's back-forward cache): run `reset` then. */
function useResetOnRestore(reset: () => void) {
  useEffect(() => {
    const on = (e: PageTransitionEvent) => { if (e.persisted) reset() }
    window.addEventListener('pageshow', on)
    return () => window.removeEventListener('pageshow', on)
  })
}

/** Resolves true when the browser is on its way to the tool (stay disabled), false when there is nothing to wait for. */
async function connectTool(key: string, label: string, say: (text: string) => void): Promise<boolean> {
  try {
    const { authorizeUrl } = await agent.connectTool(key)
    if (authorizeUrl.startsWith('/')) { say(`${label} isn't connected in this demo.`); return false }
    let https = false
    try { https = new URL(authorizeUrl).protocol === 'https:' } catch { /* not an address */ }
    if (!https) { say(CONNECT_FAILED); return false }
    location.assign(authorizeUrl)
    return true
  } catch { return false /* told by the agent's notice */ }
}

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
  const { manage } = useToolControls()
  const [connecting, setConnecting] = useState<string | null>(null)
  useResetOnRestore(() => setConnecting(null))
  const connect = async (k: string) => { setConnecting(k); if (!(await connectTool(k, 'Connect', say))) setConnecting(null) }
  const say = (text: string) => { showToast(text, { icon: 'info', ms: 4000 }) }

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
      <CardGrid size="lg" variant="rows" className={ONE(connected.length)}>
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
      <CardGrid size="lg" variant="rows" className={ONE(channels.length)}>
        {channels.map(c => {
          const locked = S < c.need
          return (
            <button key={c.key} type="button" data-channel-row onClick={() => openTool(c.key)} className={ROW}>
              <LogoTile k={c.key} className={locked ? 'grayscale' : undefined} />
              <span className="min-w-0 flex-1">
                <span className={`flex items-center gap-2 ${NAME} ${locked ? 'text-foreground-3' : ''}`}>{c.name}{locked && <StageTag tag={STAGE_TAGS[c.need]} />}</span>
                <span className={`block ${DESC}`}>{c.desc}</span>
              </span>
              <span className="flex items-center gap-1.5 text-xs whitespace-nowrap text-muted-foreground">
                {locked ? `Included from ${STAGE_TAGS[c.need]}` : <><Dot className={INK_DOT} size={6} />Connected {fmtDay(c.since, display())}</>}
              </span>
              <Icon name="chevron_right" size={18} className="text-faint" />
            </button>
          )
        })}
      </CardGrid>
      {(beingConnected.length > 0 || catalog.length > 0) && rule}
      </>}

      {beingConnected.length > 0 && <>
      <SectionHeader title="Being connected" count={beingConnected.length} className={SECTION_HEAD} />
      <CardGrid size="lg" variant="rows" className={ONE(beingConnected.length)}>
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
      <CardGrid size="lg" variant="rows" className={ONE(catalog.length)}>
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
                {/* A first login that failed shows the tool page's own line in place of the description. */}
                {tools.details[c.k]?.loginFailedAt ? <div className={cn(DESC, 'text-warning-text')}>{toolView(ctx, c.k).listLine}</div> : <div className={DESC}>{c.desc}</div>}
              </div>
              {manage && c.accountId
                ? <Button variant="outline" disabled={connecting !== null} onClick={() => { void connect(c.k) }} className={cn('flex-none', tap)}>Connect</Button>
                : <Button variant={req ? 'requested' : 'outline'} disabled={req} onClick={ask} className={cn('flex-none', tap)}>
                    {req && <Icon name="check" size={17} />}{req ? 'Requested' : 'Request'}
                  </Button>}
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
  if (state === 'off') return "None. It isn't connected."
  return ['Read only', 'Read, plus drafts you approve', 'Read, drafts and agreed jobs within limits'][S]
}

export function ToolPage() {
  const key = useUi(s => s.appKey)
  const { data } = useCtx()
  const { channels, details } = data.tools
  const channel = channels.find(c => c.key === key)
  // A link to a tool that arrives before the tools have been read (the sign-in's return) waits for them, not for a redirect.
  const route = toolRoute(data.tools, key, data.resources.tools.status)
  if (route === 'wait') return <ToolsLoading />
  if (route === 'failed') return <ToolsFailed />
  // A channel that is also a tool the agent reads (Slack) gets the tool page, which carries the controls.
  return channel && !Object.hasOwn(details, key) ? <ChannelPage channel={channel} /> : <ToolDetailPage />
}

function ToolsLoading() {
  return (
    <Page className="pt-4.5">
      <PageHeader title="Tools" description="The tools your Inhouse agent works with." />
      <EmptyState className="mt-6" variant="inline">Loading your tools.</EmptyState>
    </Page>
  )
}

/** The tools couldn't be read: the link stays, and the page says so with a way to try again. */
function ToolsFailed() {
  const [again, setAgain] = useState(false)
  return (
    <Page className="pt-4.5">
      <PageHeader title="Tools" description="The tools your Inhouse agent works with." />
      <EmptyState className="mt-6" variant="inline">We couldn't load your tools.</EmptyState>
      <Button className="mt-4" size="lg" disabled={again} onClick={() => { setAgain(true); void agent.retry('tools').finally(() => setAgain(false)) }}>Try again</Button>
    </Page>
  )
}

/** A channel's page (Slack): where the team hears from the agent. Not a tool it reads, so no abilities or questions (D6). */
function ChannelPage({ channel: c }: { channel: ToolChannel }) {
  const { S } = useCtx()
  const go = useUi(s => s.go)
  const openSettings = useUi(s => s.openSettings)
  const locked = S < c.need
  const status = locked ? `Included from ${STAGE_TAGS[c.need]}` : `Connected · ${fmtDay(c.since, display())}`
  // Before Act the channel isn't live, so only the website shows.
  const info: [string, ReactNode][] = []
  if (!locked && c.channel) info.push(['Channel', c.channel])
  if (!locked && c.sends?.length) info.push(['What it sends', <ul key="sends">{c.sends.map(x => <li key={x}>{x}</li>)}</ul>])
  info.push(['Website', <a key="site" href={`https://${c.site}`} target="_blank" rel="noopener noreferrer" className="underline underline-offset-3">{c.site} ↗</a>])
  return (
    <Page className="pt-4.5">
      <Button variant="quiet" onClick={() => go('apps')} className="gap-1">
        <Icon name="arrow_back" size={17} />Tools
      </Button>
      <PageHeader className="mt-4" title={c.name} description={c.desc}
        leading={<LogoTile k={c.key} size="xl" className={cn('shadow-card', locked && 'grayscale')} />}
        tag={<Badge variant="status" size="md">{status}</Badge>}
        actions={!locked && (
          <Button variant="outline" size="lg" onClick={() => openSettings('you-notif')}>
            <Icon name="notifications" size={17} />Notification settings
          </Button>
        )} />
      <SectionHeader title="Details" className={LABEL} />
      <DetailList variant="relaxed" items={info} className={`${CARD} px-5 py-2.5 text-base`} />
    </Page>
  )
}

function ToolDetailPage() {
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
  const { manage, adminLine } = useToolControls()
  const [confirming, setConfirming] = useState(false)
  const [signingIn, setSigningIn] = useState(false)
  useResetOnRestore(() => setSigningIn(false))
  // Status, abilities, last read and suggested questions all follow the tool's state (M17).
  const view = toolView(ctx, key)
  const bad = view.state === 'disconnected'
  // A person's pause, even while the login is also broken: Pause access and Resume access follow it.
  const off = !!st.toolPaused[key]
  const pauseLabel = off ? 'Resume access' : 'Pause access'
  const connectLabel = bad ? 'Reconnect' : 'Connect'
  const reconnect = async () => {
    setSigningIn(true)
    if (!(await connectTool(key, connectLabel, text => showToast(text, { icon: 'info', ms: 4000 })))) setSigningIn(false)
  }
  const disconnect = async () => {
    setConfirming(false)
    try {
      const { revoked } = await agent.disconnectTool(key)
      showToast(revoked ? `${A.name} is disconnected.` : `${A.name} is disconnected, but its access wasn't removed on its side. Remove the app there too.`, revoked ? undefined : { icon: 'info', ms: 8000 })
    } catch { /* told by the agent's notice */ }
  }
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
        tag={<Badge variant="status" size="md">{view.statusText}</Badge>}
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
        {manage && (
          <div className="flex flex-wrap gap-2">
            {(bad || view.state === 'off') && <Button size="lg" className={tap} disabled={signingIn} onClick={() => { void reconnect() }}>{connectLabel}</Button>}
            {(view.state === 'connected' || view.state === 'paused' || bad) && <Button variant="secondary" size="lg" className={tap} onClick={onPause}>{pauseLabel}</Button>}
            {A.canDisconnect && <Button variant="outline" size="lg" className={tap} onClick={() => setConfirming(true)}>Disconnect</Button>}
          </div>
        )}
        {adminLine && <div className={`basis-full ${DESC}`}>Your Inhouse team manages tools.</div>}
        {bad && manage && A.canDisconnect && <div className={`basis-full ${DESC}`}>If Reconnect doesn't work, disconnect it, then connect again.</div>}
        {A.revokeFailed && <div className="basis-full text-sm text-pretty text-warning-text">{`${A.name}'s access wasn't removed on its side when it was last disconnected. Remove the app there too.`}</div>}
      </div>
      {confirming && (
        <Confirm label={`Disconnect ${A.name}`} title={`Disconnect ${A.name}?`} action="Disconnect" onCancel={() => setConfirming(false)} onConfirm={() => { void disconnect() }}>
          Your Inhouse agent stops reading {A.name} and its access is removed. You can connect it again any time.
        </Confirm>
      )}

      <SectionHeader title="Details" className={LABEL} />
      <DetailList variant="relaxed" items={info} className={`${CARD} px-5 py-2.5 text-base`} />
    </Page>
  )
}
