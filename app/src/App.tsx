import { Component, Suspense, lazy, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ComponentType, ReactNode } from 'react'
import { agent } from './agent'
import type { ToolsData } from './agent/types'
import type { Page } from './state/store'
import { FROM_SETTINGS_MENU, chatEntries, defaultChatId, newestChat, openChatKey, takeReplaceEntry, useAgentData, useAgentState, useUi } from './state/store'
import { Sidebar } from './shell/Sidebar'
import { Banner, TopBar } from './shell/TopBar'
import { Toasts } from './shell/Toasts'
import { CRASH_KEY, RouteBoundary } from './ErrorBoundary'
import { DevSwitcher } from './shell/DevSwitcher'
import { cn } from '@/lib/utils'
import { Skeleton } from '@/components/ui/skeleton'
import { DotsBackground, GooDefs, Page as PageBox } from './ui'
import { Today } from './screens/Today'
import { Chats } from './screens/Chats'
import { Approvals } from './screens/Approvals'
import { Routines } from './screens/Routines'
import { Activity } from './screens/Activity'
import { Tools, ToolPage } from './screens/Tools'
import { Skills } from './screens/Skills'
import { MENU } from './screens/settings/content'
import { ProblemPanel } from './overlays/ProblemPanel'
import { TeamWindow } from './overlays/TeamWindow'
import { HelpWindow } from './overlays/HelpWindow'
import { CommandPalette } from './overlays/CommandPalette'

// The heavy routes load on first visit (P-2): Settings, Usage, the Library (its viewer and previews come with it) and
// the Trace window are the biggest source files after Chats, which Today's first send needs anyway. Today and the
// rest stay in the entry chunk.
// After `vite:preloadError` is handled (see below) Vite's preload helper resolves the import with undefined, not the
// module. Picking a component from that would throw into the ErrorBoundary for the moment before the reload lands, so a
// missing module returns a promise that never settles: the Suspense fallback stays up until the reload.
function lazyRoute<M, C extends ComponentType>(load: () => Promise<M>, pick: (m: M) => C) {
  return lazy(async () => {
    const m = await load()
    return m === undefined ? new Promise<never>(() => {}) : { default: pick(m) }
  })
}
const Library = lazyRoute(() => import('./screens/Library'), m => m.Library)
const Usage = lazyRoute(() => import('./screens/Usage'), m => m.Usage)
const Settings = lazyRoute(() => import('./screens/Settings'), m => m.Settings)
const TraceWindow = lazyRoute(() => import('./overlays/TraceWindow'), m => m.TraceWindow)

/** A trace window whose chunk can't load closes and says so, instead of taking the app down. */
class TraceBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() { return { failed: true } }
  componentDidCatch(error: unknown) {
    console.error('Inhouse: the trace window crashed and was closed.', error instanceof Error ? error.message : error, error)
    useUi.getState().patch({ traceId: null })
    useUi.getState().showToast("Couldn't open the trace. Reload and try again.", { icon: 'info', key: 'trace-error' })
  }
  render() { return this.state.failed ? null : this.props.children }
}

const SCREENS: Record<Page, React.ComponentType> = {
  today: Today, library: Library, chats: Chats, approvals: Approvals, routines: Routines, activity: Activity,
  apps: Tools, app: ToolPage, skills: Skills, usage: Usage, settings: Settings,
}

// A tab left open across a deploy (or a rollback) asks for a chunk the new build no longer has. Vite fires
// `vite:preloadError`: reload once so the tab gets the current index.html and its chunks. The saved session (drafts,
// chats) is in localStorage and flushed on pagehide (state/store.ts), so a reload keeps it, and the hash keeps the route.
// The stamp stops a loop: a second failure within 30 s is left to throw into the ErrorBoundary.
const RELOAD_KEY = 'inhouse.preload-reload'
// Set right before the reload: a later failure in this same document (a CSS dependency, then the module) must not reach the ErrorBoundary.
let reloading = false
window.addEventListener('vite:preloadError', e => {
  if (reloading) { e.preventDefault(); return }
  // Offline, a reload would only show the browser's error page: let the failure reach the ErrorBoundary.
  if (!navigator.onLine) return
  let last = 0
  try { last = Number(sessionStorage.getItem(RELOAD_KEY)) || 0 }
  catch (err) { console.warn('Inhouse: could not read the reload stamp, not reloading.', err); return }
  if (Date.now() - last < 30_000) return
  try { sessionStorage.setItem(RELOAD_KEY, String(Date.now())) }
  catch (err) { console.warn('Inhouse: could not write the reload stamp, not reloading.', err); return }
  e.preventDefault()
  reloading = true
  location.reload()
})

/** What a lazy page shows while its chunk loads: the Library's loading look (skeleton blocks, a hidden status line). */
function PageFallback() {
  // The live region is on screen first and its text arrives a moment later, so a screen reader announces it.
  const [text, setText] = useState('')
  useEffect(() => { const t = setTimeout(() => setText('Loading'), 50); return () => clearTimeout(t) }, [])
  return (
    <PageBox width="wide" role="status">
      <span className="sr-only">{text}</span>
      <Skeleton className="h-9 w-44 animate-none rounded-sm bg-fill-hover" />
      <Skeleton className="mt-4 h-4 w-80 max-w-full animate-none rounded-sm" />
      <Skeleton className="mt-7 h-40 animate-none rounded-2xl" />
    </PageBox>
  )
}

/** The page's h1 (or main, for a page without one) takes focus on a route change, not on first load. Rendered inside the page's Suspense, so a lazy page is in the DOM first. */
let shownSlug: string | null = null
function RouteFocus({ slug }: { slug: string }) {
  // `slug` names the page plus what a click inside the page changes into another page (a tool, the phone's settings menu);
  // a chat id, a settings tab or a Library file is not part of it.
  useEffect(() => {
    const prev = shownSlug
    shownSlug = slug
    if (prev === null || prev === slug) return
    const main = document.getElementById('main')
    if (!main || main.contains(document.activeElement)) return // the page already put focus somewhere (the composer)
    const target = main.querySelector<HTMLElement>('h1') ?? main
    target.tabIndex = -1
    target.classList.add('outline-none')
    target.focus({ preventScroll: true })
  }, [slug])
  return null
}

/** A tool's or channel's name, or undefined for a key that is neither (a stale or typed link). */
const toolName = (t: ToolsData, k: string) => t.channels.find(c => c.key === k)?.name ?? (Object.hasOwn(t.details, k) ? t.details[k].name : undefined)

// ---------- hash routes: #/today, #/tools/shopify, #/settings/team-memory, #/chats/all, #/chats/<id> ----------
// On a phone, #/settings alone is the settings menu, so Back from a settings page returns to it.
const PAGE_SLUG: Record<Page, string> = { today: 'today', library: 'library', chats: 'chats', approvals: 'approvals', routines: 'routines', activity: 'activity', apps: 'tools', app: 'tools', skills: 'skills', usage: 'usage', settings: 'settings' }
const toHash = (page: Page, appKey: string, setTab: string, chat: string, menu = false) =>
  '#/' + PAGE_SLUG[page] + (page === 'app' ? '/' + appKey : page === 'settings' ? (menu ? '' : '/' + setTab) : page === 'chats' ? '/' + encodeURIComponent(chat) : '')
const SETTINGS_TABS = MENU.flatMap(g => g.items.map(([k]) => k))
const PAGE_LABEL: Record<Page, string> = { today: 'Today', library: 'Library', chats: 'Chats', approvals: 'Approvals', routines: 'Routines', activity: 'Activity', apps: 'Tools', app: 'Tools', skills: 'Skills', usage: 'Usage', settings: 'Settings' }
/** A link that names a page, tool or tab that doesn't exist lands where it did before, and says so. */
const notFound = (where: string) => useUi.getState().showToast(`That page doesn't exist. You're on ${where}.`, { icon: 'info', key: 'route-notice' })
const SETTINGS_DEFAULT = 'you-general'
/** A settings tab's label: MENU items are [key, icon, label]. */
const settingsLabel = (tab: string) => MENU.flatMap(g => g.items).find(([k]) => k === tab)?.[2] ?? 'Settings'
/** The hash names something (as opposed to an empty hash). */
const hasSlug = (hash: string) => hash.startsWith('#/') && !!hash.slice(2).split('/')[0]
/** `chat` is `all` (See all), `new` (a chat with nothing asked yet) or a chat id. */
type Route = Partial<{ page: Page; appKey: string; setTab: string; chat: string; setMenu: boolean }>
/** A chat id as written in the hash: percent-encoded, like Copy link's URL. A malformed escape is read as typed, and names no chat. */
function chatIdFrom(raw: string | undefined): string | undefined {
  if (!raw) return raw
  try { return decodeURIComponent(raw) } catch { return raw }
}

/**
 * A route for the hash, or null for no hash or an unknown page. It reads no agent data, so it can run
 * before the first render. Unknown tools and tabs are caught at render (see `useHashRoute` and `App`).
 */
function fromHash(hash: string): Route | null {
  // Routes are "#/page". A plain anchor ("#main", the skip link's, opened in a new tab) names no page.
  if (!hash.startsWith('#/')) return null
  const [slug, rawSub] = hash.replace(/^#\/?/, '').split('/')
  if (!slug) return null
  const sub = slug === 'chats' ? chatIdFrom(rawSub) : rawSub
  if (slug === 'tools') return sub ? { page: 'app', appKey: sub } : { page: 'apps' }
  if (slug === 'settings') return sub ? { page: 'settings', setTab: sub, setMenu: false } : { page: 'settings', setMenu: true }
  if (slug === 'chats') return sub ? { page: 'chats', chat: sub } : { page: 'chats' }
  const page = (Object.keys(PAGE_SLUG) as Page[]).find(p => PAGE_SLUG[p] === slug)
  return page ? { page } : null
}

/** Put a route into the UI state. `#/chats` and a chat id that doesn't exist open the newest chat (see `useHashRoute`). */
function applyRoute(r: Route, first: boolean) {
  const ui = useUi.getState()
  const { chat, ...rest } = r
  if (r.page !== 'chats') { ui.patch({ ...rest, ...(first ? {} : { openId: null, pop: null, sideOpen: false, traceId: null, editing: null }) }); return }
  // The first route goes through the same actions as a later one, so a chat's saved additions come out of the stash.
  if (!first) ui.patch({ traceId: null, editing: null })
  if (chat === 'all') ui.openChatList()
  else if (chat === 'new') { if (!(ui.page === 'chats' && ui.fresh && !ui.chatList)) ui.newChat() }
  else {
    const id = chat ?? defaultChatId(agent.read())
    if (id === null) ui.newChat() // no chats at all
    else ui.openChat(id) // the open chat just shows
  }
}

// Apply a deep link before the first render.
const initialRoute = fromHash(location.hash)
if (initialRoute) applyRoute(initialRoute, true)
/** The first link named a page that doesn't exist: App says so once it has mounted. */
const bootUnknownPage = !initialRoute && hasSlug(location.hash)

function useHashRoute() {
  const page = useUi(s => s.page)
  const appKey = useUi(s => s.appKey)
  const setTab = useUi(s => s.setTab)
  const chatId = useUi(s => s.chatId)
  const chatList = useUi(s => s.chatList)
  const fresh = useUi(s => s.fresh)
  const started = useUi(s => s.started)
  // Only a phone shows the settings menu on its own; desktop always shows a page.
  const phone = useUi(s => s.phone)
  const setMenu = useUi(s => s.setMenu)
  const menu = phone && setMenu
  const data = useAgentData()
  const agentState = useAgentState()
  const openKey = openChatKey({ fresh, chatId }, data)
  const chatKey = chatList ? 'all' : openKey ?? 'new'
  // Unknown also covers a deleted chat, and the newest sample chat (`#/chats`) once it was deleted.
  const chatUnknown = page === 'chats' && !chatList && openKey !== null && !chatEntries(data, started, agentState).some(c => c.id === openKey)
  const fallbackChat = newestChat(data, started, agentState)?.id ?? null
  const chatIsNew = started.some(c => c.id === chatKey)
  useEffect(() => {
    const apply = () => {
      const r = fromHash(location.hash)
      const ui = useUi.getState()
      if (r) { applyRoute(r, false); return }
      const named = hasSlug(location.hash)
      history.replaceState(null, '', toHash(ui.page, ui.appKey, ui.setTab, ui.chatList ? 'all' : openChatKey(ui, agent.read()) ?? 'new', ui.phone && ui.setMenu))
      if (named) notFound(ui.page === 'app' ? toolName(agent.read().tools, ui.appKey) ?? 'Tools' : ui.page === 'settings' ? settingsLabel(ui.setTab) : PAGE_LABEL[ui.page])
    }
    window.addEventListener('hashchange', apply)
    return () => window.removeEventListener('hashchange', apply)
  }, [])
  // A chat id that doesn't exist (a stale or typed link, a deleted chat, or a chat from before a reload) opens the newest
  // chat left, or a new chat when every chat was deleted, replacing the entry.
  useEffect(() => {
    if (chatUnknown) {
      // Said only for a link that named the chat, not for `#/chats` once the newest chat was deleted, nor for a chat
      // that exists but isn't in this scenario (First day or Loading picked from the demo switches).
      const named = fromHash(location.hash)?.chat
      if (named && named !== 'all' && named !== 'new' && (!agent.allChatIds().includes(named) || agent.getSnapshot().chatDeleted[named])) useUi.getState().showToast("That chat isn't available. It may have been deleted.", { icon: 'info', key: 'route-notice' })
      history.replaceState(null, '', toHash('chats', appKey, setTab, fallbackChat ?? 'new'))
      if (fallbackChat) useUi.getState().openChat(fallbackChat) // restores what was added to it, if anything
      else useUi.getState().newChat()
    }
  }, [chatUnknown, appKey, setTab, fallbackChat])
  useEffect(() => {
    // An unknown tool or settings tab (a stale or typed link) is replaced in place, so it adds no history entry.
    if (page === 'app' && !toolName(data.tools, appKey)) {
      history.replaceState(null, '', toHash('apps', appKey, setTab, chatKey))
      useUi.getState().patch({ page: 'apps' })
      notFound('Tools')
      return
    }
    if (page === 'settings' && !SETTINGS_TABS.includes(setTab)) {
      history.replaceState(null, '', toHash('settings', appKey, SETTINGS_DEFAULT, chatKey))
      useUi.getState().patch({ setTab: SETTINGS_DEFAULT })
      notFound(settingsLabel(SETTINGS_DEFAULT))
      return
    }
    if (chatUnknown) return // replaced above
    const h = toHash(page, appKey, setTab, chatKey, menu)
    // An open Library file keeps its own link (#/library/<id>, see screens/library/route.ts).
    if (location.hash === h || (page === 'library' && location.hash.startsWith(`${h}/`))) return
    // A hash that only needs tidying (none, unknown, no tab) replaces the entry. A real move adds one.
    // So does a new chat getting its id when the first question is asked: Back skips the empty chat.
    const cur = fromHash(location.hash)
    // On a phone the settings menu and a settings page are two entries; desktop tidies #/settings into its page.
    const sameMenu = !(page === 'settings' && phone) || (cur?.setMenu ?? menu) === menu
    const tidy = !cur || (cur.page === page && (cur.appKey ?? appKey) === appKey && (cur.setTab ?? setTab) === setTab && (cur.chat ?? chatKey) === chatKey && sameMenu)
      || (page === 'chats' && cur.page === 'chats' && cur.chat === 'new' && chatIsNew)
    // A settings page opened from the phone menu remembers it, so its Back button can step back instead of adding an entry.
    if (takeReplaceEntry() || tidy) history.replaceState(history.state, '', h)
    else history.pushState(phone && page === 'settings' && !menu && cur?.page === 'settings' && cur.setMenu ? FROM_SETTINGS_MENU : null, '', h)
  }, [page, appKey, setTab, data.tools, chatKey, chatUnknown, chatIsNew, menu, phone])
}

export default function App() {
  const page = useUi(s => s.page)
  const appKey = useUi(s => s.appKey)
  const toolKnown = !!toolName(useAgentData().tools, appKey)
  const phone = useUi(s => s.phone)
  const chatList = useUi(s => s.chatList)
  const traceId = useUi(s => s.traceId)
  const chatId = useUi(s => s.chatId)
  const fresh = useUi(s => s.fresh)
  const mainRef = useRef<HTMLElement>(null)
  const setTab = useUi(s => s.setTab)
  const setMenu = useUi(s => s.setMenu)
  const tools = useAgentData().tools
  useHashRoute()

  // On load: a crash's "Message the team" (ErrorBoundary) opens Report a bug with a line about it, and a link to a page
  // that doesn't exist says so.
  useEffect(() => {
    let crash: string | null = null
    try { crash = sessionStorage.getItem(CRASH_KEY); sessionStorage.removeItem(CRASH_KEY) }
    catch (e) { console.warn('Inhouse: could not read the crash note.', e) }
    if (crash !== null) useUi.getState().openTeam('bug', crash)
    if (bootUnknownPage) notFound(PAGE_LABEL[useUi.getState().page])
  }, [])

  // Esc closes any panel, window or menu.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') useUi.getState().closeOverlays() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // A file dropped outside a drop target is ignored, so the browser never leaves the app to open it (on any page).
  // The Composer takes its own drops and Settings' photo input its own picks; neither depends on this.
  useEffect(() => {
    const files = (e: DragEvent) => !!e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files')
    const stop = (e: DragEvent) => { if (files(e)) e.preventDefault() }
    window.addEventListener('dragover', stop)
    window.addEventListener('drop', stop)
    return () => { window.removeEventListener('dragover', stop); window.removeEventListener('drop', stop) }
  }, [])

  // Phone layout at 760 px and below: sidebar becomes a drawer.
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 760px)')
    const on = () => {
      const { pop, patch } = useUi.getState()
      // The account menu opens from the drawer, so it goes with it.
      patch({ phone: mq.matches, sideOpen: false, ...(pop === 'me' ? { pop: null } : {}) })
    }
    on()
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])

  useEffect(() => { mainRef.current?.scrollTo({ top: 0 }) }, [page])

  // The tab's title names the page ("Usage · Inhouse"), a tool or a settings page by its own name.
  // Settings pages read "<Page> · Settings · Inhouse". A layout effect runs before RouteFocus's effect, so the title is
  // already the new page's when its h1 takes focus.
  const label = page === 'app' ? toolName(tools, appKey) ?? 'Tools' : page === 'settings' ? (phone && setMenu ? 'Settings' : `${settingsLabel(setTab)} · Settings`) : PAGE_LABEL[page]
  useLayoutEffect(() => { document.title = `${label} · Inhouse` }, [label])
  const focusKey = PAGE_SLUG[page] + (page === 'app' ? (toolKnown ? `/${appKey}` : '') : page === 'settings' && phone ? (setMenu ? '/menu' : '/page') : '')

  // An unknown tool key shows the Tools list until `useHashRoute` has moved the route there.
  const Screen = page === 'app' && !toolKnown ? Tools : SCREENS[page]
  const subKey = page === 'app' ? appKey : page === 'settings' ? setTab : page === 'chats' ? (chatList ? 'all' : fresh ? 'new' : chatId ?? '') : ''
  return (
    // `isolation` here (not on main) keeps the dots layer (zIndex -1) above the page colour and below the cards, while modals inside main still stack above the Sidebar.
    <div className="isolate flex h-dvh overflow-hidden bg-background">
      {/* First in the tab order: past the sidebar to the page (L18). An anchor's own jump would change the hash route. */}
      <a href="#main" onClick={e => { e.preventDefault(); mainRef.current?.focus() }}
        className="fixed top-2.5 left-2.5 z-dev rounded-lg bg-primary px-3.5 py-2 text-sm font-strong text-primary-foreground not-focus:sr-only">
        Skip to content
      </a>
      <Sidebar />
      <div className="relative flex min-w-0 flex-1 flex-col">
        {/* Dots only on Today and inside a chat; the All chats list uses the plain page background like Tools and Skills. */}
        {(page === 'today' || (page === 'chats' && !chatList)) && <DotsBackground />}
        {/* The top bar is the banner landmark: a header outside main, so it stays put while main scrolls. */}
        <div className="flex-none"><TopBar /></div>
        <main id="main" ref={mainRef} tabIndex={-1} className="relative flex min-h-0 flex-1 flex-col overflow-auto outline-none">
          <div className="flex-none"><Banner /></div>
          {/* Chats, and on desktop Settings and the Library, fill what is left under the banner and scroll inside (their side menus stay put); other pages scroll in main. */}
          <div className={cn(page === 'chats' || (!phone && (page === 'settings' || page === 'library')) ? 'flex min-h-0 flex-1 basis-0 flex-col' : 'flex-none')}>
            {/* Keyed by page; the sub-key (tool, chat, settings tab) resets it too, so moving away clears an error screen.
                It sits outside Suspense, so a lazy screen that fails to load shows this screen's error, not the app's. */}
            <RouteBoundary key={page} resetKey={subKey} name={PAGE_LABEL[page]}>
              <Suspense fallback={<PageFallback />}>
                <Screen />
                <RouteFocus slug={focusKey} />
              </Suspense>
            </RouteBoundary>
          </div>
        </main>
      </div>
      <ProblemPanel />
      {traceId && <TraceBoundary><Suspense fallback={null}><TraceWindow /></Suspense></TraceBoundary>}
      <TeamWindow />
      <HelpWindow />
      <CommandPalette />
      <Toasts />
      <DevSwitcher />
      <GooDefs />
    </div>
  )
}
