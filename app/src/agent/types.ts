// Domain types for the Inhouse app. The mock agent and (later) the real
// agent client both implement AgentClient, so swapping touches one module.
// Every value and event AgentClient returns is a zod schema in shared/contract; the types here are inferred from those
// schemas, so each is defined once. What stays here: the client interface, its inputs, the error class and constants.
import type { Stage, StageIndex, Scenario, AgentErrorCode, Instant } from '../../shared/contract/common'
import type { RoutineRun } from '../../shared/contract/routine'
import type { RoutineRunHistory } from '../../shared/contract/routines'
import type { Trace } from '../../shared/contract/trace'
import type { ModelMode } from '../../shared/contract/model'
import type { LibraryFile } from '../../shared/contract/library'
import type { ApproveResult, TeamRequest, SetAsideReason, AgentState } from '../../shared/contract/state'
import type { AgentNotice, AgentNotification } from '../../shared/contract/notice'
import type { AgentData } from '../../shared/contract/data'
import type { WaitingMemory } from '../../shared/contract/memory-approvals'
import type { ErrorReason, ResourceKey } from '../../shared/contract/common'
import type { Me } from '../../shared/contract/me'
import type { InviteInput, MemberRole } from '../../shared/contract/members'
import type { CreateChatInput, SendPriority } from '../../shared/contract/requests'
import type { ActiveRun, SendTurnResult } from '../../shared/contract/runs'
import type { ChatList, ChatPage } from '../../shared/contract/chats'
import type { AttachmentRef } from '../../shared/contract/attachments'
import type { RunFrame } from '../../shared/contract/run-event'

export type { Stage, StageIndex, Scenario, Effort, AgentErrorCode, ErrorReason, ResourceKey, ResourceStatus, Instant, Money, ClockTime, Prose } from '../../shared/contract/common'
export type { AgentMeta } from '../../shared/contract/meta'
/** The lists the agent's work fills, which `refresh` reads again (the resource each shows by). */
export type RefreshList = Extract<ResourceKey, 'library' | 'problems' | 'activity' | 'notifications' | 'requests' | 'skills'>
export type { ProblemSource, ProblemFact, Draft, DraftItem, Problem } from '../../shared/contract/problem'
export type { ToolDetail, CatalogTool, ToolChannel, ToolSetup, ToolsData } from '../../shared/contract/tools'
export type { RoutineDef, RoutineRun } from '../../shared/contract/routine'
export type { RoutineHistoryRun, RoutineRunHistory, RoutineRunOutcome } from '../../shared/contract/routines'
export type { SkillDef, SkillSuggestion } from '../../shared/contract/skill'
export type { TraceStepKind, TraceStep, Trace } from '../../shared/contract/trace'
export type { ModelMode } from '../../shared/contract/model'
export type { MemoryLine, MemoryData } from '../../shared/contract/memory'
export type { WaitingMemory } from '../../shared/contract/memory-approvals'
export type { UsageRow, UsageData } from '../../shared/contract/usage'
export type { PeopleData, ApprovalRule, Approver } from '../../shared/contract/people'
export type { MemberRecord, MemberRole, MemberId, InviteInput } from '../../shared/contract/members'
export type { Me, Role, Can, CanKey } from '../../shared/contract/me'
export type { SupportGrant, GrantHours } from '../../shared/contract/grants'
export type { CreateChatInput, DemoContext, SendPriority } from '../../shared/contract/requests'
export type { ChatEvent, ActiveRun, SendTurnResult, TurnFailure, PauseState } from '../../shared/contract/runs'
export type { ChatSummary, ChatList, ChatPage, StoredMessage } from '../../shared/contract/chats'
export type { AttachmentRef } from '../../shared/contract/attachments'
export type { ActivityLine } from '../../shared/contract/activity'
export type { AuditEntry, AuditLine } from '../../shared/contract/audit'
export type { Attachment, TablePart, RoutineCard, SkillCard, MessagePart, ChatMessage, SeedTurn, ChatThread, ChatData } from '../../shared/contract/chat'
export type { RunEvent, RunFrame } from '../../shared/contract/run-event'
export type { LibraryKind, LibraryPlace, DocPreview, LibraryLink, LibraryFile } from '../../shared/contract/library'
export type { ApprovalRecord, ApproveResult, TeamRequest, StampRecord, SetAsideReason, SetAsideRecord, AgentState } from '../../shared/contract/state'
export type { AgentNotice, NoticePage, AgentNotification } from '../../shared/contract/notice'
export type { AgentData } from '../../shared/contract/data'

export const STAGES: Stage[] = ['Watch', 'Act', 'Run']
export const SCENARIOS: Scenario[] = ['Normal', 'First day', 'Loading', 'Tool disconnected', 'Cap reached']
export type LinkState = 'live' | 'held' | 'reload' | 'grantEnded'

/** One message into a chat. `clientTurnKey` (8 to 64 of A-Z a-z 0-9 _ -) is kept by the caller for retries of this send. */
export interface ChatSendInput {
  clientTurnKey: string
  text: string
  quote?: string
  priority?: SendPriority
  /** The picker's model id (`fable`, `opus`, ...). */
  model: string
  replacesRun?: string
  attachments?: AttachmentRef[]
}

export const stageIndex = (s: Stage): StageIndex => STAGES.indexOf(s) as StageIndex

/** A model as the Composer gets it: the team's chosen effort, and whether the team can use it. */
export interface ThinkingMode extends ModelMode { on: boolean }

/** What a write rejects with. The change was taken back, and a notice told the person, so a caller needn't await it. */
export class AgentError extends Error {
  readonly code: AgentErrorCode
  /** Why, when the code alone doesn't say (not invited, the last Admin). */
  readonly reason?: ErrorReason
  /** On a stale `ifRev`, the current record or null if it is gone. */
  readonly current?: Record<string, unknown> | null
  constructor(code: AgentErrorCode, message: string, extra: { reason?: ErrorReason; current?: Record<string, unknown> | null } = {}) {
    super(message); this.name = 'AgentError'; this.code = code
    if (extra.reason !== undefined) this.reason = extra.reason
    if (extra.current !== undefined) this.current = extra.current
  }
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
  /** The client makes the chat's id, so the chat shows at once, and tells the agent here. A failed save takes the chat back (a notice tells the person). Saying it twice is fine (idempotent for its owner). */
  createChat(chat: CreateChatInput): Promise<void>
  /** One page of the person's chats, newest first (`deleted` lists the deleted ones). Each answer carries the `rev` the writes below send as `ifRev`. */
  listChats(opts?: { cursor?: string; limit?: number; deleted?: boolean }): Promise<ChatList>
  /** A chat's history, newest first from `cursor`, and `runs`: the live run and any ended run whose turns aren't all stored yet (attach to each, from 0). Rejects with not found for a chat the person doesn't have. */
  getChat(id: string, cursor?: string): Promise<ChatPage>
  /** A message into the chat: a new run, or a queued turn of its live run (`position` says which). Never waits for the answer. The same `clientTurnKey` with the same text answers the same turn, so a retry never asks twice;
   *  the same key with other text rejects with a conflict (key reused). Other refusals: forbidden (paused, model off, removed), unavailable (draining), conflict (session damaged, waiting for an answer), rate limited (queue full) and invalid. */
  send(chatId: string, input: ChatSendInput): Promise<SendTurnResult>
  /** Ends that turn and keeps the session, so what waits goes next. A turn still waiting is cancelled. Rejects with a conflict (the turn ended) for one that already ended. */
  interrupt(turnId: string): Promise<void>
  /** The hard stop of that turn only (plan S4): the run's other queued turns carry on. A turn still waiting is cancelled. A conflict (the turn ended) once it ended. */
  stop(turnId: string): Promise<void>
  /** The runs the person can attach to now. */
  activeRuns(): Promise<ActiveRun[]>
  /**
   * Follows a run: `onFrame` gets every event after `fromSeq` (default 0) in order, each exactly once, whatever the
   * connection does underneath (dropped frames, a replay after a reconnect, a stale tab). Returns the detach. A run the agent
   * refuses (not the person's, or unknown) calls `onRefused` with the code, and no frame comes.
   */
  attach(runId: string, onFrame: (f: RunFrame) => void, fromSeq?: number, onRefused?: (code: AgentErrorCode) => void): () => void
  /** The chat socket's state: `live`, `held` (the server restarts: reconnecting), `reload` (this build can't read the server's frames) or `grantEnded` (a support grant ended, the chat's data was dropped). */
  link(): LinkState
  onLink(listener: (state: LinkState) => void): () => void
  /** `id` is a run id, a turn id, or a `trace` on a message, problem or activity line. Null when the steps aren't available. */
  getTrace(id: string): Promise<Trace | null>
  /** The owner's recovery for a chat whose session is damaged: the history stays, the next message starts the session fresh. */
  resetSession(chatId: string): Promise<void>

  // Pause and resume
  /** Resolves to when it was paused. */
  pause(): Promise<Instant>
  resume(): Promise<void>

  // plain reads and writes
  setToggle(key: string, on: boolean): Promise<void>
  requestTool(key: string, on: boolean): Promise<void>
  requestSkill(name: string): Promise<void>
  /** A skill's page is open: fetches its instructions (`body` in `read().skills`) if they aren't in yet. `read()` changes when
   *  they arrive; it resolves then, or at once when there's nothing to fetch. */
  loadSkill(name: string): Promise<void>
  /**
   * P6a brand skills: deletes one of the brand's own skills (`mine`) by name, at the rev last read. Its maker or an
   * admin may (`canChange`); anyone else, or one of the Inhouse team's skills, is refused. Gone from `read().skills` at
   * once, and back if the server refuses.
   */
  deleteSkill(name: string): Promise<void>
  setToolPaused(key: string, paused: boolean): Promise<void>
  forgetMemory(key: string, forgotten: boolean): Promise<void>
  /**
   * P6a: the team facts waiting for an OK, newest first. Read when the Team memory page opens, for someone with
   * `me().can.approveMemory` (an Admin, or the Inhouse team under a grant); anyone else is refused. The demo has none.
   */
  waitingMemory(): Promise<WaitingMemory[]>
  /**
   * P6a: approves (`true`) or rejects a waiting team fact, at the rev the last `waitingMemory()` read. Approved, it joins the
   * team's memory; rejected, it's gone. A stale rev rejects with `conflict` carrying the fact as it is now (read the list
   * again). A conflict showing this same decision already landed (an earlier send's answer was lost) resolves as done.
   */
  reviewMemory(key: string, approved: boolean): Promise<void>
  /** A settings dropdown or text field. Null puts it back to the default. Rejects with `invalid` for a key or value the settings registry (shared/contract/settings.ts) refuses. */
  setSetting(key: string, value: string | null): Promise<void>
  /** A member's photo as a data URL. Null removes it, so initials show; Reset demo brings the sample photo back. */
  setPhoto(memberId: string, dataUrl: string | null): Promise<void>
  sendTeamRequest(req: TeamRequest): Promise<void>
  /**
   * The person withdraws their own open request, named as the team window's row names it (its title and when it was asked).
   * In the product, it resolves once withdrawn. It rejects with not_found if missing or not theirs, `conflict` if
   * already closed, or the network's error. The demo's window handles the session's withdrawal and Undo.
   */
  withdrawTeamRequest(ref: { title: string; at: Instant }): Promise<void>
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
  /** Adds files to the Library and answers them. Rejects with an `AgentError` (the demo: `unavailable`, with a notice, since nothing is kept). */
  uploadFiles(files: File[]): Promise<LibraryFile[]>
  /** Where a Library file downloads from, or null where it can't (the demo). */
  fileDownloadUrl(id: string): string | null

  /** Take a problem off Today and Approvals for a reason, stamped with the time. Null brings it back (Undo). Approving it clears it too. */
  setAside(id: string, reason: SetAsideReason | null): Promise<void>
  /** Run a routine now, outside its schedule. `id` is the routine's own `id`. */
  runRoutine(id: string): Promise<RoutineRun>
  /** A routine's own recent runs, newest first (at most `ROUTINE_RUNS_MAX`). Rejects (not found) for a routine it doesn't have. */
  routineRunHistory(id: string): Promise<RoutineRunHistory>
  deleteRoutine(id: string): Promise<void>
  /** Undo a routine delete. */
  restoreRoutine(id: string): Promise<void>
  // ---------- managing chats ----------
  // Chats are keyed by id: the agent's chats in `AgentData.chat.chats` and chats a person started. The UI's chat list
  // applies `AgentState.chatTitles`, hides `chatDeleted` and lists `chatPinned` first.
  /** A person's title for a chat, trimmed and cut to CHAT_TITLE_MAX. Null puts the chat's own title back. Sends the chat's last `rev` as `ifRev`: a stale one rejects with `conflict` and the list shows the chat as it is now. */
  renameChat(id: string, title: string | null): Promise<void>
  pinChat(id: string, pinned: boolean): Promise<void>
  /** Soft delete of 1 to 50 chats (more rejects with `invalid`): they leave every list until `restoreChats`. The agent
   *  cancels their queued turns and stops their live one (each ends with a turn.cancelled event). All must be the person's own, else not found and nothing changes. */
  deleteChats(ids: string[]): Promise<void>
  /** Undo a delete (1 to 50). */
  restoreChats(ids: string[]): Promise<void>

  // ---------- P2: who is signed in, the team, support access, paging and retry (p2-design.md section 11) ----------
  // Every write to a record sends the record's last `rev` as `ifRev`. A stale one rejects with `conflict` and `current`; the
  // snapshot already holds the current value, so the UI says "Someone changed this. It's now X."
  /** Who is signed in and what they may do. Null while loading. A synchronous snapshot, stable between changes. */
  me(): Me | null
  /** Rejects with `conflict` (reason: already a member) for an email that is already on the team, `forbidden` for a person who can't invite. */
  inviteMember(input: InviteInput): Promise<void>
  /** Rejects with `conflict` (reason: the last Admin) when it would leave no Admin. */
  setMemberRole(id: string, role: MemberRole): Promise<void>
  /** Rejects with `conflict` (reason: the last Admin) for the last Admin. */
  removeMember(id: string): Promise<void>
  /** Gives the Inhouse team access for 1, 4, 24 or 72 hours. Rejects with `conflict` (reason: a grant is live) while a grant is live. The grant shows in `read().people.supportGrant`. */
  grantSupport(hours: number): Promise<void>
  endSupportGrant(id: string): Promise<void>
  /** The next page of a list. Does nothing when `read().more` says there is none. */
  loadMore(list: 'audit' | 'members'): Promise<void>
  /** Reads a resource again after its read failed (`read().resources[resource].status` is `error`). */
  retry(resource: ResourceKey): Promise<void>
  /** Reads the Memory pages' lines again, without the page showing as loading: a fact the agent saved since the last read shows. One read at a time (an open while one runs joins it). Nothing to read in the demo. */
  refreshMemory(): Promise<void>
  /** Reads a list the agent's work fills again, without the page showing as loading: what it made since the last read shows. One read at a time per list; nothing before the list's first read is in. Nothing to read in the demo. */
  refresh(list: RefreshList): Promise<void>
  /** Where the audit log downloads from, or null when the client builds the file itself (the demo, with shared/csv.ts). */
  auditExportUrl(): string | null
  /** Where Data and access's "Export everything" downloads from (route 95), or null when the client builds the file itself (the demo's invented sample). */
  dataExportUrl(): string | null
  /** Route 41: one chat file's bytes, and the name the server gave it (null when it gave none). Rejects with an `AgentError`. The demo serves a sample file. */
  downloadFile(fileId: string): Promise<{ blob: Blob; name: string | null }>
  /** Whether this client keeps attachments on the server (the real one). The demo doesn't: its files stay in the composer and the send names them by a made-up id. */
  uploadsFiles(): boolean
  /** Route 39: keeps `file` in the chat (which must exist) and answers its id. Rejects with an `AgentError` (a refusal has its `reason`) or `UploadCancelled` when `signal` aborts. */
  uploadFile(chatId: string, file: File, signal?: AbortSignal): Promise<{ fileId: string; name: string }>
  /** Closes the chat socket. Sign out calls it first, so nothing is followed while the sign-in ends (a no-op where there is no socket). */
  disconnect(): void
  /** Where signing out goes (`/cdn-cgi/access/logout` in the product), or null where there is no sign-in (the demo). */
  signOutUrl(): string | null
}

/** The longest chat title a person can set. Longer titles are cut. */
export const CHAT_TITLE_MAX = 80
