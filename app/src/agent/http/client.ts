// The product's agent client. P2 connects the account, settings, team, support-access and audit parts to the Worker over
// HTTP (transport.ts); every other method stays the P1 stub (`unavailable`) until its phase, and a run never starts.
// Reads: one fetch per resource on start (`me` and the settings first, `meta`), each with its own `status`. Writes:
// optimistic, then saved; on failure taken back, rejected with the `AgentError` and an `error` notice. The client keeps
// each record's last `rev` and sends it as `ifRev`; a `conflict` puts `current` into the snapshot.
// It imports nothing from the mock or the sample data.
import { deviceTimeZone, instantOf } from '../../lib/format'
import { MAX_TEAM_ROUTINES, RESOURCE_KEYS } from '../../../shared/contract/keys'
import { NOT_FOUND, REASON } from '../../../shared/contract/error-codes'
import { meetsRule, settingRow } from '../../../shared/contract/settings-table'
import { AgentError, CHAT_TITLE_MAX } from '../types'
import type {
  ActivityLine, AgentClient, AgentData, AgentErrorCode, AgentNotice, AgentNotification, AgentState, AuditLine, LinkState, ErrorReason, Instant, LibraryFile, Me,
  MemberRecord, MemoryData, MemoryLine, ModelMode, WaitingMemory, PauseState, RefreshList, ResourceKey, ResourceStatus, RoutineDef, RoutineRun, SkillDef, SupportGrant, Trace, UsageData,
} from '../types'
import type { ChatSummary } from '../../../shared/contract/chats'
import type { Problem } from '../../../shared/contract/problem'
import type { SetAsideReason, SetAsideRecord } from '../../../shared/contract/state'
import type { TodayAside } from '../../../shared/contract/today'
import type { TeamRequestRecord } from '../../../shared/contract/team-requests'
import type { RoutineRunHistory, RoutineState } from '../../../shared/contract/routines'
import { postDeleted, postSessionReset, putPin, putTitle, readChat, readChats, saveChat } from './chats'
import { ACTIVITY_PAGE, readActivityPage, splitActivity } from './activity'
import { postNoticesRead, readNotifications } from './bell'
import { PLACES, libraryDownloadPath, postLibraryWrite, readLibrary, uploadLibraryFile } from './library'
import { putAside, readToday } from './today'
import { postSkillDelete, readSkillPage, readSkills } from './skills'
import { fromOpen, postTeamRequest, putWithdrawn, readOpenRequests, requestKey, requestWords } from './team-requests'
import { findMemoryLine, forgetMemoryLine, readMemory, readWaitingMemory, reviewLanded, reviewMemoryLine } from './memory'
import { newRunKey, postRoutineRev, postRoutineRun, readRoutineRuns, readRoutines, setRoutineToggle } from './routines'
import { listedModels, readModels } from './models'
import type { ServedModels } from './models'
import { readPause, setPause } from './pause'
import { postTurn, postTurnAction, readActiveRuns, readTrace } from './runs'
import { ChatSocket } from './stream/socket'
import type { SocketLike, SocketParts } from './stream/socket'
import { readUsage, readUsageMonths } from './usage'
import { MESSAGE, Transport } from './transport'
import type { Contract, TransportOptions } from './transport'

const UNAVAILABLE = 'Not connected yet.'

/** The resources this client reads. Every other key has nothing to read until its phase, so it reads as ready and empty. */
type Loaded = 'meta' | 'members' | 'grants' | 'audit' | 'memory' | 'usage' | 'models' | 'chat' | 'activity' | 'notifications' | 'library' | 'routines' | 'skills' | 'requests' | 'problems'
const LOADED: readonly ResourceKey[] = ['meta', 'members', 'grants', 'audit', 'memory', 'usage', 'models', 'chat', 'activity', 'notifications', 'library', 'routines', 'skills', 'requests', 'problems'] satisfies readonly Loaded[]
/** The lists the agent's work fills: read again when their page opens and when a run ends. */
// `skills`: a chat's run may have saved a brand skill (skill_save).
const REFRESH_LISTS: readonly RefreshList[] = ['library', 'problems', 'activity', 'notifications', 'skills']

export interface HttpAgentOptions extends TransportOptions {
  /** Epoch ms. The real clock by default; the contract target moves it on (`advance`). */
  now?: () => number
  /** Opens the chat socket (route 34). A browser WebSocket to the page's own origin by default; a test passes a fake. */
  openSocket?: () => SocketLike
  /** The socket's reconnect timer (a test moves it on). */
  after?: (fn: () => void, ms: number) => unknown
}

/**
 * Route 32 (the run replay) is served since W1's history PR (#163, which flushes a turn's rows before it answers) is in
 * `fleet/agent-chat`: `activeRuns()` reads it, and a reload follows the runs it names. A test pins it on.
 */
export const ACTIVE_RUNS_WIRED = true

/** The chat socket's version in the URL (`?v=`): the contract's `CHAT_PROTOCOL_VERSION`, which this plain file can't import. */
const SOCKET_VERSION = 1
/** The list's page size. */
const CHAT_PAGE = 50


/** No data has arrived: every list empty, `status` `loading`. */
const EMPTY_DATA: AgentData = {
  status: 'loading',
  meta: {
    brand: { name: '', staff: 0, sells: '', emailDomain: '' },
    agent: { tone: '', signsEmailsAs: '' },
    currentUser: { id: '', name: '', initials: '', email: '', title: '', role: '' },
  },
  problems: [],
  tools: { connected: [], channels: [], beingConnected: [], lastRead: { default: instantOf(0) }, catalog: [], details: {}, connection: {}, setup: {}, readDone: 0 },
  routines: [],
  skills: [],
  skillSuggestions: [],
  usage: { month: '', cap: { minor: 0, currency: 'USD' }, alertAt: 0, total: { minor: 0, currency: 'USD' }, conversations: 0, questionsAsked: 0, jobsRun: 0, daily: [], breakdown: { person: [], job: [], model: [], tool: [] } },
  usageMonths: [],
  people: { members: [], approvalRules: [], supportGrant: null, runLimits: { jobsAgentMayFinish: [], alwaysWaitsForAPerson: [], dailyActionLimit: 0, largestRestockUnits: 0 } },
  memory: { team: [], personal: [] },
  auditLog: [],
  activity: { today: [], earlier: [] },
  notifications: { teamRequests: [] },
  models: [],
  defaultModel: '',
  chat: { chats: [], recentCount: 0, suggestions: [] },
  library: { places: [] },
  more: { audit: false, members: false },
  resources: Object.fromEntries(RESOURCE_KEYS.map(k => [k, { status: 'loading' }])) as Record<ResourceKey, ResourceStatus>,
  help: [],
}

/** Nothing done yet. */
const EMPTY_STATE: AgentState = {
  approved: {}, sent: {}, undone: {}, edits: {}, paused: null, toggles: {},
  routinesExtra: [], skillsExtra: [], requestedTools: {}, requestedSkills: {}, toolPaused: {},
  forgot: {}, settings: {}, teamRequests: [], readNotices: {}, libraryDeleted: {},
  setAside: {}, routinesDeleted: {}, routineRuns: [],
  chatTitles: {}, chatPinned: {}, chatDeleted: {},
}
const NO_FILES: LibraryFile[] = []
/** The Library's order: newest first, ties by id (the server's order). */
const byNewest = (a: LibraryFile, b: LibraryFile) => b.at.ms - a.at.ms || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0)
/** How many chats the sidebar lists under Recent chats (the demo's number). */
const RECENT_CHATS = 4

/** The parts of the snapshot that follow from the chats and the pause: custom titles, pins, deletes, and when the agent was paused. */
function chatState(s: Slices): AgentState {
  const chatTitles: Record<string, string> = {}
  const chatPinned: Record<string, true> = {}
  const chatDeleted: Record<string, true> = {}
  for (const c of s.chats) {
    if (c.customTitle !== null) chatTitles[c.id] = c.customTitle
    if (c.pinned) chatPinned[c.id] = true
    if (c.deleted) chatDeleted[c.id] = true
  }
  return { ...s.state, chatTitles, chatPinned, chatDeleted, paused: s.pause.paused ? s.pause.at : null }
}
const replaceChat = (list: ChatSummary[], c: ChatSummary): ChatSummary[] => (list.some(x => x.id === c.id) ? list.map(x => (x.id === c.id ? c : x)) : [c, ...list])
/** A chat's place in the list: newest activity first, ties by id (the server's order). */
const byRecent = (a: ChatSummary, b: ChatSummary) => b.at.ms - a.at.ms || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0)

/** The resources with no read until their phase. */
const NOTHING_TO_READ = Object.fromEntries(RESOURCE_KEYS.filter(k => !LOADED.includes(k)).map(k => [k, { status: 'ready' }])) as Record<ResourceKey, ResourceStatus>

/** Everything the client holds. Replaced, never changed in place, so a snapshot's identity moves only with a change. */
interface Slices {
  me: Me | null
  members: MemberRecord[]
  /** Cursor of the next page, or null on the last. */
  membersNext: string | null
  audit: AuditLine[]
  auditNext: string | null
  grant: SupportGrant | null
  /** P3 (W6): the Memory and Team memory pages' lines (route 43); a forgotten line stays, marked in `state.forgot`. */
  memory: MemoryData
  /** P3 (W5): the chats read so far (route 22), newest first, deleted ones included (marked): the list, the titles, pins and deletes come from them. */
  chats: ChatSummary[]
  chatsNext: string | null
  /** Route 38 as the server last said it, and the models the picker and the Models page list (`listedModels`). */
  served: ServedModels | null
  modelList: ModelMode[]
  /** Route 42: this month's usage, and each month the server lists (this one first). */
  usage: UsageData | null
  usageMonths: UsageData[]
  /** Route 35. */
  pause: PauseState
  /** Route 59, the first page: Activity's lines, newest first (split into today and earlier when `read()` builds the data). */
  activity: ActivityLine[]
  /** Route 60: the bell's notifications, newest first. Replaced, never changed in place, so `listNotifications()` is stable between changes. */
  notifications: AgentNotification[]
  /** Route 62: the Library's live files, newest first. Replaced, never changed in place, so `listFiles()` is stable between changes. */
  files: LibraryFile[]
  /** Files this client deleted, as last known (their `rev` is what an Undo sends): out of `files` until restored. */
  gone: Record<string, LibraryFile>
  /** Route 52: the routines (each one's switch is the `r:<id>` toggle in `state`), and the deleted ones (Undo restores them by their rev). */
  routines: RoutineDef[]
  routinesGone: RoutineDef[]
  /** Route 79: the skills the agent has (P6a W3). */
  skills: SkillDef[]
  /** Route 80: the brand's open requests to the Inhouse team; `state.teamRequests`, `requestedTools` and `requestedSkills` are made from them. */
  requests: TeamRequestRecord[]
  /** Route 57: Today's cards (set aside ones left out), the records of every card of the shown run (their `rev` is what the next set-aside sends), and the cards this client set aside (out of `problems` until put back). */
  problems: Problem[]
  aside: Record<string, TodayAside>
  asideStash: Record<string, { problem: Problem; index: number }>
  /** The record revision last read for each setting key (a key never set is absent: rev 0). */
  revs: Record<string, number>
  state: AgentState
  res: Record<ResourceKey, ResourceStatus>
}

type SettingValue = string | boolean | null

/** A refusal. A caller that doesn't await must not raise an unhandled rejection; one that awaits still gets it. */
const guard = <T,>(p: Promise<T>): Promise<T> => { p.catch(() => undefined); return p }
const rejected = <T,>(): Promise<T> => guard(Promise.reject<T>(new AgentError('unavailable', UNAVAILABLE)))

const PENDING = 'pending'
/** Base64 to bytes, or null for text that isn't base64 (the caller refuses it: `atob` throws on it). */
const decode = (b64: string): Uint8Array | null => {
  try { return Uint8Array.from(atob(b64), c => c.charCodeAt(0)) } catch { return null }
}
const initialsOf = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join('')
const ROLE_LABEL = { member: 'Member', admin: 'Admin', inhouse: 'Inhouse team' } as const
const isLive = (g: SupportGrant, now: number) => g.endedAt === null && g.endsAt.ms > now
const replaceById = (list: MemberRecord[], m: MemberRecord) => (list.some(x => x.id === m.id) ? list.map(x => (x.id === m.id ? m : x)) : [...list, m])

export class HttpAgent implements AgentClient {
  private noticeListeners = new Set<(n: AgentNotice) => void>()
  private listeners = new Set<() => void>()
  private readonly http: Transport
  private readonly now: () => number
  private s: Slices = {
    me: null, members: [], membersNext: null, audit: [], auditNext: null, grant: null, memory: EMPTY_DATA.memory, chats: [], chatsNext: null, served: null, modelList: [],
    usage: null, usageMonths: [], pause: { paused: false, at: null, by: null }, activity: [], notifications: [], files: NO_FILES, gone: {}, routines: [], routinesGone: [], skills: [], requests: [], problems: [], aside: {}, asideStash: {}, revs: {}, state: EMPTY_STATE, res: EMPTY_DATA.resources,
  }
  private readonly socket: ChatSocket
  private readonly origin: string
  /** The schemas, once the chunk has loaded (it starts loading with the client). */
  private k: Contract | null = null
  private dataCache = new WeakMap<Slices, { live: boolean; data: AgentData }>()
  private lastBuilt: { s: Slices; live: boolean; data: AgentData } | null = null
  private loading: Promise<void> | null = null
  /** The retries under way, by resource. */
  private readonly retrying = new Map<ResourceKey, Promise<void>>()
  private paging = new Set<'audit' | 'members'>()
  private expiry: ReturnType<typeof setTimeout> | undefined
  /**
   * The last value the server confirmed for a record: what a refused write goes back to. `setting:<key>`, `member:<id>`,
   * `grant`, and `photo:<id>` for the signed-in person's photo (it is on `me` and on their row, and the client may hold no
   * row for them). Filled only from what the server answered (`takeMe`, `confirmMember`, a write's answer or refusal), never
   * from what the screen shows.
   */
  private confirmed = new Map<string, unknown>()
  /** Writes in flight per record, and the end of the chain each record's next write waits for. */
  private lanes = new Map<string, Promise<void>>()
  private depth = new Map<string, number>()

  constructor(o: HttpAgentOptions = {}) {
    this.http = new Transport(o)
    this.now = o.now ?? (() => Date.now())
    this.origin = o.origin ?? ''
    this.socket = new ChatSocket({
      open: o.openSocket ?? (() => this.browserSocket()),
      parts: async (): Promise<SocketParts> => {
        const { SOCKET } = await this.http.contract()
        return {
          accepts: SOCKET.accepts,
          parseEvent: raw => { const r = SOCKET.event.safeParse(raw); return r.success ? r.data : null },
          logSkip: seq => console.warn(`Inhouse: skipped an event it could not read (seq ${seq}).`),
          parseControl: raw => {
            const r = SOCKET.message.safeParse(raw)
            return r.success && (r.data.type === 'attached' || r.data.type === 'refused') ? r.data : null
          },
        }
      },
      onReauth: () => this.reauth(),
      onGrantEnded: () => this.dropPrivileged(),
      ...(o.after ? { after: o.after } : {}),
    })
    // A chunk that fails to load is reported where a write needs it, not here.
    this.http.contract().then(k => { this.k = k }, () => undefined)
  }

  /**
   * A write that needs the schemas: it runs at once when they are here (so its change shows in the same turn), and after
   * they arrive when it was called before (a write made before the first reads are in).
   */
  private needs<A extends unknown[]>(run: (k: Contract, ...a: A) => Promise<void>): (...a: A) => Promise<void> {
    return (...a) => (this.k ? run(this.k, ...a) : guard(this.http.contract().then(k => run(k, ...a), (e: unknown) => {
      // The schemas chunk couldn't load (offline, a stale deploy): a fault of the client, told once, nothing sent.
      console.error('Inhouse: the schemas chunk did not load.', e)
      throw this.fail(new AgentError('unavailable', MESSAGE.unavailable))
    })))
  }

  // ---------- state ----------

  /** Replaces the slices and tells the listeners. */
  private commit(next: Slices) {
    // What follows from the chats, the pause and the settings is worked out here, so every change to them (a read, a write, a
    // refusal taking one back) keeps it in step.
    if (next.chats !== this.s.chats || next.pause !== this.s.pause) next = { ...next, state: chatState(next) }
    if (next.served !== this.s.served || next.state.settings !== this.s.state.settings) {
      const modelList = listedModels(next.served, next.state.settings)
      if (modelList.length !== next.modelList.length || modelList.some((m, i) => m !== next.modelList[i])) next = { ...next, modelList }
    }
    this.s = next
    this.listeners.forEach(l => l())
  }
  private patch(p: Partial<Slices>) { this.commit({ ...this.s, ...p }) }

  getSnapshot = () => this.s.state
  read = (): AgentData => {
    const g = this.s.grant
    const live = g ? isLive(g, this.now()) : false
    const hit = this.dataCache.get(this.s)
    if (hit && hit.live === live) return hit.data
    // A change to what read() doesn't carry (a setting, a switch) leaves its object alone, so nothing re-renders for it.
    const last = this.lastBuilt
    const same = last && last.live === live && (['me', 'members', 'membersNext', 'audit', 'auditNext', 'grant', 'memory', 'chats', 'modelList', 'served', 'usage', 'usageMonths', 'activity', 'routines', 'skills', 'problems', 'res'] as const).every(k => last.s[k] === this.s[k])
    const data = same ? last.data : this.build(live)
    this.dataCache.set(this.s, { live, data })
    this.lastBuilt = { s: this.s, live, data }
    return data
  }
  private build(live: boolean): AgentData {
    const { me, members, grant } = this.s
    const meta = this.s.res.meta
    const person = me ? { id: me.memberId, name: me.name, initials: initialsOf(me.name), email: me.email ?? '', title: members.find(m => m.id === me.memberId)?.title ?? '', role: ROLE_LABEL[me.role] } : EMPTY_DATA.meta.currentUser
    return {
      ...EMPTY_DATA,
      status: meta.status === 'ready' ? 'ready' : 'loading',
      meta: { ...EMPTY_DATA.meta, brand: { ...EMPTY_DATA.meta.brand, staff: members.filter(m => m.status === 'active').length }, currentUser: person },
      people: { ...EMPTY_DATA.people, members, supportGrant: grant ? { ...grant, live } : null },
      auditLog: this.s.audit,
      memory: this.s.memory,
      routines: this.s.routines,
      skills: this.s.skills,
      problems: this.s.problems,
      activity: splitActivity(this.s.activity, this.now(), { timeZone: this.s.state.settings['g:tz'] ?? deviceTimeZone(), locale: 'en-US' }),
      ...(this.s.usage ? { usage: this.s.usage, usageMonths: this.s.usageMonths } : {}),
      models: this.s.modelList,
      defaultModel: this.s.served?.default ?? '',
      chat: { chats: this.s.chats.map(c => ({ id: c.id, title: c.title, at: c.at, turns: [] })), recentCount: Math.min(this.s.chats.length, RECENT_CHATS), suggestions: [] },
      library: { places: PLACES },
      more: { audit: this.s.auditNext !== null, members: this.s.membersNext !== null },
      resources: this.s.res,
    }
  }
  me = (): Me | null => this.s.me
  /** Reads start with the first listener (the app's first render), and again never. */
  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    void this.whenLoaded()
    return () => { this.listeners.delete(listener) }
  }
  onNotice = (l: (n: AgentNotice) => void) => { this.noticeListeners.add(l); return () => { this.noticeListeners.delete(l) } }
  allChatIds = () => this.s.chats.map(c => c.id)

  private notify(n: AgentNotice) { this.noticeListeners.forEach(l => l(n)) }

  // ---------- reads ----------

  /** Starts the first reads (once) and resolves when every one has finished, whatever its result. */
  whenLoaded(): Promise<void> {
    return (this.loading ??= this.loadAll())
  }

  private async loadAll() {
    if (!(await this.loadMeta())) return
    await Promise.all([this.loadMembers(), this.loadGrants(), this.loadAudit(), this.loadMemory(), this.loadChats(), this.loadModels(), this.loadUsage(), this.loadPause(), this.loadActivity(), this.loadNotifications(), this.loadLibrary(), this.loadRoutines(), this.loadSkills(), this.loadTeamRequests(), this.loadProblems()])
  }

  private setStatus(k: ResourceKey, status: ResourceStatus) { this.patch({ res: { ...this.s.res, [k]: status } }) }
  /** A 401, or a 403 that says the person isn't on the team (never invited, or removed): the signed-out state, whichever request met it. */
  private static gone(err: AgentError): boolean {
    return err.code === 'unauthorized' || (err.code === 'forbidden' && (err.reason === REASON.notInvited || err.reason === REASON.removed))
  }
  private failStatus(k: ResourceKey, e: unknown) {
    const err = e instanceof AgentError ? e : new AgentError('unknown', MESSAGE.unknown)
    const status: ResourceStatus = { status: 'error', error: err.code, ...(err.reason ? { reason: err.reason } : {}) }
    this.patch({ res: { ...this.s.res, [k]: status, ...(HttpAgent.gone(err) ? { meta: status } : {}) } })
  }

  /** `me` first (the settings UI fails closed until it arrives), then the settings of every scope this person can read. Fails `meta` on any error. */
  private async loadMeta(): Promise<boolean> {
    try {
      const me = await this.http.call({ method: 'GET', path: '/api/me', schema: 'me' })
      this.takeMe(me)
      // Personal settings belong to a member; the Inhouse team has none.
      const scopes = me.role === 'inhouse' ? ['brand', 'technical'] : ['personal', 'brand', 'technical']
      const lists = await Promise.all(scopes.map(scope => this.http.call({ method: 'GET', path: `/api/settings/${scope}`, schema: 'settings' })))
      const settings: Record<string, string> = {}
      const toggles: Record<string, boolean> = {}
      const revs: Record<string, number> = {}
      for (const { items } of lists) for (const r of items) {
        revs[r.key] = r.rev
        this.confirmed.set(`setting:${r.key}`, r.value)
        if (typeof r.value === 'string') settings[r.key] = r.value
        else if (typeof r.value === 'boolean') toggles[r.key] = r.value
      }
      // The resources this client has nothing for yet are ready and empty, as `meta` is.
      // A routine's switch (`r:<id>`) comes from route 52, not the settings: a settings reload keeps it.
      for (const [key, on] of Object.entries(this.s.state.toggles)) if (key.startsWith('r:')) toggles[key] = on
      this.patch({ revs, state: { ...this.s.state, settings, toggles }, res: { ...this.s.res, ...NOTHING_TO_READ, meta: { status: 'ready' } } })
      return true
    } catch (e) {
      // Signed out (401) or not on the team (a 403 with reason not invited or removed): `meta` says so, and nothing else is read.
      this.failStatus('meta', e)
      return false
    }
  }

  private async loadMembers() {
    if (this.s.me && !this.s.me.can.viewMembers) return this.setStatus('members', { status: 'ready' })
    try {
      const page = await this.http.call({ method: 'GET', path: '/api/members', schema: 'members' })
      const items = page.items.map(this.newest)
      items.forEach(this.confirmMember)
      this.patch({ members: items, membersNext: page.nextCursor, res: { ...this.s.res, members: { status: 'ready' } } })
      // The requests' "sent by <name>" lines use the names just read.
      this.commit(this.withRequests(this.s, this.s.requests))
    } catch (e) { this.failStatus('members', e) }
  }

  /** Route 16 is for Admins and the Inhouse team: a person who can't grant isn't asked, and a 403 there reads as "not for you", not an error. */
  private async loadGrants() {
    // Admins can grant and the Inhouse team can read the grants (route 16); anyone else isn't asked.
    if (this.s.me && !this.s.me.can.grantSupport && this.s.me.role !== 'inhouse') return this.setStatus('grants', { status: 'ready' })
    try {
      const { items } = await this.http.call({ method: 'GET', path: '/api/grants', schema: 'grants' })
      this.confirmed.set('grant', items[0] ?? null)
      this.patch({ grant: items[0] ?? null, res: { ...this.s.res, grants: { status: 'ready' } } })
      this.watchExpiry()
    } catch (e) {
      // The Member's 403 is expected; a 403 that says the person left the team is not.
      if (e instanceof AgentError && e.code === 'forbidden' && !HttpAgent.gone(e)) return this.setStatus('grants', { status: 'ready' })
      this.failStatus('grants', e)
    }
  }

  private async loadAudit() {
    if (this.s.me && !this.s.me.can.viewAudit) return this.setStatus('audit', { status: 'ready' })
    try {
      const page = await this.http.call({ method: 'GET', path: '/api/audit', schema: 'audit' })
      this.patch({ audit: page.items, auditNext: page.nextCursor, res: { ...this.s.res, audit: { status: 'ready' } } })
    } catch (e) { this.failStatus('audit', e) }
  }

  /**
   * Route 43. The Inhouse team isn't asked on start: under a grant every read writes a `support.access` line, so it reads
   * memory only when asked (`retry('memory')`, when its page opens). Without a live grant it's refused (a 403 that
   * isn't "left the team"): nothing to show, not an error.
   */
  private refreshing: Promise<void> | null = null
  /** The Memory page opened: reads memory again (the boot read doesn't hold what the agent saved since). */
  refreshMemory = (): Promise<void> => (this.refreshing ??= this.loadMemory(true).finally(() => { this.refreshing = null }))

  private refreshingList = new Map<RefreshList, Promise<void>>()
  /** Lists asked again (a run ended) while their read was on its way: that read may have left before the change. */
  private refreshAgain = new Set<RefreshList>()
  /**
   * A list page opened (or the bell's list, on any page): reads that list again, without the page showing as loading. The
   * agent's work since the first read (a file a chat saved, the cards a Run now found) isn't in it. Nothing before the
   * first read is in (or while it failed: Retry is the way back); a failure leaves what is shown. One read at a time: an
   * open while one runs joins it.
   */
  refresh = (list: RefreshList): Promise<void> => this.refreshList(list, false)
  /** `again`: something changed after a running read left (a run ended), so one more read follows it. */
  private refreshList(list: RefreshList, again: boolean): Promise<void> {
    if (this.s.res[list].status !== 'ready') return Promise.resolve()
    const running = this.refreshingList.get(list)
    if (running) { if (again) this.refreshAgain.add(list); return running }
    const p = (async () => {
      do { this.refreshAgain.delete(list); await this.loadList(list) } while (this.refreshAgain.has(list))
    })().finally(() => { this.refreshingList.delete(list) })
    this.refreshingList.set(list, p)
    return p
  }
  private loadList(list: RefreshList): Promise<void> {
    return { library: () => this.loadLibrary(true, true), problems: () => this.loadProblems(true, true), activity: () => this.loadActivity(true, true), notifications: () => this.loadNotifications(true), requests: () => this.loadTeamRequests(true), skills: () => this.loadSkills(true, true) }[list]()
  }
  /** A run ended: what its work fills may have changed. The Inhouse team isn't read for it (it didn't ask, and a read under a grant is logged). */
  private afterRun() {
    void this.refreshUsage()
    if (this.s.me?.role === 'inhouse') return
    for (const list of REFRESH_LISTS) void this.refreshList(list, true)
  }

  private async loadMemory(asked = false) {
    if (this.s.me?.role === 'inhouse' && !asked) return this.setStatus('memory', { status: 'ready' })
    try {
      const memory = await readMemory(this.http)
      this.patch({ memory, res: { ...this.s.res, memory: { status: 'ready' } } })
    } catch (e) {
      if (e instanceof AgentError && e.code === 'forbidden' && !HttpAgent.gone(e)) return this.setStatus('memory', { status: 'ready' })
      this.failStatus('memory', e)
    }
  }

  /**
   * Route 22, the first page. Like memory, the Inhouse team isn't asked on start: under a grant every read writes a
   * `support.access` line, so it reads chats only when asked. Without a live grant it's refused: nothing to show.
   */
  private async loadChats(asked = false) {
    if (this.s.me?.role === 'inhouse' && !asked) return this.setStatus('chat', { status: 'ready' })
    try {
      const page = await readChats(this.http, { limit: CHAT_PAGE })
      this.patch({ chats: this.mergeChats(page.items), chatsNext: page.nextCursor, res: { ...this.s.res, chat: { status: 'ready' } } })
    } catch (e) {
      if (e instanceof AgentError && e.code === 'forbidden' && !HttpAgent.gone(e)) return this.setStatus('chat', { status: 'ready' })
      this.failStatus('chat', e)
    }
  }
  /** Chats as the server sent them, merged into what is held: a record never goes back to an older rev (a write's answer may be newer than a page read before it). */
  private mergeChats(items: ChatSummary[]): ChatSummary[] {
    let list = this.s.chats
    for (const c of items) {
      const have = list.find(x => x.id === c.id)
      if (have && have.rev > c.rev) continue
      this.confirmed.set(`chat:${c.id}`, c)
      list = replaceChat(list, c)
    }
    // Nothing held is dropped for being absent from a page: a chat made a moment ago may not be on it yet.
    return [...list].sort(byRecent)
  }

  /**
   * Route 59, the first page. Like memory and chats, the Inhouse team isn't asked on start: under a grant every read writes
   * a `support.access` line, so it reads Activity only when asked. Without a live grant it's refused: nothing to show.
   */
  private async loadActivity(asked = false, refresh = false) {
    if (this.s.me?.role === 'inhouse' && !asked) return this.setStatus('activity', { status: 'ready' })
    try {
      const page = await readActivityPage(this.http, { limit: ACTIVITY_PAGE })
      this.patch({ activity: page.items, res: { ...this.s.res, activity: { status: 'ready' } } })
    } catch (e) {
      if (refresh) return this.afterRefreshFailed(e, 'Activity')
      if (e instanceof AgentError && e.code === 'forbidden' && !HttpAgent.gone(e)) return this.setStatus('activity', { status: 'ready' })
      this.failStatus('activity', e)
    }
  }

  /** Route 62, every page. As Activity: the Inhouse team reads it only when asked (each read writes a `support.access` line). */
  private async loadLibrary(asked = false, refresh = false) {
    if (this.s.me?.role === 'inhouse' && !asked) return this.setStatus('library', { status: 'ready' })
    try {
      let files: LibraryFile[] | null = null
      // A read a Library write overtook (it finished, or is still on its way, after the read began) may predate it: its
      // answer would undo what the write did. Read again once the writes are done, a few times at most.
      for (let tries = 0; files === null && tries < 3; tries++) {
        await this.lanes.get('library')
        const finished = this.libraryWritesDone
        const read = await readLibrary(this.http)
        if (this.libraryWritesDone === finished && this.libraryInFlight.size === 0) files = read
      }
      if (files === null) return
      // A file this client holds as deleted that the server lists live was restored elsewhere: it isn't ours to undo now.
      const live = new Set(files.map(f => f.id))
      const gone = Object.fromEntries(Object.entries(this.s.gone).filter(([id]) => !live.has(id)))
      this.patch({ files, gone, res: { ...this.s.res, library: { status: 'ready' } } })
    } catch (e) {
      if (refresh) return this.afterRefreshFailed(e, 'the Library')
      if (e instanceof AgentError && e.code === 'forbidden' && !HttpAgent.gone(e)) return this.setStatus('library', { status: 'ready' })
      this.failStatus('library', e)
    }
  }

  /**
   * Route 52. Like Activity, the Inhouse team reads it only when asked (each read under a grant writes a support.access
   * line); without a live grant it's refused: nothing to show.
   */
  private async loadRoutines(asked = false) {
    if (this.s.me?.role === 'inhouse' && !asked) return this.setStatus('routines', { status: 'ready' })
    try {
      const list = await readRoutines(this.http)
      this.commit(this.withRoutines(this.s, list.routines, list.deleted, list.enabled))
      this.setStatus('routines', { status: 'ready' })
    } catch (e) {
      if (e instanceof AgentError && e.code === 'forbidden' && !HttpAgent.gone(e)) return this.setStatus('routines', { status: 'ready' })
      this.failStatus('routines', e)
    }
  }

  /** Route 80: the open requests. A failed read leaves "Requested" unmarked and the window's list empty; told in the console. */
  private async loadTeamRequests(asked = false) {
    try {
      const { items } = await readOpenRequests(this.http)
      this.commit(this.withRequests({ ...this.s, res: { ...this.s.res, requests: { status: 'ready' } } }, items))
    } catch (e) {
      // A refresh that fails leaves what is shown (the window's list); the first read and Retry show it.
      if (!asked || this.s.res.requests.status !== 'ready') this.failStatus('requests', e)
    }
  }
  /** The open requests as the pages read them: the list, and the "Requested" marks, all from the one list. */
  private withRequests(s: Slices, requests: TeamRequestRecord[]): Slices {
    const name = (id: string) => s.members.find(m => m.id === id)?.name ?? null
    return { ...s, requests, state: { ...s.state, ...fromOpen(requests, name) } }
  }
  /** Route 81's cap refusal in the page's words. */
  private static requestRefusal(e: unknown): unknown {
    if (e instanceof AgentError && e.code === 'forbidden' && e.reason === REASON.requestLimit) return new AgentError('forbidden', 'Your Inhouse team already has 50 open requests. Wait for an answer, or take back one of yours.', { reason: e.reason })
    return e
  }
  /**
   * Route 79: the skills the agent has, ours then the brand's own (technical: everyone reads without a grant; route 84's
   * full text is brand data). A skill's instructions already read stay while it hasn't changed. `quiet` (a refresh): a
   * failure leaves what is shown.
   */
  private async loadSkills(_asked = false, quiet = false) {
    try {
      const list = await readSkills(this.http)
      const before = new Map(this.s.skills.map(s => [s.n, s]))
      const skills = list.map(s => {
        const old = before.get(s.n)
        return old?.body !== undefined && old.updatedAt?.ms === s.updatedAt?.ms ? { ...s, body: old.body, tools: old.tools, updatedAt: old.updatedAt } : s
      })
      this.patch({ skills })
      this.setStatus('skills', { status: 'ready' })
    } catch (e) {
      if (quiet) return console.warn('Inhouse: could not read the skills again.', e instanceof Error ? e.message : e)
      if (e instanceof AgentError && e.code === 'forbidden' && !HttpAgent.gone(e)) return this.setStatus('skills', { status: 'ready' })
      this.failStatus('skills', e)
    }
  }

  /**
   * Route 57. As Activity: the Inhouse team reads it only when asked (each read under a grant writes a support.access line).
   * The cards come as the server lists them (set aside ones left out); `state.setAside` holds the records of the hidden ones.
   */
  private async loadProblems(asked = false, refresh = false) {
    if (this.s.me?.role === 'inhouse' && !asked) return this.setStatus('problems', { status: 'ready' })
    try {
      // A read a card's write overlapped may predate it (the card back, its Undo lost): read again once the writes are done.
      // Every try overlapped: a refresh keeps what is shown; a first read or a Retry takes one more read as it comes, so
      // the page never stays loading.
      const today = (await this.unraced('problems', () => readToday(this.http))) ?? (refresh || this.s.res.problems.status === 'ready' ? null : await this.plainRead('problems', () => readToday(this.http)))
      if (today === null) return
      this.commit(this.withToday(this.s, today.items, today.aside))
      this.setStatus('problems', { status: 'ready' })
    } catch (e) {
      if (refresh) return this.afterRefreshFailed(e, 'Today')
      if (e instanceof AgentError && e.code === 'forbidden' && !HttpAgent.gone(e)) return this.setStatus('problems', { status: 'ready' })
      this.failStatus('problems', e)
    }
  }

  /** The cards and records as given; `state.setAside` is the records of the cards left out (a snooze that has ended lists its card again, so it isn't one). */
  private withToday(s: Slices, problems: Problem[], aside: Record<string, TodayAside>): Slices {
    const listed = new Set(problems.map(p => p.id))
    const setAside: Record<string, SetAsideRecord> = {}
    for (const [id, r] of Object.entries(aside)) if (r.reason !== null && !listed.has(id)) setAside[id] = { reason: r.reason, at: r.at, by: r.by, loggedAt: r.loggedAt }
    const asideStash = Object.fromEntries(Object.entries(s.asideStash).filter(([id]) => id in setAside))
    return { ...s, problems, aside, asideStash, state: { ...s.state, setAside } }
  }

  /** Route 60. The Inhouse team has no bell (the route is the brand team's), so it isn't asked. */
  private async loadNotifications(refresh = false) {
    if (this.s.me?.role === 'inhouse') return this.setStatus('notifications', { status: 'ready' })
    try {
      // As Today: a read that a mark-read overlapped would put the dots back.
      const notifications = (await this.unraced('notifications', () => readNotifications(this.http))) ?? (refresh || this.s.res.notifications.status === 'ready' ? null : await this.plainRead('notifications', () => readNotifications(this.http)))
      if (notifications === null) return
      this.patch({ notifications, res: { ...this.s.res, notifications: { status: 'ready' } } })
    } catch (e) {
      if (refresh) return this.afterRefreshFailed(e, 'the notifications')
      if (e instanceof AgentError && e.code === 'forbidden' && !HttpAgent.gone(e)) return this.setStatus('notifications', { status: 'ready' })
      this.failStatus('notifications', e)
    }
  }

  /** Route 38. */
  private async loadModels() {
    try { this.patch({ served: await readModels(this.http), res: { ...this.s.res, models: { status: 'ready' } } }) } catch (e) { this.failStatus('models', e) }
  }
  /** Route 42: this month and each month the server lists. */
  private async loadUsage() {
    try {
      const { usage, usageMonths } = await readUsageMonths(this.http)
      this.patch({ usage, usageMonths, res: { ...this.s.res, usage: { status: 'ready' } } })
    } catch (e) { this.failStatus('usage', e) }
  }
  /** This month's usage again (after a turn ends, or a cap or alert save): a failure leaves what is shown. */
  private async refreshUsage() {
    try {
      const usage = await readUsage(this.http)
      const rest = this.s.usageMonths.filter(m => m.monthKey !== usage.monthKey && m.monthKey !== undefined)
      this.patch({ usage, usageMonths: [usage, ...rest] })
    } catch (e) { this.afterRefreshFailed(e, 'the spending') }
  }
  private async refreshModels() {
    try { this.patch({ served: await readModels(this.http) }) } catch (e) { this.afterRefreshFailed(e, 'the models') }
  }
  /** Route 35. */
  private async loadPause() {
    try { this.patch({ pause: await readPause(this.http) }) } catch (e) { console.warn('Inhouse: could not read whether the agent is paused.', e) }
  }

  /**
   * Reads a resource again after its read failed. The ones with nothing to read resolve at once. A retry while one for
   * the same resource is under way joins it, so two clicks make one read and a late answer can't undo an earlier one.
   */
  retry = (resource: ResourceKey): Promise<void> => {
    const load = { meta: () => this.reloadMeta(), members: () => this.loadMembers(), grants: () => this.loadGrants(), audit: () => this.loadAudit(), memory: () => this.loadMemory(true), usage: () => this.loadUsage(), models: () => this.loadModels(), chat: () => this.loadChats(true), activity: () => this.loadActivity(true), notifications: () => this.loadNotifications(), library: () => this.loadLibrary(true), routines: () => this.loadRoutines(true), skills: () => this.loadSkills(true), requests: () => this.loadTeamRequests(true), problems: () => this.loadProblems(true) }[resource as Loaded] as (() => Promise<unknown>) | undefined
    if (!load) return Promise.resolve()
    const running = this.retrying.get(resource)
    if (running) return running
    this.setStatus(resource, { status: 'loading' })
    const p = load().then(() => undefined).finally(() => { this.retrying.delete(resource) })
    this.retrying.set(resource, p)
    return p
  }
  private async reloadMeta() {
    if (await this.loadMeta()) await Promise.all([this.loadMembers(), this.loadGrants(), this.loadAudit(), this.loadMemory(), this.loadChats(), this.loadModels(), this.loadUsage(), this.loadPause(), this.loadActivity(), this.loadNotifications(), this.loadLibrary(), this.loadRoutines(), this.loadSkills(), this.loadTeamRequests(), this.loadProblems()])
  }

  /** The next page of a list. A second call while one is in flight for the same list does nothing. */
  loadMore = async (list: 'audit' | 'members'): Promise<void> => {
    const cursor = list === 'audit' ? this.s.auditNext : this.s.membersNext
    if (cursor === null || this.paging.has(list)) return
    this.paging.add(list)
    try {
      const q = `?cursor=${encodeURIComponent(cursor)}`
      if (list === 'audit') {
        const page = await this.http.call({ method: 'GET', path: `/api/audit${q}`, schema: 'audit' })
        this.patch({ audit: [...this.s.audit, ...page.items], auditNext: page.nextCursor })
      } else {
        const page = await this.http.call({ method: 'GET', path: `/api/members${q}`, schema: 'members' })
        const items = page.items.map(this.newest)
        items.forEach(this.confirmMember)
        this.patch({ members: items.reduce(replaceById, this.s.members), membersNext: page.nextCursor })
      }
    } catch (e) {
      throw this.fail(e)
    } finally { this.paging.delete(list) }
  }

  /** The member list's first page again, merged in (a write changed a record the server also stamps: the rev). */
  private async refreshMembers() {
    try {
      const page = await this.http.call({ method: 'GET', path: '/api/members', schema: 'members' })
      this.commit(page.items.reduce((st, m) => this.takeMember(st, m), this.s))
    } catch (e) { this.afterRefreshFailed(e, 'the team') }
  }
  private async refreshMe() {
    try { this.takeMe(await this.http.call({ method: 'GET', path: '/api/me', schema: 'me' })) } catch (e) { this.afterRefreshFailed(e, 'who is signed in') }
  }
  /**
   * Who is signed in, as the server says. Its photo is confirmed here, so a refused photo write has the server's value to go
   * back to whether or not the team list holds this person's row. A photo write on screen that isn't done yet keeps showing
   * (as `takeMember` keeps it on the row); everything else comes from the server.
   */
  private takeMe(me: Me) {
    this.confirmed.set(`photo:${me.memberId}`, me.photoUrl)
    const cur = this.s.me
    this.patch({ me: cur && cur.memberId === me.memberId && this.depthOf(`member:${me.memberId}:photo`) > 0 ? { ...me, photoUrl: cur.photoUrl } : me })
  }

  /** A read after a save failed: the save stands. A person who has left the team is told like any other request would tell them. */
  private afterRefreshFailed(e: unknown, what: string) {
    if (e instanceof AgentError && HttpAgent.gone(e)) this.failStatus('meta', e)
    else console.warn(`Inhouse: could not read ${what} again.`, e)
  }

  /** The grant stops being live at its end: the snapshot is told then, so a screen showing "live until" moves on. */
  private watchExpiry() {
    clearTimeout(this.expiry)
    const g = this.s.grant
    if (!g || !isLive(g, this.now())) return
    // setTimeout caps at 2^31 ms (24.8 days); a grant is at most 72 hours.
    this.expiry = setTimeout(() => this.patch({}), g.endsAt.ms - this.now() + 50)
  }

  // ---------- writes ----------

  /** A write that never reached the server (the client's own check refused it): nothing changed, the person is told. */
  private refuseLocal<T = void>(code: AgentErrorCode, text: string, reason?: ErrorReason): Promise<T> {
    return guard(Promise.reject<T>(this.fail(new AgentError(code, text, reason ? { reason } : {}))))
  }

  /** Tells the person once and returns the error to reject with. A 401, or a 403 that says the person left the team, puts the client in the signed-out state. */
  private fail(e: unknown): AgentError {
    const err = e instanceof AgentError ? e : new AgentError('unknown', MESSAGE.unknown)
    this.notify({ type: 'error', code: err.code, text: err.message })
    if (HttpAgent.gone(err)) this.failStatus('meta', err)
    return err
  }

  /**
   * Optimistic write. `apply` shows the change at once; `send` saves it; `done` folds the answer in. On failure the change
   * is taken back, `onConflict` puts the server's current record in, and the call rejects after one notice.
   *
   * `lane`: writes that share one record's `rev` (a member's row, a setting) go one at a time. A write sends after the earlier
   * write in its lane has answered, and builds its request in `send`, so it carries the rev that answer (or refusal) left.
   * Lanes don't wait for each other.
   *
   * `field`: what on screen the write changes (a setting, a member's role, a member's photo, the grant). `others` tells
   * `done`, `undo` and `onConflict` that a later write to the same field is queued, whose change is on screen: they then take
   * in only what the server said (the rev), not a value that would undo it. With none queued, a refusal goes back to the
   * field's last server-confirmed value, never to the state this write found (which may hold an earlier, unsaved write).
   * The very objects come back only for a write that found nothing queued before it and saw nothing change since.
   */
  /**
   * Writes to Today's cards (`today:<id>` lanes) and to the bell (`notices`), and how many have finished: what `unraced`
   * checks. `queued` holds each from its call, `inFlight` only once the write ahead of it in its lane is done (it is
   * sending). A write counts as finished once its answer (or refusal) is in, before its `after`, which may read.
   */
  private listWrites = {
    problems: { queued: new Set<Promise<void>>(), inFlight: new Set<Promise<void>>(), done: 0, dirty: false },
    notifications: { queued: new Set<Promise<void>>(), inFlight: new Set<Promise<void>>(), done: 0, dirty: false },
  }
  private static guardedList(lane: string | undefined): 'problems' | 'notifications' | null {
    return lane?.startsWith('today:') ? 'problems' : lane === 'notices' ? 'notifications' : null
  }
  /**
   * A read no write to its list overlapped: read again once the writes sending are done, a few times at most (null: none
   * was). It waits only for writes sending, never for queued ones: a queued write may wait on a write whose `after` is this
   * very read. A read given up on marks the list `dirty`: the last of those writes to finish reads it again (`write`).
   */
  private async unraced<T>(list: 'problems' | 'notifications', read: () => Promise<T>): Promise<T | null> {
    const w = this.listWrites[list]
    for (let tries = 0; tries < 3; tries++) {
      await Promise.all(w.inFlight)
      // A write still waiting in its lane will overlap any read made now.
      if (w.queued.size > w.inFlight.size) break
      const done = w.done
      const answer = await read()
      if (w.done === done && w.queued.size === 0) return answer
    }
    w.dirty = true
    return null
  }
  /** A read taken as it comes (a first read or a Retry every guarded try missed): a write it overlapped marks the list `dirty`. */
  private async plainRead<T>(list: 'problems' | 'notifications', read: () => Promise<T>): Promise<T> {
    const w = this.listWrites[list]
    const done = w.done
    const answer = await read()
    if (w.done !== done || w.queued.size > 0) w.dirty = true
    return answer
  }

  private write<T>(o: {
    lane?: string
    field?: string
    apply: (s: Slices) => Slices
    send: () => Promise<T>
    done: (s: Slices, answer: T, others: boolean) => Slices
    undo: (now: Slices, before: Slices, others: boolean) => Slices
    onConflict?: (s: Slices, current: Record<string, unknown>, others: boolean) => Slices
    after?: () => Promise<void>
  }): Promise<void> {
    const before = this.s
    this.commit(o.apply(before))
    const mine = this.s
    const lane = o.lane
    const field = o.field ?? lane
    const prior = lane ? this.lanes.get(lane) : undefined
    if (field) this.depth.set(field, (this.depth.get(field) ?? 0) + 1)
    const others = () => field !== undefined && (this.depth.get(field) ?? 0) > 1
    const guarded = HttpAgent.guardedList(lane)
    const w = guarded ? this.listWrites[guarded] : null
    let finished = () => {}
    let sending = () => {}
    if (w) {
      const settled: Promise<void> = new Promise(resolve => { finished = () => { if (w.queued.delete(settled)) { w.inFlight.delete(settled); w.done++; resolve() } } })
      sending = () => { if (w.queued.has(settled)) w.inFlight.add(settled) }
      w.queued.add(settled)
    }
    const run = (async () => {
      await prior
      sending()
      try {
        const answer = await o.send()
        this.commit(o.done(this.s, answer, others()))
        finished()
        await o.after?.()
      } catch (e) {
        finished()
        if (!prior && this.s === mine) this.commit(before); else this.commit(o.undo(this.s, before, others()))
        const err = e instanceof AgentError ? e : new AgentError('unknown', MESSAGE.unknown)
        if (err.current && o.onConflict) this.commit(o.onConflict(this.s, err.current, others()))
        throw this.fail(err)
      } finally {
        finished()
        // A read of this list was given up on (or taken as it came) while writes were on their way: the last one reads it
        // again, without holding up this write.
        if (guarded && w?.dirty && w.queued.size === 0) { w.dirty = false; void this.refreshList(guarded, true) }
        if (field) { const n = (this.depth.get(field) ?? 1) - 1; if (n > 0) this.depth.set(field, n); else this.depth.delete(field) }
      }
    })()
    if (lane) {
      const tail = run.then(() => undefined, () => undefined)
      this.lanes.set(lane, tail)
      void tail.then(() => { if (this.lanes.get(lane) === tail) this.lanes.delete(lane) })
    }
    return guard(run)
  }

  // ----- settings -----

  private withValue(s: Slices, key: string, value: SettingValue): Slices {
    const settings = { ...s.state.settings }
    const toggles = { ...s.state.toggles }
    delete settings[key]; delete toggles[key]
    if (typeof value === 'string') settings[key] = value
    else if (typeof value === 'boolean') toggles[key] = value
    return { ...s, state: { ...s.state, settings, toggles } }
  }
  private valueOf(s: Slices, key: string): SettingValue { return s.state.settings[key] ?? s.state.toggles[key] ?? null }

  private putSetting(k: Contract, key: string, raw: SettingValue, kind: 'text' | 'switch'): Promise<void> {
    const row = settingRow(key)
    // `r:` is a routine's switch (route 53, P4 W2); `s:` (a skill) belongs to P5.
    if (kind === 'switch' && /^r:./.test(key) && !row && typeof raw === 'boolean') return this.putRoutineEnabled(k, key.slice(2), raw)
    if (kind === 'switch' && /^[rs]:./.test(key) && !row) return this.refuse()
    if (!row) return this.refuseLocal('invalid', `"${key}" isn't a setting.`, REASON.wrongScope)
    if (raw !== null && !meetsRule(row.rule, raw)) return this.refuseLocal('invalid', `That isn't a value for "${key}".`, REASON.badType)
    // Text is kept as the server keeps it: trimmed.
    const value = typeof raw === 'string' && row.rule.t === 'text' ? raw.trim() : raw
    if (!k.BODIES.settingWrite.safeParse({ value, ifRev: 0 }).success) return this.refuseLocal('invalid', `That isn't a value for "${key}".`, REASON.badType)
    const record = `setting:${key}`
    // The name is on the member's row, so it shares that row's queue (and its rev) with the photo and the role.
    const meId = this.s.me?.memberId
    const lane = key === 'g:name' && meId ? `member:${meId}` : record
    const put = (s: Slices, rec: { value: SettingValue; rev: number }, others: boolean): Slices => {
      this.confirmed.set(record, rec.value)
      let next: Slices = { ...s, revs: { ...s.revs, [key]: rec.rev } }
      // A later write to this key is on screen: its value stays, and this answer only moves the rev it will send.
      if (!others) next = this.withValue(next, key, rec.value)
      return key === 'g:name' && meId ? this.bumpRev(next, meId, rec.rev) : next
    }
    return this.write({
      lane,
      field: record,
      apply: s => this.withValue(s, key, value),
      send: () => {
        // Read when it is sent: after the write before it in the queue has answered. The name's rev is the member row's latest known one.
        const ifRev = key === 'g:name' && meId ? this.revOfRow(meId) : this.s.revs[key] ?? 0
        return this.http.call({ method: 'PUT', path: `/api/settings/${row.scope}/${encodeURIComponent(key)}`, schema: 'setting', json: k.BODIES.settingWrite.parse({ value, ifRev }) })
      },
      done: (s, rec, others) => (others || this.valueOf(s, key) === value ? put(s, rec, others) : { ...s, revs: { ...s.revs, [key]: rec.rev } }),
      undo: (s, _before, others) => (others || this.valueOf(s, key) !== value ? s : this.withValue(s, key, (this.confirmed.get(record) ?? null) as SettingValue)),
      onConflict: (s, current, others) => {
        const rec = k.ANSWERS.setting.safeParse(current)
        return rec.success ? put(s, rec.data, others) : s
      },
      // The name is on the member's record too: its rev and the account menu's name moved.
      after: key === 'g:name' ? async () => { await Promise.all([this.refreshMembers(), this.refreshMe()]) }
        : key === 's:cap' || key === 's:alert' ? () => this.refreshUsage()
          // A model's switch or effort changes what route 38 lists.
          : /^tm:[^:]+:(on|effort)$/.test(key) ? () => this.refreshModels() : undefined,
    })
  }
  setToggle = this.needs((k, key: string, on: boolean) => this.putSetting(k, key, on, 'switch'))
  setSetting = this.needs((k, key: string, value: string | null) => this.putSetting(k, key, value, 'text'))

  // ----- photo -----

  setPhoto = this.needs((_k, memberId: string, dataUrl: string | null): Promise<void> => {
    const me = this.s.me
    if (!me || memberId !== me.memberId) {
      return this.s.members.some(m => m.id === memberId && m.status !== 'removed')
        ? this.refuseLocal('forbidden', 'You can only change your own photo.')
        : this.refuseLocal(NOT_FOUND, MESSAGE[NOT_FOUND])
    }
    let bytes: { data: Uint8Array; type: string } | undefined
    if (dataUrl !== null) {
      const m = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]*={0,2})$/.exec(dataUrl)
      const data = m && m[2].length > 0 && m[2].length % 4 === 0 ? decode(m[2]) : null
      if (!m || !data) return this.refuseLocal('invalid', 'Use a PNG, JPEG or WebP picture.', REASON.badType)
      bytes = { data, type: m[1] }
    }
    const photoAs = (s: Slices, photo: string | null): Slices => ({
      ...s, me: s.me && { ...s.me, photoUrl: photo }, members: s.members.map(x => (x.id === memberId ? { ...x, photo } : x)),
    })
    // What the server last said of this photo: there since `me` arrived (`takeMe`), so a refusal never reads the screen.
    const record = `photo:${memberId}`
    return this.write({
      lane: `member:${memberId}`,
      field: `member:${memberId}:photo`,
      apply: s => photoAs(s, dataUrl),
      send: () => this.http.call({ method: bytes ? 'PUT' : 'DELETE', path: '/api/photo', schema: 'photo', ...(bytes ? { bytes } : {}) }),
      // The answer carries the row's new rev: the next write to the row (the name, the role) is written at it.
      done: (s, r, others) => { this.confirmed.set(record, r.photoUrl); this.confirmRowPhoto(memberId, r.photoUrl, r.rev); return this.bumpRev(others ? s : photoAs(s, r.photoUrl), memberId, r.rev) },
      undo: (s, _before, others) => (others ? s : photoAs(s, this.confirmed.get(record) as string | null)),
      onConflict: (s, current, others) => {
        const photo = typeof current.photoUrl === 'string' ? current.photoUrl : null
        this.confirmed.set(record, photo)
        if (typeof current.rev === 'number') this.confirmRowPhoto(memberId, photo, current.rev)
        const next = others ? s : photoAs(s, photo)
        return typeof current.rev === 'number' ? this.bumpRev(next, memberId, current.rev) : next
      },
      after: () => this.refreshMembers(),
    })
  })

  // ----- the team -----

  /** A member's record as the server sent it. The signed-in person's row carries their photo, confirmed with it. */
  private confirmMember = (m: MemberRecord) => {
    this.confirmed.set(`member:${m.id}`, m)
    if (m.id === this.s.me?.memberId) this.confirmed.set(`photo:${m.id}`, m.photo)
  }
  /** The photo of a member's confirmed row (a photo answer says what the server now holds, before any team read does). */
  private confirmRowPhoto = (id: string, photo: string | null, rev: number) => {
    const c = this.confirmed.get(`member:${id}`) as MemberRecord | undefined
    if (c && rev >= c.rev) this.confirmed.set(`member:${id}`, { ...c, photo })
  }
  private depthOf = (field: string) => this.depth.get(field) ?? 0
  /** A member's rev only ever goes up: a later answer (the photo's refresh, a name save) may already have moved it. */
  private bumpRev = (s: Slices, id: string, rev: number): Slices => {
    const c = this.confirmed.get(`member:${id}`) as MemberRecord | undefined
    if (c && c.rev < rev) this.confirmed.set(`member:${id}`, { ...c, rev })
    // A person whose own row isn't on the page read (the team list pages) still has a rev to write at: the name's.
    const revs = id === s.me?.memberId && (s.revs['g:name'] ?? 0) < rev ? { ...s.revs, 'g:name': rev } : s.revs
    return { ...s, revs, members: s.members.map(m => (m.id === id && m.rev < rev ? { ...m, rev } : m)) }
  }
  /** The latest rev known for a member's row: the list's, or (the signed-in person's own row not being on the page) what their saves left. */
  private revOfRow = (id: string): number => Math.max(this.s.members.find(m => m.id === id)?.rev ?? 0, id === this.s.me?.memberId ? this.s.revs['g:name'] ?? 0 : 0)
  /** A row as the server sent it, unless a newer one is already known: a page served before a write must not lower the rev or bring back a photo. */
  private newest = (m: MemberRecord): MemberRecord => {
    const c = this.confirmed.get(`member:${m.id}`) as MemberRecord | undefined
    return c && c.rev > m.rev ? c : m
  }
  /**
   * The server's record for a member comes in. A field with a write on screen that isn't done yet (a queued role, a photo
   * in flight, `own` still counting itself) keeps what the screen shows; the rev and every other field come from the server.
   */
  private takeMember = (s: Slices, row: MemberRecord, own?: 'role' | 'status' | 'photo'): Slices => {
    const m = this.newest(row)
    this.confirmMember(m)
    const cur = s.members.find(x => x.id === m.id)
    if (!cur) return { ...s, members: [...s.members, m] }
    const keep = (f: 'role' | 'status' | 'photo') => this.depthOf(`member:${m.id}:${f}`) > (own === f ? 1 : 0)
    const next: MemberRecord = { ...m, role: keep('role') ? cur.role : m.role, status: keep('status') ? cur.status : m.status, photo: keep('photo') ? cur.photo : m.photo }
    return { ...s, members: replaceById(s.members, next), me: s.me && s.me.memberId === m.id && !keep('photo') ? { ...s.me, photoUrl: next.photo } : s.me }
  }
  /** A refused member write: its field goes back to what the server last confirmed, unless a later write to that field is on screen. */
  private untakeMember = (id: string, field: 'role' | 'status') => (s: Slices, _before: Slices, others: boolean): Slices => {
    const was = this.confirmed.get(`member:${id}`) as MemberRecord | undefined
    return others || !was || !s.members.some(m => m.id === id) ? s : this.memberAs(id, m => ({ ...m, [field]: was[field] }))(s)
  }
  private memberAs = (id: string, f: (m: MemberRecord) => MemberRecord) => (s: Slices): Slices => ({ ...s, members: s.members.map(m => (m.id === id ? f(m) : m)) })
  private conflictMember = (k: Contract, own: 'role' | 'status') => (s: Slices, current: Record<string, unknown>): Slices => {
    const rec = k.ANSWERS.member.safeParse(current)
    return rec.success ? this.takeMember(s, rec.data, own) : s
  }

  private seq = 0
  inviteMember = this.needs((k, input: Parameters<AgentClient['inviteMember']>[0]): Promise<void> => {
    const body = k.BODIES.invite.safeParse(input)
    if (!body.success) return this.refuseLocal('invalid', 'Check the name and the email.')
    const temp: MemberRecord = { id: `m_pending_${++this.seq}`, name: body.data.name, email: body.data.email.trim().toLowerCase(), title: body.data.title ?? null, role: body.data.role, status: 'invited', photo: null, rev: 1 }
    return this.write({
      apply: s => ({ ...s, members: [...s.members, temp] }),
      send: () => this.http.call({ method: 'POST', path: '/api/members/invites', schema: 'member', json: body.data }),
      // A person invited again keeps their old row: the answer replaces it, and the placeholder goes.
      done: (s, m) => { this.confirmMember(m); return { ...s, members: replaceById(s.members.filter(x => x.id !== temp.id), m) } },
      undo: s => ({ ...s, members: s.members.filter(x => x.id !== temp.id) }),
    })
  })

  setMemberRole = this.needs((k, id: string, role: Parameters<AgentClient['setMemberRole']>[1]): Promise<void> => {
    if (!k.BODIES.role.safeParse(role).success) return this.refuseLocal('invalid', 'A member is an Admin or a Member.')
    return this.write({
      lane: `member:${id}`,
      field: `member:${id}:role`,
      apply: this.memberAs(id, m => ({ ...m, role })),
      send: () => this.http.call({ method: 'PUT', path: `/api/members/${encodeURIComponent(id)}/role`, schema: 'member', json: k.BODIES.roleChange.parse({ role, ifRev: this.revOfRow(id) }) }),
      done: (s, m) => this.takeMember(s, m, 'role'),
      undo: this.untakeMember(id, 'role'),
      onConflict: this.conflictMember(k, 'role'),
      // Changing your own role changes what you may do.
      after: id === this.s.me?.memberId ? () => this.refreshMe() : undefined,
    })
  })

  removeMember = this.needs((k, id: string): Promise<void> => this.write({
    lane: `member:${id}`,
    field: `member:${id}:status`,
    apply: this.memberAs(id, m => ({ ...m, status: 'removed' })),
    send: () => this.http.call({ method: 'DELETE', path: `/api/members/${encodeURIComponent(id)}?ifRev=${this.revOfRow(id)}`, schema: 'member' }),
    done: (s, m) => this.takeMember(s, m, 'status'),
    undo: this.untakeMember(id, 'status'),
    onConflict: this.conflictMember(k, 'status'),
  }))

  // ----- support access -----

  grantSupport = this.needs((k, hours: number): Promise<void> => {
    const body = k.BODIES.grantCreate.safeParse({ hours })
    if (!body.success) return this.refuseLocal('invalid', 'Choose 1, 4, 24 or 72 hours.')
    const at = this.now()
    const temp: SupportGrant = {
      id: `g_${PENDING}`, createdBy: this.s.me?.memberId ?? `m_${PENDING}`, createdAt: instantOf(at), endsAt: instantOf(at + body.data.hours * 3_600_000),
      endedAt: null, endedBy: null, rev: 1, live: true,
    }
    return this.write({
      lane: 'grant',
      apply: s => ({ ...s, grant: temp }),
      send: () => this.http.call({ method: 'POST', path: '/api/grants', schema: 'grant', json: body.data }),
      done: (s, g, others) => { this.confirmed.set('grant', g); return others ? s : { ...s, grant: g } },
      undo: (s, _before, others) => (others ? s : { ...s, grant: (this.confirmed.get('grant') as SupportGrant | undefined) ?? null }),
      after: async () => this.watchExpiry(),
    })
  })

  endSupportGrant = this.needs((k, id: string): Promise<void> => {
    const was = this.s.grant
    const mine = was && was.id === id ? was : null
    // A grant already over isn't there to end.
    if (mine && !isLive(mine, this.now())) return this.refuseLocal(NOT_FOUND, MESSAGE[NOT_FOUND])
    return this.write({
      lane: 'grant',
      apply: s => ({ ...s, grant: mine && { ...mine, endedAt: instantOf(this.now()), endedBy: s.me?.memberId ?? mine.createdBy, live: false } }),
      send: () => {
        const now = this.s.grant
        return this.http.call({
          method: 'POST', path: `/api/grants/${encodeURIComponent(id)}/end`, schema: 'grant',
          json: k.BODIES.grantEnd.parse({ ifRev: now && now.id === id ? now.rev : mine?.rev ?? 1 }),
        }).catch((e: unknown) => {
          // The server says conflict for a grant that ended behind us (its rev moved); to the person it is simply not there to end.
          const g = e instanceof AgentError && e.code === 'conflict' ? k.ANSWERS.grant.safeParse(e.current) : null
          throw g?.success && !g.data.live ? new AgentError(NOT_FOUND, MESSAGE[NOT_FOUND], { current: e instanceof AgentError ? e.current : undefined }) : e
        })
      },
      done: (s, g, others) => { this.confirmed.set('grant', g); return others ? s : { ...s, grant: g } },
      undo: (s, _before, others) => (others ? s : { ...s, grant: (this.confirmed.get('grant') as SupportGrant | undefined) ?? null }),
      onConflict: (s, current, others) => {
        const g = k.ANSWERS.grant.safeParse(current)
        if (g.success) this.confirmed.set('grant', g.data)
        return g.success && !others ? { ...s, grant: g.data } : s
      },
      after: async () => this.watchExpiry(),
    })
  })

  // ----- memory (P3 W6: routes 44 and 45) -----

  private withForgot(s: Slices, key: string, forgotten: boolean): Slices {
    const forgot = { ...s.state.forgot }
    if (forgotten) forgot[key] = true; else delete forgot[key]
    return { ...s, state: { ...s.state, forgot } }
  }
  /** The line as the server answered it (its rev for the next write), and its forgotten mark. */
  private withLine(s: Slices, line: MemoryLine): Slices {
    const swap = (l: MemoryLine) => (l.key === line.key ? line : l)
    const memory = { team: s.memory.team.map(g => ({ ...g, lines: g.lines.map(swap) })), personal: s.memory.personal.map(swap) }
    return this.withForgot({ ...s, memory }, line.key, line.forgotten === true)
  }

  /** Forgets a line (`true`) or undoes that, at the rev last read: a team line through route 45, a person's own through 44. */
  forgetMemory = this.needs((k, key: string, forgotten: boolean): Promise<void> => {
    const found = findMemoryLine(this.s.memory, key)
    if (!found) return this.refuseLocal(NOT_FOUND, MESSAGE[NOT_FOUND])
    return this.write({
      lane: `memory:${key}`,
      apply: s => this.withForgot(s, key, forgotten),
      // The rev as it is when the write leaves (an earlier write on this line may have moved it).
      send: () => forgetMemoryLine(this.http, k, findMemoryLine(this.s.memory, key)?.line ?? found.line, found.scope, forgotten),
      done: (s, line, others) => (others ? s : this.withLine(s, line)),
      undo: (s, before, others) => (others ? s : this.withForgot(s, key, before.state.forgot[key] === true)),
      onConflict: (s, current, others) => {
        const line = k.ANSWERS.memoryLine.safeParse(current)
        return line.success && !others ? this.withLine(s, line.data) : s
      },
    })
  })

  // ----- team memory approval (P6a W2: routes 77 and 78) -----

  /** The waiting list as last read: a decision sends the line's rev from here. */
  private waitingLines = new Map<string, WaitingMemory>()

  /** Route 77, read when the Team memory page opens (Admins, and the Inhouse team under a grant). */
  waitingMemory = async (): Promise<WaitingMemory[]> => {
    try {
      const { facts } = await readWaitingMemory(this.http)
      this.waitingLines = new Map(facts.map(f => [f.key, f]))
      return facts
    } catch (e) {
      if (e instanceof AgentError && HttpAgent.gone(e)) this.failStatus('meta', e)
      throw e
    }
  }

  /**
   * Route 78: approves or rejects a waiting line at the rev the last list read. A conflict that already shows this decision
   * (an earlier send landed and its answer was lost) is done; any other conflict rejects with `current`, and the page
   * reads the list again. An approved line joins the team's memory, so memory is read again.
   */
  reviewMemory = this.needs(async (k, key: string, approved: boolean): Promise<void> => {
    const line = this.waitingLines.get(key)
    if (!line) return this.refuseLocal(NOT_FOUND, MESSAGE[NOT_FOUND])
    try {
      await reviewMemoryLine(this.http, k, line, approved)
    } catch (e) {
      const current = e instanceof AgentError && e.code === 'conflict' ? k.ANSWERS.memoryLine.safeParse(e.current) : null
      if (!current?.success || !reviewLanded(current.data, line.rev, approved)) {
        if (e instanceof AgentError && HttpAgent.gone(e)) this.failStatus('meta', e)
        throw this.fail(e)
      }
    }
    this.waitingLines.delete(key)
    if (approved) await this.refreshMemory()
  })

  /** Where the audit log downloads from. A relative path: the browser sends it to its own origin, with its sign-in. */
  auditExportUrl = (): string | null => '/api/audit/export.csv'
  signOutUrl = (): string | null => '/cdn-cgi/access/logout'
  uploadsFiles = (): boolean => true
  /** Route 39, after the chat's own save (`createChat`) has answered: the route is a 404 for a chat the server doesn't have yet. */
  uploadFile = async (chatId: string, file: File, signal?: AbortSignal): Promise<{ fileId: string; name: string }> => {
    await this.lanes.get(`chat:${chatId}`)
    try {
      // Loaded when a file is first sent: the entry's first load has a size budget (scripts/check-bundle.mjs).
      const { uploadFile } = await import('./files')
      const kept = await uploadFile(this.http, chatId, file, signal)
      return { fileId: kept.fileId, name: kept.name }
    } catch (e) {
      if (e instanceof AgentError && HttpAgent.gone(e)) this.failStatus('meta', e)
      throw e
    }
  }
  /** Route 41. A 401, or a 403 for a person who was removed, is the signed-out state, as on every other call. */
  downloadFile = async (fileId: string): Promise<{ blob: Blob; name: string | null }> => {
    try { return await (await import('./files')).downloadFile(this.http, fileId) } catch (e) {
      if (e instanceof AgentError && HttpAgent.gone(e)) this.failStatus('meta', e)
      throw e
    }
  }

  // ---------- everything else: the P1 stub, until its phase ----------

  /** A write that isn't served yet: refused, and the person is told with an `error` notice, as `AgentClient` says of every failed write. */
  private refuse<T = void>(): Promise<T> {
    this.notify({ type: 'error', code: 'unavailable', text: UNAVAILABLE })
    return rejected<T>()
  }

  approve = (_id: string) => this.refuse<Awaited<ReturnType<AgentClient['approve']>>>()
  undo = (_id: string) => this.refuse()
  editDraft = (_id: string, _body: string) => this.refuse()
  /**
   * Row 63, one file after another: each joins the list as the server kept it. The first refusal stops the rest and
   * rejects with what the person can act on (the size, the type, the name); the files already kept stay.
   */
  uploadFiles = async (files: File[]): Promise<LibraryFile[]> => {
    const kept: LibraryFile[] = []
    for (const file of files) {
      let one: LibraryFile
      try {
        one = await uploadLibraryFile(this.http, file)
      } catch (e) {
        const err = e instanceof AgentError ? e : new AgentError('unknown', MESSAGE.unknown)
        // files.ts loads lazily (Today's first-load budget, build-support/entry-without-zod.test.ts); if it can't load, the plain failure.
        const text = await import('./files').then(m => m.uploadRefusalText(file.name, err), () => `Couldn't upload ${file.name}. Try again.`)
        throw this.fail(new AgentError(err.code, text, err.reason ? { reason: err.reason } : {}))
      }
      kept.push(one)
      this.patch({ files: [one, ...this.s.files.filter(f => f.id !== one.id)].sort(byNewest) })
    }
    return kept
  }
  /** Row 64, on this page's origin. */
  fileDownloadUrl = (id: string): string | null => `${this.origin}${libraryDownloadPath(id)}`
  undoHandled = (_id: string) => this.refuse<string>()
  redoHandled = (_id: string) => this.refuse()

  // ---------- chats, turns and the socket (P3, W5) ----------

  /** Saves the chat the person started (route 23, idempotent): it shows at once, and a failed save takes it back with a notice. */
  createChat = this.needs((k, chat: Parameters<AgentClient['createChat']>[0]): Promise<void> => {
    const body = k.BODIES.createChat.safeParse(chat)
    if (!body.success) return this.refuseLocal('invalid', 'Check the name of the chat.')
    const known = this.s.chats.some(c => c.id === body.data.id)
    const temp: ChatSummary = { id: body.data.id, title: body.data.title, customTitle: null, pinned: false, deleted: false, at: instantOf(this.now()), rev: 1, running: false }
    return this.write({
      lane: `chat:${temp.id}`,
      apply: s => (known ? s : { ...s, chats: [temp, ...s.chats].sort(byRecent) }),
      send: () => saveChat(this.http, k, body.data),
      done: (s, c) => { this.confirmed.set(`chat:${c.id}`, c); return { ...s, chats: replaceChat(s.chats, c).sort(byRecent) } },
      undo: s => (known ? s : { ...s, chats: s.chats.filter(c => c.id !== temp.id) }),
    })
  })

  /** One page of the list, straight from the server (the snapshot keeps the first page; what a page brings is merged in). */
  listChats = async (opts?: Parameters<AgentClient['listChats']>[0]) => {
    const page = await readChats(this.http, opts ?? {})
    // A listing of deleted chats is the server's page only: the main list holds deleted ones already marked, from the writes.
    if (!opts?.deleted) this.patch({ chats: this.mergeChats(page.items) })
    return page
  }
  getChat = async (id: string, cursor?: string) => {
    // A chat made a moment ago is read after its own save has answered (as a send is), so its history isn't a 404.
    await this.lanes.get(`chat:${id}`)
    const page = await readChat(this.http, id, cursor)
    this.patch({ chats: this.mergeChats([page.chat]) })
    return page
  }

  /** What a refused chat write goes back to: the chat as the server last confirmed it, unless a later write to it is on screen. */
  private chatAs = (s: Slices, c: ChatSummary): Slices => ({ ...s, chats: replaceChat(s.chats, c).sort(byRecent) })
  private chatWrite(id: string, change: (c: ChatSummary) => ChatSummary, send: (k: Contract, rev: number) => Promise<ChatSummary>, k: Contract): Promise<void> {
    const have = this.s.chats.find(c => c.id === id)
    if (!have) return this.refuseLocal(NOT_FOUND, MESSAGE[NOT_FOUND])
    return this.write({
      lane: `chat:${id}`,
      apply: s => this.chatAs(s, change(s.chats.find(c => c.id === id) ?? have)),
      // The rev as it is when the write leaves: an earlier write on this chat has answered by then.
      send: () => send(k, (this.confirmed.get(`chat:${id}`) as ChatSummary | undefined)?.rev ?? this.s.chats.find(c => c.id === id)?.rev ?? have.rev),
      done: (s, c, others) => { this.confirmed.set(`chat:${id}`, c); return others ? s : this.chatAs(s, c) },
      undo: (s, _before, others) => { const c = this.confirmed.get(`chat:${id}`) as ChatSummary | undefined; return others || !c ? s : this.chatAs(s, c) },
      onConflict: (s, current, others) => {
        const c = k.ANSWERS.chat.safeParse(current)
        if (!c.success) return s
        this.confirmed.set(`chat:${id}`, c.data)
        return others ? s : this.chatAs(s, c.data)
      },
    })
  }
  renameChat = this.needs((k, id: string, title: string | null): Promise<void> => {
    const t = title === null ? null : title.trim().slice(0, CHAT_TITLE_MAX)
    return this.chatWrite(id, c => ({ ...c, customTitle: t || null }), (kk, rev) => putTitle(this.http, kk, id, t || null, rev), k)
  })
  pinChat = this.needs((k, id: string, pinned: boolean): Promise<void> => this.chatWrite(id, c => ({ ...c, pinned }), (kk, rev) => putPin(this.http, kk, id, pinned, rev), k))

  private deleteOrRestore(k: Contract, ids: string[], deleted: boolean): Promise<void> {
    if (ids.length < 1 || ids.length > 50) return this.refuseLocal('invalid', 'Choose 1 to 50 chats.')
    const own = ids.filter(id => this.s.chats.some(c => c.id === id))
    if (own.length !== ids.length) return this.refuseLocal(NOT_FOUND, MESSAGE[NOT_FOUND])
    const mark = (s: Slices, flag: boolean): Slices => ({ ...s, chats: s.chats.map(c => (ids.includes(c.id) ? { ...c, deleted: flag } : c)) })
    return this.write({
      lane: `chats:${[...ids].sort().join(',')}`,
      field: `chats:${[...ids].sort().join(',')}`,
      apply: s => mark(s, deleted),
      send: () => postDeleted(this.http, k, ids, deleted),
      done: (s, r) => { r.items.forEach(c => this.confirmed.set(`chat:${c.id}`, c)); return { ...s, chats: r.items.reduce(replaceChat, s.chats).sort(byRecent) } },
      undo: s => ({ ...s, chats: s.chats.map(c => (ids.includes(c.id) ? ((this.confirmed.get(`chat:${c.id}`) as ChatSummary | undefined) ?? c) : c)) }),
    })
  }
  deleteChats = this.needs((k, ids: string[]) => this.deleteOrRestore(k, ids, true))
  restoreChats = this.needs((k, ids: string[]) => this.deleteOrRestore(k, ids, false))

  /** The owner's recovery for a damaged session (route 49): the history stays, the next message starts fresh. */
  resetSession = (chatId: string): Promise<void> => guard(postSessionReset(this.http, chatId).then(() => undefined, (e: unknown) => { throw this.fail(e) }))

  /**
   * A message into the chat (route 29). Never waits for the answer. The chat's own save (`createChat`) goes first when it is
   * still on its way. A refusal rejects with its code and reason and sends no notice: the chat shows the failed message
   * itself, with its own words, and a retry with the same `clientTurnKey` is the same turn.
   */
  send = async (chatId: string, input: Parameters<AgentClient['send']>[1]) => {
    const k = await this.http.contract().catch((e: unknown): never => { console.error('Inhouse: the schemas chunk did not load.', e); throw new AgentError('unavailable', MESSAGE.unavailable) })
    await this.lanes.get(`chat:${chatId}`)
    try {
      const sent = await postTurn(this.http, k, chatId, input)
      // The agent took the message, so it is not paused now: the page read the pause state when it loaded and nothing tells it
      // an Admin resumed since, so the send is the proof. (A send is the one moment the person acts on that state.)
      if (this.s.pause.paused) this.patch({ pause: { paused: false, at: null, by: null } })
      return sent
    } catch (e) {
      if (e instanceof AgentError && HttpAgent.gone(e)) this.failStatus('meta', e)
      // Refused as paused: the page may not know yet (an Admin paused after it loaded), and a known pause may carry another
      // time and person: read the real state, once, instead of guessing it.
      if (e instanceof AgentError && e.reason === REASON.paused) void this.loadPause()
      throw e
    }
  }
  /** Routes 30 and 31. */
  interrupt = (turnId: string): Promise<void> => guard(postTurnAction(this.http, turnId, 'interrupt').then(() => undefined, (e: unknown) => { throw this.fail(e) }))
  stop = (turnId: string): Promise<void> => guard(postTurnAction(this.http, turnId, 'stop').then(() => undefined, (e: unknown) => { throw this.fail(e) }))
  // Read after the first reads, so the chats the runs belong to are known when the app follows them.
  activeRuns = async (): Promise<Awaited<ReturnType<AgentClient['activeRuns']>>> => {
    if (!ACTIVE_RUNS_WIRED) return []
    await this.whenLoaded()
    // A run of a chat the first page didn't hold is followed when that chat opens (route 24 names it in `runs`).
    return readActiveRuns(this.http)
  }

  attach = (runId: string, onFrame: Parameters<AgentClient['attach']>[1], fromSeq = 0, onRefused?: Parameters<AgentClient['attach']>[3]): (() => void) =>
    this.socket.attach(runId, f => { onFrame(f); if (f.event.type === 'run.finished') this.afterRun() }, fromSeq, onRefused)
  link = (): LinkState => this.socket.link()
  onLink = (l: (s: LinkState) => void): (() => void) => this.socket.onLink(l)
  /** Sign out: the socket closes first. */
  disconnect = (): void => this.socket.close()
  getTrace = (id: string): Promise<Trace | null> => readTrace(this.http, id)

  /** A browser WebSocket to this page's origin (the test build's, under Node: `origin`). */
  private browserSocket(): SocketLike {
    const base = (this.origin || globalThis.location?.origin) ?? ''
    if (!base) throw new Error('No origin to open the chat socket to.')
    return new WebSocket(`${base.replace(/^http/, 'ws')}/api/socket?v=${SOCKET_VERSION}`) as unknown as SocketLike
  }
  /** The socket closed 4401: the session or the lease ended. Still signed in (the cookie renews) means reconnect; not means the signed-out state. */
  private async reauth(): Promise<boolean> {
    try { this.takeMe(await this.http.call({ method: 'GET', path: '/api/me', schema: 'me' })); return true } catch (e) {
      if (e instanceof AgentError && (e.code === 'unauthorized' || HttpAgent.gone(e))) { this.failStatus('meta', e); return false }
      // Offline or the server busy: the sign-in isn't known to be gone, so try the socket again.
      return true
    }
  }
  /** 4403: the support grant ended. What it showed is dropped: the chats and the memory this client holds. */
  private dropPrivileged() {
    clearTimeout(this.expiry)
    this.patch({ chats: [], chatsNext: null, memory: EMPTY_DATA.memory, grant: this.s.grant && { ...this.s.grant, live: false } })
  }

  // ----- pause and resume (routes 36 and 37) -----

  private setPaused(to: boolean): Promise<Instant | void> {
    const was = this.s.pause
    const optimistic: PauseState = { paused: to, at: to ? instantOf(this.now()) : null, by: to ? this.s.me?.memberId ?? null : null }
    return this.write({
      lane: 'pause',
      apply: s => ({ ...s, pause: optimistic }),
      send: () => setPause(this.http, to),
      done: (s, p) => ({ ...s, pause: p }),
      undo: s => ({ ...s, pause: was }),
    })
  }
  pause = async (): Promise<Instant> => {
    await this.setPaused(true)
    return this.s.pause.at ?? instantOf(this.now())
  }
  resume = (): Promise<void> => this.setPaused(false) as Promise<void>

  /** Route 81: "Connect <tool>", named by the catalogue when it has the tool. Route 83 takes the caller's own open one back. */
  requestTool = (key: string, on: boolean): Promise<void> =>
    on ? this.fileRequest('tool', key, `Connect ${this.read().tools.catalog.find(c => c.k === key)?.name ?? key}`) : this.takeBack('tool', key)
  /** Route 81: a skill the team should add (a `job` about that skill). */
  requestSkill = (name: string): Promise<void> => this.fileRequest('job', name, `Add the skill "${name}"`)
  /** Route 84: a skill's instructions, the tools it reads and when it changed, onto its entry in the list. */
  loadSkill = async (name: string): Promise<void> => {
    const s = this.s.skills.find(x => x.n === name)
    if (!s || s.body !== undefined) return
    const page = await readSkillPage(this.http, name)
    this.patch({ skills: this.s.skills.map(x => (x.n === name ? { ...x, body: page.body, tools: page.tools, updatedAt: page.updatedAt } : x)) })
  }
  /** Route 85: a brand skill, at its rev. Off the list at once; back (as the server has it) on a refusal. */
  deleteSkill = this.needs((k, name: string): Promise<void> => {
    const s = this.s.skills.find(x => x.n === name)
    if (!s || !s.mine || s.id === undefined || s.rev === undefined) return this.refuseLocal('forbidden', "Only your team's own skills can be deleted.")
    const { id, rev } = s
    return this.write<SkillDef>({
      lane: 'skills',
      apply: st => ({ ...st, skills: st.skills.filter(x => x.n !== name) }),
      send: () => postSkillDelete(this.http, k, id, rev),
      done: st => st,
      undo: (now, before) => ({ ...now, skills: before.skills }),
      onConflict: (st, current) => ({ ...st, skills: [...st.skills.filter(x => x.n !== name), current as unknown as SkillDef] }),
    })
  })
  setToolPaused = (_key: string, _paused: boolean) => this.refuse()
  /** Route 81: what the team window sent (its type rides on the request as `kind`; its title and details become the words). */
  sendTeamRequest = (req: Parameters<AgentClient['sendTeamRequest']>[0]): Promise<void> =>
    req.kind ? this.fileRequest(req.kind, undefined, requestWords(req.title, req.text)) : rejected()
  /**
   * Route 83: the caller's own open request that the window's row names. Nothing leaves the list until the server says it is
   * withdrawn (a failure keeps the row); then it shows as Closed, Withdrawn, until the open requests are read again. A conflict
   * (the team answered it meanwhile) shows it as the server has it. There's no way back, so no undo.
   */
  withdrawTeamRequest = this.needs((k, ref: { title: string; at: Instant }): Promise<void> => {
    const key = `${ref.at.ms}|${ref.title}`
    const mine = this.s.requests.find(r => r.mine && r.status === 'open' && requestKey(r) === key)
    if (!mine) return this.refuseLocal('forbidden', "That request isn't open any more, or it isn't yours.")
    const put = (s: Slices, r: TeamRequestRecord): Slices => this.withRequests(s, [r, ...s.requests.filter(x => x.id !== r.id)])
    return this.write<TeamRequestRecord>({
      lane: 'requests',
      apply: s => s,
      send: () => putWithdrawn(this.http, k, mine.id, mine.rev),
      done: put,
      undo: (s, before) => this.withRequests(s, before.requests),
      onConflict: (s, current) => put(s, current as unknown as TeamRequestRecord),
    })
  })
  private fileRequest = this.needs((k, kind: TeamRequestRecord['kind'], subject: string | undefined, text: string): Promise<void> =>
    this.write({
      lane: 'requests',
      apply: s => (subject && kind === 'tool' ? { ...s, state: { ...s.state, requestedTools: { ...s.state.requestedTools, [subject]: true } } } : subject && kind === 'job' ? { ...s, state: { ...s.state, requestedSkills: { ...s.state.requestedSkills, [subject]: true } } } : s),
      send: () => postTeamRequest(this.http, k, { kind, ...(subject ? { subject } : {}), text }).then(
        r => {
          // The server answers the person's own open request when it already says this subject: other words back means this wasn't sent.
          if (r.text !== text.trim()) throw new AgentError('conflict', `You already have an open request about this: "${r.text}". Your Inhouse team has it. Wait for an answer, or take it back before sending another.`, { current: r as unknown as Record<string, unknown> })
          return r
        },
        (e: unknown) => { throw HttpAgent.requestRefusal(e) },
      ),
      done: (s, r) => this.withRequests(s, [r, ...s.requests.filter(x => x.id !== r.id)]),
      undo: (s, before) => ({ ...s, state: { ...s.state, requestedTools: before.state.requestedTools, requestedSkills: before.state.requestedSkills } }),
      // The person's own open request, as the server has it, joins the list: its Requested mark stays and Request isn't offered again.
      onConflict: (s, current) => this.withRequests(s, [current as unknown as TeamRequestRecord, ...s.requests.filter(x => x.id !== (current as { id?: string }).id)]),
    }))
  /** Route 83: the caller's own open request of this kind about `subject`, looked up when the write goes out (a request filed a moment ago is in the list by then). */
  private takeBack = this.needs((k, kind: TeamRequestRecord['kind'], subject: string): Promise<void> =>
    this.write<TeamRequestRecord | null>({
      lane: 'requests',
      // The mark comes off only when the caller has an open request of their own to take back: someone else's stays.
      apply: s => (kind === 'tool' && s.requests.some(r => r.mine && r.status === 'open' && r.kind === kind && r.subject === subject)
        ? { ...s, state: { ...s.state, requestedTools: Object.fromEntries(Object.entries(s.state.requestedTools).filter(([n]) => n !== subject)) } }
        : s),
      send: async () => {
        const mine = this.s.requests.find(r => r.mine && r.status === 'open' && r.kind === kind && r.subject === subject)
        return mine ? putWithdrawn(this.http, k, mine.id, mine.rev) : null
      },
      done: (s, r) => (r ? this.withRequests(s, s.requests.filter(x => x.id !== r.id)) : s),
      undo: (s, before) => ({ ...s, state: { ...s.state, requestedTools: before.state.requestedTools } }),
    }))
  listNotifications = () => this.s.notifications
  /**
   * Route 61: the notices opened, or every one listed. They show read at once; a refusal puts the dot back only on the very
   * items this write marked (a newer read replaced the others, and its answer stands), and the server skips any id this
   * person can't see.
   */
  markNoticesRead = this.needs((k, ids: string[]): Promise<void> => {
    const marked = new Set(ids)
    const unread = new Set(this.s.notifications.filter(n => n.unread && marked.has(n.id)).map(n => n.id))
    if (unread.size === 0) return Promise.resolve()
    // The items `apply` makes: a refusal puts the dot back only on these very objects. A read that landed meanwhile replaced
    // them, so its answer (read or unread) stands.
    const marked_ = new Set<AgentNotification>()
    return this.write({
      lane: 'notices',
      apply: s => ({ ...s, notifications: s.notifications.map(n => { if (!unread.has(n.id) || !n.unread) return n; const m = { ...n, unread: false }; marked_.add(m); return m }) }),
      send: () => postNoticesRead(this.http, k, [...unread]),
      done: s => s,
      undo: s => ({ ...s, notifications: s.notifications.map(n => (marked_.has(n) ? { ...n, unread: true } : n)) }),
    })
  })

  listFiles = () => this.s.files
  /**
   * Rows 65 and 66: the files leave the list (or come back) at once; the write sends each file's `rev` as it is when the
   * write leaves (one lane, so an Undo waits for its delete's answer and sends the rev that answer gave). While a later
   * write in the lane is still on its way, an answer or a refusal only folds in the revisions it carries and leaves the
   * files on the side that later write put them (no blink). A refusal puts the files back with their latest revision. A
   * `conflict` takes the revisions it carries and reads the Library again, so a file someone else deleted doesn't stay.
   * A restore skips ids this client no longer holds as deleted (an Undo joined to a delete that was refused).
   */
  /** Library writes on their way, per file id (how many name it), and how many have finished: what `loadLibrary` checks. */
  private libraryInFlight = new Map<string, number>()
  private libraryWritesDone = 0
  /** A conflict asked for a fresh read: it starts once that write has finished. */
  private libraryRelist = false

  private libraryWrite(k: Contract, asked: string[], to: 'delete' | 'restore'): Promise<void> {
    if (asked.length < 1 || asked.length > 100 || new Set(asked).size !== asked.length) return this.refuseLocal('invalid', 'Choose 1 to 100 files.')
    const ids = to === 'restore' ? asked.filter(id => this.s.gone[id]) : asked
    if (ids.length === 0) return Promise.resolve()
    if (to === 'delete' && ids.some(id => !this.s.files.some(f => f.id === id))) return this.refuseLocal(NOT_FOUND, MESSAGE[NOT_FOUND])
    const there = (s: Slices, id: string) => s.gone[id] ?? s.files.find(f => f.id === id)
    const rowsOf = (s: Slices) => ids.flatMap(id => { const f = there(s, id); return f ? [f] : [] })
    /** The files `rows` put live or gone, whatever side they were on. */
    const place = (s: Slices, rows: readonly LibraryFile[], side: 'live' | 'gone'): Slices => {
      const ours = new Set(rows.map(f => f.id))
      const gone = Object.fromEntries(Object.entries(s.gone).filter(([id]) => !ours.has(id)))
      const files = s.files.filter(f => !ours.has(f.id))
      if (side === 'gone') for (const f of rows) gone[f.id] = f
      return { ...s, gone, files: side === 'live' ? [...files, ...rows].sort(byNewest) : files }
    }
    /** The same files with the revisions `rows` carry, each left on the side it is on. */
    const fold = (s: Slices, rows: readonly LibraryFile[]): Slices => {
      const by = new Map(rows.map(f => [f.id, f]))
      const gone = { ...s.gone }
      for (const id of Object.keys(gone)) { const f = by.get(id); if (f) gone[id] = f }
      return { ...s, gone, files: s.files.map(f => by.get(f.id) ?? f) }
    }
    const after: 'live' | 'gone' = to === 'delete' ? 'gone' : 'live'
    const before: 'live' | 'gone' = to === 'delete' ? 'live' : 'gone'
    const flight = this.libraryInFlight
    for (const id of ids) flight.set(id, (flight.get(id) ?? 0) + 1)
    /** This write's files that a later queued write also names: that write decides their side. */
    const named = () => new Set(ids.filter(id => (flight.get(id) ?? 0) > 1))
    const settle = (s: Slices, rows: readonly LibraryFile[], side: 'live' | 'gone'): Slices => {
      const later = named()
      return place(fold(s, rows.filter(f => later.has(f.id))), rows.filter(f => !later.has(f.id)), side)
    }
    const run = this.write({
      // One lane for every Library write: they leave in order.
      lane: 'library',
      apply: s => place(s, rowsOf(s), after),
      send: () => postLibraryWrite(this.http, k, to, ids.map(id => ({ id, ifRev: there(this.s, id)?.rev ?? 1 }))),
      done: (s, r) => settle(s, r.items, after),
      undo: s => settle(s, rowsOf(s), before),
      onConflict: (s, current) => {
        const c = k.ANSWERS.libraryFiles.safeParse(current)
        this.libraryRelist = true
        return c.success ? fold(s, c.data.items) : s
      },
    })
    const finish = () => {
      for (const id of ids) { const n = (flight.get(id) ?? 1) - 1; if (n > 0) flight.set(id, n); else flight.delete(id) }
      this.libraryWritesDone++
      if (this.libraryRelist) { this.libraryRelist = false; void this.loadLibrary(true) }
    }
    void run.then(finish, finish)
    return run
  }
  deleteFiles = this.needs((k, ids: string[]) => this.libraryWrite(k, ids, 'delete'))
  restoreFiles = this.needs((k, ids: string[]) => this.libraryWrite(k, ids, 'restore'))

  /**
   * Route 58: a snooze or a dismissal (the card leaves at once), or an Undo (`null`: it comes back). `declined` is P6's, so it
   * is refused. The write carries the record's rev (C6); a refusal puts the card back (C3) and a conflict takes the server's
   * record and reads Today again.
   */
  setAside = this.needs((k, id: string, reason: SetAsideReason | null): Promise<void> => {
    if (reason === 'declined') return this.refuse()
    if (reason !== null && !this.s.problems.some(p => p.id === id)) return this.refuseLocal(NOT_FOUND, MESSAGE[NOT_FOUND])
    const me = this.s.me?.memberId ?? ''
    const hide = (s: Slices, why: 'snoozed' | 'dismissed'): Slices => {
      const index = s.problems.findIndex(p => p.id === id)
      if (index < 0) return s
      const at = { iso: new Date(this.now()).toISOString(), ms: this.now() }
      const have = s.aside[id]
      const aside = { ...s.aside, [id]: { reason: why, at, by: me, loggedAt: at, rev: have?.rev ?? 0 } }
      const next = this.withToday(s, s.problems.filter(p => p.id !== id), aside)
      return { ...next, asideStash: { ...next.asideStash, [id]: { problem: s.problems[index], index } } }
    }
    const show = (s: Slices): Slices => {
      const held = s.asideStash[id]
      const have = s.aside[id]
      const problems = held ? [...s.problems.slice(0, held.index), held.problem, ...s.problems.slice(held.index)] : s.problems
      return this.withToday(s, problems, have ? { ...s.aside, [id]: { ...have, reason: null } } : s.aside)
    }
    const held = this.s.asideStash[id] !== undefined
    return this.write({
      lane: `today:${id}`,
      apply: s => (reason === null ? show(s) : hide(s, reason)),
      // The rev as it is when the write leaves (an earlier write on this card may have moved it).
      send: () => putAside(this.http, k, id, reason, this.s.aside[id]?.rev ?? 0),
      // A later write on this card is queued and its change is on screen: take in only the rev the server gave.
      done: (s, record, others) => this.withToday(s, s.problems, { ...s.aside, [id]: others ? { ...(s.aside[id] ?? record), rev: record.rev } : record }),
      undo: (s, before, others) => (others ? s : this.withToday(s, before.problems, before.aside)),
      onConflict: (s, current) => {
        const record = k.ANSWERS.todayAside.safeParse(current)
        void this.loadProblems(true)
        return record.success ? this.withToday(s, s.problems, { ...s.aside, [id]: record.data }) : s
      },
      // An Undo of a card this client doesn't hold (set aside before a reload) brings it back by reading Today again.
      after: reason === null && !held ? () => this.loadProblems(true) : undefined,
    })
  })
  // ----- routines (P4 W2, routes 53 to 56) -----

  /**
   * The list as the server said it: the routines, the deleted ones, each one's switch (`r:<id>`) and `routinesDeleted`. A
   * routine with a write still on its way keeps what's on screen for it (its switch, its deleted mark): the write's own
   * answer settles it, never a read that left before it.
   */
  private withRoutines(s: Slices, live: RoutineDef[], gone: RoutineDef[], enabled: Record<string, boolean>): Slices {
    const busy = (id: string) => this.depthOf(`r:${id}`) > 0 || this.depthOf(`routine:${id}`) > 0
    const toggles = Object.fromEntries(Object.entries(s.state.toggles).filter(([key]) => !key.startsWith('r:') || busy(key.slice(2))))
    for (const [id, on] of Object.entries(enabled)) if (!busy(id)) toggles[`r:${id}`] = on
    const routinesDeleted: Record<string, true> = {}
    for (const r of gone) if (!busy(r.id)) routinesDeleted[r.id] = true
    for (const [id, v] of Object.entries(s.state.routinesDeleted)) if (busy(id) && v) routinesDeleted[id] = true
    return { ...s, routines: live, routinesGone: gone, state: { ...s.state, toggles, routinesDeleted } }
  }
  private lastOf(s: Slices, id: string): RoutineDef['last'] {
    return (s.routines.find(x => x.id === id) ?? s.routinesGone.find(x => x.id === id))?.last
  }
  /**
   * One routine as the server answered it, in whichever list it belongs to now (`deleted`: it's in the trash). An answer
   * without `last` keeps the one on screen (a write never changes which run ended last).
   */
  private withRoutine(s: Slices, answered: RoutineDef, deleted: boolean): Slices {
    const last = answered.last ?? this.lastOf(s, answered.id)
    const r: RoutineDef = { ...answered, ...(last ? { last } : {}) }
    const live = s.routines.filter(x => x.id !== r.id)
    const gone = s.routinesGone.filter(x => x.id !== r.id)
    const at = (list: RoutineDef[], old: RoutineDef[]) => { const i = old.findIndex(x => x.id === r.id); const out = [...list]; out.splice(i < 0 ? 0 : Math.min(i, out.length), 0, r); return out }
    const routinesDeleted = { ...s.state.routinesDeleted }
    if (deleted) routinesDeleted[r.id] = true; else delete routinesDeleted[r.id]
    return { ...s, routines: deleted ? live : at(live, s.routines), routinesGone: deleted ? at(gone, s.routinesGone) : gone, state: { ...s.state, routinesDeleted } }
  }
  private routineOf(id: string): { r: RoutineDef; deleted: boolean } | null {
    const live = this.s.routines.find(x => x.id === id)
    if (live) return { r: live, deleted: false }
    const gone = this.s.routinesGone.find(x => x.id === id)
    return gone ? { r: gone, deleted: true } : null
  }
  private withToggle(s: Slices, id: string, on: boolean): Slices {
    return { ...s, state: { ...s.state, toggles: { ...s.state.toggles, [`r:${id}`]: on } } }
  }

  /**
   * Route 53: a routine's switch, optimistic. A refusal takes it back; a stale rev puts in the routine and its switch as
   * the server has them now.
   */
  private putRoutineEnabled(k: Contract, id: string, on: boolean): Promise<void> {
    const found = this.routineOf(id)
    if (!found || found.deleted) return this.refuseLocal(NOT_FOUND, MESSAGE[NOT_FOUND])
    const was = this.s.state.toggles[`r:${id}`] ?? true
    const take = (s: Slices, st: { routine: RoutineDef; enabled: boolean }, others: boolean) => {
      const next = this.withRoutine(s, st.routine, false)
      return others ? next : this.withToggle(next, id, st.enabled)
    }
    return this.write({
      lane: `routine:${id}`,
      field: `r:${id}`,
      apply: s => this.withToggle(s, id, on),
      // The rev as it is when the write leaves (an earlier write in this routine's lane may have moved it).
      send: () => setRoutineToggle(this.http, k, id, on, this.routineOf(id)?.r.rev ?? found.r.rev),
      done: (s, st, others) => take(s, st, others),
      undo: (s, _before, others) => (others ? s : this.withToggle(s, id, was)),
      onConflict: (s, current, others) => {
        const st = k.ANSWERS.routineState.safeParse(current)
        return st.success ? take(s, st.data, others) : s
      },
    })
  }

  /** Route 54's refusals in the page's words (section 9). */
  private static runRefusal(e: AgentError): AgentError {
    if (e.code === 'conflict' && e.reason === REASON.runOpen) return new AgentError('conflict', 'A run is still going. Try again when it finishes.', { reason: e.reason })
    if (e.code === 'forbidden' && e.reason === REASON.stage) return new AgentError('forbidden', 'This routine runs from the Act stage. Ask an admin to move to Act.', { reason: e.reason })
    return e
  }

  /** Route 56's cap refusal in the page's words (#312 review); anything else as it came. */
  private static revRefusal(e: unknown): unknown {
    if (e instanceof AgentError && e.code === 'forbidden' && e.reason === REASON.routineLimit) return new AgentError('forbidden', `This brand already has ${MAX_TEAM_ROUTINES} routines. Delete one to restore this.`, { reason: e.reason })
    return e
  }

  /** Route 86: a routine's own recent runs. A read: it changes nothing on screen, so a failure is the caller's to show. */
  routineRunHistory = (id: string): Promise<RoutineRunHistory> => guard(readRoutineRuns(this.http, id))

  /** Route 54: one Run now; the run heads `routineRuns`. A retry of this call is a new run (a new key). */
  runRoutine = (id: string): Promise<RoutineRun> => guard((async () => {
    if (!this.routineOf(id)) throw this.fail(new AgentError(NOT_FOUND, MESSAGE[NOT_FOUND]))
    try {
      const run = await postRoutineRun(this.http, await this.http.contract(), id, newRunKey())
      this.commit({ ...this.s, state: { ...this.s.state, routineRuns: [run, ...this.s.state.routineRuns] } })
      return run
    } catch (e) {
      throw this.fail(e instanceof AgentError ? HttpAgent.runRefusal(e) : e)
    }
  })())

  /**
   * Routes 55 and 56: delete and Undo, optimistic (`routinesDeleted`), against the routine's rev. Whether it may be deleted
   * or restored is read from the screen's state (an Undo pressed while the delete is still on its way is a restore), and
   * the write queues behind the delete in the routine's lane, sending the rev the delete's answer left.
   */
  private routineRev(k: Contract, id: string, what: 'delete' | 'restore'): Promise<void> {
    const found = this.routineOf(id)
    const shownDeleted = this.s.state.routinesDeleted[id] === true
    if (!found || shownDeleted !== (what === 'restore')) return this.refuseLocal(NOT_FOUND, MESSAGE[NOT_FOUND])
    const mark = (s: Slices, deleted: boolean): Slices => {
      const routinesDeleted = { ...s.state.routinesDeleted }
      if (deleted) routinesDeleted[id] = true; else delete routinesDeleted[id]
      return { ...s, state: { ...s.state, routinesDeleted } }
    }
    /** Where the server has it, from the lists only its answers move (never the screen's optimistic mark). */
    const deletedOnServer = (s: Slices) => s.routinesGone.some(x => x.id === id)
    /**
     * `next` with the screen's mark: as the server has it, unless a later write in this routine's lane is queued, whose
     * mark is on screen (`shown`) and stays until that write settles it.
     */
    const settle = (next: Slices, others: boolean, shown: Slices) => mark(next, others ? shown.state.routinesDeleted[id] === true : deletedOnServer(next))
    return this.write<RoutineState | null>({
      lane: `routine:${id}`,
      apply: s => mark(s, what === 'delete'),
      // Nothing to send when the write ahead of this one in the lane was refused and left the routine where this one
      // would put it (an Undo queued behind a delete that failed): no request, no notice.
      send: async () => (deletedOnServer(this.s) === (what === 'delete') ? null : postRoutineRev(this.http, k, id, what, this.routineOf(id)?.r.rev ?? found.r.rev).catch((e: unknown) => { throw HttpAgent.revRefusal(e) })),
      done: (s, st, others) => settle(st === null ? s : this.withRoutine(s, st.routine, what === 'delete'), others, s),
      undo: (s, _before, others) => settle(s, others, s),
      // A restored routine goes back to its place in the server's order (newest first), which only the list knows.
      after: what === 'restore' ? () => this.loadRoutines(true) : undefined,
      onConflict: (s, current, others) => {
        const st = k.ANSWERS.routineState.safeParse(current)
        // Refused: it's still where it was before this write (deleted for a restore, live for a delete).
        return st.success ? settle(this.withRoutine(s, st.data.routine, what === 'restore'), others, s) : s
      },
    })
  }
  deleteRoutine = this.needs((k, id: string) => this.routineRev(k, id, 'delete'))
  restoreRoutine = this.needs((k, id: string) => this.routineRev(k, id, 'restore'))
}

