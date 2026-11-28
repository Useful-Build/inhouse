import { Component, Suspense, lazy, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ComponentType, ReactNode } from 'react'
import { agent, demo } from './agent'
import { isChatUnknown } from './state/chat-known'
import { AgentError } from './agent/types'
import type { AgentErrorCode, RefreshList } from './agent/types'
import { NOT_FOUND } from '../shared/contract/error-codes'
import type { Page } from './state/store'
import { FROM_SETTINGS_MENU, chatEntries, defaultChatId, newestChat, openChatKey, skillBySlug, takeReplaceEntry, useAgentData, useAgentState, useUi } from './state/store'
import { Sidebar } from './shell/Sidebar'
import { Banner, TopBar } from './shell/TopBar'
import { Toasts } from './shell/Toasts'
import { NotConnected } from './shell/NotConnected'
import { SignedOut } from './shell/SignedOut'
import { StartError } from './shell/StartError'
import { startScreen } from './shell/start-screen'
import type { StartScreen } from './shell/start-screen'
import { createHashSync } from './shell/route-sync'
import { hashBar, leaveSignInReturn } from './shell/hash-bar'
import { parseConnectReturn } from './screens/tools/connect-return'
import { toolName, toolRoute } from './shell/tool-route'
import { CRASH_KEY, RouteBoundary } from './ErrorBoundary'
import { reportError } from './report-error'
import { DevSwitcher } from './shell/DevSwitcher'
import { cn } from '@/lib/utils'
import { Skeleton } from '@/components/ui/skeleton'
import { GooDefs, Page as PageBox, SkyspaceBackground } from './ui'
import { Today } from './screens/Today'
import { Chats } from './screens/Chats'
import { useChatIsBlank } from './screens/chat/open-messages'
import { SETTINGS_PAGES, settingsTabs } from './screens/settings/menu'
import { useShortcuts } from './shell/shortcuts'

/**
 * Loads a heavy route on first use. After `vite:preloadError` is handled (see below) Vite's preload helper resolves the
 * import with undefined, not the module. Picking a component from that would throw into the screen's error boundary for
 * the moment before the reload lands, so a missing module returns a promise that never settles: the Suspense fallback
 * stays up until the reload.
 */
function lazyRoute<M, C extends ComponentType>(load: () => Promise<M>, pick: (m: M) => C) {
  return lazy(async () => {
    const m = await load()
    return m === undefined ? new Promise<never>(() => {}) : { default: pick(m) }
  })
}
// The heavy routes load on first visit (P-2): Settings, Usage, the Library (its viewer and previews come with it) and
// the Trace window are the biggest source files after Chats, which Today's first send needs anyway. Approvals, Routines,
// Activity, Tools (and its tool page) and Skills load on first visit too (P3 ship, to keep Today's first load under its
// budget: build-support/entry-without-zod.test.ts pins them). Only Today and Chats stay in the entry chunk.
const Approvals = lazyRoute(() => import('./screens/Approvals'), m => m.Approvals)
const Routines = lazyRoute(() => import('./screens/Routines'), m => m.Routines)
const Activity = lazyRoute(() => import('./screens/Activity'), m => m.Activity)
const Tools = lazyRoute(() => import('./screens/Tools'), m => m.Tools)
const ToolPage = lazyRoute(() => import('./screens/Tools'), m => m.ToolPage)
const Skills = lazyRoute(() => import('./screens/Skills'), m => m.Skills)
const SkillPage = lazyRoute(() => import('./screens/Skills'), m => m.SkillPage)
// Once the shell has painted and the browser is idle, these five load in the background, so a first visit finds its chunk
// already there (the skeleton shows only on a slow link). Library, Usage and Settings stay on first visit: they are the big ones.
const PREFETCH: (() => Promise<unknown>)[] = [
  () => import('./screens/Approvals'), () => import('./screens/Routines'), () => import('./screens/Activity'), () => import('./screens/Tools'), () => import('./screens/Skills'),
  () => import('./overlays/ProblemPanel'), () => import('./overlays/TeamWindow'), () => import('./overlays/CommandPalette'),
]
const Library = lazyRoute(() => import('./screens/Library'), m => m.Library)
const Usage = lazyRoute(() => import('./screens/Usage'), m => m.Usage)
const Settings = lazyRoute(() => import('./screens/Settings'), m => m.Settings)
const NotOnTeam = lazyRoute(() => import('./shell/NotOnTeam'), m => m.NotOnTeam)
const InhouseAccount = lazyRoute(() => import('./shell/InhouseAccount'), m => m.InhouseAccount)
const TraceWindow = lazyRoute(() => import('./overlays/TraceWindow'), m => m.TraceWindow)
// The problem window and the team window open only on a click, so they load then (or with the idle prefetch above), not with Today.
const ProblemPanel = lazyRoute(() => import('./overlays/ProblemPanel'), m => m.ProblemPanel)
const TeamWindow = lazyRoute(() => import('./overlays/TeamWindow'), m => m.TeamWindow)
// Help loads when first opened too: Today doesn't need it (first-load budget, check-bundle).
const HelpWindow = lazyRoute(() => import('./overlays/HelpWindow'), m => m.HelpWindow)
// The command palette (cmdk and its list) loads when ⌘K or Search first opens it, or with the idle prefetch: Today's first
// paint doesn't need it (check-bundle). Its shortcuts stay in the shell (shell/shortcuts.ts), so ⌘K works before it loads.
const CommandPalette = lazyRoute(() => import('./overlays/CommandPalette'), m => m.CommandPalette)

/** True from the first render where `on` is: a lazy overlay stays mounted once it has opened, so its own state lives on as it did when it loaded with the page. */
function useOpenedOnce(on: boolean) {
  const [opened, setOpened] = useState(on)
  if (on && !opened) setOpened(true)
  return opened || on
}

/** A lazy window (the trace, a problem, the team window) whose chunk can't load closes and says so, instead of taking the app down. */
class OverlayBoundary extends Component<{ children: ReactNode; name: string; what: string; open: boolean; close: () => void }, { failed: boolean; wasOpen: boolean }> {
  state = { failed: false, wasOpen: this.props.open }
  static getDerivedStateFromError() { return { failed: true } }
  // The next open tries again (a window that stays mounted keeps its boundary). Only an open clears the failure, not the
  // close that follows it: rendering a lazy window whose chunk failed while it is closed would throw again in the same pass.
  static getDerivedStateFromProps(props: { open: boolean }, state: { failed: boolean; wasOpen: boolean }) {
    if (props.open === state.wasOpen) return null
    return { wasOpen: props.open, failed: props.open ? false : state.failed }
  }
  componentDidCatch(error: unknown) {
    console.error(`Inhouse: the ${this.props.name} window crashed and was closed.`, error instanceof Error ? error.message : error, error)
    reportError('boundary', error)
    this.props.close()
    useUi.getState().showToast(`Couldn't open ${this.props.what}. Reload and try again.`, { icon: 'info', key: `${this.props.name}-error` })
  }
  render() { return this.state.failed ? null : this.props.children }
}
const closeTrace = () => useUi.getState().patch({ traceId: null })
const closeProblem = () => useUi.getState().closeProblem()
const closeTeam = () => useUi.getState().patch({ pop: null })
const closeHelp = closeTeam
const closePalette = () => useUi.getState().patch({ palette: false })

const SCREENS: Record<Page, React.ComponentType> = {
  today: Today, library: Library, chats: Chats, approvals: Approvals, routines: Routines, activity: Activity,
  apps: Tools, app: ToolPage, skills: Skills, skill: SkillPage, usage: Usage, settings: Settings,
}

// A tab left open across a deploy (or a rollback) asks for a chunk the new build no longer has. Vite fires
// `vite:preloadError`: reload once so the tab gets the current index.html and its chunks. The saved session (drafts,
// chats) is in localStorage and flushed on pagehide (state/store.ts), so a reload keeps it, and the hash keeps the route.
// The stamp stops a loop: a second failure within 30 s is left to throw into the screen's error boundary (RouteBoundary), which offers Reload.
const RELOAD_KEY = 'inhouse.preload-reload'
// Set right before the reload: a later failure in this same document (a CSS dependency, then the module) must not reach the screen's error boundary.
let reloading = false
window.addEventListener('vite:preloadError', e => {
  if (reloading) { e.preventDefault(); return }
  // Offline, a reload would only show the browser's error page: let the failure reach the screen's error boundary (its Reload waits for the person, who can see they're offline).
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
    <PageBox width="wide" role="status" data-page-loading>
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


// ---------- hash routes: #/today, #/tools/shopify, #/skills/morning-check, #/settings/team-memory, #/chats/all, #/chats/<id> ----------
// On a phone, #/settings alone is the settings menu, so Back from a settings page returns to it.
const PAGE_SLUG: Record<Page, string> = { today: 'today', library: 'library', chats: 'chats', approvals: 'approvals', routines: 'routines', activity: 'activity', apps: 'tools', app: 'tools', skills: 'skills', skill: 'skills', usage: 'usage', settings: 'settings' }
const toHash = (page: Page, appKey: string, setTab: string, chat: string, menu = false, skill = '') =>
  '#/' + PAGE_SLUG[page] + (page === 'app' ? '/' + appKey : page === 'skill' ? '/' + skill : page === 'settings' ? (menu ? '' : '/' + setTab) : page === 'chats' ? '/' + encodeURIComponent(chat) : '')
/** The pages a `#/settings/<id>` link may name: the product has no "Who approves what" or "Run limits", so a link to one lands on General. */
const SETTINGS_TABS = settingsTabs(demo === null)
/** The list each page shows that the agent's work fills (read again when the page opens). */
const PAGE_LIST: Partial<Record<Page, RefreshList>> = { today: 'problems', approvals: 'problems', library: 'library', activity: 'activity', skills: 'skills', skill: 'skills' }
const PAGE_LABEL: Record<Page, string> = { today: 'Today', library: 'Library', chats: 'Chats', approvals: 'Approvals', routines: 'Routines', activity: 'Activity', apps: 'Tools', app: 'Tools', skills: 'Skills', skill: 'Skills', usage: 'Usage', settings: 'Settings' }
/** A link that names a page, tool or tab that doesn't exist lands where it did before, and says so. */
const notFound = (where: string) => useUi.getState().showToast(`That page doesn't exist. You're on ${where}.`, { icon: 'info', key: 'route-notice' })
const SETTINGS_DEFAULT = 'you-general'
/** A settings tab's label. */
const settingsLabel = (tab: string) => SETTINGS_PAGES.find(p => p.id === tab)?.label ?? 'Settings'
/** The hash names something (as opposed to an empty hash). */
const hasSlug = (hash: string) => hash.startsWith('#/') && !!hash.slice(2).split('/')[0]
/** `chat` is `all` (See all), `new` (a chat with nothing asked yet) or a chat id. */
type Route = Partial<{ page: Page; appKey: string; skillKey: string; setTab: string; chat: string; setMenu: boolean }>
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
  if (slug === 'skills') return sub ? { page: 'skill', skillKey: sub } : { page: 'skills' }
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
// The sign-in at a tool sends the browser back to /tools/<tool>?connected=1 (or ?connect_error=<code>): open that tool, say what
// happened from a closed list of lines, and drop the query from the address.
const connectReturn = parseConnectReturn(location.pathname, location.search)
// The return's own route wins over any hash in the same address: one consistent place, and the hash is rewritten to it.
const initialRoute: Route | null = connectReturn ? (connectReturn.key ? { page: 'app', appKey: connectReturn.key } : { page: 'apps' }) : fromHash(location.hash)
if (initialRoute) applyRoute(initialRoute, true)
if (connectReturn) {
  leaveSignInReturn(connectReturn.key ? `#/tools/${connectReturn.key}` : '#/tools')
  hashBar.adopt()
  useUi.getState().showToast(connectReturn.text, connectReturn.ok ? { key: 'connect-return' } : { icon: 'error', key: 'connect-return' })
}
/** The first link named a page that doesn't exist: App says so once it has mounted. */
const bootUnknownPage = !initialRoute && hasSlug(location.hash)

const hashSync = createHashSync(hashBar, {
  toHash: p => toHash(p.page as Page, p.appKey, p.setTab, p.chatKey, p.menu, p.skillKey), fromHash, takeReplaceEntry, fromMenuState: FROM_SETTINGS_MENU,
})

function useHashRoute() {
  const page = useUi(s => s.page)
  const appKey = useUi(s => s.appKey)
  const skillKey = useUi(s => s.skillKey)
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
  const ids = chatEntries(data, started, agentState).map(c => c.id)
  // The list is one page: a chat it lacks may be an older one. Route 24 is asked about it once (found: it joins the list;
  // a 404 or a deleted chat: it is unknown), and a failed ask (offline) judges nothing.
  const [looked, setLooked] = useState<Record<string, true>>({})
  const listReady = !demo && data.resources.chat.status === 'ready'
  const needsLook = listReady && page === 'chats' && !chatList && openKey !== null && !ids.includes(openKey) && !looked[openKey]
  useEffect(() => {
    if (!needsLook || openKey === null) return
    const done = () => setLooked(l => ({ ...l, [openKey]: true }))
    agent.getChat(openKey).then(done, (e: unknown) => { if (e instanceof AgentError && e.code === NOT_FOUND) done() })
  }, [needsLook, openKey])
  const chatUnknown = isChatUnknown({ page, chatList, openKey, ids, serverList: demo ? null : data.resources.chat.status, looked: openKey !== null && looked[openKey] === true })
  const fallbackChat = newestChat(data, started, agentState)?.id ?? null
  const chatIsNew = started.some(c => c.id === chatKey)
  const skillKnown = !!skillBySlug(data, agentState, skillKey)
  const skillsStatus = data.resources.skills.status
  useEffect(() => {
    const apply = () => {
      const r = fromHash(location.hash)
      const ui = useUi.getState()
      hashBar.adopt()
      if (r) { applyRoute(r, false); return }
      const named = hasSlug(location.hash)
      hashBar.replace(toHash(ui.page, ui.appKey, ui.setTab, ui.chatList ? 'all' : openChatKey(ui, agent.read()) ?? 'new', ui.phone && ui.setMenu, ui.skillKey))
      if (named) notFound(ui.page === 'app' ? toolName(agent.read().tools, ui.appKey) ?? 'Tools' : ui.page === 'settings' ? settingsLabel(ui.setTab) : PAGE_LABEL[ui.page])
    }
    window.addEventListener('hashchange', apply)
    // A hash changed before this listener existed (a link or Back while the loading screen showed, before the shell
    // mounted) has had its event already: read it now. Like the event, after this commit's effects, so the sync effect
    // below leaves that hash alone instead of putting the first route back.
    const missed = location.hash !== hashBar.written() ? setTimeout(apply) : undefined
    return () => { clearTimeout(missed); window.removeEventListener('hashchange', apply) }
  }, [])
  // A chat id that doesn't exist (a stale or typed link, a deleted chat, or a chat from before a reload) opens the newest
  // chat left, or a new chat when every chat was deleted, replacing the entry.
  useEffect(() => {
    if (chatUnknown) {
      // Said only for a link that named the chat, not for `#/chats` once the newest chat was deleted, nor for a chat
      // that exists but isn't in this scenario (First day or Loading picked from the demo switches).
      const named = fromHash(location.hash)?.chat
      if (named && named !== 'all' && named !== 'new' && (!agent.allChatIds().includes(named) || agent.getSnapshot().chatDeleted[named])) useUi.getState().showToast("That chat isn't available. It may have been deleted.", { icon: 'info', key: 'route-notice' })
      hashBar.replace(toHash('chats', appKey, setTab, fallbackChat ?? 'new'))
      if (fallbackChat) useUi.getState().openChat(fallbackChat) // restores what was added to it, if anything
      else useUi.getState().newChat()
    }
  }, [chatUnknown, appKey, setTab, fallbackChat])
  useEffect(() => {
    // An unknown tool or settings tab (a stale or typed link) is replaced in place, so it adds no history entry.
    // Not before the tools read has answered: a link to a tool (the sign-in's return among them) is judged on what the
    // server says, not on the empty list the app starts with.
    if (page === 'app' && toolRoute(data.tools, appKey, data.resources.tools.status) === 'unknown') {
      hashBar.replace(toHash('apps', appKey, setTab, chatKey))
      useUi.getState().patch({ page: 'apps' })
      notFound('Tools')
      return
    }
    // An unknown skill likewise, once the skills themselves have loaded (the product reads them after the first paint,
    // and the app as a whole can be ready while they're still on their way).
    if (page === 'skill' && !skillKnown && skillsStatus !== 'loading') {
      hashBar.replace(toHash('skills', appKey, setTab, chatKey))
      useUi.getState().patch({ page: 'skills' })
      notFound('Skills')
      return
    }
    if (page === 'settings' && !SETTINGS_TABS.includes(setTab)) {
      hashBar.replace(toHash('settings', appKey, SETTINGS_DEFAULT, chatKey))
      useUi.getState().patch({ setTab: SETTINGS_DEFAULT })
      notFound(settingsLabel(SETTINGS_DEFAULT))
      return
    }
    if (chatUnknown) return // replaced above
    // The hash follows the app unless someone else just set one (see shell/route-sync.ts).
    hashSync.sync({ page, appKey, skillKey, setTab, chatKey, menu, phone, chatIsNew, defaultChat: defaultChatId(data) })
  }, [page, appKey, skillKey, skillKnown, skillsStatus, data.status, setTab, data.tools, data.resources.tools.status, chatKey, chatUnknown, chatIsNew, menu, phone])
}

function Shell() {
  useShortcuts()
  useEffect(() => {
    const go = () => { for (const load of PREFETCH) load().catch(() => {}) }
    if (typeof requestIdleCallback === 'function') { const id = requestIdleCallback(go, { timeout: 4000 }); return () => cancelIdleCallback(id) }
    const t = setTimeout(go, 2000)
    return () => clearTimeout(t)
  }, [])
  const page = useUi(s => s.page)
  // The demo's "View as": the screen starts again under the other view, so every list it read is read as that person.
  const viewAs = useUi(s => s.viewAs)
  // A list page reads its list again when it opens, and the bell its notices: what the agent made since the first read
  // (a file a chat saved, the cards a Run now found) isn't in it. Not the page the app starts on: the first reads cover it,
  // and for the Inhouse team landing there isn't a choice (each read under a grant writes a support.access line). The
  // client never reads the bell for the Inhouse team.
  // Compared with the start page, not "has this effect run": StrictMode runs it twice on mount in development.
  const startPage = useRef(page)
  const moved = useRef(false)
  useEffect(() => {
    if (!moved.current && page === startPage.current) return
    moved.current = true
    const list = PAGE_LIST[page]
    if (list) void agent.refresh(list)
    void agent.refresh('notifications')
  }, [page])
  const appKey = useUi(s => s.appKey)
  const shellData = useAgentData()
  const route = toolRoute(shellData.tools, appKey, shellData.resources.tools.status)
  const toolKnown = route === 'known'
  const skillKey = useUi(s => s.skillKey)
  const skill = skillBySlug(shellData, useAgentState(), skillKey)
  const phone = useUi(s => s.phone)
  const sideCollapsed = useUi(s => s.sideCollapsed)
  const chatList = useUi(s => s.chatList)
  const traceId = useUi(s => s.traceId)
  const problemOpen = useUi(s => s.openId) !== null
  const teamOpen = useUi(s => s.pop) === 'team'
  const helpOpen = useUi(s => s.pop) === 'help'
  const problemOpened = useOpenedOnce(problemOpen)
  const teamOpened = useOpenedOnce(teamOpen)
  const paletteOpen = useUi(s => s.palette)
  const paletteOpened = useOpenedOnce(paletteOpen)
  const chatId = useUi(s => s.chatId)
  const fresh = useUi(s => s.fresh)
  const chatBlank = useChatIsBlank()
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
  const label = page === 'app' ? toolName(tools, appKey) ?? 'Tools' : page === 'skill' ? skill?.n ?? 'Skills' : page === 'settings' ? (phone && setMenu ? 'Settings' : `${settingsLabel(SETTINGS_TABS.includes(setTab) ? setTab : SETTINGS_DEFAULT)} · Settings`) : PAGE_LABEL[page]
  useLayoutEffect(() => { document.title = `${label} · Inhouse` }, [label])
  const focusKey = PAGE_SLUG[page] + (page === 'app' ? (toolKnown ? `/${appKey}` : '') : page === 'skill' ? (skill ? `/${skillKey}` : '') : page === 'settings' && phone && setMenu ? '/menu' : '')

  // An unknown tool key shows the Tools list until `useHashRoute` has moved the route there.
  // While the tools are still being read, the tool page itself says so (it knows nothing of the key yet).
  const Screen = page === 'app' && route === 'unknown' ? Tools : page === 'skill' && !skill ? Skills : SCREENS[page]
  const subKey = page === 'app' ? appKey : page === 'skill' ? skillKey : page === 'settings' ? setTab : page === 'chats' ? (chatList ? 'all' : fresh ? 'new' : chatId ?? '') : ''
  // Full-shell Turrell Skyspace behind both the sidebar and main: hero on Today and blank New chat, softly quieted in an active chat, off on other pages.
  const skyspace = page === 'today' || (page === 'chats' && !chatList && chatBlank) ? 'hero' : page === 'chats' && !chatList ? 'subtle' : null
  const skyspaceOffset = phone ? 'none' : sideCollapsed ? 'rail' : 'full'
  return (
    // `isolation` here (not on main) keeps the Skyspace layer (zIndex -1) above the page colour and behind the sidebar and cards, while modals inside main still stack above the Sidebar.
    <div className="relative isolate flex h-dvh overflow-hidden bg-background">
      {skyspace && <SkyspaceBackground mode={skyspace} offset={skyspaceOffset} />}
      {/* First in the tab order: past the sidebar to the page (L18). An anchor's own jump would change the hash route. */}
      <a href="#main" onClick={e => { e.preventDefault(); mainRef.current?.focus() }}
        className="fixed top-2.5 left-2.5 z-dev rounded-lg bg-primary px-3.5 py-2 text-sm font-strong text-primary-foreground not-focus:sr-only">
        Skip to content
      </a>
      <Sidebar />
      {/* On desktop one hairline stands between the sidebar and the page (side-rule), and the top bar keeps the same 8px of air above it as the sidebar's head, so the mark and the page's title share a line. */}
      <div className={cn('relative flex min-w-0 flex-1 flex-col', !phone && 'side-rule pt-2')}>
        {/* The top bar is the banner landmark: a header outside main, so it stays put while main scrolls. */}
        <div className="flex-none"><TopBar /></div>
        <main id="main" ref={mainRef} tabIndex={-1} className="relative flex min-h-0 flex-1 flex-col overflow-auto outline-none">
          <div className="flex-none"><Banner /></div>
          {/* Chats, and on desktop Settings and the Library, fill what is left under the banner and scroll inside (their side menus stay put); other pages scroll in main. */}
          <div className={cn(page === 'chats' || (!phone && (page === 'settings' || page === 'library')) ? 'flex min-h-0 flex-1 basis-0 flex-col' : 'flex-none')}>
            {/* Keyed by page; the sub-key (tool, chat, settings tab) resets it too, so moving away clears an error screen.
                It sits outside Suspense, so a lazy screen that fails to load shows this screen's error, not the app's. */}
            <RouteBoundary key={`${page}|${viewAs}`} resetKey={subKey} name={PAGE_LABEL[page]}>
              <Suspense fallback={<PageFallback />}>
                <Screen />
                <RouteFocus slug={focusKey} />
              </Suspense>
            </RouteBoundary>
          </div>
        </main>
      </div>
      {problemOpened && <OverlayBoundary name="problem" what="this problem" open={problemOpen} close={closeProblem}><Suspense fallback={null}><ProblemPanel /></Suspense></OverlayBoundary>}
      {traceId && <OverlayBoundary name="trace" what="the trace" open close={closeTrace}><Suspense fallback={null}><TraceWindow /></Suspense></OverlayBoundary>}
      {teamOpened && <OverlayBoundary name="team" what="your Inhouse team" open={teamOpen} close={closeTeam}><Suspense fallback={null}><TeamWindow /></Suspense></OverlayBoundary>}
      {helpOpen && <OverlayBoundary name="help" what="help" open close={closeHelp}><Suspense fallback={null}><HelpWindow /></Suspense></OverlayBoundary>}
      {paletteOpened && <OverlayBoundary name="palette" what="search" open={paletteOpen} close={closePalette}><Suspense fallback={null}><CommandPalette /></Suspense></OverlayBoundary>}
      <Toasts />
      <DevSwitcher />
      <GooDefs />
    </div>
  )
}

/**
 * The product build shows one screen in place of the pages until its first read (`meta`) is in (start-screen.ts): a neutral
 * loading screen while it loads, "You're not on this team", "This is an Inhouse team account", the signed-out screen, or the load error with Retry. The
 * demo has `demo` set and never shows them.
 */
export default function App() {
  const data = useAgentData()
  const screen = demo === null ? startScreen(data) : 'app'
  // Retry sets `meta` loading again: the load error stays up while it reads, with the last error's words and Retry
  // disabled, rather than flashing back to the initial loading screen.
  const [last, setLast] = useState<{ screen: StartScreen; error?: AgentErrorCode }>({ screen })
  const retrying = screen === 'not-connected' && last.screen === 'load-error'
  const shown = retrying ? 'load-error' : screen
  const error = retrying ? last.error : data.resources.meta.error
  if (shown !== last.screen || error !== last.error) setLast({ screen: shown, error })
  if (shown === 'not-on-team') return <Suspense fallback={null}><NotOnTeam /></Suspense>
  if (shown === 'inhouse-account') return <Suspense fallback={null}><InhouseAccount /></Suspense>
  if (shown === 'signed-out') return <SignedOut />
  if (shown === 'load-error') return <StartError error={error} retrying={retrying} />
  if (shown === 'not-connected') return <NotConnected />
  return <Shell />
}
