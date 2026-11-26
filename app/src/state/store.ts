// UI state and the actions screens call. Domain state lives in the agent
// (the client behind src/agent/index.ts); this store holds navigation, overlays, composer and chat UI.
import { useMemo, useSyncExternalStore } from 'react'
import { create } from 'zustand'
import { agent, demo as demoControls, now } from '../agent'
import type { AgentData, AgentState, Attachment, ChatMessage, Instant, LibraryFile, MessagePart, RunFrame, Scenario, SetAsideReason, SkillDef, Stage } from '../agent/types'
import { AgentError, SCENARIOS, STAGES, stageIndex } from '../agent/types'
import { NOT_FOUND, REASON } from '../../shared/contract/error-codes'
import type { ChatView } from '../screens/chat/view'
import { NO_MODEL_TEXT, RELOAD_NOTE, RUN_FAILED, STOPPED_NOTE, emptyView, upsert } from '../screens/chat/notes'
import { productStage } from './stage'
import { heldFile, dropFile, withoutPending } from './pending-files'
import type { AbortSet } from '../screens/chat/upload'
import { shownClock, shownDateTimeIn, shownTimeOn } from '../agent/upgrade-times'
import { instantOf } from '../lib/format'
import { STARTED_CHAT_PREFIX } from './chatIds'
import { clearRevealed } from '../screens/chat/reveal'
import { rememberTrigger } from '../ui/dialogs'
import { activeMode, problemById } from './derive'
import type { Ctx } from './derive'

export type Page = 'today' | 'library' | 'chats' | 'approvals' | 'routines' | 'activity' | 'apps' | 'app' | 'skills' | 'skill' | 'usage' | 'settings'
export type Pop = null | 'notif' | 'me' | 'team' | 'help'
export type RequestType = 'tool' | 'job' | 'change' | 'bug' | 'feedback'
export type Ambient = 'When Inhouse agent works' | 'Always' | 'Off'
export type ActivityFilter = 'all' | 'change' | 'needs'
export type UsageTab = 'person' | 'job' | 'model' | 'tool'
export type SkillTab = 'all' | 'team' | 'mine'
/** A skill's name as it shows in its page's link: "Morning check" is "morning-check". */
export const skillSlug = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'skill'
/**
 * Every skill's link, one per skill: the Inhouse team's skills first, then the team's own (made in a chat). A skill whose
 * name makes a slug already taken gets "-2", "-3" and so on, so a team-made "Reorder drafting" never opens the built-in one.
 */
export const skillSlugs = (data: { skills: SkillDef[] }, state: { skillsExtra: SkillDef[] }): Map<SkillDef, string> => {
  const out = new Map<SkillDef, string>()
  const taken = new Set<string>()
  for (const s of data.skills.concat(state.skillsExtra)) {
    const base = skillSlug(s.n)
    let slug = base
    for (let i = 2; taken.has(slug); i++) slug = `${base}-${i}`
    taken.add(slug)
    out.set(s, slug)
  }
  return out
}
/** The skill a page's slug names (`skillSlugs`). */
export const skillBySlug = (data: { skills: SkillDef[] }, state: { skillsExtra: SkillDef[] }, key: string): SkillDef | undefined => {
  for (const [s, slug] of skillSlugs(data, state)) if (slug === key) return s
  return undefined
}
export type TodaySort = 'default' | 'amount'
export type ApprovalSort = 'oldest' | 'newest' | 'stake'

/** A chat in the lists: one the person started in this session (listed in Recent chats and See all until Reset demo) or
 *  the agent's. `at` is when it was last active: the lists show it and group by its day. */
export interface ChatEntry { id: string; title: string; at: Instant; pinned?: boolean }

/** Every chat that wasn't deleted, newest first (the ones started here, then the agent's), with the person's titles. A chat
 *  started here that the agent lists too (the real client lists it once saved) is listed once, as the agent's. */
const liveChats = (data: AgentData, started: ChatEntry[], st: AgentState): ChatEntry[] => {
  const agents = new Set(data.chat.chats.map(c => c.id))
  return [...started.filter(c => !agents.has(c.id)), ...data.chat.chats].filter(c => !st.chatDeleted[c.id])
    .map(c => ({ id: c.id, title: st.chatTitles[c.id] ?? c.title, at: c.at, pinned: !!st.chatPinned[c.id] }))
}

/** The chat list the sidebar, See all and the top bar read: deleted chats hidden, pinned ones first, then newest first. */
export const chatEntries = (data: AgentData, started: ChatEntry[], st: AgentState): ChatEntry[] => {
  const all = liveChats(data, started, st)
  return [...all.filter(c => c.pinned), ...all.filter(c => !c.pinned)]
}

/** The newest chat that wasn't deleted, pinned or not. Undefined when every chat was deleted. */
export const newestChat = (data: AgentData, started: ChatEntry[], st: AgentState): ChatEntry | undefined => liveChats(data, started, st)[0]

/**
 * One toast in the stack. `ms` is how long it shows (Toasts.tsx counts it down, pausing on hover and focus). `key` names
 * it, so a toast with the same key replaces it in place. `holds` are approvals going out: the toast has no timer and
 * leaves once every one went out (or was taken back), on Undo or on close.
 */
export interface Toast { id: number; text: string; icon: string; undo?: () => void; ms: number; key?: string; holds?: string[] }
interface ToastOpts { undo?: () => void; ms?: number; icon?: string; key?: string; holds?: string[] }

/** A chat that is answering: the agent's run id once it started, the thinking line, the ask that owns it, and the
 *  messages sent into it that wait for their turn (`turn.started` shows each with its quote and files). */
interface ChatRun { runId: string | null; /** The turn being answered, once it starts: what Stop ends. */ turnId: string | null; text: string; token: number; sent: QueuedMsg[]; /** Stop was pressed while the send was still on its way. */ stopAsked?: true }
/** A message typed while its chat was answering: it waits above the composer until the answer ends, or goes now (H8).
 *  `paused`: Stop (or a reload) stopped the answer it waited for, so it goes only by Send now (D). */
export interface QueuedMsg { id: string; text: string; quote?: string; atts?: Attachment[]; model: string | null; paused?: true }
/** Editing a question already sent (M11): it goes in place of the question and its answer. `saved` is what the composer
 *  held before, put back on cancel and after sending. */
export interface EditingMsg { chatId: string; id: string; hide: string[]; saved: { text: string; atts: Attachment[]; replyTo: string | null } }
/** What the person added to a chat in this session: messages, and seeded or earlier messages they deleted. */
interface ChatAdds { extras: ChatMessage[]; hidden: Record<string, true> }
export type LibraryView = 'masonry' | 'grid' | 'list'

/** The agent's newest chat, the one a plain `#/chats` opens before any chat was picked. Null when it has none (day one). */
export const defaultChatId = (data: AgentData): string | null => data.chat.chats.at(0)?.id ?? null

/** The chat whose messages are in `extras`: the open one, null for a new chat (or when there are no chats at all). */
export const openChatKey = (s: Pick<UiState, 'fresh' | 'chatId'>, data: AgentData): string | null =>
  s.fresh ? null : s.chatId ?? defaultChatId(data)

/** The open chat's run, or undefined when it isn't answering (a new chat, or no chat at all, never is). */
export const openRun = (s: Pick<UiState, 'fresh' | 'chatId' | 'runs'>): ChatRun | undefined => {
  const key = openChatKey(s, agent.read())
  return key === null ? undefined : own(s.runs, key)
}

/** A chat's stored messages in the order the agent stored them (by position), and where the page before them starts. */
export interface ChatHistory { messages: ChatMessage[]; next: string | null; state: 'loading' | 'ready' | 'error' }

export interface UiState {
  // demo switches (dev only)
  stage: Stage
  scenario: Scenario
  ambient: Ambient
  animateMark: boolean
  /** The demo switches panel is open. */
  demoOpen: boolean

  // navigation
  page: Page
  appKey: string
  /** The open skill's page (`skill`): the skill's slug, from `skillSlugs`. */
  skillKey: string
  setTab: string
  /** The review window. */
  openId: string | null
  /** The list the review window was opened from (Today's needs-you cards, Approvals' waiting drafts): what "1 of N" steps through. */
  queue: string[]
  pop: Pop
  team: { type: RequestType; title: string; text: string; shot: boolean }
  /** Team requests the person withdrew this session (`teamRequestKey`): there's no withdraw route on main yet (P6a), so it lives here. */
  teamWithdrawn: string[]
  traceId: string | null
  /** The toast stack, oldest first. */
  toasts: Toast[]
  phone: boolean
  sideOpen: boolean

  // drafts in the panel
  editing: string | null

  // composer
  todayDraft: string
  chatDraft: string
  atts: Attachment[]
  /** Chosen model id, or null for the agent data's default. */
  modelSel: string | null
  toolOff: Record<string, boolean>

  // chat
  /** The open chat, or null for the newest one. */
  chatId: string | null
  /** Showing the list of all chats instead of a conversation. */
  chatList: boolean
  fresh: boolean
  extras: ChatMessage[]
  hidden: Record<string, true>
  /** Chats started in this session, newest first. */
  started: ChatEntry[]
  /** What was added to chats the person left, by chat id, for when they come back. */
  stash: Record<string, { extras: ChatMessage[]; hidden: Record<string, true> }>
  replyTo: string | null
  /** Every chat that is answering, by chat id. Several may answer at once; leaving a chat doesn't stop its answer.
   *  The open chat's run is `openRun(state)`. */
  runs: Record<string, ChatRun>
  /** What each chat's run events built (queued turns, notices, a damaged session). Not saved: a reload attaches again. */
  views: Record<string, ChatView>
  /** What the agent holds of a chat's past (`getChat`), by chat id: read when a chat that has no seed turns opens. Not saved. */
  history: Record<string, ChatHistory>
  /** Messages waiting for a chat's answer to end, by chat id, oldest first. Saved (D7): after a reload they wait paused. */
  queued: Record<string, QueuedMsg[]>
  /** The question being edited in the composer, or null. */
  editMsg: EditingMsg | null
  /** The Library's view, kept across a reload. */
  libraryView: LibraryView

  // page filters
  actFilter: ActivityFilter
  usageTab: UsageTab
  /** Index into the usage months, 0 being this month. */
  usageMonth: number
  skillTab: SkillTab
  todaySort: TodaySort

  // ---------- conversation ----------
  /** Thumbs up or down on an answer, by the id of the turn's first answer message (stable while it streams). Kept for the session, cleared by Reset demo. */
  feedback: Record<string, 'up' | 'down'>
  approvalSort: ApprovalSort
  /** Phone: Settings shows its menu alone, not the selected page. Desktop shows both and ignores it. */
  setMenu: boolean

  // ---------- navigation (PR 5) ----------
  /** The command palette (⌘K) is open. */
  palette: boolean
  /** Desktop: the sidebar is the icon rail. A UI preference saved per browser; the phone drawer ignores it. */
  sideCollapsed: boolean
}

export interface UiActions {
  /** Shallow update for simple UI fields. */
  patch(p: Partial<UiState>): void
  go(page: Page, extra?: Partial<UiState>): void
  openTool(key: string): void
  /** A skill's page, by the skill's name. */
  /** Opens a skill's page by its link slug (`skillSlugs`). */
  openSkill(key: string): void
  openSettings(tab: string): void
  /** Opens the review window. `queue` is the list it was opened from, in its order, for stepping. */
  openProblem(id: string, queue?: string[]): void
  /** Moves the open review window to another problem in its queue. */
  stepProblem(id: string): void
  closeProblem(): void
  openPop(pop: Pop): void
  openTeam(type: RequestType, text?: string): void
  closeOverlays(): void
  /** Adds a toast to the stack and returns its id. */
  showToast(text: string, opts?: ToastOpts): number
  /** Removes one toast, by id or key. */
  dismissToast(idOrKey: number | string): void
  /** The Undo button: runs the toast's undo, then removes that toast. */
  runToastUndo(id: number): void
  /** For an undo closure: removes the toast whose Undo is running. Does nothing outside an Undo; never clears the stack. */
  clearToast(): void
  openTrace(id: string): void
  newChat(prefill?: string): void
  /** Open one of the chats in the sidebar or in See all. */
  openChat(id: string): void
  /** See all: the list of every chat. */
  openChatList(): void
  /** `replacesRun`: the run whose answer this replaces (Regenerate, Try again), so the agent doesn't make its routine or skill twice.
   *  `fromComposer`: the open composer's Send, which sends its quote and files and clears it. Any other ask (a suggestion,
   *  Try again) sends only its own `quote` and `atts` and leaves the composer's draft, files and quote as they are. */
  ask(question: string, opts?: { replacesRun?: string; fromComposer?: boolean; quote?: string; atts?: Attachment[] }): Promise<void>
  /** Stops one chat's answer (the open chat's by default) and notes it in that chat. */
  stopRun(chatId?: string): void
  /** Try again on a failed answer: a failed send goes again under its own key (once, however often it reached the agent); a failed turn is asked as a new question that replaces its run, with its quote and files. */
  retryAnswer(lineId: string, trace: string, question: string): void
  /** The open composer's message waits for the open chat's answer to end (H8). */
  queueMessage(): void
  /** A waiting message goes now: the answer stops (a note says so) and this one is answered in the same run. */
  sendQueuedNow(id: string): void
  /** Takes a waiting message out of the open chat's queue and returns it (Remove, or Edit putting it back). */
  unqueue(id: string): QueuedMsg | undefined
  /** Edit of a sent question: its text, quote and files go in the composer, which shows "Editing" until sent or cancelled. */
  startEdit(m: Extract<ChatMessage, { role: 'user' }>, hide: string[]): void
  /** Leaves editing: the composer gets back what it held before. */
  cancelEdit(): void
  /** Sends the edited question in place of the old one and its answer. */
  sendEdit(): void
  /** Deletes messages from a chat, with Undo that works from any chat. */
  deleteMessages(chatId: string, ids: string[]): void
  /** Resolves with null once approved, or with why it wasn't (the agent's notice also says so); it never rejects. */
  approve(id: string): Promise<string | null>
  unapprove(id: string): void
  undoHandled(id: string): void
  togglePause(): void
  setDemo(p: Partial<Pick<UiState, 'stage' | 'scenario' | 'ambient' | 'animateMark'>>): void
  resetDemo(): void

  /** Approve several drafts at once; the toast's Undo takes back every one that hasn't gone out. */
  approveMany(ids: string[]): void
  /** Snooze, dismiss or don't send a problem, with Undo in the toast. */
  setAside(id: string, reason: SetAsideReason): void
  /** Settings from the account menu: on a phone the menu shows first, on desktop this tab. */
  openSettingsMenu(tab: string): void
  // ---------- managing chats ----------
  /** Empty keeps the old title; the chat's own title clears the person's. */
  renameChat(id: string, title: string): void
  pinChat(id: string, pinned: boolean): void
  /** Copies the chat's full URL. */
  copyChatLink(id: string): void
  /** Asks the composer to open its model menu (a switched-off model's failed answer offers it). */
  openModelMenu(): void
  /** Reads a chat's history (the newest page, or with `more` the page before what is shown). A chat with seed turns has none to read. */
  loadHistory(chatId: string, more?: boolean): void
  /** The recovery for a chat whose session is damaged: the history stays and the next message starts fresh. */
  resetSession(chatId: string): void
  /** Deletes with an Undo toast. Deleting the open chat opens the newest one left, or a new chat. */
  deleteChats(ids: string[]): void
  // ---------- navigation (PR 5) ----------
  /** Desktop: collapse the sidebar to its icon rail, or expand it. Saved per browser. */
  toggleSidebar(): void

  // ---------- conversation ----------
  /**
   * Asks a question again in place of its answer: the question and answer (`hideIds`) are hidden and the question is
   * asked anew at the end of the chat, with its quote and attachments. The composer's draft, reply and attachments stay.
   */
  regenerate(hideIds: string[], question: { text: string; quote?: string; atts?: Attachment[] }): void
  /** Thumbs up or down on an answer; the same rating again clears it. Down also opens "Report a wrong answer". */
  rateAnswer(id: string, rating: 'up' | 'down', answerText: string): void
}

const DEMO_KEY = 'inhouse.demo.switches.v1'
const AMBIENTS: Ambient[] = ['When Inhouse agent works', 'Always', 'Off']
type DemoSwitches = Pick<UiState, 'stage' | 'scenario' | 'ambient' | 'animateMark'>
/** Where a clean demo starts, and where Reset demo puts the stage and scenario back. */
const DEFAULT_DEMO: DemoSwitches = { stage: 'Act', scenario: 'Normal', ambient: 'Always', animateMark: true }
const saveDemo = (d: DemoSwitches) => {
  try { localStorage.setItem(DEMO_KEY, JSON.stringify(d)) }
  catch (e) { console.warn('Inhouse demo: could not save switches.', e) }
}
/** Saved switches, keeping only values the app knows. */
const loadDemo = (): DemoSwitches => {
  const d = DEFAULT_DEMO
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(DEMO_KEY) ?? '{}')
    if (typeof raw !== 'object' || raw === null) return d
    const r = raw as Record<string, unknown>
    return {
      stage: STAGES.find(x => x === r.stage) ?? d.stage,
      scenario: SCENARIOS.find(x => x === r.scenario) ?? d.scenario,
      // Earlier versions saved this switch as 'When Ava works' and then 'When agent works'.
      ambient: AMBIENTS.find(x => x === (r.ambient === 'When Ava works' || r.ambient === 'When agent works' ? 'When Inhouse agent works' : r.ambient)) ?? d.ambient,
      animateMark: typeof r.animateMark === 'boolean' ? r.animateMark : d.animateMark,
    }
  } catch (e) { console.warn('Inhouse demo: could not read switches.', e); return d }
}

// ---------- navigation (PR 5) ----------
const SIDEBAR_KEY = 'inhouse.ui.sidebar.v1'
/** The saved sidebar choice: collapsed or not. Blocked storage means expanded. */
const loadSideCollapsed = (): boolean => {
  try { return localStorage.getItem(SIDEBAR_KEY) === 'collapsed' } catch { return false }
}

let toastSeq = 0
/** Set while the store is made: the restored session gained reload notes, so it is saved once the store exists. */
let saveAfterSetup = false
/** The toast whose Undo is running, so `clearToast()` in an undo closure removes that toast and nothing else. */
let undoing: number | null = null
const MAX_TOASTS = 4
const TOO_LATE = 'Too late to undo. It already went out.'
/** The key of the one toast for approvals going out: each new held approval joins it, so the stack stays capped. */
const HELD = 'held'
/** Every approval the held toast's Undo takes back (approved together or one after another while it showed). */
let heldIds: string[] = []
/** The held toast's text: how many it approved and how many of those are still waiting to go out. */
const heldText = (approved: number, waiting: number) => approved === 1 && waiting === 1
  ? 'Approved. It goes out in 10 seconds.'
  : `Approved ${approved} drafts. ${waiting === approved ? 'They go' : waiting === 1 ? '1 goes' : `${waiting} go`} out in 10 seconds.`
/** Unique per page load, so ids made after a reload (chats, messages) never take an older one's. */
const chatSession = Date.now().toString(36)
let msgSeq = 0
const msgId = () => `m-${chatSession}-${++msgSeq}`
/** A turn id the agent made (its answers carry it as their trace), as opposed to a recorded trace key on a seeded answer. */
const TURN_ID = /^t_/
let chatSeq = 0
/** Now on the client entry's clock: the demo clock in the demo, the real clock in the product (agent/index.ts). */
const demoTime = () => new Date(now())
/** A write the agent took back: it already told the person with a notice, so the console gets the detail. */
const logFailure = (what: string) => (e: unknown) => { console.warn(`Inhouse: ${what}.`, e) }
/** A started chat's title: the question when it's short, else its first words cut at a word break (L8). */
const TITLE_MAX = 40
const shortTitle = (text: string): string => {
  const t = text.trim().replace(/\s+/g, ' ')
  if (t.length <= TITLE_MAX) return t || 'New chat'
  let out = ''
  for (const w of t.split(' ')) { const next = out ? `${out} ${w}` : w; if (next.length > TITLE_MAX - 1) break; out = next }
  // A first word longer than the cap is cut; a title never ends on a little word or a stop.
  if (!out) out = t.slice(0, TITLE_MAX - 1)
  out = out.replace(/(\s+(a|an|the|and|or|of|for|to|in|on|by|with|from|at|my|our|is|are))+$/i, '').replace(/[\s,.;:!?-]+$/, '')
  return out + '…'
}
/** A chat started now, titled from its first words. */
const startedChat = (text: string): ChatEntry =>
  ({ id: `${STARTED_CHAT_PREFIX}${chatSession}-${++chatSeq}`, title: shortTitle(text), at: instantOf(demoTime().getTime()) })
/** The notes a stopped answer leaves: Retry asks its question again. */
export const isStoppedNote = (m: ChatMessage): boolean => m.role === 'event' && (m.text === STOPPED_NOTE || m.text === RELOAD_NOTE)

/**
 * The open chat's additions, filed under its id, so opening another chat and coming back keeps them. A new chat isn't kept.
 * Invariant: a chat's additions live in exactly one place, `extras`/`hidden` while it is open, else `stash[id]`. So every
 * action that changes the open chat moves them in the same `set` that changes `chatId` (see `withOpen`).
 */
const stashed = (s: UiState): UiState['stash'] => {
  const id = openChatKey(s, agent.read())
  return id === null ? s.stash : { ...s.stash, [id]: { extras: s.extras, hidden: s.hidden } }
}
/** Opening chat `id`: the old open chat's additions go to the stash, and `id`'s come out of it. */
const withOpen = (s: UiState, id: string): Pick<UiState, 'stash' | 'extras' | 'hidden' | 'chatId' | 'fresh'> => {
  const all = stashed(s)
  const back = own(all, id)
  return { stash: without(all, id), chatId: id, fresh: false, extras: back?.extras ?? [], hidden: back?.hidden ?? {} }
}
/** A record's own entry: a chat id from the hash (`constructor`) never reads the object's prototype. */
const own = <T,>(o: Record<string, T>, key: string): T | undefined => (Object.hasOwn(o, key) ? o[key] : undefined)
const without = <T,>(o: Record<string, T>, key: string): Record<string, T> => { const { [key]: _gone, ...rest } = o; return rest }
const hideIds = (h: Record<string, true>, ids: string[]) => ({ ...h, ...Object.fromEntries(ids.map(k => [k, true as const])) })
const unhideIds = (h: Record<string, true>, ids: string[]) => { const n = { ...h }; ids.forEach(k => { delete n[k] }); return n }

// ---------- composer drafts (PR 4) ----------
// Each composer keeps its own text and files: Today, and every chat by id. The open one lives in todayDraft,
// chatDraft and atts (what the screens and ask() read); the others wait in `drafts` until their composer opens again.
// A new chat isn't kept, like its messages (see stashed()).

export interface ComposerDraft { text: string; atts: Attachment[] }

// Declaration merging adds these to UiState and UiActions above.
export interface UiState {
  /** The drafts of the composers that aren't open, by composerKey(). */
  drafts: Record<string, ComposerDraft>
  /** Bumped to ask the open composer to take focus (setComposerText with focus). */
  composerFocus: number
  /** Bumped to ask the chat's composer to open its model menu. */
  modelMenuAsk: number
}
export interface UiActions {
  /** Puts text into the open composer (Today's, or the open chat's), replacing its draft. `focus` focuses it, caret at the end. */
  setComposerText(text: string, opts?: { focus?: boolean }): void
}

/** Which composer is open: 'today', a chat's id, or null (a new chat, the list of chats, or a page without one). */
const composerKey = (s: UiState): string | null =>
  s.page === 'today' ? 'today' : s.page === 'chats' && !s.chatList ? openChatKey(s, agent.read()) : null

/** The drafts without the one under `key`. */
const dropDraft = (drafts: UiState['drafts'], key: string | null): UiState['drafts'] => {
  if (key === null || !Object.hasOwn(drafts, key)) return drafts
  const { [key]: _gone, ...rest } = drafts
  return rest
}

const composerActions = (set: (f: (s: UiState) => Partial<UiState>) => void): Pick<UiActions, 'setComposerText'> => ({
  setComposerText: (text, opts) => set(s => ({
    ...(s.page === 'today' ? { todayDraft: text } : { chatDraft: text }),
    composerFocus: opts?.focus ? s.composerFocus + 1 : s.composerFocus,
  })),
})
// ---------- end composer drafts ----------

// ---------- phase 1 memory (decision D7) ----------
// What the person was doing survives a reload until Reset demo: the chats they started, what they added to every chat,
// the composer drafts, the model pick, their thumbs and the Library view. Saved on change (debounced) and on pagehide.
// Runs aren't saved: a chat that was answering gets RELOAD_NOTE when the page loads again.

export const SESSION_KEY = 'inhouse.ui.session.v1'
interface SavedSession {
  started: ChatEntry[]
  /** Every chat's additions, the open one's too, by chat id. */
  chats: Record<string, ChatAdds>
  todayDraft: string
  /** The composers' drafts by composerKey(); 'today' holds only Today's files (its text is `todayDraft`). */
  drafts: Record<string, ComposerDraft>
  modelSel: string | null
  feedback: Record<string, 'up' | 'down'>
  libraryView: LibraryView
  /** The chats that were answering when this was saved. */
  answering: string[]
  /** Each chat's queued messages, the ones sent into its run first (a reload stops the run before it answers them). */
  queued: Record<string, QueuedMsg[]>
}

type Rec = Record<string, unknown>
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v)
const isStr = (v: unknown): v is string => typeof v === 'string'
const isAtt = (v: unknown): v is Attachment => isRec(v) && isStr(v.name) && isStr(v.meta) && isStr(v.icon)
const isAtts = (v: unknown): v is Attachment[] => Array.isArray(v) && v.every(isAtt)
const isRow = (r: unknown) => isRec(r) && ['order', 'age', 'why', 'value'].every(k => isStr(r[k]))
const isTable = (t: unknown) => isRec(t) && isStr(t.title) && isStr(t.summary) && (t.icon === undefined || isStr(t.icon))
  && Array.isArray(t.rows) && t.rows.every(isRow) && Array.isArray(t.sources) && t.sources.every(isStr)
const PART_OK: Record<MessagePart['type'], (p: Rec) => boolean> = {
  text: p => isStr(p.text),
  table: p => isTable(p.table),
  approval: p => isStr(p.problemId),
  routine: p => isRec(p.routine) && ['id', 'name', 'freq', 'day', 'note'].every(k => isStr((p.routine as Rec)[k])) && isClock((p.routine as Rec).time) && isInstant((p.routine as Rec).next),
  skill: p => isRec(p.skill) && ['name', 'desc', 'tools', 'mode'].every(k => isStr((p.skill as Rec)[k])),
  workRow: p => isStr(p.text) && isInstant(p.at),
  notInThisStage: p => isStr(p.text),
  error: p => isStr(p.text) && isStr(p.retryQuestion),
  suggestions: p => Array.isArray(p.questions) && p.questions.every(isStr),
  // Stage 1 (W0-A): no build makes this part yet (M2-H draws it).
  ask: p => isStr(p.actionId),
}
const isPart = (v: unknown): v is MessagePart => isRec(v) && Object.hasOwn(PART_OK, v.type as string) && PART_OK[v.type as MessagePart['type']](v)
const isMsg = (m: unknown): m is ChatMessage => {
  if (!isRec(m) || !isStr(m.id)) return false
  if (m.role === 'user') return isStr(m.text) && (m.quote === undefined || isStr(m.quote)) && (m.atts === undefined || isAtts(m.atts)) && (m.at === undefined || isInstant(m.at))
  if (m.role === 'event') return isStr(m.text)
  if (m.role === 'agent') return isStr(m.trace) && isPart(m.part) && (m.model === undefined || isStr(m.model)) && (m.at === undefined || isInstant(m.at))
  return false
}
const isInstant = (v: unknown): v is Instant => isRec(v) && isStr(v.iso) && typeof v.ms === 'number' && Date.parse(v.iso) === v.ms
const isClock = (v: unknown) => isRec(v) && Number.isInteger(v.hour) && Number.isInteger(v.minute)
/**
 * A message saved before C1 (P1), in today's shape: an answer's `at` was epoch ms, a routine card's time and next run and
 * a work row's time were saved as they showed ("7:00 AM", "Next run Tue, Nov 17 at 7:00 AM"), on the demo clock's day.
 * Anything else is returned as it is, for `isMsg` to judge.
 */
const upgradeMsg = (m: unknown): unknown => {
  if (!isRec(m) || m.role !== 'agent') return m
  const base = demoTime()
  let out: Rec = typeof m.at === 'number' && Number.isFinite(m.at) ? { ...m, at: instantOf(m.at) } : m
  const p = out.part
  if (isRec(p) && p.type === 'workRow' && isStr(p.time)) {
    const { time, ...rest } = p
    const at = shownTimeOn(time, base)
    if (at) out = { ...out, part: { ...rest, at } }
  }
  if (isRec(p) && p.type === 'routine' && isRec(p.routine) && isStr(p.routine.time) && isStr(p.routine.next)) {
    const time = shownClock(p.routine.time), next = shownDateTimeIn(p.routine.next, base)
    if (time && next) out = { ...out, part: { ...p, routine: { ...p.routine, time, next } } }
  }
  return out
}
const isQueued = (v: unknown): v is QueuedMsg => isRec(v) && isStr(v.id) && isStr(v.text) && (v.quote === undefined || isStr(v.quote))
  && (v.atts === undefined || isAtts(v.atts)) && (v.model === null || isStr(v.model))
const isAdds = (v: unknown): v is ChatAdds => isRec(v) && Array.isArray(v.extras) && isRec(v.hidden)
const LIBRARY_VIEWS: LibraryView[] = ['masonry', 'grid', 'list']

/** The saved session, keeping only known shapes and chats that exist. Null when nothing was saved. */
function loadSession(): SavedSession | null {
  let raw: unknown
  try { raw = JSON.parse(localStorage.getItem(SESSION_KEY) ?? 'null') }
  catch (e) { console.warn('Inhouse: could not read the saved session, starting fresh.', e); return null }
  if (!isRec(raw)) return null
  const started = (Array.isArray(raw.started) ? raw.started : [])
    .flatMap((c): ChatEntry[] => {
      if (!isRec(c) || !isStr(c.id) || !isStr(c.title) || !c.id.startsWith(STARTED_CHAT_PREFIX)) return []
      // Saved before C1 (P1): the time it showed ("8:00 AM"), started on the demo clock's day.
      const at = isInstant(c.at) ? c.at : isStr(c.at) ? shownTimeOn(c.at, demoTime()) : null
      return at ? [{ id: c.id, title: c.title, at }] : []
    })
  const data = agent.read()
  // Every chat the agent has in any scenario, not only the one showing: a reload on First day or Loading (no chats)
  // keeps what the person added to the sample chats for when they switch back.
  const known = new Set([...started.map(c => c.id), ...agent.allChatIds()])
  const exists = (id: string) => known.has(id)
  const chats: Record<string, ChatAdds> = {}
  for (const [id, c] of Object.entries(isRec(raw.chats) ? raw.chats : {})) {
    if (!exists(id) || !isAdds(c)) continue
    const extras = c.extras.map(upgradeMsg).filter(isMsg).map(m => (m.role === 'user' && m.atts ? { ...m, atts: withoutPending(m.atts) } : m))
    // A message it can't read (or convert from before C1) is dropped, and said so.
    if (extras.length < c.extras.length) console.warn(`Inhouse: dropped ${c.extras.length - extras.length} saved message(s) it could not read in chat ${id}.`)
    chats[id] = { extras, hidden: Object.fromEntries(Object.entries(c.hidden).filter(([, v]) => v === true)) as Record<string, true> }
  }
  const drafts: Record<string, ComposerDraft> = {}
  for (const [k, d] of Object.entries(isRec(raw.drafts) ? raw.drafts : {})) {
    if ((k === 'today' || exists(k)) && isRec(d) && isStr(d.text) && isAtts(d.atts)) drafts[k] = { text: d.text, atts: withoutPending(d.atts) }
  }
  return {
    started, chats, drafts,
    todayDraft: isStr(raw.todayDraft) ? raw.todayDraft : '',
    // The choice is the person's, kept in this browser like a draft. The product reads its models after the app starts, so with none
    // known yet the saved id can't be checked and is kept; `activeMode` falls back to the default for one the team can't use, and
    // a send names the mode it resolved, never the raw id.
    modelSel: isStr(raw.modelSel) && (data.models.length === 0 || data.models.some(m => m.id === raw.modelSel)) ? raw.modelSel : null,
    feedback: Object.fromEntries(Object.entries(isRec(raw.feedback) ? raw.feedback : {}).filter(([, v]) => v === 'up' || v === 'down')) as SavedSession['feedback'],
    libraryView: LIBRARY_VIEWS.find(v => v === raw.libraryView) ?? 'masonry',
    answering: (Array.isArray(raw.answering) ? raw.answering : []).filter((id): id is string => isStr(id) && exists(id)),
    queued: Object.fromEntries(Object.entries(isRec(raw.queued) ? raw.queued : {}).flatMap(([id, list]) => {
      const ok = exists(id) && Array.isArray(list) ? list.filter(isQueued) : []
      // A model the team can't use any more falls back to the default; the reload stopped the answer, so each waits paused.
      return ok.length ? [[id, ok.map(q => ({ id: q.id, text: q.text, quote: q.quote, atts: q.atts && withoutPending(q.atts), paused: true as const,
        model: q.model !== null && data.models.some(m => m.id === q.model) ? q.model : null }))]] : []
    })),
  }
}

/** The store's starting state from a saved session. The first chat to open (no id yet means the newest) gets its additions in `extras`. */
function restoreSession(saved: SavedSession | null): { ui: Partial<UiState>; started?: ChatEntry[]; noted?: boolean } {
  if (!saved) return { ui: {} }
  const chats = { ...saved.chats }
  for (const id of saved.answering) {
    const c = chats[id] ?? { extras: [], hidden: {} }
    chats[id] = { ...c, extras: [...c.extras, { id: msgId(), role: 'event', text: RELOAD_NOTE }] }
  }
  const open = openChatKey({ fresh: false, chatId: null }, agent.read())
  const here = open === null ? undefined : chats[open]
  const stash = open === null ? chats : without(chats, open)
  const { today, ...drafts } = saved.drafts
  return {
    started: saved.started,
    noted: saved.answering.length > 0,
    ui: {
      // The open chat by its id, so a scenario switch never moves the open chat under its saved additions.
      chatId: open, started: saved.started, stash, extras: here?.extras ?? [], hidden: here?.hidden ?? {},
      todayDraft: saved.todayDraft, atts: today?.atts ?? [], drafts,
      modelSel: saved.modelSel, feedback: saved.feedback, libraryView: saved.libraryView, queued: saved.queued,
    },
  }
}

/** What to save: every chat's additions (the open one's from `extras`) and the open composer's draft filed under its key. */
function sessionOf(s: UiState): SavedSession {
  const chats: Record<string, ChatAdds> = { ...s.stash }
  const open = openChatKey(s, agent.read())
  if (open !== null) chats[open] = { extras: s.extras, hidden: s.hidden }
  for (const [id, c] of Object.entries(chats)) if (!c.extras.length && !Object.keys(c.hidden).length) delete chats[id]
  const drafts = { ...s.drafts }
  const key = composerKey(s)
  if (key === 'today') { if (s.atts.length) drafts.today = { text: '', atts: s.atts } }
  else if (key !== null && (s.chatDraft || s.atts.length)) drafts[key] = { text: s.chatDraft, atts: s.atts }
  // A message sent into a run waits in the run until its turn starts: saved at the front of its chat's queue.
  const queued: Record<string, QueuedMsg[]> = {}
  for (const id of new Set([...Object.keys(s.runs), ...Object.keys(s.queued)])) {
    const list = [...(own(s.runs, id)?.sent ?? []), ...(own(s.queued, id) ?? [])]
    if (list.length) queued[id] = list
  }
  return { started: s.started, chats, todayDraft: s.todayDraft, drafts, modelSel: s.modelSel, feedback: s.feedback, libraryView: s.libraryView, answering: Object.keys(s.runs), queued }
}

let saveTimer: ReturnType<typeof setTimeout> | undefined
/** One notice per run of failed saves: it shows again only after a save worked. */
let saveFailed = false
function saveSession() {
  clearTimeout(saveTimer)
  saveTimer = undefined
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify(sessionOf(useUi.getState())))
    saveFailed = false
  } catch (e) {
    console.warn('Inhouse: could not save the session.', e)
    if (saveFailed) return
    saveFailed = true
    useUi.getState().showToast("Couldn't save your drafts and chats. Your browser storage is full.", { icon: 'error' })
  }
}
/** Reset demo: forget the saved session. The store's fresh state is saved again on its next change. */
function clearSession() {
  clearTimeout(saveTimer)
  saveTimer = undefined
  try { localStorage.removeItem(SESSION_KEY) } catch (e) { console.warn('Inhouse: could not clear the saved session.', e) }
}
// ---------- end phase 1 memory ----------

const initialUi = (): Omit<UiState, 'stage' | 'scenario' | 'ambient' | 'animateMark' | 'palette' | 'sideCollapsed'> => ({
  demoOpen: false, page: 'today', appKey: 'shopify', skillKey: '', setTab: 'you-general', openId: null, queue: [], pop: null,
  team: { type: 'tool', title: '', text: '', shot: true }, teamWithdrawn: [], traceId: null, toasts: [], phone: false, sideOpen: false,
  editing: null, todayDraft: '', chatDraft: '', atts: [], modelSel: null, toolOff: {},
  chatId: null, chatList: false, fresh: false, extras: [], hidden: {}, stash: {}, started: [], replyTo: null,
  runs: {}, views: {}, history: {}, queued: {}, editMsg: null, libraryView: 'masonry',
  actFilter: 'all', usageTab: 'person', usageMonth: 0, skillTab: 'all', todaySort: 'default',
  drafts: {}, composerFocus: 0, modelMenuAsk: 0,
  feedback: {},
  approvalSort: 'oldest',
  setMenu: false,
})

export const useUi = create<UiState & UiActions>()((set, get) => {
  // The demo's saved switches are the demo's alone. The product starts from the defaults and saves nothing: its stage comes
  // from the client's `stage` setting (`useCtx`, `./stage`), so `stage` here is a placeholder there, and so is `scenario`.
  const demo = demoControls ? loadDemo() : DEFAULT_DEMO
  demoControls?.setDemo({ stage: demo.stage, scenario: demo.scenario })
  const session = restoreSession(loadSession())
  // The reload note goes into the saved session once, not again on every reload until something else saves.
  saveAfterSetup = !!session.noted

  // ---------- toasts ----------
  const stack = (toasts: Toast[]): Pick<UiState, 'toasts'> => ({ toasts })
  const showToast: UiActions['showToast'] = (text, opts = {}) => {
    const t: Toast = { id: ++toastSeq, text, icon: opts.icon ?? 'check_circle', undo: opts.undo, ms: opts.ms ?? 7000, key: opts.key, holds: opts.holds }
    set(s => {
      const same = t.key === undefined ? -1 : s.toasts.findIndex(x => x.key === t.key)
      // The same key replaces that toast in place (a repeated "Saved", a second chat delete joining the first).
      if (same >= 0) return stack(s.toasts.map((x, i) => (i === same ? t : x)))
      // Over MAX_TOASTS the oldest toast without Undo leaves. A notice never pushes out a toast with Undo: over four
      // toasts that all have Undo it shows as one more. A new toast with Undo pushes out the oldest Undo toast that holds
      // nothing. A toast with `holds` leaves only when its approvals went out, on its Undo or on its close, never to
      // make room. (This replaces the design's "when all four have Undo, the oldest goes".)
      const list = [...s.toasts, t]
      while (list.length > MAX_TOASTS) {
        const older = list.slice(0, -1)
        let out = older.findIndex(x => !x.undo)
        if (out < 0 && t.undo) out = older.findIndex(x => !x.holds?.length)
        if (out < 0) break
        list.splice(out, 1)
      }
      return stack(list)
    })
    return t.id
  }
  const dismissToast: UiActions['dismissToast'] = idOrKey =>
    set(s => (s.toasts.some(x => x.id === idOrKey || x.key === idOrKey) ? stack(s.toasts.filter(x => x.id !== idOrKey && x.key !== idOrKey)) : {}))
  /** The held toast leaves once every approval it holds went out or was taken back; until then its count follows (same id). */
  const settleHolds = () => {
    const { approved, sent } = agent.getSnapshot()
    const waiting = (t: Toast) => t.holds?.filter(h => !sent[h] && approved[h]) ?? []
    // Also when an approval it counts but doesn't hold (a reversible draft, approved in the same tap) was taken back.
    const changed = (t: Toast) => !!t.holds?.length && (waiting(t).length !== t.holds.length || heldIds.some(id => !approved[id]))
    set(s => (s.toasts.some(changed) ? stack(s.toasts.flatMap(t => {
      if (!changed(t)) return [t]
      const holds = waiting(t)
      if (!holds.length) return []
      heldIds = heldIds.filter(id => approved[id])
      return [{ ...t, holds, text: heldText(heldIds.length, holds.length) }]
    })) : {}))
  }
  /**
   * Approvals going out join the one held toast (key HELD) instead of adding one each, so the stack has a hard cap.
   * `ids` are every approval this action made, `holds` those still waiting to go out. One Undo takes back all of them.
   */
  const showHeld = (ids: string[], holds: string[]) => {
    const current = get().toasts.find(t => t.key === HELD)
    heldIds = [...new Set([...(current ? heldIds : []), ...ids])]
    const all = [...new Set([...(current?.holds ?? []), ...holds])]
    const undo = () => {
      const { approved, sent } = agent.getSnapshot()
      for (const id of heldIds) if (approved[id] && !sent[id]) agent.undo(id).catch(logFailure('could not undo an approval'))
      settleHolds()
    }
    showToast(heldText(heldIds.length, all.length), { undo, icon: 'schedule_send', key: HELD, holds: all })
    settleHolds()
  }
  const clearToast = () => { if (undoing !== null) dismissToast(undoing) }

  // Another tab can send or take back a held approval: its toast leaves here too, since it has no timer of its own.
  agent.subscribe(settleHolds)
  agent.onNotice(n => {
    // A sent notice removes only the toasts whose holds all went out, then shows itself: it never replaces another toast.
    if (n.type === 'approval.sent') { settleHolds(); showToast(n.text, { ms: 4000 }) }
    // A stale save: the Settings screen follows with what the record is now, in this same toast (key `conflict`).
    else if (n.type === 'error') showToast(n.text, { icon: 'error', ...(n.code === 'conflict' ? { key: 'conflict' } : {}) })
    else showToast(n.text, { icon: 'info' })
  })

  let historyEpoch = 0
  // A support grant ended (close 4403): what the grant showed is dropped, the chats' messages and runs with it. The agent client
  // already dropped its own copy and detached every run.
  agent.onLink(state => {
    if (state !== 'grantEnded') return
    // A history read still on its way when the grant ended must not write what it read back.
    historyEpoch++
    set({ runs: {}, views: {}, history: {}, extras: [], hidden: {}, stash: {}, queued: {}, started: [] })
  })

  // ---------- runs ----------
  /** One writer for a chat's additions: `extras`/`hidden` when it is open, else its stash entry (see `stashed`). */
  const updateChat = (chatId: string, fn: (c: ChatAdds) => ChatAdds) => set(s => {
    if (openChatKey(s, agent.read()) === chatId) return fn({ extras: s.extras, hidden: s.hidden })
    return { stash: { ...s.stash, [chatId]: fn(own(s.stash, chatId) ?? { extras: [], hidden: {} }) } }
  })
  /** Adds a message, or replaces the one with its id where it stands (a stable id never doubles a message). */
  const addTo = (chatId: string, m: ChatMessage) => updateChat(chatId, c => ({ ...c, extras: upsert(c.extras, m) }))
  /** The agent's socket for each chat's run: one attach per chat at a time. */
  const attached = new Map<string, () => void>()
  const detachRun = (chatId: string) => { attached.get(chatId)?.(); attached.delete(chatId) }
  /** Tokens of runs that finished, and of runs dropped here while their send was still on its way: what a late send answer needs to know. */
  const ended = new Set<number>()
  const cancelledSends = new Set<number>()
  /** The upload of a send that is still putting its files on the server, by the send's token: Stop ends it. */
  const uploadAborts = new Map<number, AbortSet>()
  /** A message's id when it was first shown here (`local-…`) to the stable one the run gave it: Undo of a Regenerate looks it up. */
  const renamed = new Map<string, string>()
  /** Forgets a chat's run here: its later events are ignored (its token is gone). The agent's run goes on, or is ended by whatever asked. */
  const forgetRun = (chatId: string): ChatRun | undefined => {
    const r = own(get().runs, chatId)
    detachRun(chatId)
    if (r) {
      // A send still on its way: when its answer comes, the turn it made is stopped (nobody is following it).
      if (r.runId === null) cancelledSends.add(r.token)
      set(s => ({ runs: without(s.runs, chatId) }))
    }
    return r
  }
  /** Stops the answer being written now, that turn only: the messages waiting go on (plan S4). False when nothing was answering. */
  const stopLive = (chatId: string): boolean => {
    const r = own(get().runs, chatId)
    if (!r) return false
    // A send still on its way: it stops the moment its turn is known. A turn waiting on the budget has no live turn: the waiting one is stopped.
    const waiting = own(get().views, chatId)
    if (r.turnId) agent.stop(r.turnId).catch(logFailure('could not stop the answer'))
    else if (r.runId && waiting?.budgetWait && waiting.queued[0]) agent.stop(waiting.queued[0].turnId).catch(logFailure('could not stop the answer'))
    else if (!r.runId) { uploadAborts.get(r.token)?.abortAll(); set(s => { const cur = own(s.runs, chatId); return cur ? { runs: { ...s.runs, [chatId]: { ...cur, stopAsked: true } } } : {} }) }
    return true
  }
  const stopChat = stopLive
  /** A chat's run ends for good here (it was deleted, or its question was taken back): what waited in it goes back to the
   *  person's queue, paused, so none is lost, and `note` says the answer stopped (once). The agent cancels its own queue. */
  const parkRun = (chatId: string, note: boolean) => {
    const r = own(get().runs, chatId)
    if (!r) return
    if (r.sent.length) {
      const held = r.sent.map(q => ({ ...q, paused: true as const }))
      set(s => ({ queued: { ...s.queued, [chatId]: [...held, ...(own(s.queued, chatId) ?? [])] } }))
    }
    if (note) updateChat(chatId, c => { const last = c.extras.at(-1); return last && isStoppedNote(last) ? c : { ...c, extras: [...c.extras, { id: msgId(), role: 'event', text: STOPPED_NOTE }] } })
    forgetRun(chatId)
  }
  /** Ends the edit open in the composer: it gets back what it held before (only while that chat is open). */
  const restoreEdit = (focus: boolean) => {
    const e = get().editMsg
    if (!e) return
    set({ editMsg: null })
    if (openChatKey(get(), agent.read()) !== e.chatId) return
    set({ atts: e.saved.atts, replyTo: e.saved.replyTo })
    get().setComposerText(e.saved.text, { focus })
  }
  /** An ask starting in a chat (Regenerate, Retry, a suggestion, the queue) ends an edit open there first (F). */
  const dropEdit = (chatId: string) => { if (get().editMsg?.chatId === chatId) restoreEdit(false) }
  let askSeq = 0
  let keySeq = 0
  /** What a send that didn't come back was sent with, by the id of its failed line: Try again sends the same thing under the same key, so a send that did reach the agent is never asked twice. */
  const failedSends = new Map<string, { key: string; q: string; o: SendOpts }>()
  /** Tells the agent about a chat the person started. A failure shows the agent's notice; the chat stays on screen. */
  const createChat = (c: ChatEntry) => {
    // The agent's error notice already told the person.
    agent.createChat({ id: c.id, title: c.title }).catch(logFailure('the agent could not make the chat'))
  }
  // Chats started before a reload: the agent learns them again before anything reads the chat list.
  session.started?.forEach(createChat)

  /** The run reducer and the words about a turn's end load with the first send, not with the page (Today's JS budget). */
  let chat: typeof import('../screens/chat/run') | null = null
  const loadChat = async () => (chat ??= await import('../screens/chat/run'))
  const lib = () => { if (!chat) throw new Error('The chat code is not loaded: a run starts only after loadChat().'); return chat }

  /** What one send carries. */
  interface SendOpts { quote?: string; atts: Attachment[]; model: string | null; replacesRun?: string; priority?: 'now' | 'next' | 'later' }

  /** What a frame changes in the store: the chat's view, its messages and the run's line above the composer. */
  const takeFrame = (cid: string, token: number, f: RunFrame) => {
    const cur = own(get().runs, cid)
    if (cur?.token !== token) return
    const prev = own(get().views, cid) ?? emptyView()
    const next = lib().reduce(prev, f.event, f.at, f.runId)
    if (next === prev) return
    for (const m of next.messages) if (!prev.messages.includes(m)) addTo(cid, m)
    const done = f.event.type === 'run.finished'
    set(s => {
      const views = { ...s.views, [cid]: next }
      const r = own(s.runs, cid)
      if (!r || r.token !== token) return { views }
      if (done) return { views, runs: without(s.runs, cid) }
      return {
        views,
        runs: { ...s.runs, [cid]: { ...r, turnId: next.live, text: next.thinking ?? r.text, sent: next.queued.map(q => ({ id: q.turnId, text: q.text, quote: q.quote, atts: q.atts.length ? q.atts : undefined, model: null })) } },
      }
    })
    if (done) { ended.add(token); detachRun(cid) }
  }
  /** Follows a run: a chat's frames go through `takeFrame` from the first (a replay shows what the live stream showed). */
  const follow = (cid: string, token: number, runId: string) => {
    detachRun(cid)
    // The detach is filed first: the replay can end the run inside `attach`, before it has returned.
    let off: (() => void) | null = null
    let over = false
    attached.set(cid, () => { over = true; off?.() })
    off = agent.attach(runId, f => takeFrame(cid, token, f), 0, code => {
      // Refused (not found, not the person's): nothing will come, so the run is dropped here.
      console.warn(`Inhouse: the agent refused the run (${code}).`)
      if (own(get().runs, cid)?.token === token) forgetRun(cid)
    })
    if (over) off()
  }

  // Answers still being written on the agent's side (the page reloaded, or another tab sent): follow each from its first event.
  // Messages are keyed by id, so what the history already shows isn't added twice. The reload note was about a run that
  // stopped; this one didn't, so its note goes.
  /** Follows each run from its first event, unless its chat is already answering here or isn't one the agent has. */
  const followRuns = async (list: readonly { runId: string; chatId: string }[]) => {
    if (list.length) await loadChat()
    const known = new Set(agent.allChatIds())
    for (const r of list) {
      if (own(get().runs, r.chatId) || !known.has(r.chatId)) continue
      const token = ++askSeq
      set(s => ({ runs: { ...s.runs, [r.chatId]: { runId: r.runId, turnId: null, text: 'Reading your question…', token, sent: [] } } }))
      updateChat(r.chatId, c => ({ ...c, extras: c.extras.filter(m => !(m.role === 'event' && m.text === RELOAD_NOTE)) }))
      follow(r.chatId, token, r.runId)
    }
  }
  void agent.activeRuns().then(followRuns, logFailure('could not read the answers being written'))

  /** Sends `q` into chat `cid`, open or not: a new run, or a turn queued in the chat's live run. Synchronous up to and including
   *  adding the person's message (when it starts a run): regenerate() reads it right after calling ask(). */
  const runAsk = async (cid: string, q: string, o: SendOpts & { key?: string; failedLine?: string }) => {
    dropEdit(cid)
    const existing = own(get().runs, cid)
    const token = existing?.token ?? ++askSeq
    const mode = activeMode(agent.read(), agent.getSnapshot().settings, o.model)
    const at = () => instantOf(demoTime().getTime())
    const priority = o.priority ?? (existing ? 'now' : 'next')
    // One key per send action (never per text: two identical quick sends are two turns); a retry of a failed send brings its own.
    const key = o.key ?? `k${chatSession}${(++keySeq).toString(36)}`
    const local = `local-${key}`
    if (o.failedLine) { const gone = o.failedLine; updateChat(cid, c => ({ ...c, extras: c.extras.filter(m => m.id !== gone) })) }
    // Words about a send that didn't go: the agent's notice told the person too, so this is the chat's own line.
    const failed = (text: string) => {
      failedSends.set(`${local}.f`, { key, q, o: { quote: o.quote, atts: o.atts, model: o.model, replacesRun: o.replacesRun, priority } })
      addTo(cid, { id: `${local}.f`, role: 'agent', trace: '', at: at(), part: { type: 'error', text, retryQuestion: q } })
    }
    if (!mode) { failed(NO_MODEL_TEXT); return }
    if (!existing) {
      set(s => ({ runs: { ...s.runs, [cid]: { runId: null, turnId: null, text: 'Reading your question…', token, sent: [] } } }))
      addTo(cid, { id: local, role: 'user', text: q, quote: o.quote, atts: o.atts.length ? o.atts : undefined, at: at() })
    }
    // The real client keeps a file on the server before the message names it (route 39, which needs the chat to exist: its save
    // goes first). The demo names a made-up id and keeps nothing.
    const showAtts = (list: Attachment[]) => { if (!existing) updateChat(cid, c => ({ ...c, extras: c.extras.map(m => (m.id === local && m.role === 'user' ? { ...m, atts: list.length ? list : undefined } : m)) })) }
    try {
      const lib0 = await loadChat()
      const { refOf, rememberAttachments } = lib0
      let refs: { fileId: string; name: string }[] | undefined
      if (agent.uploadsFiles() && o.atts.length) {
        const asked = o.atts
        if (asked.some(a => a.pending !== undefined)) showAtts(asked.map(a => (a.pending === undefined ? a : { ...a, meta: 'Uploading…' })))
        const set0 = uploadAborts.get(token) ?? new lib0.AbortSet()
        uploadAborts.set(token, set0)
        const ctl = set0.add()
        let at: Awaited<ReturnType<typeof lib0.attemptUpload>>
        try {
          at = await lib0.attemptUpload(asked, { fileOf: heldFile, upload: (f, signal) => agent.uploadFile(cid, f, signal), signal: ctl.signal }, dropFile)
        } finally { set0.remove(ctl); if (!set0.size) uploadAborts.delete(token) }
        o = { ...o, atts: at.atts }
        showAtts(at.atts)
        if (at.kind === 'cancelled') throw new lib0.UploadStopped()
        if (at.kind === 'failed') throw at.error
        if (at.kind === 'refused') {
          // The message doesn't go without the files the person chose: the reasons say what to change, and Try again sends the rest.
          if (own(get().runs, cid)?.token === token && !existing) { forgetRun(cid); cancelledSends.delete(token) }
          failed(at.text)
          return
        }
        refs = at.refs
      }
      rememberAttachments(o.atts)
      const result = await agent.send(cid, {
        clientTurnKey: key, text: q, ...(o.quote !== undefined ? { quote: o.quote } : {}), priority, model: mode.id,
        ...(o.replacesRun !== undefined ? { replacesRun: o.replacesRun } : {}), ...(refs ? (refs.length ? { attachments: refs } : {}) : o.atts.length ? { attachments: o.atts.map(refOf) } : {}),
      })
      failedSends.delete(`${local}.f`)
      const run = own(get().runs, cid)
      if (!run) {
        // The chat or the run was dropped while the send was on its way: what it started is stopped, as nobody follows it.
        if (cancelledSends.delete(token)) { agent.stop(result.turnId).catch(logFailure('could not stop the answer')); return }
        if (!ended.has(token)) return
        // The run ended before the send came back, so the agent started a new run for it: follow that one from its first event.
        const next = ++askSeq
        set(s => ({ runs: { ...s.runs, [cid]: { runId: result.runId, turnId: null, text: 'Reading your question…', token: next, sent: [] } } }))
        follow(cid, next, result.runId)
        return
      }
      if (run.token !== token) { return }
      if (!existing || run.runId === null || run.runId !== result.runId) {
        // The person's message takes its stable id, so the run's own events upsert it instead of adding it again.
        if (!existing) { renamed.set(local, result.messageId); updateChat(cid, c => ({ ...c, extras: c.extras.map(m => (m.id === local ? { ...m, id: result.messageId } : m)) })) }
        set(s => { const cur = own(s.runs, cid); return cur?.token === token ? { runs: { ...s.runs, [cid]: { ...cur, runId: result.runId } } } : {} })
        follow(cid, token, result.runId)
      }
      if (own(get().runs, cid)?.stopAsked) { agent.stop(result.turnId).catch(logFailure('could not stop the answer')) }
    } catch (e) {
      // A refusal by the agent is final; one that only says it couldn't be reached is worth asking again with the same key.
      console.warn('Inhouse: the agent did not take the message.', e)
      if (e instanceof AgentError && e.reason === REASON.sessionDamaged) set(s => ({ views: { ...s.views, [cid]: { ...(own(s.views, cid) ?? emptyView()), damaged: true } } }))
      if (own(get().runs, cid)?.token === token && !existing) { forgetRun(cid); cancelledSends.delete(token) }
      failed(chat && e instanceof chat.UploadStopped ? chat.UPLOAD_STOPPED : e instanceof AgentError && chat ? chat.sendFailureText(e) : RUN_FAILED)
    }
  }

  return {
    ...initialUi(),
    ...demo,
    ...session.ui,
    // ---------- navigation (PR 5) ----------
    // Outside initialUi, so Reset demo keeps the sidebar as the person left it.
    palette: false,
    sideCollapsed: loadSideCollapsed(),
    toggleSidebar: () => {
      const sideCollapsed = !get().sideCollapsed
      set({ sideCollapsed })
      try { localStorage.setItem(SIDEBAR_KEY, sideCollapsed ? 'collapsed' : 'expanded') }
      catch (e) { console.warn('Inhouse: could not save the sidebar choice.', e) }
    },

    patch: p => set(p),
    ...composerActions(set),
    go: (page, extra) => set({ page, openId: null, pop: null, sideOpen: false, ...extra }),
    openTool: key => set({ page: 'app', appKey: key, pop: null, openId: null, sideOpen: false }),
    openSkill: key => set({ page: 'skill', skillKey: key, pop: null, openId: null, sideOpen: false }),
    // The page itself, never the phone menu (openSettingsMenu asks for the menu).
    openSettings: tab => set({ page: 'settings', setTab: tab, setMenu: false, pop: null, openId: null, sideOpen: false }),
    openProblem: (id, queue) => { rememberTrigger(); set({ openId: id, queue: queue?.includes(id) ? queue : [] }) },
    stepProblem: id => set({ openId: id, editing: null }),
    closeProblem: () => set({ openId: null, queue: [], editing: null }),
    // On a phone the drawer sits above these, so opening one closes the drawer.
    // Only pops that are focus-managed dialogs remember their trigger; the account menu is not one.
    // The account menu opens from the phone drawer, so it leaves the drawer open; every other pop-up closes it.
    openPop: pop => { if (pop === 'team' || pop === 'help') rememberTrigger(); set(pop === 'me' ? { pop } : { pop, sideOpen: false }) },
    openTeam: (type, text = '') => { rememberTrigger(); set({ pop: 'team', team: { type, title: '', text, shot: true }, sideOpen: false }) },
    closeOverlays: () => set({ openId: null, pop: null, traceId: null, sideOpen: false, editing: null }),
    showToast,
    dismissToast,
    runToastUndo: id => {
      const t = get().toasts.find(x => x.id === id)
      if (!t?.undo) return
      undoing = id
      // No catch: an undo that throws is a bug to see, and the toast still goes.
      try { t.undo() } finally { undoing = null; dismissToast(id) }
    },
    clearToast,
    openTrace: id => { rememberTrigger(); set({ traceId: id }) },
    // Leaving a chat never stops its answer: the run keeps writing to that chat (decision D9).
    newChat: (prefill = '') => {
      // A new chat has no composer key, like the pages without a composer: its files start empty, never carried over.
      set(s => ({ page: 'chats', chatList: false, openId: null, pop: null, sideOpen: false, stash: stashed(s), fresh: true, extras: [], hidden: {}, chatDraft: prefill, atts: [], replyTo: null, modelSel: null }))
    },
    openChat: id => {
      const s = get()
      // The chat that is already open (a sidebar row, a Library source link): just show it. Its draft, reply, files
      // and a running answer stay as they are.
      if (openChatKey(s, agent.read()) === id) {
        // By its id from now on (it may have been "the newest chat"), so a scenario switch can't move it.
        set({ page: 'chats', chatList: false, openId: null, pop: null, sideOpen: false, chatId: id })
        return
      }
      set(u => ({ page: 'chats', chatList: false, openId: null, pop: null, sideOpen: false, ...withOpen(u, id), replyTo: null, chatDraft: '' }))
    },
    openChatList: () => set({ page: 'chats', chatList: true, openId: null, pop: null, sideOpen: false }),

    // Synchronous up to and including adding the person's message: regenerate() reads it right after calling.
    ask: async (question, askOpts = {}) => {
      const q = question.trim()
      if (!q) return
      // An edit open in this chat ends first: the composer gets back what it held before it (F).
      const s0 = get()
      const here = s0.page === 'chats' && !s0.chatList ? openChatKey(s0, agent.read()) : null
      if (here !== null) dropEdit(here)
      // Only the composer's own Send takes its quote and files and clears it (while editing, that Send is sendEdit).
      const fromComposer = askOpts.fromComposer === true
      // A question from Today, a tool page or the list of chats starts a chat of its own.
      const before = get()
      if (before.page !== 'chats' || before.chatList) {
        get().newChat()
        // The mode picked in the composer goes with the question, even though a new chat starts from the default.
        set({ modelSel: before.modelSel })
      }
      // The first question gives a new chat its id and its place in Recent chats and See all. The agent is told without
      // waiting, so the question shows at once.
      let chatId = openChatKey(get(), agent.read())
      if (chatId === null) {
        const chat = startedChat(q)
        createChat(chat)
        set(s => ({ fresh: false, chatId: chat.id, started: [chat, ...s.started] }))
        chatId = chat.id
      }
      // The files come from the composer the question was asked in (Today's, when it starts a chat).
      const { replyTo, modelSel } = get()
      set(s => ({
        page: 'chats', openId: null, pop: null, sideOpen: false,
        // Only the composer the question came from is cleared: asking in a chat leaves Today's draft alone.
        ...(fromComposer ? {
          replyTo: null, atts: [], chatDraft: '',
          ...(before.page === 'today' ? { todayDraft: '' } : {}),
          drafts: dropDraft(s.drafts, composerKey(before)),
        } : {}),
      }))
      const quote = fromComposer ? replyTo ?? undefined : askOpts.quote
      return runAsk(chatId, q, { quote, atts: fromComposer ? before.atts : askOpts.atts ?? [], model: modelSel, replacesRun: askOpts.replacesRun })
    },
    retryAnswer: (lineId, trace, question) => {
      const cid = openChatKey(get(), agent.read())
      if (cid === null) return
      const failed = failedSends.get(lineId)
      if (failed) { void runAsk(cid, failed.q, { ...failed.o, key: failed.key, failedLine: lineId }); return }
      const t = own(own(get().views, cid)?.turns ?? {}, trace)
      void get().ask(question, { replacesRun: t?.runId || undefined, quote: t?.quote, atts: t?.atts })
    },
    stopRun: chatId => {
      const id = chatId ?? openChatKey(get(), agent.read())
      if (id !== null) stopChat(id)
    },
    queueMessage: () => {
      const s = get()
      const cid = openChatKey(s, agent.read())
      const text = s.chatDraft.trim()
      if (cid === null || !own(s.runs, cid) || !text) return
      const item = { text, quote: s.replyTo ?? undefined, atts: s.atts, model: s.modelSel }
      set(u => ({ chatDraft: '', atts: [], replyTo: null, drafts: dropDraft(u.drafts, cid) }))
      // The agent queues it: it shows above the composer (`turn.queued`) and starts when the answer ends, or goes next.
      void runAsk(cid, item.text, { quote: item.quote, atts: item.atts, model: item.model, priority: 'next' })
    },
    unqueue: id => {
      const cid = openChatKey(get(), agent.read())
      if (cid === null) return undefined
      // A turn the agent holds in its queue: cancelled there.
      const waiting = own(get().runs, cid)?.sent.find(x => x.id === id)
      if (waiting) {
        agent.stop(id).catch(logFailure('could not take the message out of the queue'))
        return waiting
      }
      const list = own(get().queued, cid)
      const item = list?.find(x => x.id === id)
      if (!list || !item) return undefined
      const rest = list.filter(x => x.id !== id)
      set(s => ({ queued: rest.length ? { ...s.queued, [cid]: rest } : without(s.queued, cid) }))
      return item
    },
    sendQueuedNow: id => {
      const cid = openChatKey(get(), agent.read())
      const queuedItem = get().unqueue(id)
      if (cid === null || !queuedItem) return
      // Sent, it waits for nothing any more.
      const { paused: _paused, ...item } = queuedItem
      // Send now ends what is running (E) and goes next in the same run; with nothing answering it is simply asked.
      void runAsk(cid, item.text, { quote: item.quote, atts: item.atts ?? [], model: item.model, priority: own(get().runs, cid) ? 'now' : 'next' })
    },
    startEdit: (m, hide) => {
      const s = get()
      const cid = openChatKey(s, agent.read())
      if (cid === null) throw new Error('startEdit: no chat is open.')
      // Editing another question keeps what the composer held before the first edit.
      const saved = s.editMsg?.chatId === cid ? s.editMsg.saved : { text: s.chatDraft, atts: s.atts, replyTo: s.replyTo }
      set({ editMsg: { chatId: cid, id: m.id, hide, saved }, replyTo: m.quote ?? null, atts: m.atts ?? [] })
      get().setComposerText(m.text, { focus: true })
    },
    cancelEdit: () => restoreEdit(true),
    sendEdit: () => {
      const s = get()
      const e = s.editMsg
      const text = s.chatDraft.trim()
      if (!e || !text || openChatKey(s, agent.read()) !== e.chatId) return
      const question = { text, quote: s.replyTo ?? undefined, atts: s.atts }
      // The composer gets back what it held before; regenerate() lends the edited question its own quote and files.
      set({ editMsg: null, chatDraft: e.saved.text, atts: e.saved.atts, replyTo: e.saved.replyTo })
      get().regenerate(e.hide, question)
    },
    deleteMessages: (chatId, ids) => {
      updateChat(chatId, c => ({ ...c, hidden: hideIds(c.hidden, ids) }))
      // Undo finds the chat wherever it is now: open, or filed away because the person moved on.
      showToast('Message deleted', { icon: 'delete', undo: () => updateChat(chatId, c => ({ ...c, hidden: unhideIds(c.hidden, ids) })) })
    },

    approve: id => {
      set({ editing: null })
      return agent.approve(id).then(({ held, doneText }) => {
        // A held approval's toast stays until it goes out (no timer): pausing it would promise an Undo the agent no longer honours.
        if (held) showHeld([id], [id])
        else showToast(doneText, { undo: () => get().unapprove(id), key: `approve:${id}` })
        return null
      }, (e: unknown) => {
        logFailure('could not approve')(e)
        return e instanceof Error && e.message ? e.message : 'Something went wrong.'
      })
    },
    unapprove: id => {
      if (agent.getSnapshot().sent[id] && !problemById(agent.read(), id).draft.rev) {
        dismissToast(`approve:${id}`)
        showToast(TOO_LATE, { icon: 'info' })
        return
      }
      agent.undo(id).catch(logFailure('could not undo the approval'))
      dismissToast(`approve:${id}`)
      settleHolds()
    },
    undoHandled: id => {
      agent.undoHandled(id).then(text => showToast(text, { undo: () => { agent.redoHandled(id).catch(logFailure('could not redo')) } }), logFailure('could not undo'))
    },
    togglePause: () => {
      if (agent.getSnapshot().paused) { agent.resume().catch(logFailure('could not resume')); showToast('Your Inhouse agent is running again', { ms: 4000 }); return }
      agent.pause().catch(logFailure('could not pause'))
      showToast('Your Inhouse agent is paused. Chats, routines and jobs are stopped.', { undo: () => { agent.resume().catch(logFailure('could not resume')) } })
    },

    setDemo: p => {
      // With no chat picked (no chats when the page loaded), the open chat is the scenario's newest: when the switch
      // changes it, the old one's additions go to the stash and the new one's come out, so a save can't overwrite them.
      const was = openChatKey(get(), agent.read())
      set(p)
      const { stage, scenario, ambient, animateMark } = get()
      demoControls?.setDemo({ stage, scenario })
      if (demoControls) saveDemo({ stage, scenario, ambient, animateMark })
      const now = openChatKey(get(), agent.read())
      if (now !== was) {
        set(s => {
          const all = was === null ? s.stash : { ...s.stash, [was]: { extras: s.extras, hidden: s.hidden } }
          const back = now === null ? undefined : own(all, now)
          return { stash: now === null ? all : without(all, now), extras: back?.extras ?? [], hidden: back?.hidden ?? {} }
        })
      }
    },
    resetDemo: () => {
      // Every answer stops: the runs go with the state, so their late events find no token.
      for (const id of Object.keys(get().runs)) forgetRun(id)
      // Answers already revealed are forgotten with the chats, so an id reused after the reset reveals again.
      clearRevealed()
      demoControls?.reset()
      clearSession()
      // The stage and scenario go back to their defaults with everything else; the dot sweep and mark animation stay.
      const { ambient, animateMark } = get()
      const d = { ...DEFAULT_DEMO, ambient, animateMark }
      demoControls?.setDemo({ stage: d.stage, scenario: d.scenario })
      if (demoControls) saveDemo(d)
      set({ ...initialUi(), ...d, phone: get().phone, demoOpen: get().demoOpen })
      // The brand and channels came from the override at load, so a reload is what drops them.
      if (demoControls?.dataOverrideActive) location.reload()
    },

    approveMany: ids => {
      set({ editing: null })
      // One failed approval doesn't lose the toast and Undo of the ones that went through (its notice already showed).
      void Promise.allSettled(ids.map(id => agent.approve(id))).then(results => {
        const okIds: string[] = []
        const held: string[] = []
        const { sent } = agent.getSnapshot()
        results.forEach((r, i) => {
          if (r.status === 'rejected') { logFailure('could not approve a draft')(r.reason); return }
          okIds.push(ids[i])
          // One that already went out holds nothing and isn't counted as going out.
          if (r.value.held && !sent[ids[i]]) held.push(ids[i])
        })
        if (!okIds.length) return
        // Undo takes back every one that hasn't gone out.
        if (held.length) { showHeld(okIds, held); return }
        const undo = () => {
          const now = agent.getSnapshot().sent
          for (const id of okIds) if (!now[id]) agent.undo(id).catch(logFailure('could not undo an approval'))
          settleHolds()
        }
        showToast(`Approved ${okIds.length} drafts`, { undo })
      })
    },
    setAside: (id, reason) => {
      agent.setAside(id, reason).catch(logFailure('could not set the problem aside'))
      const text = { snoozed: 'Snoozed until tomorrow', dismissed: "Dismissed. It won't come back today.", declined: 'Not sent. The draft is out of Approvals.' }[reason]
      showToast(text, { icon: reason === 'snoozed' ? 'snooze' : 'check_circle', undo: () => { agent.setAside(id, null).catch(logFailure('could not bring the problem back')) } })
    },
    openSettingsMenu: tab => { get().openSettings(tab); set({ setMenu: true }) },
    // ---------- managing chats ----------
    renameChat: (id, title) => {
      const t = title.trim().replace(/\s+/g, ' ')
      const own = [...get().started, ...agent.read().chat.chats].find(c => c.id === id)?.title
      if (!t || t === (agent.getSnapshot().chatTitles[id] ?? own)) return
      agent.renameChat(id, t === own ? null : t).catch(logFailure('could not rename the chat'))
    },
    pinChat: (id, pinned) => {
      agent.pinChat(id, pinned).catch(logFailure('could not pin the chat'))
      showToast(pinned ? 'Chat pinned' : 'Chat unpinned', { icon: 'keep', ms: 4000 })
    },
    openModelMenu: () => set(s => ({ modelMenuAsk: s.modelMenuAsk + 1 })),
    loadHistory: (chatId, more = false) => {
      const have = own(get().history, chatId)
      if (have?.state === 'loading' || (have && have.state !== 'error' && !more) || (more && (!have || have.next === null))) return
      const cursor = more ? have?.next ?? undefined : undefined
      const epoch = historyEpoch
      set(s => ({ history: { ...s.history, [chatId]: { messages: have?.messages ?? [], next: have?.next ?? null, state: 'loading' } } }))
      agent.getChat(chatId, cursor).then(async page => {
        if (epoch !== historyEpoch) return
        // `runs`: the live run and any ended run whose turns aren't all stored yet (route 24). Each is replayed from its first event;
        // what the history already holds shows once (stable ids).
        void followRuns(page.runs).catch(logFailure('could not follow the answers being written'))
        // The page is newest first; the thread reads oldest first, by stored position. A turn's stored end row is put in
        // the words the live stream used (they load with the chat code, as at a send).
        const sorted = [...page.messages].sort((a, b) => a.pos - b.pos)
        const older: ChatMessage[] = sorted.some(m => m.role === 'event' && m.end !== undefined) ? (await loadChat()).historyMessages(sorted) : sorted
        if (epoch !== historyEpoch) return
        set(s => {
          const cur = own(s.history, chatId)
          return { history: { ...s.history, [chatId]: { messages: more ? [...older, ...(cur?.messages ?? [])] : older, next: page.nextCursor, state: 'ready' } } }
        })
      }).catch((e: unknown) => {
        // The read failed, or the chat code for the page's end rows didn't load: either way the page isn't shown.
        if (epoch !== historyEpoch) return
        // A chat this tab just started whose save failed (or never reached the agent) has no history: it reads as empty, not as an error.
        if (e instanceof AgentError && e.code === NOT_FOUND && get().started.some(c => c.id === chatId)) {
          set(s => ({ history: { ...s.history, [chatId]: { messages: [], next: null, state: 'ready' } } }))
          return
        }
        console.warn('Inhouse: could not read the chat history.', e)
        set(s => ({ history: { ...s.history, [chatId]: { messages: have?.messages ?? [], next: have?.next ?? null, state: 'error' } } }))
      })
    },
    resetSession: chatId => {
      agent.resetSession(chatId).then(() => {
        set(s => { const v = own(s.views, chatId); return v ? { views: { ...s.views, [chatId]: { ...v, damaged: false, notice: null } } } : {} })
        showToast('Ready for a fresh start. Your messages are still here.', { icon: 'refresh', ms: 4000 })
      }, logFailure('could not start the chat fresh'))
    },
    copyChatLink: id => {
      const url = `${location.origin}${location.pathname}#/chats/${encodeURIComponent(id)}`
      const failed = () => showToast("Couldn't copy the link.", { icon: 'error' })
      if (!navigator.clipboard) { failed(); return }
      navigator.clipboard.writeText(url).then(() => showToast('Link copied', { icon: 'link', ms: 4000 }), e => { console.warn('Inhouse: could not copy the link.', e); failed() })
    },
    deleteChats: ids => {
      if (!ids.length) return
      const s = get()
      const data = agent.read()
      const openId = s.page === 'chats' && !s.chatList ? openChatKey(s, data) : null
      // A second delete while the first toast is still up joins it (same key, replaced in place), so one Undo brings back both.
      const earlier = lastChatDelete && s.toasts.some(t => t.key === CHAT_DELETE && t.undo === lastChatDelete?.undo) ? lastChatDelete : null
      // Every deleted chat that is answering, open or not, stops, and says so (Undo brings it back with the note).
      // The agent cancels what waits in them and stops what answers; here their runs are forgotten.
      for (const id of ids) { stopLive(id); parkRun(id, true) }
      agent.deleteChats(ids).catch(logFailure('could not delete the chats'))
      // The open chat was deleted: move to the newest chat left (or a new chat), and remember both for Undo.
      // A second delete keeps the first `from`, so Undo goes back to the chat the person was really on.
      let moved = earlier?.moved ?? null
      if (openId && ids.includes(openId)) {
        const next = newestChat(data, s.started, agent.getSnapshot())
        replaceNextEntry = true
        if (next) get().openChat(next.id); else get().newChat()
        moved = { from: earlier?.moved && earlier.moved.to === openId ? earlier.moved.from : openId, to: next?.id ?? null }
      }
      const all = [...(earlier?.ids ?? []), ...ids]
      const undo = () => {
        agent.restoreChats(all).catch(logFailure('could not restore the chats'))
        // Undo goes back to the deleted chat only if the person is still where the delete moved them.
        const u = get()
        const here = u.page === 'chats' && !u.chatList && (moved?.to === null ? u.fresh : !u.fresh && u.chatId === moved?.to)
        if (moved && here) get().openChat(moved.from)
      }
      lastChatDelete = { ids: all, moved, undo }
      showToast(`Deleted ${all.length} ${all.length === 1 ? 'chat' : 'chats'}`, { icon: 'delete', undo, key: CHAT_DELETE })
    },

    // ---------- conversation ----------
    regenerate: (hideIdList, question) => {
      const open = openChatKey(get(), agent.read())
      if (open === null) throw new Error('regenerate: no chat is open.')
      // An edit open here ends first, so the composer kept below is the one from before it (F).
      dropEdit(open)
      const s0 = get()
      const chatId = open
      // The run that wrote the old answer, so the agent updates what it made (a routine, a skill) instead of adding one.
      const replaces = s0.extras.find(m => m.role === 'agent' && hideIdList.includes(m.id) && TURN_ID.test(m.trace))
      // The run that wrote it, when this page saw it (a run id, which is all the agent takes); after a reload nothing here knows it, so none is sent.
      const replacesRun = replaces?.role === 'agent' ? own(s0.views, chatId)?.turns[replaces.trace]?.runId || undefined : undefined
      // The routine the replaced run made, if it still stands: if the new answer makes none, the agent deletes it, and Undo
      // brings it back (one the person had deleted already stays deleted). Only that run's: a later turn's routine is
      // hidden with the tail but stays live, so the person can delete it themselves, and Undo mustn't bring that back.
      const was = agent.getSnapshot().routinesDeleted
      const routines = s0.extras.flatMap(m => (m.role === 'agent' && replacesRun !== undefined && replaces?.role === 'agent' && m.trace === replaces.trace && hideIdList.includes(m.id) && m.part.type === 'routine' && !was[m.part.routine.id] ? [m.part.routine.id] : []))
      // The question goes with its own quote and files; the composer's draft stays as it is.
      set(s => ({ hidden: hideIds(s.hidden, hideIdList) }))
      void get().ask(question.text, { replacesRun, quote: question.quote, atts: question.atts })
      // ask() has added the question before its first await: it is the newest message of the open chat.
      const askedFirst = get().extras.at(-1)?.id
      // Undo brings the old turn back and drops the new question with whatever it answered so far, wherever the chat is now.
      const undo = () => {
        const deleted = agent.getSnapshot().routinesDeleted
        for (const id of routines) if (deleted[id]) agent.restoreRoutine(id).catch(logFailure('could not restore the routine'))
        const u = get()
        const now = openChatKey(u, agent.read()) === chatId ? u.extras : own(u.stash, chatId)?.extras ?? []
        // The question may have taken its stable id since it was asked.
        const asked = askedFirst === undefined ? undefined : renamed.get(askedFirst) ?? askedFirst
        const at = now.findIndex(m => m.id === asked)
        // Still answering it (no newer question): stop that run. The dropped turn needs no stopped note.
        if (at >= 0 && !now.some((m, j) => j > at && m.role === 'user') && stopLive(chatId)) parkRun(chatId, false)
        updateChat(chatId, c => {
          const i = c.extras.findIndex(m => m.id === asked)
          if (i < 0) return { ...c, hidden: unhideIds(c.hidden, hideIdList) }
          const end = c.extras.findIndex((m, j) => j > i && m.role === 'user')
          return { extras: [...c.extras.slice(0, i), ...(end < 0 ? [] : c.extras.slice(end))], hidden: unhideIds(c.hidden, hideIdList) }
        })
      }
      showToast('Asking again', { icon: 'refresh', undo })
    },
    rateAnswer: (id, rating, answerText) => {
      const feedback = { ...get().feedback }
      if (feedback[id] === rating) delete feedback[id]; else feedback[id] = rating
      set({ feedback })
      if (feedback[id] === 'down') get().openTeam('bug', 'This answer looks wrong: "' + answerText.slice(0, 120) + '"')
    },
  }
})

let replaceNextEntry = false
/** True once after deleting the open chat: the move to the next chat replaces the history entry, so Back skips the deleted chat. */
export const takeReplaceEntry = (): boolean => { const r = replaceNextEntry; replaceNextEntry = false; return r }

/** The key of the chat delete toast: a second delete replaces it, joined. */
const CHAT_DELETE = 'chat-delete'
/** The last chat delete and its Undo, so the next delete can join it while its toast is still showing. */
let lastChatDelete: { ids: string[]; moved: { from: string; to: string | null } | null; undo: () => void } | null = null

/** The files in the Library, re-rendering when one is deleted or restored. */
export const useLibraryFiles = (): LibraryFile[] => useSyncExternalStore(agent.subscribe, agent.listFiles)

/** Agent domain state, re-rendering on change. */
export const useAgentState = (): AgentState => useSyncExternalStore(agent.subscribe, agent.getSnapshot)

/** Read-only domain data (problems, tools, usage, people, chat strings): everything that is not state. */
export const useAgentData = (): AgentData => useSyncExternalStore(agent.subscribe, agent.read)

/**
 * Stage index, agent state and data: the input every selector in derive.ts takes. The demo's scenario switch isn't in it:
 * a scenario shows through the data the client reads (the mock serves another snapshot per scenario).
 */
export function useCtx(): Ctx {
  const agentState = useAgentState()
  const data = useAgentData()
  const demoStage = useUi(s => s.stage)
  // The demo's switch drives the stage there; on the product it is the agent's technical `stage` setting.
  const stage = demoControls ? demoStage : productStage(agentState.settings)
  return useMemo(() => ({ S: stageIndex(stage), agent: agentState, data }), [stage, agentState, data])
}

// ---------- composer drafts (PR 4): swap drafts when the open composer changes ----------
// Runs on every navigation (actions, the hash route, Back): files the composer that closed and opens the next one's.
useUi.subscribe((s, prev) => {
  const from = composerKey(prev)
  const to = composerKey(s)
  if (from === to) return
  // Editing is per chat (F): leaving the chat ends an open edit, and its draft is what the composer held before it.
  const edit = prev.editMsg !== null && prev.editMsg.chatId === from ? prev.editMsg.saved : null
  const left = edit ?? { text: prev.chatDraft, atts: prev.atts }
  // A change that also replaced `drafts` (Reset demo) has already set them: don't file the old composer back in.
  let drafts = s.drafts === prev.drafts && from !== null ? { ...s.drafts, [from]: { text: from === 'today' ? '' : left.text, atts: left.atts } } : s.drafts
  if (from !== null && !drafts[from]?.text && !drafts[from]?.atts.length) drafts = dropDraft(drafts, from)
  const next = to === null ? undefined : own(drafts, to)
  useUi.setState({
    // The quote goes back to the one from before the edit too, unless the change set its own. Only off a chat (Today,
    // the chat list, another page): a quote never follows a person into another chat or a new one, so there it's dropped.
    ...(edit && s.editMsg === prev.editMsg ? { editMsg: null, ...(s.replyTo === prev.replyTo ? { replyTo: s.page === 'chats' && !s.chatList ? null : edit.replyTo } : {}) } : {}),
    drafts: dropDraft(drafts, to),
    atts: next?.atts ?? [],
    // Today keeps its text in todayDraft; a new chat keeps what newChat() put there (its prefill).
    ...(to !== null && to !== 'today' ? { chatDraft: next?.text ?? '' } : {}),
  })
})
// ---------- end composer drafts ----------

// Leaving Settings forgets that its phone menu was showing, so a link back opens the page.
useUi.subscribe((s, prev) => { if (s.page !== prev.page && s.page !== 'settings' && s.setMenu) useUi.setState({ setMenu: false }) })

/** History state of a phone Settings page whose previous entry is the Settings menu. */
export const FROM_SETTINGS_MENU = { fromSettingsMenu: true }
/** The phone Settings page's Back to the menu: back in history when the menu is the previous entry, else the menu is shown (a new entry). */
export function backToSettingsMenu() {
  if ((history.state as typeof FROM_SETTINGS_MENU | null)?.fromSettingsMenu) history.back()
  else useUi.getState().patch({ setMenu: true })
}

// ---------- phase 1 memory: save on change and on pagehide ----------
const SESSION_FIELDS = ['started', 'stash', 'extras', 'hidden', 'todayDraft', 'chatDraft', 'drafts', 'atts', 'modelSel', 'feedback', 'libraryView', 'chatId', 'fresh', 'page', 'chatList', 'queued'] as const
/** Only which chats are answering and what was sent into them is saved, so a thinking step (a new `runs` object) doesn't schedule a save. */
const answeringKey = (s: UiState) => Object.entries(s.runs).map(([id, r]) => `${id}:${r.sent.map(x => x.id).join(',')}`).join('\n')
useUi.subscribe((s, prev) => {
  if (!SESSION_FIELDS.some(k => s[k] !== prev[k]) && answeringKey(s) === answeringKey(prev)) return
  clearTimeout(saveTimer)
  saveTimer = setTimeout(saveSession, 300)
})
window.addEventListener('pagehide', () => { if (saveTimer !== undefined) saveSession() })
if (saveAfterSetup) saveSession()
// Two tabs share one saved session: the last one to save wins. (The agent's own state syncs between tabs; this doesn't.)
