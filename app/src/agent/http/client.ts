// The product's agent client. P2 connects the account, settings, team, support-access and audit parts to the Worker over
// HTTP (transport.ts); every other method stays the P1 stub (`unavailable`) until its phase, and a run never starts.
// Reads: one fetch per resource on start (`me` and the settings first, `meta`), each with its own `status`. Writes:
// optimistic, then saved; on failure taken back, rejected with the `AgentError` and an `error` notice. The client keeps
// each record's last `rev` and sends it as `ifRev`; a `conflict` puts `current` into the snapshot.
// It imports nothing from the mock or the sample data.
import { instantOf } from '../../lib/format'
import { RESOURCE_KEYS } from '../../../shared/contract/keys'
import { NOT_FOUND, REASON } from '../../../shared/contract/error-codes'
import { meetsRule, settingRow } from '../../../shared/contract/settings-table'
import { AgentError } from '../types'
import type {
  AgentClient, AgentData, AgentErrorCode, AgentNotice, AgentNotification, AgentState, AuditLine, LinkState, ErrorReason, Instant, LibraryFile, Me,
  MemberRecord, MemoryData, MemoryLine, ResourceKey, ResourceStatus, RoutineRun, SupportGrant, Trace,
} from '../types'
import { findMemoryLine, forgetMemoryLine, readMemory } from './memory'
import { MESSAGE, Transport } from './transport'
import type { Contract, TransportOptions } from './transport'

const UNAVAILABLE = 'Not connected yet.'

/** The resources this client reads. Every other key has nothing to read until its phase, so it reads as ready and empty. */
type Loaded = 'meta' | 'members' | 'grants' | 'audit' | 'memory'
const LOADED: readonly ResourceKey[] = ['meta', 'members', 'grants', 'audit', 'memory'] satisfies readonly Loaded[]

export interface HttpAgentOptions extends TransportOptions {
  /** Epoch ms. The real clock by default; the contract target moves it on (`advance`). */
  now?: () => number
}

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
const NO_NOTIFICATIONS: AgentNotification[] = []
const NO_FILES: LibraryFile[] = []
const NO_IDS: string[] = []

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
  private s: Slices = { me: null, members: [], membersNext: null, audit: [], auditNext: null, grant: null, memory: EMPTY_DATA.memory, revs: {}, state: EMPTY_STATE, res: EMPTY_DATA.resources }
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
    const same = last && last.live === live && (['me', 'members', 'membersNext', 'audit', 'auditNext', 'grant', 'memory', 'res'] as const).every(k => last.s[k] === this.s[k])
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
  allChatIds = () => NO_IDS

  private notify(n: AgentNotice) { this.noticeListeners.forEach(l => l(n)) }

  // ---------- reads ----------

  /** Starts the first reads (once) and resolves when every one has finished, whatever its result. */
  whenLoaded(): Promise<void> {
    return (this.loading ??= this.loadAll())
  }

  private async loadAll() {
    if (!(await this.loadMeta())) return
    await Promise.all([this.loadMembers(), this.loadGrants(), this.loadAudit(), this.loadMemory()])
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
   * Reads a resource again after its read failed. The ones with nothing to read resolve at once. A retry while one for
   * the same resource is under way joins it, so two clicks make one read and a late answer can't undo an earlier one.
   */
  retry = (resource: ResourceKey): Promise<void> => {
    const load = { meta: () => this.reloadMeta(), members: () => this.loadMembers(), grants: () => this.loadGrants(), audit: () => this.loadAudit(), memory: () => this.loadMemory(true) }[resource as Loaded] as (() => Promise<unknown>) | undefined
    if (!load) return Promise.resolve()
    const running = this.retrying.get(resource)
    if (running) return running
    this.setStatus(resource, { status: 'loading' })
    const p = load().then(() => undefined).finally(() => { this.retrying.delete(resource) })
    this.retrying.set(resource, p)
    return p
  }
  private async reloadMeta() {
    if (await this.loadMeta()) await Promise.all([this.loadMembers(), this.loadGrants(), this.loadAudit(), this.loadMemory()])
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
    else console.warn(`Inhouse: could not read ${what} again after a save.`, e)
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
    const run = (async () => {
      await prior
      try {
        const answer = await o.send()
        this.commit(o.done(this.s, answer, others()))
        await o.after?.()
      } catch (e) {
        if (!prior && this.s === mine) this.commit(before); else this.commit(o.undo(this.s, before, others()))
        const err = e instanceof AgentError ? e : new AgentError('unknown', MESSAGE.unknown)
        if (err.current && o.onConflict) this.commit(o.onConflict(this.s, err.current, others()))
        throw this.fail(err)
      } finally {
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
    // `r:` (a routine) and `s:` (a skill) switches belong to P4 and P5.
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
      after: key === 'g:name' ? async () => { await Promise.all([this.refreshMembers(), this.refreshMe()]) } : undefined,
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

  /** Where the audit log downloads from. A relative path: the browser sends it to its own origin, with its sign-in. */
  auditExportUrl = (): string | null => '/api/audit/export.csv'
  signOutUrl = (): string | null => '/cdn-cgi/access/logout'

  // ---------- everything else: the P1 stub, until its phase ----------

  /** A write that isn't served yet: refused, and the person is told with an `error` notice, as `AgentClient` says of every failed write. */
  private refuse<T = void>(): Promise<T> {
    this.notify({ type: 'error', code: 'unavailable', text: UNAVAILABLE })
    return rejected<T>()
  }

  approve = (_id: string) => this.refuse<Awaited<ReturnType<AgentClient['approve']>>>()
  undo = (_id: string) => this.refuse()
  editDraft = (_id: string, _body: string) => this.refuse()
  undoHandled = (_id: string) => this.refuse<string>()
  redoHandled = (_id: string) => this.refuse()

  createChat = (_chat: Parameters<AgentClient['createChat']>[0]) => this.refuse()
  // The chat surface (C4, C5) is the next PR's: until then each call is refused, and a read or an attach finds nothing.
  listChats = (_opts?: Parameters<AgentClient['listChats']>[0]) => this.refuse<Awaited<ReturnType<AgentClient['listChats']>>>()
  getChat = (_id: string, _cursor?: string) => this.refuse<Awaited<ReturnType<AgentClient['getChat']>>>()
  send = (_chatId: string, _input: Parameters<AgentClient['send']>[1]) => this.refuse<Awaited<ReturnType<AgentClient['send']>>>()
  interrupt = (_turnId: string) => this.refuse()
  stop = (_turnId: string) => this.refuse()
  activeRuns = () => Promise.resolve([] as Awaited<ReturnType<AgentClient['activeRuns']>>)
  attach = (_runId: string, _onFrame: Parameters<AgentClient['attach']>[1], _fromSeq?: number, _onRefused?: Parameters<AgentClient['attach']>[3]): (() => void) => () => undefined
  link = (): LinkState => 'live'
  onLink = (_l: (s: LinkState) => void): (() => void) => () => undefined
  getTrace = (_id: string): Promise<Trace | null> => Promise.resolve(null)
  resetSession = (_chatId: string) => this.refuse()

  pause = () => this.refuse<Instant>()
  resume = () => this.refuse()

  requestTool = (_key: string, _on: boolean) => this.refuse()
  requestSkill = (_name: string) => this.refuse()
  setToolPaused = (_key: string, _paused: boolean) => this.refuse()
  sendTeamRequest = (_req: Parameters<AgentClient['sendTeamRequest']>[0]) => this.refuse()
  listNotifications = () => NO_NOTIFICATIONS
  markNoticesRead = (_ids: string[]) => this.refuse()

  listFiles = () => NO_FILES
  deleteFiles = (_ids: string[]) => this.refuse()
  restoreFiles = (_ids: string[]) => this.refuse()

  setAside = (_id: string, _reason: Parameters<AgentClient['setAside']>[1]) => this.refuse()
  runRoutine = (_id: string) => this.refuse<RoutineRun>()
  deleteRoutine = (_id: string) => this.refuse()
  restoreRoutine = (_id: string) => this.refuse()
  renameChat = (_id: string, _title: string | null) => this.refuse()
  pinChat = (_id: string, _pinned: boolean) => this.refuse()
  deleteChats = (_ids: string[]) => this.refuse()
  restoreChats = (_ids: string[]) => this.refuse()
}

