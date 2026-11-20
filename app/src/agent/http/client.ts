// The product's agent client, until P2 connects it to the Worker. It implements `AgentClient` with nothing behind it:
// reads return the `loading` snapshot (empty lists, nothing known), writes reject with `AgentError('unavailable')`, and a
// run never starts. The product shell reads that as "not connected yet" and shows one screen in place of the pages
// (src/shell/NotConnected.tsx). P2 fills this file in. It imports nothing from the mock or the sample data.
import { instantOf } from '../../lib/format'
import { AgentError } from '../types'
import type {
  AgentClient, AgentData, AgentNotification, AgentState, AskOptions, Instant, LibraryFile, RoutineRun, RunEvent, Trace,
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
  tools: { connected: [], channels: [], beingConnected: [], lastRead: { default: instantOf(0) }, catalog: [], details: {} },
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
  scenarios: { firstDay: { setup: [] }, loading: { readDone: 0 }, toolDisconnected: { tool: '', at: instantOf(0) } },
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
  demoStartedAt: 0,
}
const NO_NOTIFICATIONS: AgentNotification[] = []
const NO_FILES: LibraryFile[] = []
const NO_IDS: string[] = []

/** A write: always refused. A caller that doesn't await must not raise an unhandled rejection; one that awaits still gets it. */
const refuse = <T = void>(): Promise<T> => {
  const p = Promise.reject<T>(new AgentError('unavailable', UNAVAILABLE))
  p.catch(() => undefined)
  return p
}

export class HttpAgent implements AgentClient {
  getSnapshot = () => EMPTY_STATE
  read = () => LOADING
  subscribe = (_listener: () => void) => () => undefined
  onNotice = (_listener: Parameters<AgentClient['onNotice']>[0]) => () => undefined
  allChatIds = () => NO_IDS

  approve = (_id: string) => refuse<Awaited<ReturnType<AgentClient['approve']>>>()
  undo = (_id: string) => refuse()
  editDraft = (_id: string, _body: string) => refuse()
  undoHandled = (_id: string) => refuse<string>()
  redoHandled = (_id: string) => refuse()

  createChat = (_chat: { id: string; title: string }) => refuse()
  /** A run that never starts: the first `next()` rejects. */
  ask = (_text: string, _opts: AskOptions): AsyncIterable<RunEvent> => ({ [Symbol.asyncIterator]: () => ({ next: () => refuse<IteratorResult<RunEvent>>() }) })
  send = (_runId: string, _text: string, _opts?: Parameters<AgentClient['send']>[2]) => refuse()
  interrupt = (_runId: string) => refuse()
  stop = (_runId: string): void => undefined
  getTrace = (_id: string): Trace | null => null

  pause = () => refuse<Instant>()
  resume = () => refuse()

  setToggle = (_key: string, _on: boolean) => refuse()
  requestTool = (_key: string, _on: boolean) => refuse()
  requestSkill = (_name: string) => refuse()
  setToolPaused = (_key: string, _paused: boolean) => refuse()
  forgetMemory = (_key: string, _forgotten: boolean) => refuse()
  setSetting = (_key: string, _value: string | null) => refuse()
  setPhoto = (_personId: string, _dataUrl: string | null) => refuse()
  sendTeamRequest = (_req: Parameters<AgentClient['sendTeamRequest']>[0]) => refuse()
  listNotifications = () => NO_NOTIFICATIONS
  markNoticesRead = (_ids: string[]) => refuse()

  listFiles = () => NO_FILES
  deleteFiles = (_ids: string[]) => refuse()
  restoreFiles = (_ids: string[]) => refuse()

  setAside = (_id: string, _reason: Parameters<AgentClient['setAside']>[1]) => refuse()
  runRoutine = (_id: string) => refuse<RoutineRun>()
  deleteRoutine = (_id: string) => refuse()
  restoreRoutine = (_id: string) => refuse()
  renameChat = (_id: string, _title: string | null) => refuse()
  pinChat = (_id: string, _pinned: boolean) => refuse()
  deleteChats = (_ids: string[]) => refuse()
  restoreChats = (_ids: string[]) => refuse()
}
