// Domain types for the Inhouse app. The mock agent and (later) the real
// agent client both implement AgentClient, so swapping touches one module.
// Every value and event AgentClient returns is a zod schema in shared/contract; the types here are inferred from those
// schemas, so each is defined once. What stays here: the client interface, its inputs, the error class and constants.
import type { Stage, StageIndex, Scenario, Effort, AgentErrorCode, Instant } from '../../shared/contract/common'
import type { RoutineRun } from '../../shared/contract/routine'
import type { Trace } from '../../shared/contract/trace'
import type { ModelMode } from '../../shared/contract/model'
import type { Attachment } from '../../shared/contract/chat'
import type { RunEvent } from '../../shared/contract/run-event'
import type { LibraryFile } from '../../shared/contract/library'
import type { ApproveResult, TeamRequest, SetAsideReason, AgentState } from '../../shared/contract/state'
import type { AgentNotice, AgentNotification } from '../../shared/contract/notice'
import type { AgentData } from '../../shared/contract/data'

export type { Stage, StageIndex, Scenario, Effort, AgentErrorCode, Instant, Money, ClockTime } from '../../shared/contract/common'
export type { AgentMeta } from '../../shared/contract/meta'
export type { ProblemSource, Draft, Problem } from '../../shared/contract/problem'
export type { ToolDetail, CatalogTool, ToolChannel, ToolsData } from '../../shared/contract/tools'
export type { RoutineDef, RoutineRun } from '../../shared/contract/routine'
export type { SkillDef, SkillSuggestion } from '../../shared/contract/skill'
export type { TraceStepKind, TraceStep, Trace } from '../../shared/contract/trace'
export type { ModelMode } from '../../shared/contract/model'
export type { MemoryLine, MemoryData } from '../../shared/contract/memory'
export type { UsageRow, UsageData } from '../../shared/contract/usage'
export type { PeopleData } from '../../shared/contract/people'
export type { AuditEntry, ActivityLine } from '../../shared/contract/activity'
export type { Attachment, TablePart, RoutineCard, SkillCard, MessagePart, ChatMessage, SeedTurn, ChatThread, ChatData } from '../../shared/contract/chat'
export type { RunEvent } from '../../shared/contract/run-event'
export type { LibraryKind, LibraryPlace, DocPreview, LibraryLink, LibraryFile } from '../../shared/contract/library'
export type { ApprovalRecord, ApproveResult, TeamRequest, StampRecord, SetAsideReason, SetAsideRecord, AgentState } from '../../shared/contract/state'
export type { AgentNotice, NoticePage, AgentNotification } from '../../shared/contract/notice'
export type { AgentData } from '../../shared/contract/data'

export const STAGES: Stage[] = ['Watch', 'Act', 'Run']
export const SCENARIOS: Scenario[] = ['Normal', 'First day', 'Loading', 'Tool disconnected', 'Cap reached']
/** Where a person's photo is kept in `AgentState.settings`: a data URL, or '' once they removed it. */
export const photoKey = (personId: string) => `photo:${personId}`
export const stageIndex = (s: Stage): StageIndex => STAGES.indexOf(s) as StageIndex

/** A model as the Composer gets it: the team's chosen effort, and whether the team can use it. */
export interface ThinkingMode extends ModelMode { on: boolean }

/** What a write rejects with. The change was taken back, and a notice told the person, so a caller needn't await it. */
export class AgentError extends Error {
  readonly code: AgentErrorCode
  constructor(code: AgentErrorCode, message: string) { super(message); this.name = 'AgentError'; this.code = code }
}

/** How soon a message sent into a running answer is taken: `now` steers at the next step, `next` (the default) when the
 *  current turn ends, `later` after everything else waiting. The engine's message priority. */
export type SendPriority = 'now' | 'next' | 'later'

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
  /** Resolves to when it was paused. */
  pause(): Promise<Instant>
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
