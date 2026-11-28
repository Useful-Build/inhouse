// Deterministic mock agent. Reads only from sample-data, uses no randomness and
// makes no model calls: same input, same output, same timings. Phase 2 swaps this
// module for a real agent client behind the same AgentClient interface.
import {
  activityFixed, auditLog, chatList, chatScript, helpGuides, defaultModel, library, memory, meta as sampleMeta, models, notifications, people, problemById,
  problems, routines, scenarios, seedRoutine, seedTable, skillSuggestions, skillSuggestionsTitle, skills, traceDisconnectedVariant,
  traces, tools as sampleTools, usage, usageAtCap, usageHistory,
} from './data'
import { loadSkillBodies, routineIdOf, sampleAt, sampleRuns } from './data'
import type { TraceKey } from './data'
import type {
  CreateChatInput, ApprovalRule, AuditLine, MemberRecord, MemberRole, Me, ResourceKey, ResourceStatus,
  AgentClient, AgentData, AgentErrorCode, AgentNotice, AgentNotification, AgentState, ApproveResult, ActiveRun, ChatList, ChatPage, ChatSendInput, ChatSummary, ChatThread, LinkState, RunFrame, SendTurnResult, StoredMessage, ClockTime, DemoContext,
  Instant, LibraryFile, MessagePart, NoticePage, RoutineCard, RoutineDef, RoutineRun, Scenario, SeedTurn, SetAsideReason, SetAsideRecord,
  SkillDef, StageIndex, StampRecord, TablePart, TeamRequest, ToolSetup, ToolsData, Trace, UsageData, MemoryLine, WaitingMemory,
} from './types'
import { AgentError, CHAT_TITLE_MAX, STAGES } from './types'
import type { BatchCovers } from './types'
import type { ChatEngine, Host } from './mock-chat'
import { shownClock, shownDateTimeIn, shownTimeOn } from './upgrade-times'
import { DEMO_START, demoDayAt, demoNow } from './demo-clock'
import { instantOf } from '../lib/format'
import { INVALID, NOT_FOUND, REASON } from '../../shared/contract/error-codes'
import type { ErrorReason } from '../../shared/contract/common'
import type { SupportGrant } from '../../shared/contract/grants'
import { CAN_KEYS, GRANT_HOURS, RESOURCE_KEYS, ROUTINE_RUNS_MAX } from '../../shared/contract/keys'
import type { RoutineHistoryRun, RoutineRunHistory } from '../../shared/contract/routines'
import type { Can } from '../../shared/contract/me'
import type { InviteInput } from '../../shared/contract/members'
import type { AvailableChannels, NotifyChannelList, PutNotifyChannels } from '../../shared/contract/notify-slack'
import type { ActionCard, ActionChoice, ActionFilter, ActionItemsPage, ActionResolution } from '../../shared/contract/actions'
import type { MockActions } from './mock-actions'
import type { Permission } from '../../shared/contract/permissions'
import type { CeilingList, CeilingRow } from '../../shared/contract/ceiling'
import type { Question } from '../../shared/contract/questions'
import type { Job } from '../../shared/contract/jobs'
import { MEMBER_ID_PATTERN, meetsRule, settingRow } from '../../shared/contract/settings-table'
import { PRODUCT_STAGE, pendingIds } from '../state/derive'

/**
 * Test hook: a brand other than the sample one. `localStorage['inhouse.demo.data.v1']` is `{ "brandName"?: string, "channels"?: false }`:
 * the brand's name, and no connected channel. Only the mock reads it, so the e2e specs can show a customer whose data isn't the sample's.
 */
const DATA_OVERRIDE_KEY = 'inhouse.demo.data.v1'
const override = (() => {
  try {
    const raw = (JSON.parse(localStorage.getItem(DATA_OVERRIDE_KEY) ?? '{}') ?? {}) as Record<string, unknown>
    // Only these shapes count: a non-empty brand name, and `channels: false`. Anything else is ignored.
    return {
      brandName: typeof raw.brandName === 'string' && raw.brandName ? raw.brandName : undefined,
      channels: raw.channels === false ? false as const : undefined,
    }
  } catch { return { brandName: undefined, channels: undefined } }
})()
/** True when the brand or channels came from the override: they were built at load, so only a reload drops them. */
export const dataOverrideActive = !!override.brandName || override.channels === false
// ---------- C2: people by member id. The sample data names people by name and by ids like "sam"; the mock converts at load. ----------
export const memberIdOf = (sampleId: string) => `m_${sampleId}`
/** The signed-in person's member id: the sample Admin. */
export const ME_ID = memberIdOf(sampleMeta.currentUser.id)
/** The sample people as members: a member is an Admin or a Member (approving is a job per rule, by member id, not a role). */
const SAMPLE_MEMBERS: MemberRecord[] = people.members.map(m => ({
  id: memberIdOf(m.id), name: m.name, email: m.email, title: m.title, role: m.role === 'Admin' ? 'admin' : 'member', status: 'active', photo: m.photo ?? null, rev: 1,
}))
const ID_BY_NAME = new Map(SAMPLE_MEMBERS.map(m => [m.name, m.id]))
/** A saved or sample name as a member id: an id stays, a known name converts, any other name was the signed-in person's own (what `stamp` always wrote). */
/** `known`: the ids of the members this demo has. A name or id nobody has is the signed-in person's own, and `unknown` hears it. */
const idOfBy = (by: string, known: ReadonlySet<string>, unknown: (by: string) => void) => {
  if (known.has(by)) return by
  const id = ID_BY_NAME.get(by)
  if (id) return id
  unknown(by)
  return ME_ID
}
/** The Inhouse team's people have member ids too (kind inhouse): the sample audit log names them. */
const actorIdOf = (who: string) => ID_BY_NAME.get(who) ?? (/\(Inhouse team\)/.test(who) ? `m_${who.replace(/\s*\(.*\)/, '').toLowerCase().replace(/[^a-z0-9]+/g, '_')}` : 'm_inhouse-team')
/** The brand's rules name an approver by member id, or `anyone`. */
const APPROVAL_RULES: Omit<ApprovalRule, 'rev'>[] = people.approvalRules.map(r => {
  const approver = r.approver === 'Anyone who approves' ? 'anyone' : ID_BY_NAME.get(r.approver)
  if (!approver) throw new Error(`Sample data: the rule "${r.what}" names "${r.approver}", who isn't a member.`)
  return { what: r.what, detail: r.detail, approver }
})
/** The sample audit log as the product serves it: ids, newest highest, and the actor's member id. */
const AUDIT_LINES: AuditLine[] = auditLog.map((e, i, all) => ({ id: all.length - i, at: e.at, actorId: actorIdOf(e.who), who: e.who, what: e.what, detail: e.detail }))
/** Activity's fixed lines with the member who did each one (a line's `who` starts with the person's first name: "Dana approved"). */
const withActor = (l: (typeof activityFixed.today)[number]) => {
  const m = SAMPLE_MEMBERS.find(x => l.who.startsWith(`${x.name.split(' ')[0]} `))
  return m ? { ...l, actorId: m.id } : l
}
const ACTIVITY = { today: activityFixed.today.map(withActor), earlier: activityFixed.earlier.map(withActor) }

const brandedMeta = override.brandName ? { ...sampleMeta, brand: { ...sampleMeta.brand, name: override.brandName } } : sampleMeta
const meta = { ...brandedMeta, currentUser: { ...brandedMeta.currentUser, id: ME_ID } }
/** Every tool connected and read: the scenarios below set `connection`, `setup` and `readDone` their own way. */
const tools: ToolsData = { ...sampleTools, ...(override.channels === false ? { channels: [] } : {}), connection: {}, setup: {}, readDone: sampleTools.connected.length }

/** v2: times are on the demo clock and records carry who did it. v1 is dropped. Before C1 (P1) a time was saved as it
 *  showed ("8:03 AM", with a sortable minute); `sanitize` turns those into instants, so the key doesn't change. */
const STORAGE_KEY = 'inhouse.demo.v2'
/** Run id to what the run replayed and made, so a saved answer's steps open after a reload and Regenerate updates in place. */
const RUNS_KEY = 'inhouse.demo.runs.v1'
/** How many runs RUNS_KEY keeps, oldest dropped first. */
const RUNS_KEPT = 200
/** Unique per page load, so run ids never repeat across reloads. */
const SESSION = Date.now().toString(36)
const SAVE_FAILED = "Couldn't save. Your browser storage is full."
const TOO_LATE = 'Too late to undo. It already went out.'
const FINISHED = 'That answer has already finished.'
/** Send hold for approvals that cannot be undone once they go out. */
const SEND_HOLD_MS = 10_000
const THINKING_STEP_MS = 800

const initialState = (): AgentState => ({
  approved: {}, sent: {}, undone: {}, edits: {}, paused: null, toggles: {},
  routinesExtra: [], skillsExtra: [], requestedTools: {}, requestedSkills: {}, toolPaused: {},
  forgot: {}, settings: {}, teamRequests: [], readNotices: {}, libraryDeleted: {},
  setAside: {},
  routinesDeleted: {}, routineRuns: [],
  // managing chats
  chatTitles: {}, chatPinned: {}, chatDeleted: {},
})

// ---------- the read-only snapshot ----------

type RawTurn = { user?: string; agent?: Record<string, unknown>[]; trace?: string; model?: string }
/** A seeded answer's recorded trace: every one has its own, so its footer and steps are its own. */
const needTrace = (turn: RawTurn, where: string): string => {
  if (!turn.trace) throw new Error(`Sample data: an answer in ${where} has no trace.`)
  return turn.trace
}

/** A seeded answer's model: the mode (models.json) that answered it, shown in its steps line. */
const needModel = (turn: RawTurn, where: string): string => {
  if (!turn.model || !models.some(m => m.id === turn.model)) throw new Error(`Sample data: an answer in ${where} has no known model.`)
  return turn.model
}

const seedPart = (a: Record<string, unknown>): MessagePart => {
  switch (a.type) {
    case 'text': return { type: 'text', text: a.text as string }
    case 'table': return { type: 'table', table: seedTable }
    case 'workRow': return { type: 'workRow', text: a.text as string, at: sampleAt('a work row', a.at) }
    case 'approval': return { type: 'approval', problemId: a.problemId as string }
    case 'routine':
      // The routine this chat set up: it is on the Routines page under its own name (routines.json).
      return { type: 'routine', routine: { id: routineIdOf(seedRoutine.name), name: seedRoutine.name, freq: seedRoutine.freq, day: seedRoutine.day, time: seedRoutine.time, next: sampleAt('the seed routine card', a.next), note: a.note as string } }
    default: throw new Error(`Unknown seed part type: ${String(a.type)}`)
  }
}

const seedThread: SeedTurn[] = (chatScript.seedThread.turns as RawTurn[]).map((turn): SeedTurn =>
  turn.user
    ? { role: 'user', text: turn.user }
    : { role: 'agent', trace: traceKey(needTrace(turn, 'the seed thread')), model: needModel(turn, 'the seed thread'), parts: (turn.agent ?? []).map(seedPart) })

/** The other chats: plain text, work rows, tables with the table's own data, and the demo's action cards. */
const chatPart = (a: Record<string, unknown>): MessagePart => {
  switch (a.type) {
    case 'text': return { type: 'text', text: a.text as string }
    case 'workRow': return { type: 'workRow', text: a.text as string, at: sampleAt('a work row', a.at) }
    case 'table': return { type: 'table', table: a.table as TablePart }
    // Stage 1 M3-U: one of the demo's agent actions (sample-data/actions.json), as its card.
    case 'ask': return { type: 'ask', actionId: a.actionId as string }
    default: throw new Error(`Unknown chat part type: ${String(a.type)}`)
  }
}
/** The chats, newest first by `at`. Bad data stops the app: the demo has no stages (decision A13), so no turn names one. */
function loadChats(): ChatThread[] {
  const out = chatList.chats.map((c): ChatThread => ({
    id: c.id, title: c.title, at: sampleAt(`the chat "${c.id}"`, c.at),
    turns: c.turns === 'seedThread' ? seedThread : (c.turns as RawTurn[]).map((turn): SeedTurn => {
      if (turn.user) return { role: 'user', text: turn.user }
      if ('stage' in turn) throw new Error(`Sample data: chat "${c.id}" has a turn for a stage; the demo has none.`)
      return { role: 'agent', trace: traceKey(needTrace(turn, `chat "${c.id}"`)), model: needModel(turn, `chat "${c.id}"`), parts: (turn.agent ?? []).map(chatPart) }
    }),
  }))
  // All chats lists them in this order, so it must be newest first by a real time (never by the shown `at`).
  out.forEach((c, i) => {
    if (i > 0 && c.at.ms > out[i - 1].at.ms) throw new Error(`Sample data: chat "${c.id}" is newer than "${out[i - 1].id}", so the chats aren't newest first.`)
  })
  return out
}
const chats = loadChats()
// Every trace a scripted answer names exists, checked at load rather than when someone happens to ask.
for (const t of [...chatScript.scripted.map(x => x.trace), chatScript.fallback.trace, chatScript.firstDayTrace, chatScript.loadingTrace, 'generic', 'stuck', 'query', 'morning', 'draft']) traceKey(t)

/** When each draft was made: the time on its file in the Library's Approvals place. Every problem needs one. */
function draftTimes(): Record<string, Instant> {
  const out: Record<string, Instant> = {}
  for (const f of library.files) if (f.link?.to === 'approval') out[f.link.id] = f.at
  for (const p of problems) if (!out[p.id]) throw new Error(`Sample data: no draft file with a time for problem "${p.id}".`)
  return out
}

/** The sample routines, each with its id, and the one the stuck orders chat set up. Ids must not repeat. */
function routineDefs(): RoutineDef[] {
  const asked = (chatScript.seedThread.turns as RawTurn[]).find(t => t.user && /\bevery morning\b/.test(t.user))
  if (!asked?.user) throw new Error('chat-script.json: the seed thread has no request for the stuck orders routine.')
  const { name, freq, day, time, next, need, by } = seedRoutine
  if (![0, 1, 2].includes(need)) throw new Error(`Sample data: the routine "${name}" has an unknown stage "${String(need)}".`)
  // `by` stays: the routine's details say who made it ("Made by You" for the signed-in person).
  const fromChat: Omit<RoutineDef, 'id'> = { name, freq, day, time, next, need: need as RoutineDef['need'], what: `Created in a chat: "${asked.user}"`, inChat: true, rev: 1, ...(by ? { by } : {}) }
  const out = [...routines, fromChat].map(r => ({ ...r, id: routineIdOf(r.name) }))
  const ids = new Set(out.map(r => r.id))
  if (ids.size !== out.length) throw new Error('Sample data: two routines have the same id.')
  return out
}

const DRAFT_TIMES = draftTimes()
/** A problem's draft trace id: the recorded `draft` steps, titled for that problem (see `getTrace`). */
const DRAFT_TRACE = 'draft:'
/** Built once, so `read()` returns the same object every time. The data for the Normal scenario (and, with their changes below, the others). */
const DATA: AgentData = {
  status: 'ready',
  meta,
  problems: problems.map(p => ({ ...p, trace: `${DRAFT_TRACE}${p.id}`, draftedAt: DRAFT_TIMES[p.id] })),
  tools,
  routines: routineDefs(),
  skills,
  skillSuggestions,
  skillSuggestionsTitle,
  usage,
  usageMonths: [usage, ...usageHistory],
  people: { members: SAMPLE_MEMBERS, approvalRules: APPROVAL_RULES.map(r => ({ ...r, rev: 0 })), runLimits: people.runLimits, supportGrant: null },
  memory,
  auditLog: AUDIT_LINES,
  activity: ACTIVITY,
  notifications: { teamRequests: notifications.teamRequests },
  models,
  defaultModel,
  library: { places: library.places },
  help: helpGuides,
  chat: { chats, recentCount: chatList.recent, suggestions: chatScript.suggestions },
  more: { audit: false, members: false },
  resources: Object.fromEntries(RESOURCE_KEYS.map(k => [k, { status: 'ready' }])) as Record<ResourceKey, ResourceStatus>,
}

/** A month with nothing spent: what a brand has before its agent has run. */
const noUsage = (u: UsageData): UsageData => ({
  ...u, total: { ...u.total, minor: 0 }, conversations: 0, questionsAsked: 0, jobsRun: 0, daily: u.daily.map(d => ({ ...d, minor: 0 })),
  breakdown: { person: [], job: [], model: [], tool: [] },
})
/** Nothing found or done yet: no problems, chats, Activity lines, audit lines or usage. */
const NOTHING_YET = {
  problems: [], activity: { today: [], earlier: [] }, auditLog: [],
  usage: noUsage(usage), usageMonths: [noUsage(usage)],
  chat: { ...DATA.chat, chats: [] },
} satisfies Partial<AgentData>
const SETUP_DUE: ToolSetup['due'][] = ['today', 'tomorrow', 'this-week']
/** Day one's setup list (scenarios.json): each of `being` (the tools being connected) the Inhouse team is setting up, by key, with when it should connect. Bad data stops the app. */
function firstDaySetup(being: string[]): ToolsData['setup'] {
  const out: ToolsData['setup'] = {}
  for (const [key, when] of Object.entries(scenarios['First day'].today.setup)) {
    if (!being.includes(key) || !Object.hasOwn(tools.details, key)) throw new Error(`Sample data: the First day setup names "${key}", which isn't a tool being connected.`)
    const due = SETUP_DUE.find(d => d === when)
    if (!due) throw new Error(`Sample data: the First day setup has "${key}" due "${when}", which isn't today, tomorrow or this-week.`)
    out[key] = { due }
  }
  return out
}
/** The tools being connected on day one, in display order: the ones the agent will read, then the one already on its way. */
const FIRST_DAY_TOOLS = [...tools.connected, ...tools.beingConnected.filter(k => !tools.connected.includes(k))]
/**
 * Day one, before the agent has read anything: no tools or channels connected yet (the six are being connected, per
 * scenarios.json), nothing found, asked or run, no Library files and no notifications (see `listFiles` and
 * `listNotifications`). The routines and skills are the ones the Inhouse team sets up (none made in a chat), not run or
 * used yet. Every screen reads these from here, so none shows another day's data.
 */
const FIRST_DAY: AgentData = {
  ...DATA,
  ...NOTHING_YET,
  tools: { ...DATA.tools, connected: [], channels: [], beingConnected: FIRST_DAY_TOOLS, setup: firstDaySetup(FIRST_DAY_TOOLS), readDone: 0 },
  routines: DATA.routines.filter(r => !r.inChat).map(({ last: _last, ...r }) => r),
  skills: skills.filter(s => !s.mine).map(s => ({ ...s, used: 'Not used yet' })),
}
/**
 * Still loading: a real client starts here, with empty lists, until the agent's data arrives. The tools are known (the
 * morning check is reading them, scenarios.json `readDone` of them so far); everything they hold isn't yet.
 */
const LOADING: AgentData = { ...DATA, ...NOTHING_YET, status: 'loading', resources: Object.fromEntries(RESOURCE_KEYS.map(k => [k, { status: 'loading' }])) as Record<ResourceKey, ResourceStatus>, routines: [], skills: [], skillSuggestions: [], tools: { ...DATA.tools, readDone: scenarios.Loading.today.readDone } }
/** One tool's login expired this morning (scenarios.json): it stays connected but can't be read. */
const LOST_TOOL = scenarios['Tool disconnected'].tool
if (!Object.hasOwn(tools.details, LOST_TOOL)) throw new Error('Sample data: the Tool disconnected scenario names an unknown tool.')
const TOOL_DISCONNECTED: AgentData = {
  ...DATA,
  tools: { ...DATA.tools, connection: { [LOST_TOOL]: { status: 'disconnected', since: sampleAt('the Tool disconnected scenario', scenarios['Tool disconnected'].at) } } },
}
/** At the cap: this month's own usage with spend at the cap (usage.json `capReached`), so the chart, the cost per
 *  conversation and the breakdowns agree with it. Earlier months don't change. */
const CAP_REACHED: AgentData = { ...DATA, usage: usageAtCap, usageMonths: [usageAtCap, ...usageHistory] }
const DATA_FOR: Record<Scenario, AgentData> = { Normal: DATA, 'Tool disconnected': TOOL_DISCONNECTED, 'Cap reached': CAP_REACHED, 'First day': FIRST_DAY, Loading: LOADING }
/** The scenarios where the agent has read nothing yet. */
const isNoData = (sc: Scenario) => sc === 'First day' || sc === 'Loading'

/** A seeded chat's first question, so a notification can open the chat that holds its answer. */
const chatAsking = (q: string): string => {
  const c = chats.find(x => x.turns.some(t => t.role === 'user' && t.text === q))
  if (!c) throw new Error(`Sample data: no chat asks "${q}".`)
  return c.id
}
const PAGES: Record<string, NoticePage> = { Today: 'today', Approvals: 'approvals', Activity: 'activity', Routines: 'routines', Library: 'library' }
/** What a notification in notifications.json opens: "tool page: <key>", "chat: <id>", "new chat: <a seeded question>" (opens
 *  the seeded chat that answers it, never a new question) or a page name. */
const linkOf = (opens: string): AgentNotification['link'] => {
  let m = /^tool page: (.+)$/.exec(opens)
  if (m) { if (!Object.hasOwn(tools.details, m[1])) throw new Error(`Sample data: notification opens unknown tool "${m[1]}".`); return { to: 'tool', key: m[1] } }
  m = /^chat: (.+)$/.exec(opens)
  if (m) { if (!chats.some(c => c.id === m![1])) throw new Error(`Sample data: notification opens unknown chat "${m[1]}".`); return { to: 'chat', id: m[1] } }
  m = /^new chat: (.+)$/.exec(opens)
  if (m) return { to: 'chat', id: chatAsking(m[1]) }
  if (Object.hasOwn(PAGES, opens)) return { to: 'page', page: PAGES[opens] }
  throw new Error(`Sample data: notification opens "${opens}", which isn't a tool, chat or page.`)
}
/** A notification's id from what it says, so changed content arrives unread. */
const noticeId = (text: string) => 'n-' + text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48)
/**
 * A bell row in notifications.json: a plain one (`text`), or the drafts line (`drafts`, its count from Today). `approval`:
 * an approval notice (the outbox's words, server/notices/templates.ts), shown only where the demo shows its actions (the
 * Normal scenario); `waiting`: it says something waits on this person.
 */
type RawNotification = { text?: string; drafts?: string; who: string; at: string; unread: boolean; opens: string; icon?: string; waiting?: boolean; approval?: boolean }

/**
 * The view the demo shows, as the product's (decision A13, option B): no stages, pinned to the Act view (`PRODUCT_STAGE`),
 * so what the sample data offers by stage (a routine's `need`) reads as the product does.
 */
const DEMO_VIEW = STAGES.indexOf(PRODUCT_STAGE) as StageIndex

/** A card a Pause sent back to waiting, for its bell notice. */
type SentBack = { id: string; actionId: string; rev: number; atMs: number }
/** The outbox's notice title for an approval a Pause sent back (server/notices/templates.ts, the lapsed approval's). */
const APPROVAL_SENT_BACK = 'Approval sent back'

// ---------- saved state: keep only known shapes ----------

type Rec = Record<string, unknown>
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown): v is string => typeof v === 'string'
const isArr = (v: unknown): v is unknown[] => Array.isArray(v)
/** A record keeping only the entries whose value passes `ok`. */
const recOf = <T,>(v: unknown, ok: (x: unknown) => x is T): Record<string, T> =>
  isRec(v) ? Object.fromEntries(Object.entries(v).filter(([, x]) => ok(x))) as Record<string, T> : {}
const flagsOf = (v: unknown) => recOf(v, (x): x is true => x === true)
const hasStrs = (o: unknown, keys: string[]): o is Rec => isRec(o) && keys.every(k => str(o[k]))

const SET_ASIDE: SetAsideReason[] = ['snoozed', 'dismissed', 'declined']
/** The id for the next routine created in a chat: one past the highest so far. Deleted ones stay in `routinesExtra`, so ids never repeat. */
const nextChatRoutineId = (extra: RoutineCard[]) =>
  `routine-chat-${extra.reduce((m, r) => Math.max(m, Number(/^routine-chat-(\d+)$/.exec(r.id)?.[1] ?? 0)), 0) + 1}`
const isInstant = (x: unknown): x is Instant => isRec(x) && str(x.iso) && typeof x.ms === 'number' && Date.parse(x.iso) === x.ms

// ---------- a state saved before C1: times as they showed ("8:03 AM" with a minute), amounts and dates as text ----------

/** When, from a record saved now (`at` an instant) or before C1 (`at` shown, `atMin` its minute on the demo's Monday). */
const savedAt = (r: Rec): Instant | null => (isInstant(r.at) ? r.at : str(r.at) && typeof r.atMin === 'number' ? demoDayAt(r.atMin) : null)
/** The real time of a record saved now (`loggedAt`) or before C1 (`ms`). */
const savedLoggedAt = (r: Rec): Instant | null => (isInstant(r.loggedAt) ? r.loggedAt : typeof r.ms === 'number' && Number.isFinite(r.ms) ? instantOf(r.ms) : null)
/** A pause saved now (an instant) or before C1 ("8:03 AM"). */
const savedPause = (v: unknown): Instant | null => (isInstant(v) ? v : str(v) ? shownTimeOn(v, DEMO_START) : null)
/** A routine card's time saved now or before C1 ("7:00 AM"). */
const savedClock = (v: unknown): ClockTime | null => {
  if (isRec(v) && Number.isInteger(v.hour) && Number.isInteger(v.minute) && (v.hour as number) >= 0 && (v.hour as number) < 24 && (v.minute as number) >= 0 && (v.minute as number) < 60) return { hour: v.hour as number, minute: v.minute as number }
  return str(v) ? shownClock(v) : null
}
/** A routine card's next run saved now or before C1 ("Next run Mon, Nov 23 at 7:00 AM", in the demo's year). */
const savedNext = (v: unknown): Instant | null => (isInstant(v) ? v : str(v) ? shownDateTimeIn(v, DEMO_START) : null)
/** A routine made in a chat, saved now or before C1. */
const savedRoutine = (r: unknown): RoutineCard | null => {
  if (!hasStrs(r, ['id', 'name', 'freq', 'day', 'note', 'what'])) return null
  const time = savedClock(r.time), next = savedNext(r.next)
  return time && next ? { id: r.id as string, name: r.name as string, freq: r.freq as string, day: r.day as string, time, next, note: r.note as string, what: r.what as string, ...(typeof r.rev === 'number' && Number.isInteger(r.rev) && r.rev >= 1 ? { rev: r.rev } : {}) } : null
}
/** A request to the Inhouse team, saved now or before C1 ("New tool · sent by Sam, just now", sent in that session: now). */
const savedRequest = (r: unknown, now: Instant): TeamRequest | null => {
  if (!hasStrs(r, ['icon', 'title', 'sub', 'status'])) return null
  // In the order `sendTeamRequest` writes them, so a state saved now loads as it was saved.
  const sub = isInstant(r.at) ? r.sub as string : (r.sub as string).replace(/, just now$/, '')
  return {
    icon: r.icon as string, title: r.title as string, sub, at: isInstant(r.at) ? r.at : now, status: r.status as string,
    ...(typeof r.text === 'string' ? { text: r.text } : {}),
  }
}
/** A stamp (when and who), saved now or before C1. */
const savedStamp = (x: unknown, idOf: (by: string) => string): StampRecord | null => {
  if (!isRec(x) || !str(x.by) || !x.by.trim()) return null
  const at = savedAt(x)
  return at ? { at, by: idOf(x.by) } : null
}
/** The entries of a saved record that `conv` keeps; `onDrop` hears the key of each it can't. */
const recConv = <T,>(v: unknown, conv: (x: unknown) => T | null, onDrop: (key: string) => void): Record<string, T> =>
  isRec(v) ? Object.fromEntries(Object.entries(v).flatMap(([k, x]) => { const c = conv(x); if (c === null) onDrop(k); return c === null ? [] : [[k, c]] })) : {}

// ---------- what the server would keep: members, photos, the support grant and every record's `rev` ----------

/** A support grant as saved: `live` and `rev` are worked out when it is read. */
type StoredGrant = Omit<SupportGrant, 'live' | 'rev'>
/**
 * The mock's stand-in for the Worker's tables, saved beside the state. Roles, photos, removals, invitations and the grant
 * moved out of `AgentState.settings` (`p:`, `photo:`, `d:support`): the contract no longer lets a setting hold them.
 * `revs` is each record's revision, `member:<id>`, `setting:<key>`, `grant:<id>`, `routine:<id>`, `memory:<key>`, `file:<id>`;
 * a record with no entry has its first revision (a setting never set has 0).
 */
interface Server {
  roles: Record<string, MemberRole>
  /** A photo as a data URL, or null once removed. A member with no entry keeps the sample photo. */
  photos: Record<string, string | null>
  removed: Record<string, true>
  invited: MemberRecord[]
  grant: StoredGrant | null
  grantSeq: number
  revs: Record<string, number>
  /**
   * P6a: team facts waiting for an OK (the demo has none; the e2e fixtures seed them), and the ones approved since, which
   * join the team's memory. Each line's rev is its first; `revs` moves it.
   */
  memoryWaiting: MemoryLine[]
  memoryApproved: MemoryLine[]
  /** P6a brand skills: the sample's own skills deleted (by name), and when one was last changed in a chat. */
  skillsDeleted: Record<string, true>
  skillsChanged: Record<string, Instant>
}
/** The demo has no actions, permissions or questions (Stage 1 M2): an answer to one names nothing it has. */
const NO_M2_RECORD = "That isn't there any more."
/** What the mock says to someone without `approveMemory` (the server's matrix refuses routes 77 and 78 the same way). */
const WAITING_REFUSED = 'Only admins and the Inhouse team can see what waits for an OK.'
const DECIDING_REFUSED = 'Only admins and the Inhouse team can decide on what waits for an OK.'
/** A saved team line (hand-checked, so the mock doesn't carry zod's runtime; memory.ts holds the schema). */
const isTeamLine = (l: unknown): l is MemoryLine =>
  isRec(l) && str(l.key) && l.key.length > 0 && str(l.text) && l.text.length > 0 && str(l.source)
  && typeof l.rev === 'number' && Number.isInteger(l.rev) && l.rev >= 1 && (l.at === undefined || isInstant(l.at))
/** The saved line with only the fields a team line carries (no forgotten or waiting mark: where it's kept says that). */
const teamLineOf = (l: MemoryLine): MemoryLine => ({ key: l.key, text: l.text, source: l.source, ...(l.at ? { at: l.at } : {}), rev: l.rev, scope: 'brand' })
const DEMO_GRANT_HOURS = 72
/** A first-run server: the sample team, and the live support grant the demo's "Inhouse team access" switch always showed. */
const defaultServer = (startedAt: number): Server => {
  const now = demoNow(startedAt).getTime()
  return {
    roles: {}, photos: {}, removed: {}, invited: [], grantSeq: 1, revs: {}, memoryWaiting: [], memoryApproved: [], skillsDeleted: {}, skillsChanged: {},
    grant: { id: 'g_demo-1', createdBy: ME_ID, createdAt: instantOf(now), endsAt: instantOf(now + DEMO_GRANT_HOURS * 3_600_000), endedAt: null, endedBy: null },
  }
}
const isRole = (x: unknown): x is MemberRole => x === 'member' || x === 'admin'
/** A saved invited member: the shape of a `MemberRecord` (hand-checked, so the mock doesn't carry zod's runtime; members.ts holds the schema). */
const isMemberRecord = (m: unknown): m is MemberRecord =>
  isRec(m) && str(m.id) && MEMBER_ID_PATTERN.test(m.id) && str(m.name) && m.name.trim().length >= 1 && m.name.length <= 80
  && (m.email === null || str(m.email)) && (m.title === null || str(m.title)) && isRole(m.role)
  && (m.status === 'invited' || m.status === 'active' || m.status === 'removed') && (m.photo === null || str(m.photo))
  && typeof m.rev === 'number' && Number.isInteger(m.rev) && m.rev >= 1
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
/** An invitation as the server would take it: a name and a job title of 1 to 80 characters trimmed, an email, a role, and nothing else. */
const readInvite = (v: unknown): { name: string; email: string; title?: string; role: MemberRole } | null => {
  if (!isRec(v) || Object.keys(v).some(k => !['name', 'email', 'title', 'role'].includes(k))) return null
  if (!str(v.name) || !str(v.email) || !isRole(v.role)) return null
  const name = v.name.trim(), title = v.title === undefined ? undefined : str(v.title) ? v.title.trim() : null
  if (name.length < 1 || name.length > 80 || !EMAIL.test(v.email) || v.email.length > 254 || title === null || (title !== undefined && (title.length < 1 || title.length > 80))) return null
  return { name, email: v.email, ...(title !== undefined ? { title } : {}), role: v.role }
}
const sampleIdOf = (key: string, prefix: string) => (key.startsWith(prefix) ? memberIdOf(key.slice(prefix.length)) : null)
/** A saved server, or null for one that isn't (a demo saved before C2 has none: the legacy keys convert in `sanitize`). */
const savedServer = (v: unknown, startedAt: number): Server => {
  const out = defaultServer(startedAt)
  if (!isRec(v)) return out
  const grant = isRec(v.grant) ? v.grant : null
  const g = grant && str(grant.id) && isInstant(grant.createdAt) && isInstant(grant.endsAt) && str(grant.createdBy)
    ? { id: grant.id, createdBy: grant.createdBy, createdAt: grant.createdAt, endsAt: grant.endsAt, endedAt: isInstant(grant.endedAt) ? grant.endedAt : null, endedBy: str(grant.endedBy) ? grant.endedBy : null }
    : null
  return {
    roles: recOf(v.roles, isRole),
    photos: recOf(v.photos, (x): x is string | null => str(x) || x === null),
    removed: flagsOf(v.removed),
    invited: (isArr(v.invited) ? v.invited : []).filter(isMemberRecord),
    // A saved `grant: null` is "there never was one"; a missing or unreadable one is the first-run grant.
    grant: v.grant === null ? null : g ?? out.grant,
    grantSeq: typeof v.grantSeq === 'number' && Number.isInteger(v.grantSeq) && v.grantSeq >= 1 ? v.grantSeq : 1,
    revs: recOf(v.revs, (x): x is number => typeof x === 'number' && Number.isInteger(x) && x >= 0),
    memoryWaiting: (isArr(v.memoryWaiting) ? v.memoryWaiting : []).filter(isTeamLine).map(teamLineOf),
    memoryApproved: (isArr(v.memoryApproved) ? v.memoryApproved : []).filter(isTeamLine).map(teamLineOf),
    skillsDeleted: flagsOf(v.skillsDeleted),
    skillsChanged: recOf(v.skillsChanged, isInstant),
  }
}

/** A saved demo as it loads. */
interface Loaded {
  server: Server
  state: AgentState
  /** When this demo started (epoch ms): the demo clock counts from it. A demo control, not agent state: saved beside the state. */
  startedAt: number
  /** Whether the saved demo carried its own start. False: the clock starts now and isn't saved yet. */
  started: boolean
  /** Whether the upgrade filled in a value from the clock now (a team request saved before C1 has no `at`). */
  filledFromNow: boolean
}

/**
 * The saved demo, keeping only known shapes. An entry it can't read (or convert from an older shape) is dropped and named
 * in one console warning; an entry that names a routine that no longer exists is dropped on purpose, without one.
 */
const sanitize = (raw: unknown): Loaded => {
  if (!isRec(raw)) { const startedAt = Date.now(); return { state: initialState(), server: defaultServer(startedAt), startedAt, started: false, filledFromNow: false } }
  const started = typeof raw.demoStartedAt === 'number' && Number.isFinite(raw.demoStartedAt)
  const demoStartedAt = started ? raw.demoStartedAt as number : Date.now()
  const dropped: string[] = []
  const drop = (where: string) => { dropped.push(where) }
  /** The items of a saved list that `conv` keeps; the index of each it can't is dropped as `field[i]`. */
  const listConv = <T,>(field: string, v: unknown, conv: (x: unknown) => T | null): T[] =>
    (isArr(v) ? v : []).flatMap((x, i) => { const c = conv(x); if (c === null) drop(`${field}[${i}]`); return c === null ? [] : [c] })
  const server = savedServer(raw.server, demoStartedAt)
  const knownIds = new Set([...SAMPLE_MEMBERS.map(m => m.id), ...server.invited.map(m => m.id)])
  const unknownBy = new Set<string>()
  const byId = (by: string) => idOfBy(by, knownIds, n => unknownBy.add(n))
  const approved: AgentState['approved'] = {}
  for (const [id, r] of Object.entries(isRec(raw.approved) ? raw.approved : {})) {
    const at = isRec(r) ? savedAt(r) : null, loggedAt = isRec(r) ? savedLoggedAt(r) : null
    if (!hasStrs(r, ['by', 'title', 'doneText']) || !(r.by as string).trim() || !at || !loggedAt) { drop(`approved.${id}`); continue }
    approved[id] = { at, by: byId(r.by as string), loggedAt, title: r.title as string, doneText: r.doneText as string, partial: r.partial === true }
  }
  const routinesExtra = listConv('routinesExtra', raw.routinesExtra, savedRoutine)
    // An id twice keeps the first.
    .filter((r, i, all) => all.findIndex(x => x.id === r.id) === i)
  // Routine entries and runs that name no routine are dropped.
  const known = (id: string) => DATA.routines.some(r => r.id === id) || routinesExtra.some(r => r.id === id)
  const now = instantOf(demoNow(demoStartedAt).getTime())
  const paused = savedPause(raw.paused)
  if (paused === null && raw.paused !== null && raw.paused !== undefined) drop('paused')
  // Before C9 a role (`p:<id>`), a photo (`photo:<id>`) and the support switch (`d:support`) were settings: they move to the server.
  const legacy = recOf(raw.settings, str)
  for (const [k, v] of Object.entries(legacy)) {
    const role = sampleIdOf(k, 'p:'), photo = sampleIdOf(k, 'photo:')
    if (role && !server.roles[role]) server.roles[role] = v === 'Admin' ? 'admin' : 'member'
    if (photo && !(photo in server.photos)) server.photos[photo] = v === '' ? null : v
  }
  if (raw.server === undefined && raw.toggles !== undefined && isRec(raw.toggles) && raw.toggles['d:support'] === false && server.grant) {
    server.grant = { ...server.grant, endedAt: instantOf(demoNow(demoStartedAt).getTime()), endedBy: ME_ID }
  }
  // An approval rule's approver saved by name converts to the member id (or `anyone`).
  const settings: Record<string, string> = {}
  for (const [k, v] of Object.entries(legacy)) {
    if (k.startsWith('p:') || k.startsWith('photo:')) continue
    if (/^a:\d+$/.test(k)) { const a = v === 'Anyone who approves' ? 'anyone' : v.startsWith('m_') ? v : ID_BY_NAME.get(v); if (a && (a === 'anyone' || knownIds.has(a))) settings[k] = a; else drop(`settings.${k}`); continue }
    settings[k] = v
  }
  const toggles = recOf(raw.toggles, (x): x is boolean => typeof x === 'boolean')
  delete toggles['d:support']
  const state: AgentState = {
    approved,
    sent: flagsOf(raw.sent),
    undone: recConv(raw.undone, x => savedStamp(x, byId), k => drop(`undone.${k}`)),
    edits: recOf(raw.edits, str),
    paused,
    toggles,
    routinesExtra,
    skillsExtra: listConv('skillsExtra', raw.skillsExtra, r => (hasStrs(r, ['n', 'd', 'icon', 'by', 'used']) && !!(r.by as string).trim() && [0, 1, 2].includes(r.need as number) ? r as SkillDef : null)),
    requestedTools: flagsOf(raw.requestedTools),
    requestedSkills: flagsOf(raw.requestedSkills),
    toolPaused: flagsOf(raw.toolPaused),
    forgot: flagsOf(raw.forgot),
    settings,
    teamRequests: listConv('teamRequests', raw.teamRequests, r => savedRequest(r, now)),
    // The old notificationsRead / notificationRead flags are dropped: their notifications show unread once more.
    readNotices: flagsOf(raw.readNotices),
    libraryDeleted: flagsOf(raw.libraryDeleted),
    setAside: recConv(raw.setAside, (x): SetAsideRecord | null => {
      if (!isRec(x) || !SET_ASIDE.includes(x.reason as SetAsideReason)) return null
      const stamp = savedStamp(x, byId), loggedAt = savedLoggedAt(x)
      return stamp && loggedAt ? { reason: x.reason as SetAsideReason, ...stamp, loggedAt } : null
    }, k => drop(`setAside.${k}`)),
    routinesDeleted: Object.fromEntries(Object.keys(flagsOf(raw.routinesDeleted)).filter(known).map(id => [id, true as const])),
    // In the order `runRoutine` writes a run, so a state saved now loads as it was saved.
    routineRuns: listConv('routineRuns', (isArr(raw.routineRuns) ? raw.routineRuns : []).filter(r => !isRec(r) || !str(r.routine) || known(r.routine)), (r): RoutineRun | null => {
      if (!hasStrs(r, ['routine']) || !(r.trace === undefined || str(r.trace)) || !(r.result === undefined || str(r.result))) return null
      const at = savedAt(r)
      return at ? { routine: r.routine as string, at, ...(r.result !== undefined ? { result: r.result as string } : {}), ...(r.trace !== undefined ? { trace: r.trace as string } : {}) } : null
    }),
    // managing chats. A started chat's title, pin and delete are kept until Reset demo: its id is unique per page load
    // (chatIds.ts), so it can't be taken by a newer chat, and the app keeps the chat itself across a reload.
    chatTitles: Object.fromEntries(Object.entries(recOf(raw.chatTitles, (x): x is string => str(x) && x.trim() !== '')).map(([k, t]) => [k, t.slice(0, CHAT_TITLE_MAX)])),
    chatPinned: flagsOf(raw.chatPinned),
    chatDeleted: flagsOf(raw.chatDeleted),
  }
  for (const n of unknownBy) dropped.push(`a person named "${n}" (taken as the signed-in person)`)
  if (dropped.length) console.warn(`Inhouse demo: dropped saved entries it could not read: ${dropped.join(', ')}.`)
  // Only a request saved without its time gets `now` itself.
  const filledFromNow = state.teamRequests.some(r => r.at === now)
  return { state, server, startedAt: demoStartedAt, started, filledFromNow }
}


// ---------- the mock ----------

export type Script = { thinking: string[]; delayMs: number; parts: MessagePart[]; trace: TraceKey; after?: (info: RunInfo, replaces?: string) => void }

/** What a run replayed and made: its recorded trace, and the routine or skill it created (Regenerate updates those in place).
 *  `kept` is a routine an earlier run made that this failed run left standing: the next answer updates it in place, so it
 *  isn't made twice, but never takes it back (this run didn't make it). A failed run carries the earlier `skill` as its own.
 *  One per turn: the first turn's id is the run's, a turn started by `send` is `${runId}-t${n}`. */
export type RunInfo = { trace: TraceKey; routine?: string; kept?: string; skill?: string }
/** One turn of a run in the mock (the server's `turns` row): its state, and the two ways to end it early. */
export interface MockTurn {
  turnId: string; runId: string; chatId: string; input: ChatSendInput; ord: number; queuedAt: Instant
  state: 'queued' | 'live' | 'ended'
  /** `interrupt` ends this turn and keeps the session; `stop` is the hard stop. Both end only this turn. */
  interrupt: AbortController; hard: AbortController
}
/** A run in the mock: its events by seq (kept, so any attach replays them), who follows it, and its turns. */
export interface MockRun { runId: string; chatId: string; frames: RunFrame[]; live: boolean; turns: MockTurn[]; subs: Set<(f: RunFrame) => void>; info?: RunInfo }
/** What `scriptNextTurn` can make the next turn do (a test hook: the real target scripts the same through its scripted model). */
export type ScriptedTurn = 'turnBudget' | 'maxTurns' | 'capReached' | 'budgetBusyThenStart' | 'budgetBusyThenFail' | 'sessionDamaged' | 'crash'

const TRACE_KEYS = Object.keys(traces)
/** A trace named in the sample data ("routine (without the approval step)" names `routine`). An unknown one stops the app. */
function traceKey(t: string): TraceKey {
  const k = t.split(' ')[0]
  // Not TRACE_KEYS: the chats are loaded (and call this) before that constant is set.
  if (!Object.hasOwn(traces, k)) throw new Error(`Sample data: unknown trace "${t}".`)
  return k
}

const loadRunInfo = (): Map<string, RunInfo> => {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(RUNS_KEY) ?? '[]')
    if (!isArr(raw)) return new Map()
    return new Map(raw.filter((e): e is [string, RunInfo] => isArr(e) && str(e[0]) && isRec(e[1]) && str(e[1].trace) && TRACE_KEYS.includes(e[1].trace)
      && (e[1].routine === undefined || str(e[1].routine)) && (e[1].kept === undefined || str(e[1].kept)) && (e[1].skill === undefined || str(e[1].skill))))
  } catch (e) {
    console.warn('Inhouse demo: could not read saved runs, their steps start empty.', e)
    return new Map()
  }
}

/** A unique string the product build check (scripts/check-product-build.mjs) looks for: it must never be in the product build. */
export const MOCK_MARKER = 'inhouse-canary:mock'

export class MockAgent implements AgentClient {
  readonly marker = MOCK_MARKER
  private state: AgentState
  /** What the server would keep (members, photos, the grant, every record's rev), saved beside the state. */
  private server: Server
  /** The `rev` of each record as this client last saw it: what a write sends as `ifRev`. A record with no entry is at its current rev. */
  private seen: Record<string, number> = {}
  /** Resources whose read fails until `retry` (a test hook, `failRead`). */
  private failed: Partial<Record<ResourceKey, AgentErrorCode>> = {}
  /** When this demo started (epoch ms): set at first load and by Reset demo. The demo clock counts from it. Saved with the
   *  state under the same key, as it always was, but not part of `AgentState`: the real agent has no demo start. */
  private startedAt: number
  private listeners = new Set<() => void>()
  /** The sample skills' instructions once `loadSkill` has loaded them (by skill name), and the load while it runs. */
  private skillBodies: Record<string, string> | null = null
  private skillBodiesLoad: Promise<void> | null = null
  private noticeListeners = new Set<(n: AgentNotice) => void>()
  private holdTimers: Record<string, ReturnType<typeof setTimeout>> = {}
  private mockRuns = new Map<string, MockRun>()
  /** The chat's messages the server stored (D1), beyond the sample chats' own turns. */
  private history = new Map<string, StoredMessage[]>()
  scripted: ScriptedTurn | null = null
  /** The chat engine (mock-chat.ts): runs, turns and the chat reads. Loads with the first send, so it isn't in Today's first load. */
  private engine: ChatEngine | null = null
  private sendDelayMs = 0
  readonly k = { chats, ME_ID, SESSION, FINISHED, THINKING_STEP_MS, tools, traceKey, meName: () => this.meName(), changeSkill: (name: string) => this.changeSkill(name) }
  private linkState: LinkState = 'live'
  private linkListeners = new Set<(l: LinkState) => void>()
  /** Run id to what it replayed and made, saved (bounded) so a saved chat's run ids keep their steps after a reload. */
  private runInfo = loadRunInfo()
  /** Chats the app made with `createChat`. `ask` takes these and the sample chats, nothing else. */
  private created = new Set<string>()
  /** What each chat made with `createChat` is called and when it began. */
  private createdInfo = new Map<string, { title: string; at: Instant }>()
  private demo: DemoContext = { scenario: 'Normal' }

  constructor() {
    const { state, server, startedAt, started, filledFromNow } = this.loadSaved()
    this.state = state
    this.server = server
    this.startedAt = startedAt
    // The demo clock counts from the first load: save that moment now, so a reload before any other write doesn't
    // start the clock again at 8:00 AM while the app already shows later times. An upgrade that filled in a value from
    // the clock now (a team request saved before C1 has no `at`) is saved too, so the next load doesn't set it again.
    // Any other older shape is saved converted at the next real write, not on load: a tab still open on the build before
    // the upgrade reads what this one saves (the storage event), and its own reader would drop what it can't read.
    if (!started || filledFromNow) this.commit({})
    this.resumeHolds()
    // The chat engine loads now, in the background: not part of the first load, and ready before the first send.
    void this.loadEngine()
    // Another tab changed the saved state: take it, so two open tabs don't overwrite each other.
    if (typeof window !== 'undefined') {
      window.addEventListener('storage', e => { if (e.key === STORAGE_KEY || e.key === null) this.syncFromStorage() })
    }
  }

  // ----- state plumbing -----

  /** The saved demo (see `sanitize`), or a fresh one when storage can't be read. */
  private loadSaved(): Loaded {
    try {
      return sanitize(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null'))
    } catch (e) {
      console.warn('Inhouse demo: could not read saved state, starting fresh.', e)
      const startedAt = Date.now()
      return { state: initialState(), server: defaultServer(startedAt), startedAt, started: false, filledFromNow: false }
    }
  }

  /** What is saved under STORAGE_KEY: the state with the demo's start, in the shape it always had. */
  private saved(): string { return JSON.stringify({ ...this.state, demoStartedAt: this.startedAt, server: this.server }) }

  /** DemoControls (demo-controls.ts): when this demo started, as epoch ms. The demo clock counts from it. */
  demoStartedAt(): number { return this.startedAt }

  /** Apply a change and save it. A failed save is reported to the UI; `revert` also drops the change from memory. False when the save failed. */
  private commit(next: Partial<AgentState>, revert = false, server?: Server): boolean {
    const before = this.state, serverBefore = this.server
    this.state = { ...this.state, ...next }
    if (server) this.server = server
    let ok = true
    try { localStorage.setItem(STORAGE_KEY, this.saved()) }
    catch (e) {
      console.warn('Inhouse demo: could not save state.', e)
      ok = false
      if (revert) { this.state = before; this.server = serverBefore }
      this.notify({ type: 'save.failed', text: SAVE_FAILED })
    }
    this.listeners.forEach(l => l())
    return ok
  }

  /** A failed write: an AgentError the caller can await. `tell` also sends it as a notice (a failed save already sent one). */
  private rejected(code: AgentErrorCode, text: string, tell: boolean, extra?: { reason?: ErrorReason; current?: Record<string, unknown> }): Promise<never> {
    if (tell) this.notify({ type: 'error', code, text })
    const p = Promise.reject(new AgentError(code, text, extra))
    // The person was told by a notice and the console has the cause, so a caller that doesn't await must not also
    // raise an unhandled rejection. A caller that awaits still gets the rejection: this handler is on `p` only.
    p.catch(() => undefined)
    return p
  }

  /** A write: applied at once, taken back if it can't be saved. */
  private write(next: Partial<AgentState>, server?: Server): Promise<void> { return this.writeThen(next, undefined, server) }
  /** A write that resolves to `value`. A failed save rejects through `rejected()`, so a caller that doesn't await raises nothing. */
  private writeThen<T>(next: Partial<AgentState>, value: T, server?: Server): Promise<T> {
    return this.commit(next, true, server) ? Promise.resolve(value) : this.rejected('unknown', SAVE_FAILED, false)
  }

  /**
   * Another tab changed the saved state. Drop holds that are no longer pending, take over holds this tab
   * has no timer for (the tab that started one may have closed), and tell this tab when a hold went out.
   */
  private syncFromStorage() {
    const wasSent = this.state.sent
    const { state, server, startedAt } = this.loadSaved()
    this.state = state
    this.server = server
    // Another tab's changes are taken as read: this client's next write is against what it now shows.
    this.seen = {}
    this.startedAt = startedAt
    for (const id of Object.keys(this.holdTimers)) {
      if (this.state.approved[id] && !this.state.sent[id]) continue
      clearTimeout(this.holdTimers[id])
      delete this.holdTimers[id]
    }
    this.resumeHolds()
    this.listeners.forEach(l => l())
    for (const id of Object.keys(this.state.sent)) {
      const rec = this.state.approved[id]
      if (!wasSent[id] && rec) this.notify({ type: 'approval.sent', id, text: rec.doneText })
    }
  }

  private notify(n: AgentNotice) { this.noticeListeners.forEach(l => l(n)) }

  /** Now on the demo clock: shown, sortable, and who is doing it. */
  private stamp(): StampRecord {
    return { at: instantOf(demoNow(this.startedAt).getTime()), by: ME_ID }
  }

  getSnapshot = () => this.state
  /** `read()` with what the server holds laid over the scenario's data: members, rules, grant, revs, resource status. Rebuilt only when one of those changes. */
  /** The last few views by what they were built from, so a write taken back reads the very object it read before. */
  private views: { base: AgentData; key: unknown[]; v: AgentData }[] = []
  read = (): AgentData => {
    const base = DATA_FOR[this.demo.scenario]
    // Whether the grant is live changes with the clock alone, so it is part of what a view is built from.
    const key = [this.server, this.state.settings, this.failed, this.grantNow()?.live, this.skillBodies]
    const hit = this.views.find(x => x.base === base && x.key.every((k, i) => k === key[i]))
    if (hit) return hit.v
    const v = this.overlay(base)
    this.views = [{ base, key, v }, ...this.views].slice(0, 8)
    return v
  }

  private rev(rec: string, base: number) { return this.server.revs[rec] ?? base }
  private meName() { return this.state.settings['g:name']?.trim() || meta.currentUser.name }
  /** The team as the server serves it: the sample people and the ones invited, with their role, photo, status and rev. */
  private members(): MemberRecord[] {
    const s = this.server
    // A sample member invited again is one record (the invited one), kept where they were in the list.
    const again = new Map(s.invited.map(m => [m.id, m]))
    const sampleIds = new Set(SAMPLE_MEMBERS.map(m => m.id))
    return [...SAMPLE_MEMBERS.map(m => again.get(m.id) ?? m), ...s.invited.filter(m => !sampleIds.has(m.id))].map(m => ({
      ...m,
      name: m.id === ME_ID ? this.meName() : m.name,
      role: s.roles[m.id] ?? m.role,
      photo: m.id in s.photos ? s.photos[m.id] : m.photo,
      status: s.removed[m.id] ? 'removed' as const : m.status,
      rev: this.rev(`member:${m.id}`, m.rev),
    }))
  }
  private grantNow(): SupportGrant | null {
    const g = this.server.grant
    if (!g) return null
    const now = demoNow(this.startedAt).getTime()
    return { ...g, rev: this.rev(`grant:${g.id}`, 1), live: g.endedAt === null && g.endsAt.ms > now }
  }
  private overlay(base: AgentData): AgentData {
    const failed = this.failed
    const status = (k: ResourceKey): ResourceStatus => (failed[k] ? { status: 'error', error: failed[k] } : base.resources[k])
    const revs = this.server.revs
    const bodies = this.skillBodies
    const { skillsDeleted, skillsChanged } = this.server
    // The brand's name is its `b:name` setting as in the product (trimmed; unset or blank keeps the sample's name).
    const brandName = this.state.settings['b:name']?.trim() || base.meta.brand.name
    return {
      ...base,
      ...(brandName === base.meta.brand.name ? {} : { meta: { ...base.meta, brand: { ...base.meta.brand, name: brandName } } }),
      // The sample's own skills (`mine`) as the demo's people left them: deleted ones gone, changed ones dated. Who may
      // change one: its maker or an admin, so the demo's admin may change them all.
      skills: base.skills.filter(s => !(s.mine && skillsDeleted[s.n])).map(s => {
        const changed = s.mine && Object.hasOwn(skillsChanged, s.n) ? skillsChanged[s.n] : undefined
        return {
          ...s,
          ...(bodies && Object.hasOwn(bodies, s.n) ? { body: bodies[s.n] } : {}),
          ...(changed ? { updatedAt: changed, used: 'Changed today' } : {}),
          ...(s.mine ? { canChange: true } : {}),
        }
      }),
      people: {
        ...base.people,
        members: failed.members ? [] : this.members(),
        approvalRules: APPROVAL_RULES.map((r, i) => ({ ...r, approver: this.approverOf(i, r.approver), rev: revs[`setting:a:${i}`] ?? 0 })),
        supportGrant: failed.grants ? null : this.grantNow(),
      },
      routines: base.routines.map(r => ({ ...r, rev: revs[`routine:${r.id}`] ?? r.rev })),
      memory: {
        team: this.withApproved(base.memory.team).map(g => ({ ...g, lines: g.lines.map(l => ({ ...l, rev: revs[`memory:${l.key}`] ?? l.rev })) })),
        personal: base.memory.personal.map(l => ({ ...l, rev: revs[`memory:${l.key}`] ?? l.rev })),
      },
      auditLog: failed.audit ? [] : base.auditLog,
      resources: Object.fromEntries(RESOURCE_KEYS.map(k => [k, status(k)])) as Record<ResourceKey, ResourceStatus>,
    }
  }
  /** The team's groups with the lines approved in this demo after the first group's own (a group of their own when there is none). */
  private withApproved(team: AgentData['memory']['team']): AgentData['memory']['team'] {
    const extra = this.server.memoryApproved
    if (extra.length === 0) return team
    if (team.length === 0) return [{ group: 'Shared with the team', lines: extra }]
    return team.map((g, i) => (i === 0 ? { ...g, lines: [...g.lines, ...extra] } : g))
  }
  private approverOf(i: number, sample: ApprovalRule['approver']): ApprovalRule['approver'] {
    const saved = this.state.settings[`a:${i}`]
    return saved === 'anyone' || (saved !== undefined && saved.startsWith('m_')) ? saved : sample
  }

  private meSnap: { key: unknown[]; me: Me } | null = null
  /** The signed-in person: the sample Admin. `can` follows the role (the demo's Admin may do everything, call 10). */
  me = (): Me | null => {
    if (DATA_FOR[this.demo.scenario].status === 'loading') return null
    const key = [this.server, this.state.settings['g:name']]
    if (this.meSnap && key.every((k, i) => k === this.meSnap!.key[i])) return this.meSnap.me
    const m = this.members().find(x => x.id === ME_ID)!
    const admin = m.role === 'admin'
    const can = Object.fromEntries(CAN_KEYS.map(k => [k, k === 'viewMembers' || k === 'viewAudit' || k === 'exportAudit' ? true : admin])) as Can
    const me: Me = { memberId: ME_ID, name: m.name, email: m.email, role: m.role, can, photoUrl: m.photo, grant: null }
    this.meSnap = { key, me }
    return me
  }
  allChatIds = () => [...chats.map(c => c.id), ...this.created]
  subscribe = (l: () => void) => { this.listeners.add(l); return () => { this.listeners.delete(l) } }
  onNotice = (l: (n: AgentNotice) => void) => { this.noticeListeners.add(l); return () => { this.noticeListeners.delete(l) } }
  /** DemoControls (demo-controls.ts), not AgentClient: the real client has neither. */
  setDemo(ctx: DemoContext) {
    const changed = ctx.scenario !== this.demo.scenario
    this.demo = ctx
    // What `read`, `listFiles` and `listNotifications` return follows the scenario.
    if (changed) this.listeners.forEach(l => l())
  }

  reset() {
    Object.values(this.holdTimers).forEach(clearTimeout)
    this.holdTimers = {}
    this.mockRuns.forEach(r => r.turns.forEach(t => t.hard.abort()))
    this.mockRuns.clear(); this.history.clear(); this.engine?.clear(); this.scripted = null; this.sendDelayMs = 0
    this.created.clear(); this.createdInfo.clear()
    this.runInfo.clear()
    // A demo whose actions loaded starts them again; one that never read them has nothing to reset.
    void this.demoActionsLoad?.then(a => a.reset())
    this.sentBack = []
    try { localStorage.removeItem(RUNS_KEY) } catch (e) { console.warn('Inhouse demo: could not clear saved runs.', e) }
    try { localStorage.removeItem(DATA_OVERRIDE_KEY) } catch (e) { console.warn('Inhouse demo: could not clear the data override.', e) }
    this.startedAt = Date.now()
    this.seen = {}
    this.failed = {}
    this.commit(initialState(), false, defaultServer(this.startedAt))
  }

  // ----- approvals -----

  private scheduleSend(id: string, delay: number) {
    clearTimeout(this.holdTimers[id])
    this.holdTimers[id] = setTimeout(() => {
      delete this.holdTimers[id]
      const rec = this.state.approved[id]
      if (!rec || this.state.sent[id]) return
      this.commit({ sent: { ...this.state.sent, [id]: true } })
      this.notify({ type: 'approval.sent', id, text: rec.doneText })
    }, Math.max(0, delay))
  }

  /** Finish holds that are pending but have no timer here: after a reload, or when another tab closed. */
  private resumeHolds() {
    for (const [id, rec] of Object.entries(this.state.approved)) {
      const p = problems.find(x => x.id === id)
      if (!p || this.state.sent[id] || p.draft.rev || this.holdTimers[id]) continue
      this.scheduleSend(id, SEND_HOLD_MS - (Date.now() - rec.loggedAt.ms))
    }
  }

  approve(id: string): Promise<ApproveResult> {
    const p = problemById(id)
    const held = !p.draft.rev
    const existing = this.state.approved[id]
    if (existing) return Promise.resolve({ record: existing, held, doneText: existing.doneText })
    // Wording is fixed now, so history never rewrites itself when an undo changes later.
    const record = { ...this.stamp(), loggedAt: instantOf(Date.now()), title: p.draft.title, doneText: p.doneText, partial: false }
    // Approving a problem that was set aside brings it back as a normal approval everywhere.
    const setAside = { ...this.state.setAside }; delete setAside[id]
    if (!this.commit({ approved: { ...this.state.approved, [id]: record }, setAside }, true)) return this.rejected('unknown', SAVE_FAILED, false)
    if (held) this.scheduleSend(id, SEND_HOLD_MS)
    return Promise.resolve({ record, held, doneText: record.doneText })
  }

  undo(id: string) {
    if (this.state.sent[id] && !problemById(id).draft.rev) return this.rejected('conflict', TOO_LATE, true)
    clearTimeout(this.holdTimers[id])
    delete this.holdTimers[id]
    const approved = { ...this.state.approved }; delete approved[id]
    const sent = { ...this.state.sent }; delete sent[id]
    const ok = this.write({ approved, sent })
    // A hold whose undo couldn't be saved is still approved: let it go out as the person last saw it.
    if (this.state.approved[id] && !this.state.sent[id] && !problemById(id).draft.rev) this.resumeHolds()
    return ok
  }

  editDraft(id: string, body: string) { return this.write({ edits: { ...this.state.edits, [id]: body } }) }

  undoHandled(id: string): Promise<string> {
    const p = problemById(id)
    const text = p.partial ? 'Undone: the variant is live again' : `Undone: ${p.doneText.toLowerCase()}`
    return this.writeThen({ undone: { ...this.state.undone, [id]: this.stamp() } }, text)
  }
  redoHandled(id: string) { const undone = { ...this.state.undone }; delete undone[id]; return this.write({ undone }) }

  // ----- Pause and resume -----

  pause(): Promise<Instant> {
    const { at } = this.stamp()
    const done = this.writeThen({ paused: at }, at)
    // A paused agent ends what is running and cancels what waits (the server's fence), and sends every approval still in
    // its hold back to waiting (N12). Actions never read have none in a hold.
    if (this.state.paused === at) {
      this.engine?.fence(() => true, 'paused')
      void this.demoActionsLoad?.then(a => a.pause())
    }
    return done
  }
  resume() { return this.write({ paused: null }) }

  // ----- plain reads and writes -----

  setToggle(key: string, on: boolean) {
    const row = settingRow(key)
    // `r:<routine>` and `s:<skill>` are the routine and skill switches (P4 and P5 own them); every other key must be a switch in the registry.
    if (row ? !meetsRule(row.rule, on) : !/^[rs]:./.test(key)) return this.rejected('invalid', `"${key}" isn't a switch.`, true, { reason: row ? REASON.badType : REASON.wrongScope })
    const rec = `setting:${key}`
    const stale = this.conflict(rec, 0, () => this.settingRecord(key))
    if (stale) return stale
    return this.writeRecs([[rec, 0]], { toggles: { ...this.state.toggles, [key]: on } })
  }
  requestTool(key: string, on: boolean) {
    const requestedTools = { ...this.state.requestedTools }
    if (on) requestedTools[key] = true; else delete requestedTools[key]
    return this.write({ requestedTools })
  }
  requestSkill(name: string) { return this.write({ requestedSkills: { ...this.state.requestedSkills, [name]: true } }) }
  setToolPaused(key: string, paused: boolean) {
    const toolPaused = { ...this.state.toolPaused }
    if (paused) toolPaused[key] = true; else delete toolPaused[key]
    return this.write({ toolPaused })
  }
  /** The demo has no sign-in at a tool: the address is this app's own, which the Tools page reads as "connected" (no navigation). */
  connectTool(key: string): Promise<{ authorizeUrl: string }> { return Promise.resolve({ authorizeUrl: `/tools/${encodeURIComponent(key)}?connected=1` }) }
  disconnectTool(_key: string): Promise<{ revoked: boolean }> { return this.rejected('unavailable', "Disconnecting isn't connected in this demo.", true) }
  forgetMemory(key: string, forgotten: boolean) {
    const rec = `memory:${key}`
    const stale = this.conflict(rec, 1, () => ({ key, rev: this.rev(rec, 1) }))
    if (stale) return stale
    const forgot = { ...this.state.forgot }
    if (forgotten) forgot[key] = true; else delete forgot[key]
    return this.writeRecs([[rec, 1]], { forgot })
  }
  // Stage 1 M2 (N18): the demo has no questions: its list is empty and every answer is refused (there is nothing it could
  // name), with no notice. Stage 1 M3-U and the demo catch-up (PR 1): its actions and permissions are the real agent's
  // cards and Always allowed list on sample data (mock-actions.ts), in the Normal scenario; in the other scenarios none,
  // as before. They load with the first read of them (their module and sample data), outside Today's first load
  // (check-bundle).
  private demoActionsLoad: Promise<MockActions> | null = null
  private actionListeners = new Set<(u: { actionId: string; rev: number }) => void>()
  private demoActions(): Promise<MockActions> {
    return this.demoActionsLoad ??= import('./mock-actions').then(m => new m.MockActions({
      now: () => demoNow(this.startedAt).getTime(),
      shown: () => this.demo.scenario === 'Normal',
      hasTool: tool => { const t = this.read().tools; return tool !== 'slack' || t.connected.includes('slack') || t.channels.some(c => c.key === 'slack') },
      meId: ME_ID,
      memberId: memberIdOf,
      paused: () => this.state.paused !== null,
      changed: u => { this.actionListeners.forEach(l => l(u)) },
      sentBack: u => { this.sentBack = [{ ...u, id: `n-sent-back-${u.actionId}-${u.rev}` }, ...this.sentBack]; this.listeners.forEach(l => l()) },
    }))
  }
  /** A demo action's answer: the card, or the refusal as an AgentError (no notice: the card says it). */
  private async acted<T>(run: (a: MockActions) => T): Promise<T> {
    const a = await this.demoActions()
    try { return run(a) } catch (e) {
      if (!(e instanceof AgentError)) throw e
      return this.rejected(e.code, e.message, false, { ...(e.reason ? { reason: e.reason } : {}), ...(e.current ? { current: e.current } : {}) })
    }
  }
  actions(filter?: ActionFilter): Promise<ActionCard[]> { return this.acted(a => a.list(filter)) }
  action(id: string): Promise<ActionCard> { return this.acted(a => a.get(id)) }
  answerAction(id: string, ifRev: number, choice: ActionChoice, covers?: BatchCovers): Promise<ActionCard> { return this.acted(a => a.answer(id, ifRev, choice, covers)) }
  undoAction(id: string, ifRev: number): Promise<ActionCard> { return this.acted(a => a.undo(id, ifRev)) }
  resolveAction(id: string, ifRev: number, outcome: ActionResolution): Promise<ActionCard> { return this.acted(a => a.resolve(id, ifRev, outcome)) }
  withdrawAction(id: string, ifRev: number): Promise<ActionCard> { return this.acted(a => a.withdraw(id, ifRev)) }
  actionItems(id: string, after: number): Promise<ActionItemsPage> { return this.acted(a => a.items(id, after)) }
  onActionUpdated(l: (u: { actionId: string; rev: number }) => void): () => void { this.actionListeners.add(l); return () => { this.actionListeners.delete(l) } }
  permissions(): Promise<Permission[]> { return this.acted(a => a.permissions()) }
  removePermission(id: string, ifRev: number): Promise<Permission[]> { return this.acted(a => a.removePermission(id, ifRev)) }
  questions(): Promise<Question[]> { return Promise.resolve([]) }
  answerQuestion(): Promise<Question> { return this.rejected(NOT_FOUND, NO_M2_RECORD, false) }
  // Stage 1 M1-D (N3): the demo runs no long jobs. A chat has none, and a Cancel names nothing it has.
  job(_chatId: string): Promise<Job | null> { return Promise.resolve(null) }
  cancelJob(_jobId: string): Promise<Job> { return this.rejected(NOT_FOUND, NO_M2_RECORD, false) }
  // Stage 1 M3-C (N26): the demo has no ceiling (its page is the product's only, menu.ts), so a read or a change names
  // nothing it has, refused like the M2 answers above (the same words, so Today's first load barely grows).
  ceiling(): Promise<CeilingList> { return this.rejected(NOT_FOUND, NO_M2_RECORD, false) }
  setCeiling(): Promise<CeilingRow> { return this.rejected(NOT_FOUND, NO_M2_RECORD, false) }

  waitingMemory(): Promise<WaitingMemory[]> {
    if (!this.me()?.can.approveMemory) return this.rejected('forbidden', WAITING_REFUSED, false)
    const facts = this.server.memoryWaiting.map(l => {
      const rec = `memory:${l.key}`
      this.seen[rec] = this.rev(rec, l.rev)
      return { ...l, rev: this.rev(rec, l.rev), scope: 'brand' as const, waiting: true as const, kind: 'memory' as const }
    })
    return Promise.resolve([...facts].reverse())
  }
  reviewMemory(key: string, approved: boolean) {
    if (!this.me()?.can.approveMemory) return this.rejected('forbidden', DECIDING_REFUSED, true)
    const line = this.server.memoryWaiting.find(l => l.key === key)
    if (!line) return this.rejected(NOT_FOUND, 'That rule no longer waits for an OK.', true)
    const rec = `memory:${key}`
    const stale = this.conflict(rec, line.rev, () => ({ ...line, rev: this.rev(rec, line.rev), waiting: true }))
    if (stale) return stale
    const memoryWaiting = this.server.memoryWaiting.filter(l => l.key !== key)
    const memoryApproved = approved ? [...this.server.memoryApproved, line] : this.server.memoryApproved
    return this.writeRecs([[rec, line.rev]], {}, { memoryWaiting, memoryApproved })
  }
  setSetting(key: string, value: string | null) {
    const row = settingRow(key)
    if (!row) return this.rejected('invalid', `"${key}" isn't a setting.`, true, { reason: REASON.wrongScope })
    if (value !== null && !meetsRule(row.rule, value)) return this.rejected('invalid', `That isn't a value for "${key}".`, true, { reason: REASON.badType })
    const rec = `setting:${key}`
    const stale = this.conflict(rec, 0, () => this.settingRecord(key))
    if (stale) return stale
    const settings = { ...this.state.settings }
    if (value === null) delete settings[key]; else settings[key] = value
    // The signed-in person's name is on their member record, so changing it moves that record's rev too.
    return this.writeRecs(key === 'g:name' ? [[rec, 0], [`member:${ME_ID}`, 1]] : [[rec, 0]], { settings })
  }
  setPhoto(memberId: string, dataUrl: string | null) {
    if (!this.members().some(m => m.id === memberId && m.status !== 'removed')) return this.rejected(NOT_FOUND, 'No such member.', true)
    return this.writeRecs([[`member:${memberId}`, 1]], {}, { photos: { ...this.server.photos, [memberId]: dataUrl } })
  }

  // ----- records with a rev (C6) -----

  /** A setting as the server serves it: what `conflict` carries as `current`. */
  private settingRecord(key: string): Record<string, unknown> {
    const v = this.state.settings[key] ?? this.state.toggles[key] ?? null
    return { key, value: v, rev: this.rev(`setting:${key}`, 0), updatedAt: null, updatedBy: null }
  }
  /**
   * A write to a record this client last saw at another rev is stale: it never applies, and rejects with `conflict` carrying
   * the record as it is now (the state already holds that value, so the UI shows it). Null when it isn't stale.
   */
  private conflict(rec: string, base: number, current: () => Record<string, unknown>): Promise<never> | null {
    const now = this.rev(rec, base)
    // A rev above the current one is a write taken back (the contract suite's refusal): not stale.
    if ((this.seen[rec] ?? now) >= now) return null
    this.seen[rec] = now
    return this.rejected('conflict', 'Someone changed this.', true, { current: current() })
  }
  /** A server with each record's rev bumped (`recs` are `[record, its first rev]`). */
  private bumped(recs: [string, number][]): Server {
    const revs = { ...this.server.revs }
    for (const [rec, base] of recs) revs[rec] = (revs[rec] ?? base) + 1
    return { ...this.server, revs }
  }
  /** A chat-made routine is a card in the state: its rev moves there too, so the snapshot shows it. */
  private routineNext(ids: string[], next: Partial<AgentState>): Partial<AgentState> {
    const extra = next.routinesExtra ?? this.state.routinesExtra
    if (!extra.some(c => ids.includes(c.id))) return next
    return { ...next, routinesExtra: extra.map(c => (ids.includes(c.id) ? { ...c, rev: this.rev(`routine:${c.id}`, 1) + 1 } : c)) }
  }
  /** A write that bumps each record's rev in the same commit as the change. `recs` are `[record, its first rev]`. */
  private writeRecs(recs: [string, number][], next: Partial<AgentState>, patch: Partial<Server> = {}): Promise<void> {
    const revs = { ...this.server.revs, ...patch.revs }
    for (const [rec, base] of recs) revs[rec] = (revs[rec] ?? base) + 1
    const ok = this.commit(next, true, { ...this.server, ...patch, revs })
    if (!ok) return this.rejected('unknown', SAVE_FAILED, false)
    for (const [rec] of recs) this.seen[rec] = revs[rec]
    return Promise.resolve()
  }

  /** Test hook (the contract suite's `writeElsewhere`): change a record behind this client, as another session would, so its next write is stale. */
  changeElsewhere(ref: { kind: 'setting'; key: string } | { kind: 'member'; id: string } | { kind: 'grant'; id: string } | { kind: 'routine' | 'memory' | 'file' | 'chat'; id: string }, value?: string | boolean): void {
    const rec = ref.kind === 'setting' ? `setting:${ref.key}` : ref.kind === 'memory' ? `memory:${ref.id}` : `${ref.kind}:${ref.id}`
    const base = ref.kind === 'setting' ? 0 : 1
    this.seen[rec] ??= this.rev(rec, base)
    const revs = { ...this.server.revs, [rec]: this.rev(rec, base) + 1 }
    let server: Server = { ...this.server, revs }
    let state = this.state
    if (ref.kind === 'setting') {
      if (typeof value === 'boolean') state = { ...state, toggles: { ...state.toggles, [ref.key]: value } }
      else if (typeof value === 'string') state = { ...state, settings: { ...state.settings, [ref.key]: value } }
    } else if (ref.kind === 'member' && isRole(value)) server = { ...server, roles: { ...server.roles, [ref.id]: value } }
    else if (ref.kind === 'grant' && value === 'end' && this.server.grant) server = { ...server, grant: { ...this.server.grant, endedAt: instantOf(demoNow(this.startedAt).getTime()), endedBy: ME_ID } }
    this.state = state
    this.commit(ref.kind === 'routine' ? this.routineNext([ref.id], {}) : {}, false, server)
  }
  /** Test hook (`failRead`): this resource's read fails with `code` until `retry`; null undoes it. */
  failRead(resource: ResourceKey, code: AgentErrorCode | null = 'unavailable') {
    const failed = { ...this.failed }
    if (code) failed[resource] = code; else delete failed[resource]
    this.failed = failed
    this.listeners.forEach(l => l())
  }
  sendTeamRequest(req: TeamRequest) { return this.write({ teamRequests: [req, ...this.state.teamRequests] }) }
  /** The demo keeps nothing to withdraw on a server: the window shows the request as withdrawn for the session (its `teamWithdrawn`), and an Undo puts it back. */
  withdrawTeamRequest(_ref: { title: string; at: Instant }) { return Promise.resolve() }
  markNoticesRead(ids: string[]) {
    const fresh = ids.filter(id => !this.state.readNotices[id])
    return fresh.length ? this.write({ readNotices: { ...this.state.readNotices, ...Object.fromEntries(fresh.map(id => [id, true as const])) } }) : Promise.resolve()
  }

  // ----- notifications -----

  private notesFor: [AgentState, Scenario, readonly SentBack[]] | null = null
  private notes: AgentNotification[] = []
  /** The approvals a Pause sent back (mock-actions.ts), newest first: each one's bell notice. In memory, like the cards. */
  private sentBack: readonly SentBack[] = []
  /** Rebuilt only when state, scenario or the notices sent back change, so React sees the same array until then. */
  listNotifications = (): AgentNotification[] => {
    const { scenario } = this.demo
    const f = this.notesFor
    if (f && f[0] === this.state && f[1] === scenario && f[2] === this.sentBack) return this.notes
    this.notesFor = [this.state, scenario, this.sentBack]
    this.notes = this.buildNotifications(scenario)
    return this.notes
  }

  private buildNotifications(scenario: Scenario): AgentNotification[] {
    // On day one, and while loading, nothing has happened yet.
    if (isNoData(scenario)) return []
    const st = this.state
    const data = this.read()
    // The product's view (no stages, decision A13): the same count as Approvals' drafts.
    const nNeed = pendingIds({ S: DEMO_VIEW, agent: st, data, noStages: true }).length
    const actions = scenario === 'Normal'
    // A Pause's notices, as the outbox sends them: "Approval sent back", to Approvals, waiting on this person again.
    const out: AgentNotification[] = !actions ? [] : this.sentBack.map(b => ({
      id: b.id, icon: 'undo', text: APPROVAL_SENT_BACK, who: 'Inhouse', at: instantOf(b.atMs), unread: !st.readNotices[b.id], waiting: true, link: { to: 'page', page: 'approvals' },
    }))
    for (const n of notifications.notifications as RawNotification[]) {
      if (n.approval && !actions) continue
      if (n.drafts !== undefined) {
        // The waiting line. Its id carries the count, so a higher count arrives unread again; a count that fell (a draft
        // was approved) stays read.
        if (nNeed === 0) continue
        const kind = 'waiting-drafts'
        const read = Object.keys(st.readNotices).some(k => k.startsWith(`${kind}-`) && Number(k.slice(kind.length + 1)) >= nNeed)
        out.push({
          id: `${kind}-${nNeed}`, icon: 'task_alt', who: n.who, at: sampleAt('a notification', n.at), unread: n.unread && !read, waiting: true,
          text: nNeed === 1 ? n.drafts.replace('{pending} drafts are', '1 draft is') : n.drafts.replace('{pending}', String(nNeed)),
          link: linkOf(n.opens),
        })
        continue
      }
      if (n.text === undefined) throw new Error(`Sample data: the notification at "${n.at}" has no text.`)
      const link = linkOf(n.opens)
      const person = data.people.members.some(m => m.name === n.who) ? n.who : undefined
      const id = noticeId(n.text)
      out.push({
        id, text: n.text, who: n.who, person, at: sampleAt(`the notification "${n.text}"`, n.at), unread: n.unread && !st.readNotices[id], link,
        icon: n.icon ?? (person ? 'check_circle' : link.to === 'tool' ? 'support_agent' : link.to === 'chat' ? 'summarize' : 'notifications'),
        ...(n.waiting ? { waiting: true } : {}),
      })
    }
    return out
  }

  // ----- library -----

  private filesFor: [AgentState['libraryDeleted'], boolean, Server['revs']] | null = null
  private files: LibraryFile[] = []
  /** Rebuilt only when the deleted set or the scenario's data changes, so React sees the same array until then. */
  listFiles = () => {
    const none = isNoData(this.demo.scenario)
    if (!this.filesFor || this.filesFor[0] !== this.state.libraryDeleted || this.filesFor[1] !== none || this.filesFor[2] !== this.server.revs) {
      this.filesFor = [this.state.libraryDeleted, none, this.server.revs]
      const deleted = this.state.libraryDeleted
      this.files = none ? [] : library.files.filter(f => !deleted[f.id]).map(f => ({ ...f, rev: this.rev(`file:${f.id}`, f.rev) }))
    }
    return this.files
  }
  /** The first stale record among `ids`, as a rejection, or null. */
  private staleAmong(prefix: string, ids: string[]) {
    for (const id of ids) { const s = this.conflict(`${prefix}:${id}`, 1, () => ({ id, rev: this.rev(`${prefix}:${id}`, 1) })); if (s) return s }
    return null
  }
  deleteFiles(ids: string[]) {
    const stale = this.staleAmong('file', ids)
    if (stale) return stale
    const libraryDeleted = { ...this.state.libraryDeleted }
    for (const id of ids) libraryDeleted[id] = true
    return this.writeRecs([...new Set(ids)].map(id => [`file:${id}`, 1] as [string, number]), { libraryDeleted })
  }
  restoreFiles(ids: string[]) {
    const stale = this.staleAmong('file', ids)
    if (stale) return stale
    const libraryDeleted = { ...this.state.libraryDeleted }
    for (const id of ids) delete libraryDeleted[id]
    return this.writeRecs([...new Set(ids)].map(id => [`file:${id}`, 1] as [string, number]), { libraryDeleted })
  }

  uploadFiles = (_files: File[]): Promise<LibraryFile[]> => this.rejected('unavailable', "Uploads aren't connected in this demo.", true)
  fileDownloadUrl = (_id: string): string | null => null

  setAside(id: string, reason: SetAsideReason | null) {
    problemById(id)
    const setAside = { ...this.state.setAside }
    if (reason) setAside[id] = { reason, ...this.stamp(), loggedAt: instantOf(Date.now()) }; else delete setAside[id]
    return this.write({ setAside })
  }

  runRoutine(id: string): Promise<RoutineRun> {
    if (!DATA.routines.some(r => r.id === id) && !this.state.routinesExtra.some(r => r.id === id)) throw new Error(`Unknown routine id: ${id}`)
    const { at } = this.stamp()
    // The morning check replays its recorded steps; other routines have none recorded.
    // The demo's result is the routine's own last run's ("found 6 things"); none if it has no last run (day one has none).
    const note = DATA_FOR[this.demo.scenario].routines.find(r => r.id === id)?.last?.result
    const run: RoutineRun = { routine: id, at, ...(note ? { result: note } : {}), ...(id === routineIdOf('Morning check') ? { trace: 'morning' } : {}) }
    return this.writeThen({ routineRuns: [run, ...this.state.routineRuns] }, run)
  }
  /**
   * Route 86's answer from the sample data: this session's Run nows (each finished: the demo has no run to follow), then the
   * routine's sample runs where this scenario has them (not on day one) and the stage runs it.
   */
  routineRunHistory(id: string): Promise<RoutineRunHistory> {
    const r = DATA_FOR[this.demo.scenario].routines.find(x => x.id === id) ?? this.state.routinesExtra.find(x => x.id === id)
    if (!r || this.state.routinesDeleted[id]) return this.rejected(NOT_FOUND, "This routine isn't here any more.", false)
    const now = this.state.routineRuns.filter(x => x.routine === id).map((x): RoutineHistoryRun => ({
      at: x.at, outcome: 'done', result: x.result ?? 'It finished', manual: true, ...(x.trace ? { trace: x.trace } : {}),
    }))
    const need = 'need' in r ? r.need : 1
    const sample = 'last' in r && r.last && DEMO_VIEW >= need ? sampleRuns[r.name] ?? [] : []
    const runs = [...now, ...sample].sort((a, b) => b.at.ms - a.at.ms).slice(0, ROUTINE_RUNS_MAX)
    return Promise.resolve({ runs })
  }
  deleteRoutine(id: string) {
    const stale = this.staleAmong('routine', [id])
    if (stale) return stale
    return this.writeRecs([[`routine:${id}`, 1]], this.routineNext([id], { routinesDeleted: { ...this.state.routinesDeleted, [id]: true } }))
  }
  restoreRoutine(id: string) {
    const stale = this.staleAmong('routine', [id])
    if (stale) return stale
    const routinesDeleted = { ...this.state.routinesDeleted }
    delete routinesDeleted[id]
    return this.writeRecs([[`routine:${id}`, 1]], this.routineNext([id], { routinesDeleted }))
  }

  // ----- who is signed in, the team, support access, paging and retry (P2) -----

  /** The last Admin guard: true when `id` is an active Admin and nobody else is. */
  private isLastAdmin(id: string) {
    const all = this.members().filter(m => m.status === 'active' && m.role === 'admin')
    return all.length === 1 && all[0].id === id
  }
  private memberToWrite(id: string): MemberRecord | Promise<never> {
    const m = this.members().find(x => x.id === id && x.status !== 'removed')
    return m ?? this.rejected(NOT_FOUND, 'No such member.', true)
  }

  inviteMember(input: InviteInput): Promise<void> {
    const parsed = readInvite(input)
    if (!parsed) return this.rejected('invalid', 'Check the name and the email.', true)
    const { name, email, title, role } = parsed
    const norm = email.trim().toLowerCase()
    const same = this.members().filter(m => m.email?.toLowerCase() === norm)
    if (same.some(m => m.status !== 'removed')) return this.rejected('conflict', 'That email is already on the team.', true, { reason: REASON.alreadyMember })
    const back = same[0]
    if (back) {
      // A removed person invited again comes back as an invited member with the new name, title and role.
      const removed = { ...this.server.removed }; delete removed[back.id]
      const rec = `member:${back.id}`
      const invited = this.server.invited.some(m => m.id === back.id)
        ? this.server.invited.map(m => (m.id === back.id ? { ...m, name, title: title ?? null, role, status: 'invited' as const } : m))
        : [...this.server.invited, { ...back, name, title: title ?? null, role, status: 'invited' as const, photo: null }]
      return this.writeRecs([[rec, back.rev]], {}, { removed, invited: invited.filter((m, i, all) => all.findIndex(x => x.id === m.id) === i), roles: { ...this.server.roles, [back.id]: role }, photos: Object.fromEntries(Object.entries(this.server.photos).filter(([k]) => k !== back.id)), revs: { ...this.server.revs, [rec]: back.rev } })
    }
    const id = `m_invited_${this.server.invited.length + 1}`
    const record: MemberRecord = { id, name, email: norm, title: title ?? null, role, status: 'invited', photo: null, rev: 1 }
    return this.write({}, { ...this.server, invited: [...this.server.invited, record] })
  }

  setMemberRole(id: string, role: MemberRole): Promise<void> {
    if (!isRole(role)) return this.rejected('invalid', 'A member is an Admin or a Member.', true)
    const m = this.memberToWrite(id)
    if (m instanceof Promise) return m
    const rec = `member:${id}`
    const stale = this.conflict(rec, m.rev, () => ({ ...m }))
    if (stale) return stale
    if (role === 'member' && this.isLastAdmin(id)) return this.rejected('conflict', "There has to be at least one Admin.", true, { reason: REASON.lastAdmin })
    return this.writeRecs([[rec, 1]], {}, { roles: { ...this.server.roles, [id]: role } })
  }

  removeMember(id: string): Promise<void> {
    const m = this.memberToWrite(id)
    if (m instanceof Promise) return m
    const rec = `member:${id}`
    const stale = this.conflict(rec, m.rev, () => ({ ...m }))
    if (stale) return stale
    if (this.isLastAdmin(id)) return this.rejected('conflict', "There has to be at least one Admin.", true, { reason: REASON.lastAdmin })
    return this.writeRecs([[rec, 1]], {}, { removed: { ...this.server.removed, [id]: true } })
  }

  grantSupport(hours: number): Promise<void> {
    if (!(GRANT_HOURS as readonly number[]).includes(hours)) return this.rejected('invalid', 'Choose 1, 4, 24 or 72 hours.', true)
    if (this.grantNow()?.live) return this.rejected('conflict', 'Inhouse team access is already on.', true, { reason: REASON.grantLive })
    const now = demoNow(this.startedAt).getTime()
    const seq = this.server.grantSeq + 1
    const grant: StoredGrant = { id: `g_demo-${seq}`, createdBy: ME_ID, createdAt: instantOf(now), endsAt: instantOf(now + hours * 3_600_000), endedAt: null, endedBy: null }
    return this.write({}, { ...this.server, grant, grantSeq: seq })
  }

  endSupportGrant(id: string): Promise<void> {
    const g = this.grantNow()
    if (!g || g.id !== id || !g.live) return this.rejected(NOT_FOUND, 'There is no live grant to end.', true)
    const rec = `grant:${id}`
    const stale = this.conflict(rec, 1, () => ({ ...g }))
    if (stale) return stale
    return this.writeRecs([[rec, 1]], {}, { grant: { ...this.server.grant!, endedAt: instantOf(demoNow(this.startedAt).getTime()), endedBy: ME_ID } })
  }

  /** The demo pages nothing: every list comes whole. */
  loadMore(_list: 'audit' | 'members'): Promise<void> { return Promise.resolve() }

  retry(resource: ResourceKey): Promise<void> {
    if (this.failed[resource]) this.failRead(resource, null)
    return Promise.resolve()
  }

  auditExportUrl = (): string | null => null
  /** The demo has no server export: Data and access builds a small invented file instead (settings/content.ts). */
  dataExportUrl = (): string | null => null
  checkDataExport = (): Promise<void> => Promise.resolve()
  refreshMemory = (): Promise<void> => Promise.resolve()
  refresh = (): Promise<void> => Promise.resolve()
  uploadsFiles = (): boolean => false
  uploadFile = (): Promise<{ fileId: string; name: string }> => this.rejected('unknown', 'Files are not kept in the demo.', false)
  /** The demo has no stored files: every id answers a small sample, named by the chip that asked. */
  downloadFile = (): Promise<{ blob: Blob; name: string | null }> => Promise.resolve({ blob: new Blob(['A sample file from the demo.\n'], { type: 'text/plain' }), name: null })
  signOutUrl = (): string | null => null

  // ---------- P5 (p5-w4): the Slack channels listed for notices ----------
  // The demo's list lives in ./mock-notify, loaded on first use, so none of it weighs on Today's first load.
  listNotifyChannels = (): Promise<NotifyChannelList> => import('./mock-notify').then(m => m.demoNotify.list())
  availableNotifyChannels = (): Promise<AvailableChannels> => import('./mock-notify').then(m => m.demoNotify.available())
  saveNotifyChannels = (input: PutNotifyChannels): Promise<NotifyChannelList> => import('./mock-notify').then(m => m.demoNotify.save(input))
  disconnect = (): void => undefined

  // ----- skills -----

  /** P6a brand skills: one of the brand's own (made in a chat this session, or the sample's) is deleted; ours never are. */
  deleteSkill(name: string): Promise<void> {
    const extra = this.state.skillsExtra.find(s => s.n === name)
    if (extra) return this.write({ skillsExtra: this.state.skillsExtra.filter(s => s.n !== name) })
    const sample = this.read().skills.find(s => s.n === name)
    // Already gone (another tab deleted it): a conflict with what this page showed.
    if (!sample) return this.rejected('conflict', 'That skill is already gone.', true)
    if (!sample.mine) return this.rejected('forbidden', "Only your team's own skills can be deleted.", true)
    return this.write({}, { ...this.server, skillsDeleted: { ...this.server.skillsDeleted, [name]: true } })
  }

  /** A chat changed one of the brand's own skills (mock-script's "Change the ... skill"): dated now. */
  private changeSkill(name: string): void {
    const at = instantOf(demoNow(this.startedAt).getTime())
    const extra = this.state.skillsExtra.find(s => s.n === name)
    if (extra) {
      this.commit({ skillsExtra: this.state.skillsExtra.map(s => (s.n === name ? { ...s, updatedAt: at, used: 'Changed today' } : s)) })
      return
    }
    this.commit({}, false, { ...this.server, skillsChanged: { ...this.server.skillsChanged, [name]: at } })
  }

  /** Loads every sample skill's instructions at once (their own chunk), the first time any skill's page asks. */
  loadSkill(_name: string): Promise<void> {
    if (this.skillBodies) return Promise.resolve()
    this.skillBodiesLoad ??= loadSkillBodies().then(
      bodies => { this.skillBodies = bodies; this.listeners.forEach(l => l()) },
      (err: unknown) => { this.skillBodiesLoad = null; throw err },
    )
    return this.skillBodiesLoad
  }

  // ----- traces -----

  getTrace(id: string): Promise<Trace | null> { return Promise.resolve(this.traceOf(id)) }
  private traceOf(id: string): Trace | null {
    const problem = id.startsWith(DRAFT_TRACE) ? problems.find(p => p.id === id.slice(DRAFT_TRACE.length)) : undefined
    const key = problem ? 'draft' : this.runInfo.get(id)?.trace ?? id
    const found = Object.hasOwn(traces, key) ? traces[key] : undefined
    if (!found) return null
    const base = problem ? { ...found, title: `Drafted a fix for ${problem.title}` } : found
    let steps = base.steps
    if (key === 'morning' && this.demo.scenario === 'Tool disconnected') {
      const v = traceDisconnectedVariant
      steps = steps.map(s => s.label.startsWith(v.replaceStepStartingWith)
        ? { ...s, kind: 'fail' as const, label: v.with.label, endMs: v.with.endMs, detail: v.with.detail }
        : s)
    }
    return { ...base, id, steps }
  }

  /** Remembers what a run replayed and made, keeping the newest RUNS_KEPT. */
  saveRunInfo(runId: string, info: RunInfo) {
    this.runInfo.delete(runId)
    this.runInfo.set(runId, { ...info })
    while (this.runInfo.size > RUNS_KEPT) this.runInfo.delete(this.runInfo.keys().next().value!)
    try { localStorage.setItem(RUNS_KEY, JSON.stringify([...this.runInfo])) }
    catch (e) { console.warn("Inhouse demo: could not save the run's steps; they won't open after a reload.", e) }
  }

  // ----- chat -----

  /** A routine part's card, saved as it appears. With `replaces`, the routine that run made is updated in place (same id). */
  saveRoutine(part: Extract<MessagePart, { type: 'routine' }>, replaces: string | undefined, info: RunInfo): MessagePart {
    const was = replaces ? this.runInfo.get(replaces) : undefined
    const old = was?.routine ?? was?.kept
    const reuse = old !== undefined && this.state.routinesExtra.some(x => x.id === old) ? old : null
    const id = reuse ?? nextChatRoutineId(this.state.routinesExtra)
    const routine = { ...part.routine, id, rev: reuse ? this.rev(`routine:${id}`, 1) + 1 : 1 }
    const routinesDeleted = { ...this.state.routinesDeleted }; delete routinesDeleted[routine.id]
    this.commit({
      routinesExtra: reuse ? this.state.routinesExtra.map(x => (x.id === reuse ? routine : x)) : [...this.state.routinesExtra, routine],
      routinesDeleted,
    }, false, reuse ? this.bumped([[`routine:${id}`, 1]]) : undefined)
    if (reuse) this.seen[`routine:${id}`] = routine.rev
    info.routine = routine.id
    return { ...part, routine }
  }

  /**
   * The replacing answer made no routine in place of the one the replaced run made: that routine is deleted the way a
   * person deletes one (`routinesDeleted`), so Regenerate's Undo can restore it. A skill is never taken back.
   */
  takeBack(replaced: string, info: RunInfo) {
    const old = this.runInfo.get(replaced)
    if (!old?.routine || info.routine) return
    const rec = `routine:${old.routine}`
    this.commit(this.routineNext([old.routine], { routinesDeleted: { ...this.state.routinesDeleted, [old.routine]: true } }), false, this.bumped([[rec, 1]]))
    this.seen[rec] = this.rev(rec, 1)
  }

  private knownChat(id: string) { return this.created.has(id) || chats.some(c => c.id === id) }

  // ----- chats (the server's side of C4, in memory and in the saved state) -----

  /** A chat's id and when it began, for the sample chats the scenario shows and the ones the app made. */
  chatUniverse(): { id: string; title: string; at: Instant }[] {
    const seed = this.read().chat.chats.map(c => ({ id: c.id, title: c.title, at: c.at }))
    const made = [...this.created].flatMap(id => { const i = this.createdInfo.get(id); return i ? [{ id, ...i }] : [] })
    return [...made, ...seed]
  }
  private chatBase(id: string): { id: string; title: string; at: Instant } | undefined {
    const c = chats.find(x => x.id === id)
    if (c) return { id, title: c.title, at: c.at }
    const i = this.createdInfo.get(id)
    return this.created.has(id) && i ? { id, ...i } : undefined
  }
  private chatRecord(id: string): Record<string, unknown> | null {
    const base = this.chatBase(id)
    return base ? { ...this.summary(base) } : null
  }
  /** The last time anything happened in the chat: its start, or its newest stored message. */
  private lastAt(id: string, began: Instant): Instant {
    const h = this.history.get(id)
    return h?.length ? h[h.length - 1].at : began
  }
  private summary(c: { id: string; title: string; at: Instant }): ChatSummary {
    const custom = this.state.chatTitles[c.id] ?? null
    return {
      id: c.id, title: custom ?? c.title, customTitle: custom, pinned: !!this.state.chatPinned[c.id], deleted: !!this.state.chatDeleted[c.id],
      at: this.lastAt(c.id, c.at), rev: this.rev(`chat:${c.id}`, 1),
      running: [...this.mockRuns.values()].some(r => r.live && r.chatId === c.id),
    }
  }
  /** A paging cursor: opaque to the caller, base64url (no padding) of the last key. */
  cursorOf = (key: string) => btoa(key).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  keyOf(cursor: string): string | null {
    try { return atob(cursor.replace(/-/g, '+').replace(/_/g, '/')) } catch { return null }
  }

  createChat(chat: CreateChatInput): Promise<void> {
    const id = chat.id
    if (!id.trim()) return this.rejected(INVALID, "Couldn't start the chat.", true)
    // Saying it twice is fine: the chat is the same one (idempotent for its owner).
    if (this.created.has(id)) return Promise.resolve()
    if (chats.some(c => c.id === id)) return Promise.resolve()
    this.created.add(id)
    this.createdInfo.set(id, { title: chat.title.slice(0, 200) || 'New chat', at: instantOf(demoNow(this.startedAt).getTime()) })
    // A write changes the snapshot's identity (the contract), so a React reader of `getSnapshot` sees the new chat. Saved
    // like any write: a refused save takes the chat back, and `commit` already told the person.
    const before = this.state
    this.state = { ...this.state }
    // Saved without `commit`, which tells the listeners in this call: the store makes the chats it restored at load while
    // it is still being created.
    try { localStorage.setItem(STORAGE_KEY, this.saved()) }
    catch (e) {
      console.warn('Inhouse demo: could not save state.', e)
      this.state = before
      this.created.delete(id); this.createdInfo.delete(id)
      this.notify({ type: 'save.failed', text: SAVE_FAILED })
      queueMicrotask(() => this.listeners.forEach(l => l()))
      return this.rejected('unknown', SAVE_FAILED, false)
    }
    // `allChatIds` changed, so `subscribe` listeners are told. On the next microtask, not in this call: the store makes the
    // chats it restored at load while it is still being created, and a listener must not run into it half made.
    queueMicrotask(() => this.listeners.forEach(l => l()))
    return Promise.resolve()
  }

  // ----- the chat engine: C4's reads and C5's runs (mock-chat.ts) -----

  private loadEngine = async (): Promise<ChatEngine> => {
    if (!this.engine) {
      const { ChatEngine: Engine } = await import('./mock-chat')
      this.engine ??= new Engine(this as unknown as Host)
    }
    return this.engine
  }
  /** Waits for the engine. The app asks at start, so a first send isn't waiting on its chunk; the tests wait for it too. */
  preload(): Promise<void> { return this.loadEngine().then(() => undefined) }
  async listChats(opts: { cursor?: string; limit?: number; deleted?: boolean } = {}): Promise<ChatList> { return (await this.loadEngine()).listChats(opts) }
  async getChat(id: string, cursor?: string): Promise<ChatPage> { return (await this.loadEngine()).getChat(id, cursor) }
  async resetSession(chatId: string): Promise<void> { return (await this.loadEngine()).resetSession(chatId) }
  async send(chatId: string, input: ChatSendInput): Promise<SendTurnResult> {
    const engine = await this.loadEngine()
    // Test hook (`delaySends`): the answer takes this long to get back, as over a network; the server has the message only then.
    if (this.sendDelayMs > 0) await new Promise<void>(resolve => setTimeout(resolve, this.sendDelayMs))
    return engine.send(chatId, input)
  }
  /** Test hook: every send takes `ms` of demo time before the agent has it (default 0, as before). */
  delaySends(ms: number) { this.sendDelayMs = ms }
  // Before the first send nothing runs: a turn can't be found, there are no active runs and nothing to attach to.
  interrupt(turnId: string): Promise<void> { return this.engine ? this.engine.interrupt(turnId) : this.rejected(NOT_FOUND, 'That answer is not here.', true) }
  stop(turnId: string): Promise<void> { return this.engine ? this.engine.stop(turnId) : this.rejected(NOT_FOUND, 'That answer is not here.', true) }
  activeRuns(): Promise<ActiveRun[]> { return this.engine ? this.engine.activeRuns() : Promise.resolve([]) }
  attach(runId: string, onFrame: (f: RunFrame) => void, fromSeq = 0, onRefused?: (code: AgentErrorCode) => void): () => void {
    if (this.engine) return this.engine.attach(runId, onFrame, fromSeq, onRefused)
    onRefused?.(NOT_FOUND)
    return () => undefined
  }

  /** The next turn of the run this test hook names starts as it says (a spending cap, a busy budget, a damaged session). */
  scriptNextTurn(kind: ScriptedTurn | null) { this.scripted = kind }
  /** Test hook: the connection state the app shows (the mock has no socket). */
  setLink(state: LinkState) { this.linkState = state; this.linkListeners.forEach(l => l(state)) }

  link = (): LinkState => this.linkState
  onLink = (l: (s: LinkState) => void) => { this.linkListeners.add(l); return () => { this.linkListeners.delete(l) } }

  // ----- managing chats -----

  /** The ids of a delete or restore: 1 to 50, every one the person's own (else nothing changes). */
  private idsRefusal(ids: string[]): Promise<never> | null {
    if (ids.length < 1 || ids.length > 50) return this.rejected(INVALID, 'Pick 1 to 50 chats.', true, ids.length > 50 ? { reason: REASON.tooMany } : undefined)
    if (ids.some(id => !this.knownChat(id))) return this.rejected(NOT_FOUND, "One of those chats isn't available.", true)
    return null
  }
  private chatConflict(id: string) { return this.conflict(`chat:${id}`, 1, () => this.chatRecord(id) ?? { id }) }

  renameChat(id: string, title: string | null) {
    if (!this.knownChat(id)) return this.rejected(NOT_FOUND, "That chat isn't available. It may have been deleted.", true)
    const stale = this.chatConflict(id)
    if (stale) return stale
    const chatTitles = { ...this.state.chatTitles }
    const t = title?.trim().replace(/\s+/g, ' ').slice(0, CHAT_TITLE_MAX).trimEnd()
    if (t) chatTitles[id] = t; else delete chatTitles[id]
    return this.writeRecs([[`chat:${id}`, 1]], { chatTitles })
  }
  pinChat(id: string, pinned: boolean) {
    if (!this.knownChat(id)) return this.rejected(NOT_FOUND, "That chat isn't available. It may have been deleted.", true)
    const stale = this.chatConflict(id)
    if (stale) return stale
    const chatPinned = { ...this.state.chatPinned }
    if (pinned) chatPinned[id] = true; else delete chatPinned[id]
    return this.writeRecs([[`chat:${id}`, 1]], { chatPinned })
  }
  deleteChats(ids: string[]) {
    const bad = this.idsRefusal(ids)
    if (bad) return bad
    const chatDeleted = { ...this.state.chatDeleted }
    for (const id of ids) chatDeleted[id] = true
    const done = this.writeRecs(ids.map(id => [`chat:${id}`, 1] as [string, number]), { chatDeleted })
    // Their queued turns are cancelled and their live one stopped, once the delete is saved.
    if (this.state.chatDeleted === chatDeleted) this.engine?.fence(run => ids.includes(run.chatId), 'deleted')
    return done
  }
  restoreChats(ids: string[]) {
    const bad = this.idsRefusal(ids)
    if (bad) return bad
    const chatDeleted = { ...this.state.chatDeleted }
    for (const id of ids) delete chatDeleted[id]
    return this.writeRecs(ids.map(id => [`chat:${id}`, 1] as [string, number]), { chatDeleted })
  }
}
