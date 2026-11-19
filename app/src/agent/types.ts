// Domain types for the Inhouse app. The mock agent and (later) the real
// agent client both implement AgentClient, so swapping touches one module.

export type Stage = 'Watch' | 'Act' | 'Run'
/** 0 Watch, 1 Act, 2 Run. `need` fields in the sample data use the same index. */
export type StageIndex = 0 | 1 | 2
export type Scenario = 'Normal' | 'First day' | 'Loading' | 'Tool disconnected' | 'Cap reached'
export const STAGES: Stage[] = ['Watch', 'Act', 'Run']
export const SCENARIOS: Scenario[] = ['Normal', 'First day', 'Loading', 'Tool disconnected', 'Cap reached']
/** Where a person's photo is kept in `AgentState.settings`: a data URL, or '' once they removed it. */
export const photoKey = (personId: string) => `photo:${personId}`
export const stageIndex = (s: Stage): StageIndex => STAGES.indexOf(s) as StageIndex

// ---------- sample data shapes ----------

export interface ProblemSource { n: string; logo?: string; icon?: string; name: string; text: string }

export interface Draft {
  title: string
  lines: [string, string][]
  bodyLabel?: string
  body?: string
  money?: boolean
  customer?: boolean
  /** Reversible: Undo stays after approval, no 10 s hold. */
  rev?: boolean
  memory?: string
  cta: string
  approver?: string
  ask?: string
  runTitle?: string
  runLines?: [string, string][]
  doneNote?: string
}

export interface Problem {
  id: string
  sev: string
  area: string
  title: string
  sub: string
  logos: string[]
  cost: string
  costNote: string
  next: string
  review?: string
  /** Run: what Inhouse agent did by itself. Present means handled in Run. */
  done?: string
  doneText: string
  /** What waits for a person in Run. */
  wait?: string
  partial?: boolean
  partialShort?: string
  runDoneText?: string
  isDraft?: boolean
  /** Trace id of the run that drafted or handled this problem. Missing means no steps to show. */
  trace?: string
  found: [string, string][]
  sources: ProblemSource[]
  draft: Draft
  /** When the agent made this problem's draft, as shown (Activity, Approvals). Never sort on it: use `draftedMin`. */
  draftedAt: string
  /** The same time as minutes since midnight: what Approvals sorts by. */
  draftedMin: number
}

export interface ToolDetail {
  name: string
  desc: string
  progress?: boolean
  ex: string[]
  read: string
  draft: string
  run: string
  conn: string
  site: string
  since: string
}

export interface CatalogTool { k: string; name: string; desc: string; need?: StageIndex }

export interface RoutineDef {
  /** The agent's own id for the routine: stable, and what runRoutine, deleteRoutine and restoreRoutine take. */
  id: string
  name: string
  what: string
  freq: 'Daily' | 'Weekly' | string
  day: string
  time: string
  next: string
  need: StageIndex
  money?: boolean
  last?: string
  /** Made in a sample chat (the stuck orders chat): listed only from the stage it needs, since below it the chat couldn't make it. */
  inChat?: boolean
}

export interface SkillDef { n: string; d: string; icon: string; need: StageIndex; by: string; used: string; mine?: boolean }
export interface SkillSuggestion { n: string; d: string; icon: string }

export type TraceStepKind = 'root' | 'model' | 'tool' | 'agent' | 'wait' | 'handoff' | 'approval' | 'answer' | 'fail'
export interface TraceStep { label: string; kind: TraceStepKind; start: number; end: number; depth: number; detail: string }
/** `id` is whatever the agent calls the run: a recorded key or a run id in the mock, a run id in phase 2. */
export interface Trace { id: string; title: string; duration: number; cost: string; tokens: string; steps: TraceStep[] }

/** How hard a model thinks, as the engine names it. */
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'
/** A model from models.json, with its default effort. */
export interface ModelMode { id: string; label: string; model: string; sub: string; effort: Effort }
/** A model as the Composer gets it: the team's chosen effort, and whether the team can use it. */
export interface ThinkingMode extends ModelMode { on: boolean }

export interface MemoryLine { key: string; text: string; source: string }

export interface UsageRow {
  name: string
  /** What the row covers when the team can't reach the agent in a channel. */
  sub: string
  /** The same line once a channel is connected: `{channel}` stands for the channel's name. Missing: `sub` always. */
  subWithChannel?: string
  dollars: number
  conversations: number
}

// ---------- chat ----------

export interface Attachment { name: string; meta: string; icon: string }

export interface TablePart {
  title: string
  summary: string
  /** Material Symbols name for the header. Default: a delivery truck. */
  icon?: string
  rows: { order: string; age: string; why: string; value: string }[]
  sources: string[]
}

export interface RoutineCard {
  /** The agent's own id for the routine, as on RoutineDef. */
  id: string
  name: string
  freq: string
  day: string
  time: string
  next: string
  note: string
  /** Original request, for routines created in a chat. */
  what?: string
}

export interface SkillCard { name: string; desc: string; tools: string; mode: string }

/** One part of the agent's reply. Matches the README's MessagePart list. */
export type MessagePart =
  | { type: 'text'; text: string }
  | { type: 'table'; table: TablePart }
  | { type: 'approval'; problemId: string }
  | { type: 'routine'; routine: RoutineCard }
  | { type: 'skill'; skill: SkillCard }
  | { type: 'workRow'; text: string; time: string }
  | { type: 'notInThisStage'; text: string }
  | { type: 'error'; text: string; retryQuestion: string }
  /** Questions to ask next, offered as chips under an answer the agent couldn't give (decision D8). */
  | { type: 'suggestions'; questions: string[] }

export type ChatMessage =
  | { id: string; role: 'user'; text: string; quote?: string; atts?: Attachment[] }
  /**
   * `model` (the model id from models.json, shown by its label) and `at` (when it answered, ms since the epoch) are set
   * on answers given in this session; seed answers have neither. Phase 1 stamps them in the store; in phase 2 the agent
   * fills them in on each `part` event.
   */
  | { id: string; role: 'agent'; part: MessagePart; trace: string; model?: string; at?: number }
  | { id: string; role: 'event'; text: string }

export type RunEvent =
  | { type: 'run.started'; runId: string }
  | { type: 'step'; label: string }
  /** Phase 2: the agent may carry the model id that answered and when (ms since the epoch); the store falls back to its own. */
  /** `trace` is the turn's trace id (`getTrace`): each message sent into a run starts a turn with its own, the run's id
   *  for the first turn and `${runId}-t${n}` for the nth (the store names a failed turn's error by it). */
  | { type: 'part'; part: MessagePart; trace: string; model?: string; at?: number }
  /** A message sent into the running answer (`send`) is now being answered: the store adds it as the person's message and the run goes on. */
  | { type: 'turn.started'; text: string }
  | { type: 'approval.requested'; approvalId: string }
  /** Comes only when nothing sent into the run is still waiting. */
  | { type: 'run.finished'; runId: string; steps: number; seconds: number; cost: string }
  | { type: 'run.failed'; runId: string; message: string }
  | { type: 'run.stopped'; runId: string }

// ---------- library ----------

export type LibraryKind = 'images' | 'documents' | 'code' | 'media' | 'other'
export interface LibraryPlace { id: string; name: string; icon: string }

/** A first page for documents Inhouse agent made: a small structured document the Library draws, not a real PDF render. */
export interface DocPreview {
  tag: string
  title: string
  meta: [string, string][]
  table?: { head: string[]; rows: string[][]; total?: string | string[] }
  note?: string
}

/** Where a file came from. Opening it goes to that chat, the Routines page or that approval. Uploads have no link. */
export type LibraryLink = { to: 'chat' | 'approval'; id: string } | { to: 'routines' }

export interface LibraryFile {
  id: string
  name: string
  /** The badge: PDF, CSV, MD, XLSX, JSON, SQL, PY, PNG, JPG, M4A, MP4, ZIP, ICS. */
  type: string
  kind: LibraryKind
  /** A LibraryPlace id. */
  place: string
  /** Shown on the card: "Chat: Stuck orders over 3 days", "Routine: Morning check", "Uploaded by Priya Shah". */
  from: string
  link?: LibraryLink
  by: string
  /** True when the agent made the file, false when a person uploaded it. Decides "Made by" or "Uploaded by". */
  madeByAgent: boolean
  size: string
  /** Shown. It carries no year on purpose. */
  date: string
  /** Sort key, newest last when ascending. */
  at: string
  /** Images: the picture and its width/height ratio. */
  src?: string
  ratio?: string
  doc?: DocPreview
  table?: { head: string[]; rows: string[][]; total: string }
  /** Code and text files: the contents. */
  text?: string
  media?: 'audio' | 'video'
  duration?: string
  poster?: string
  /** ZIP: what is inside. */
  entries?: string[]
  /** Calendar files: the events. */
  lines?: [string, string][]
}

// ---------- agent state (persisted, resettable) ----------

export interface ApprovalRecord {
  /** Time of day shown to the user, on the demo clock ("8:03 AM"). */
  at: string
  /** The same time as minutes since midnight, for sorting. */
  atMin: number
  /** Who approved it: the person's name at approval time. */
  by: string
  /** Epoch ms, used to finish the 10 s hold across reloads. */
  ms: number
  /** Draft title at approval time (partial-aware). History keeps it even if the stage or undo state changes later. */
  title: string
  /** Final wording once done or sent, taken at approval time. */
  doneText: string
  /** Whether Inhouse agent had done part of this job by itself when it was approved (Run). Decides the lines and note shown later. */
  partial: boolean
}

/** What `approve` tells the UI, so it never recomputes the wording. */
export interface ApproveResult {
  record: ApprovalRecord
  /** True when the 10 s send hold runs. False for reversible drafts. */
  held: boolean
  doneText: string
}

export interface TeamRequest { icon: string; title: string; sub: string; status: string }

export interface AgentState {
  approved: Record<string, ApprovalRecord>
  /** Approved, held 10 s, now final. */
  sent: Record<string, true>
  /** Run: a person undid what Inhouse agent handled: when and who. */
  undone: Record<string, StampRecord>
  /** Edited draft bodies. */
  edits: Record<string, string>
  /** When a person paused Inhouse agent ("8:03 AM" on the demo clock), or null. */
  paused: string | null
  /** Switches: routines (r:<name>), settings (n:, m:, l:, d:). Missing = default. */
  toggles: Record<string, boolean>
  routinesExtra: RoutineCard[]
  skillsExtra: SkillDef[]
  requestedTools: Record<string, true>
  requestedSkills: Record<string, true>
  toolPaused: Record<string, true>
  forgot: Record<string, true>
  /** Settings dropdowns and text fields, by row key. Missing = the page's default. */
  settings: Record<string, string>
  teamRequests: TeamRequest[]
  /**
   * Bell notifications read, by id: one a person opened, or every one listed when they chose Mark all as read, so a
   * later notification still arrives unread. A notification whose content changes gets a new id. Phase 2: the agent
   * sends notifications with their own ids.
   */
  readNotices: Record<string, true>
  /** Library files a person deleted. */
  libraryDeleted: Record<string, true>

  /** Problems a person set aside, by id: snoozed or dismissed on Today, or a draft they chose not to send. Approving one clears it. */
  setAside: Record<string, SetAsideRecord>
  /** Routines a person deleted, by the routine's `id`. */
  routinesDeleted: Record<string, true>
  /** Routines a person ran with Run now, newest first. */
  routineRuns: RoutineRun[]
  // ---------- managing chats ----------
  /** Chat titles a person set, by chat id. Missing = the chat's own title. */
  chatTitles: Record<string, string>
  /** Pinned chats: listed first, under Pinned in the sidebar. */
  chatPinned: Record<string, true>
  /** Chats a person deleted. Soft, so Undo can bring them back; Reset demo clears it. */
  chatDeleted: Record<string, true>
  /** When this demo started (epoch ms): set at first load and by Reset demo. The demo clock counts from it (agent/clock.ts). */
  demoStartedAt: number
}

/** When and by whom something was done: `at` is shown ("8:03 AM"), `atMin` sorts, `by` is the person's name then. */
export interface StampRecord { at: string; atMin: number; by: string }

/** Why a problem left Today and Approvals: snoozed until tomorrow, not a problem, or a draft not to send. */
export type SetAsideReason = 'snoozed' | 'dismissed' | 'declined'
/** When and why a problem was set aside. A snooze lasts until the day after `ms`; the mock's date never moves, so it keeps it all demo. */
export interface SetAsideRecord {
  reason: SetAsideReason
  /** Time of day shown to the user, on the demo clock ("8:03 AM"). */
  at: string
  /** The same time as minutes since midnight, for sorting. */
  atMin: number
  /** Who set it aside: the person's name then. */
  by: string
  /** Epoch ms, so a real client can end a snooze the next day. */
  ms: number
}

/** One Run now. `routine` is the routine's `id`; `at` is shown, `atMin` sorts; `trace` is the run's steps when the agent has them; `result` is what the run found, when the agent says. */
export interface RoutineRun { routine: string; at: string; atMin: number; trace?: string; result?: string }

export type AgentNotice =
  | { type: 'approval.sent'; id: string; text: string }
  /** A change could not be saved (the browser's storage is full). `text` is what to tell the person. */
  | { type: 'save.failed'; text: string }
  /** A write failed and was taken back. The method's promise rejects with the same AgentError; `text` is what to tell the person. */
  | { type: 'error'; code: AgentErrorCode; text: string }

export type AgentErrorCode = 'offline' | 'forbidden' | 'conflict' | 'unknown'
/** What a write rejects with. The change was taken back, and a notice told the person, so a caller needn't await it. */
export class AgentError extends Error {
  readonly code: AgentErrorCode
  constructor(code: AgentErrorCode, message: string) { super(message); this.name = 'AgentError'; this.code = code }
}

/** How soon a message sent into a running answer is taken: `now` steers at the next step, `next` (the default) when the
 *  current turn ends, `later` after everything else waiting. The engine's message priority. */
export type SendPriority = 'now' | 'next' | 'later'

/** A bell notification, as the agent sends it. Stable until state changes, like `listFiles()`. */
export interface AgentNotification {
  /** Changes when what it says changes, so a new count arrives unread. */
  id: string
  icon: string
  text: string
  who: string
  /** A person's name when one did it: the bell shows their avatar. */
  person?: string
  /** When, as shown. */
  at: string
  unread: boolean
  /** It says something is waiting for the person: "You're all caught up" never shows above it. */
  waiting?: boolean
  link: { to: 'tool'; key: string } | { to: 'page'; page: NoticePage } | { to: 'chat'; id: string }
}
/** The places a notification can open. */
export type NoticePage = 'today' | 'approvals' | 'activity' | 'routines' | 'library'

export interface AskOptions {
  /** The chat the question is asked in: a sample chat's id, or one made with `createChat`. Any other id throws. */
  chatId: string
  /** The part of an answer the person is replying to. */
  quote?: string
  /** The run whose answer this one replaces (Regenerate, Edit of its question, or Try again on a failed answer). The agent
   *  updates in place what that run made (a routine, a skill), so nothing is made twice. A routine the new answer doesn't
   *  make again is deleted (`routinesDeleted`, so `restoreRoutine` brings it back), unless the new answer failed: then
   *  the routine stays, and the failed run carries it on, so the answer after it updates it rather than making a second.
   *  A skill is never taken back. */
  replacesRun?: string
  attachments?: Attachment[]
  /** Model id from models.json. */
  mode?: string
  /** How hard that mode thinks, as set in Settings. Phase 2 passes it to the engine. */
  effort?: Effort
}

export interface DemoContext { stage: Stage; scenario: Scenario }

// ---------- read-only domain data ----------

export interface AgentMeta {
  brand: { name: string; staff: number; sells: string; emailDomain: string }
  agent: { tone: string; signsEmailsAs: string }
  currentUser: { id: string; name: string; initials: string; email: string; title: string; role: string }
}

/** A channel the team hears from the agent on (Slack): not a tool it reads. Decision D6. */
export interface ToolChannel {
  key: string
  name: string
  /** What it's for, as one line. */
  desc: string
  /** The stage it starts at: shown as included from that stage below it. */
  need: StageIndex
  /** When it was connected, as shown ("Nov 2"). */
  since: string
  site: string
  /** Where it reaches the team ("#ops"). */
  channel?: string
  /** What reaches that channel, as short phrases. */
  sends?: string[]
  /** Who can ask the agent there. */
  ask?: string
}

export interface ToolsData {
  /** The six tools Inhouse agent reads, in display order. */
  connected: string[]
  /** Connected channels the team hears from the agent on (Slack, from Act): not tools it reads. Decision D6. */
  channels: ToolChannel[]
  beingConnected: string[]
  lastRead: Record<string, string> & { default: string }
  catalog: CatalogTool[]
  details: Record<string, ToolDetail>
}

export interface UsageData {
  month: string
  cap: number
  alertAt: number
  total: number
  conversations: number
  questionsAsked: number
  jobsRun: number
  daily: number[]
  breakdown: Record<'person' | 'job' | 'model' | 'tool', UsageRow[]>
}

export interface PeopleData {
  members: { id: string; name: string; photo?: string; email: string; title: string; role: string }[]
  approvalRules: { what: string; detail: string; approver: string }[]
  runLimits: { jobsAgentMayFinish: { id: string; name: string; desc: string }[]; dailyActionLimit: number; largestRestockUnits: number }
}

export interface MemoryData {
  team: { group: string; lines: MemoryLine[] }[]
  personal: MemoryLine[]
}

export interface AuditEntry { day: string; who: string; what: string; detail: string; at: string }

export interface ActivityLine {
  /** Missing for lines that belong to today. */
  day?: string
  /** Shown ("6:00 AM"). Never sort on it: use `atMin`. */
  t: string
  /** The same time as minutes since midnight, for sorting inside a day. */
  atMin: number
  kind: 'read' | 'change' | 'needs' | 'problem'
  /** Shown only from this stage up. */
  minStage?: Stage
  text: string
  who: string
  why: string
  result: string
  by: string
  /** The run's recorded steps. Missing for a routine whose steps weren't recorded. */
  trace?: string
}

/** One turn of the seed conversation. `stage` limits an agent turn to that stage. */
export type SeedTurn =
  | { role: 'user'; text: string }
  | { role: 'agent'; stage?: Stage; trace: string; parts: MessagePart[] }

/** One chat in the sidebar and in See all. Its messages are the turns, then whatever the person adds. */
export interface ChatThread {
  id: string
  title: string
  /** Group in See all: Today, Yesterday, Last 7 days or Earlier. */
  day: string
  /** Shown: today a time, the six days before a weekday, older a date. Never sort on it: use `iso`. */
  at: string
  /** When, as a local ISO date and time ("2026-11-16T07:42"): what the list's newest-first order follows. */
  iso: string
  turns: SeedTurn[]
}

export interface ChatData {
  /** Every chat, newest first. */
  chats: ChatThread[]
  /** How many of them the sidebar lists. */
  recentCount: number
  suggestions: string[]
}

/**
 * Read-only snapshot of everything the UI reads besides AgentState: sample data in the mock,
 * data from the Worker in phase 2. A real client caches it and calls `subscribe` listeners on change.
 */
export interface AgentData {
  /** `loading` until the agent's data has arrived: lists are empty then. The mock is `loading` only in the Loading scenario. */
  status: 'loading' | 'ready'
  meta: AgentMeta
  problems: Problem[]
  tools: ToolsData
  routines: RoutineDef[]
  skills: SkillDef[]
  skillSuggestions: SkillSuggestion[]
  /** The heading over `skillSuggestions` ("Suggested for Shopify brands"). Missing: "Suggested for you". */
  skillSuggestionsTitle?: string
  usage: UsageData
  /** Usage by month for the month picker, newest first. The first one is `usage`. */
  usageMonths: UsageData[]
  people: PeopleData
  memory: MemoryData
  auditLog: AuditEntry[]
  /** The fixed lines of Activity. Today's approvals and handled jobs come from state. */
  activity: { today: ActivityLine[]; earlier: ActivityLine[] }
  notifications: {
    teamRequests: { title: string; sub: string; status: string }[]
      }
  scenarios: {
    firstDay: { setup: [string, string][] }
    /** The Loading scenario: how many tools the morning check has read so far. */
    loading: { readDone: number }
    /** The Tool disconnected scenario: which tool lost its login, and when (shown). */
    toolDisconnected: { tool: string; at: string }
  }
  models: ModelMode[]
  defaultModel: string
  chat: ChatData
  library: { places: LibraryPlace[] }
  /** Help and guides, from the account menu. */
  help: { icon: string; title: string; text: string }[]
}

/**
 * The agent, as the app talks to it. Reads used by React are synchronous snapshots (`getSnapshot`, `read`, `listFiles`,
 * `listNotifications`, `getTrace`). Every method that changes state applies the change to the snapshot at once
 * (optimistic) and returns a Promise that resolves once it's saved; on failure it takes the change back, rejects with an
 * `AgentError` and also sends a notice (`save.failed` when the browser couldn't save it, else `error`), so a caller that
 * doesn't await still tells the person.
 */
export interface AgentClient {
  // state
  getSnapshot(): AgentState
  /** Synchronous, stable between changes (React reads it with useSyncExternalStore). Follows the demo scenario. */
  read(): AgentData
  subscribe(listener: () => void): () => void
  onNotice(listener: (n: AgentNotice) => void): () => void
  /** Every chat id the agent has, whatever the demo scenario shows (`read().chat.chats` follows the scenario): the sample
   *  chats and the ones made with `createChat`. The app checks saved chat additions against it. */
  allChatIds(): string[]
  /** Dev switcher: stage comes from the plan in production, scenario from real state. Tells listeners when it changes. */
  setDemo(ctx: DemoContext): void
  /** Dev action: clear every state change. */
  reset(): void

  // approvals
  /** Starts the 10 s hold, or finishes at once for reversible drafts. */
  approve(id: string): Promise<ApproveResult>
  /** Rejects with `conflict` once a held draft went out. */
  undo(id: string): Promise<void>
  editDraft(id: string, body: string): Promise<void>

  // Run: undo what Inhouse agent handled by itself
  /** Resolves to the toast text. */
  undoHandled(id: string): Promise<string>
  redoHandled(id: string): Promise<void>

  // chat
  /** The client makes the chat's id, so the chat shows at once, and tells the agent here. */
  createChat(chat: { id: string; title: string }): Promise<void>
  ask(text: string, opts: AskOptions): AsyncIterable<RunEvent>
  /** A message into a running answer (the engine's streaming input). The run's stream carries on with `turn.started`.
   *  Rejects when the run has ended. */
  send(runId: string, text: string, opts?: { priority?: SendPriority; attachments?: Attachment[] }): Promise<void>
  /** Ends the current turn and keeps the session, so messages waiting go next. */
  interrupt(runId: string): Promise<void>
  /** The hard stop: ends the run and everything waiting in it. */
  stop(runId: string): void
  /** `id` comes from the agent: a run id from `run.started`, a `trace` on a message, problem or activity line. Null when the steps aren't available. */
  getTrace(id: string): Trace | null

  // Pause and resume
  /** Resolves to when it was paused, as shown. */
  pause(): Promise<string>
  resume(): Promise<void>

  // plain reads and writes
  setToggle(key: string, on: boolean): Promise<void>
  requestTool(key: string, on: boolean): Promise<void>
  requestSkill(name: string): Promise<void>
  setToolPaused(key: string, paused: boolean): Promise<void>
  forgetMemory(key: string, forgotten: boolean): Promise<void>
  /** A settings dropdown or text field. Null puts it back to the default. */
  setSetting(key: string, value: string | null): Promise<void>
  /** A person's photo as a data URL. Null removes it, so initials show; Reset demo brings the sample photo back. */
  setPhoto(personId: string, dataUrl: string | null): Promise<void>
  sendTeamRequest(req: TeamRequest): Promise<void>
  /** The bell's notifications, newest first. Stable between changes. */
  listNotifications(): AgentNotification[]
  /** Bell notifications read: the one opened, or every listed one for Mark all as read. */
  markNoticesRead(ids: string[]): Promise<void>

  // library
  /** Every file in the Library that wasn't deleted, newest first. Stable between changes. Follows the demo scenario. */
  listFiles(): LibraryFile[]
  deleteFiles(ids: string[]): Promise<void>
  /** Undo a delete. */
  restoreFiles(ids: string[]): Promise<void>

  /** Take a problem off Today and Approvals for a reason, stamped with the time. Null brings it back (Undo). Approving it clears it too. */
  setAside(id: string, reason: SetAsideReason | null): Promise<void>
  /** Run a routine now, outside its schedule. `id` is the routine's own `id`. */
  runRoutine(id: string): Promise<RoutineRun>
  deleteRoutine(id: string): Promise<void>
  /** Undo a routine delete. */
  restoreRoutine(id: string): Promise<void>
  // ---------- managing chats ----------
  // Chats are keyed by id: the agent's chats in `AgentData.chat.chats` and chats a person started. The UI's chat list
  // applies `AgentState.chatTitles`, hides `chatDeleted` and lists `chatPinned` first.
  /** A person's title for a chat, trimmed and cut to CHAT_TITLE_MAX. Null puts the chat's own title back. */
  renameChat(id: string, title: string | null): Promise<void>
  pinChat(id: string, pinned: boolean): Promise<void>
  /** Soft delete: the chats leave every list until `restoreChats`. It doesn't stop an answer still being written to
   *  one of them: the caller stops that run with `stop` first (the app does, for every deleted chat that is answering). */
  deleteChats(ids: string[]): Promise<void>
  /** Undo a delete. */
  restoreChats(ids: string[]): Promise<void>
}

/** The longest chat title a person can set. Longer titles are cut. */
export const CHAT_TITLE_MAX = 80
