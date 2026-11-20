// The product's agent client, until P2 connects it to the Worker. It implements `AgentClient` with nothing behind it:
// reads return the `loading` snapshot (empty lists, nothing known), writes reject with `AgentError('unavailable')` and send
// the `error` notice every failed write sends, and a run never starts. The product shell reads that as "not connected yet" and shows one screen in place of the pages
// (src/shell/NotConnected.tsx). P2 fills this file in. It imports nothing from the mock or the sample data.
import { instantOf } from '../../lib/format'
import { AgentError } from '../types'
import type {
  AgentClient, AgentData, AgentNotice, AgentNotification, AgentState, AskOptions, Instant, LibraryFile, RoutineRun, RunEvent, Trace,
} from '../types'

const UNAVAILABLE = 'Not connected yet.'

/** No data has arrived: every list empty, `status` `loading`. The same object every time, so React sees no change. */
const LOADING: AgentData = {
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
  people: { members: [], approvalRules: [], runLimits: { jobsAgentMayFinish: [], alwaysWaitsForAPerson: [], dailyActionLimit: 0, largestRestockUnits: 0 } },
  memory: { team: [], personal: [] },
  auditLog: [],
  activity: { today: [], earlier: [] },
  notifications: { teamRequests: [] },
  models: [],
  defaultModel: '',
  chat: { chats: [], recentCount: 0, suggestions: [] },
  library: { places: [] },
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

/** A refusal. A caller that doesn't await must not raise an unhandled rejection; one that awaits still gets it. */
const rejected = <T,>(): Promise<T> => {
  const p = Promise.reject<T>(new AgentError('unavailable', UNAVAILABLE))
  p.catch(() => undefined)
  return p
}

export class HttpAgent implements AgentClient {
  private noticeListeners = new Set<(n: AgentNotice) => void>()

  /** A write: always refused, and the person is told with an `error` notice, as `AgentClient` says of every failed write. */
  private refuse<T = void>(): Promise<T> {
    const n: AgentNotice = { type: 'error', code: 'unavailable', text: UNAVAILABLE }
    this.noticeListeners.forEach(l => l(n))
    return rejected<T>()
  }

  getSnapshot = () => EMPTY_STATE
  read = () => LOADING
  subscribe = (_listener: () => void) => () => undefined
  onNotice = (l: (n: AgentNotice) => void) => { this.noticeListeners.add(l); return () => { this.noticeListeners.delete(l) } }
  allChatIds = () => NO_IDS

  approve = (_id: string) => this.refuse<Awaited<ReturnType<AgentClient['approve']>>>()
  undo = (_id: string) => this.refuse()
  editDraft = (_id: string, _body: string) => this.refuse()
  undoHandled = (_id: string) => this.refuse<string>()
  redoHandled = (_id: string) => this.refuse()

  createChat = (_chat: { id: string; title: string }) => this.refuse()
  /** A run that never starts: the first `next()` rejects. Not a write, so no notice: the caller shows the failed answer. */
  ask = (_text: string, _opts: AskOptions): AsyncIterable<RunEvent> => ({ [Symbol.asyncIterator]: () => ({ next: () => rejected<IteratorResult<RunEvent>>() }) })
  send = (_runId: string, _text: string, _opts?: Parameters<AgentClient['send']>[2]) => this.refuse()
  interrupt = (_runId: string) => this.refuse()
  stop = (_runId: string): void => undefined
  getTrace = (_id: string): Trace | null => null

  pause = () => this.refuse<Instant>()
  resume = () => this.refuse()

  setToggle = (_key: string, _on: boolean) => this.refuse()
  requestTool = (_key: string, _on: boolean) => this.refuse()
  requestSkill = (_name: string) => this.refuse()
  setToolPaused = (_key: string, _paused: boolean) => this.refuse()
  forgetMemory = (_key: string, _forgotten: boolean) => this.refuse()
  setSetting = (_key: string, _value: string | null) => this.refuse()
  setPhoto = (_personId: string, _dataUrl: string | null) => this.refuse()
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
