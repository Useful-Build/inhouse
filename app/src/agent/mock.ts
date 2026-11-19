// Deterministic mock agent. Reads only from sample-data, uses no randomness and
// makes no model calls: same input, same output, same timings. Phase 2 swaps this
// module for a real agent client behind the same AgentClient interface.
import {
  activityFixed, auditLog, chatList, chatScript, helpGuides, defaultModel, library, memory, meta as sampleMeta, models, notifications, people, problemById,
  problems, routines, scenarios, seedRoutine, seedTable, skillSuggestions, skillSuggestionsTitle, skills, traceDisconnectedVariant,
  traces, tools as sampleTools, usage, usageAtCap, usageHistory,
} from './data'
import { sampleAt } from './data'
import type { ProblemSeed, TraceKey } from './data'
import type {
  AgentClient, AgentData, AgentErrorCode, AgentNotice, AgentNotification, AgentState, ApproveResult, AskOptions, Attachment, ChatThread, ClockTime, DemoContext,
  Instant, LibraryFile, MessagePart, NoticePage, RoutineCard, RoutineDef, RoutineRun, RunEvent, Scenario, SeedTurn, SendPriority, SetAsideReason, SetAsideRecord,
  SkillCard, SkillDef, Stage, StampRecord, TablePart, TeamRequest, Trace, UsageData,
} from './types'
import { AgentError, CHAT_TITLE_MAX, photoKey, stageIndex } from './types'
import { DEMO_START, demoDayAt, demoNow, shownClock, shownDateTimeIn, shownTimeOn } from './clock'
import { instantOf } from '../lib/format'
import { listNames, pendingIds, visibleProblems } from '../state/derive'

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
const meta = override.brandName ? { ...sampleMeta, brand: { ...sampleMeta.brand, name: override.brandName } } : sampleMeta
const tools = override.channels === false ? { ...sampleTools, channels: [] } : sampleTools

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
  demoStartedAt: Date.now(),
})

// ---------- the read-only snapshot ----------

const cap1 = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)
/** A sample routine's id, from its name: "Morning check" is "routine-morning-check". */
const routineIdOf = (name: string) => 'routine-' + name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')

type RawTurn = { user?: string; stage?: string; agent?: Record<string, unknown>[]; trace?: string; model?: string }
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
    case 'notInThisStage': return { type: 'notInThisStage', text: a.text as string }
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
    : { role: 'agent', stage: turn.stage as Stage | undefined, trace: traceKey(needTrace(turn, 'the seed thread')), model: needModel(turn, 'the seed thread'), parts: (turn.agent ?? []).map(seedPart) })

/** The other chats: plain text, work rows and tables, with the table's own data. */
const chatPart = (a: Record<string, unknown>): MessagePart => {
  switch (a.type) {
    case 'text': return { type: 'text', text: a.text as string }
    case 'workRow': return { type: 'workRow', text: a.text as string, at: sampleAt('a work row', a.at) }
    case 'table': return { type: 'table', table: a.table as TablePart }
    default: throw new Error(`Unknown chat part type: ${String(a.type)}`)
  }
}
const STAGES_OK = ['Watch', 'Act', 'Run']
/** The chats, newest first by `at`; an agent turn with a `stage` shows only in that stage. Bad data stops the app. */
function loadChats(): ChatThread[] {
  const out = chatList.chats.map((c): ChatThread => ({
    id: c.id, title: c.title, at: sampleAt(`the chat "${c.id}"`, c.at),
    turns: c.turns === 'seedThread' ? seedThread : (c.turns as RawTurn[]).map((turn): SeedTurn => {
      if (turn.user) return { role: 'user', text: turn.user }
      if (turn.stage !== undefined && !STAGES_OK.includes(turn.stage)) throw new Error(`Sample data: chat "${c.id}" has a turn for an unknown stage "${turn.stage}".`)
      return { role: 'agent', stage: turn.stage as Stage | undefined, trace: traceKey(needTrace(turn, `chat "${c.id}"`)), model: needModel(turn, `chat "${c.id}"`), parts: (turn.agent ?? []).map(chatPart) }
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
  const { name, freq, day, time, next, need } = seedRoutine
  if (![0, 1, 2].includes(need)) throw new Error(`Sample data: the routine "${name}" has an unknown stage "${String(need)}".`)
  const fromChat: Omit<RoutineDef, 'id'> = { name, freq, day, time, next, need: need as RoutineDef['need'], what: `Created in a chat: "${asked.user}"`, inChat: true }
  const out = [...routines, fromChat].map(r => ({ ...r, id: routineIdOf(r.name) }))
  const ids = new Set(out.map(r => r.id))
  if (ids.size !== out.length) throw new Error('Sample data: two routines have the same id.')
  return out
}

const DRAFT_TIMES = draftTimes()
/** A problem's draft trace id: the recorded `draft` steps, titled for that problem (see `getTrace`). */
const DRAFT_TRACE = 'draft:'
/** Built once, so `read()` returns the same object every time. The data for the Normal, Tool disconnected and Cap reached scenarios. */
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
  people,
  memory,
  auditLog: auditLog as AgentData['auditLog'],
  activity: activityFixed,
  notifications: { teamRequests: notifications.teamRequests },
  scenarios: {
    firstDay: { setup: scenarios['First day'].today.setup as [string, string][] },
    loading: { readDone: scenarios.Loading.today.readDone },
    toolDisconnected: { tool: scenarios['Tool disconnected'].tool, at: sampleAt('the Tool disconnected scenario', scenarios['Tool disconnected'].at) },
  },
  models,
  defaultModel,
  library: { places: library.places },
  help: helpGuides,
  chat: { chats, recentCount: chatList.recent, suggestions: chatScript.suggestions },
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
/**
 * Day one, before the agent has read anything: no tools or channels connected yet (the six are being connected, per
 * scenarios.json), nothing found, asked or run, no Library files and no notifications (see `listFiles` and
 * `listNotifications`). The routines and skills are the ones the Inhouse team sets up (none made in a chat), not run or
 * used yet. Every screen reads these from here, so none shows another day's data.
 */
const FIRST_DAY: AgentData = {
  ...DATA,
  ...NOTHING_YET,
  tools: { ...DATA.tools, connected: [], channels: [], beingConnected: [...tools.connected, ...tools.beingConnected.filter(k => !tools.connected.includes(k))] },
  routines: DATA.routines.filter(r => !r.inChat).map(({ last: _last, ...r }) => r),
  skills: skills.filter(s => !s.mine).map(s => ({ ...s, used: 'Not used yet' })),
}
/**
 * Still loading: a real client starts here, with empty lists, until the agent's data arrives. The tools are known (the
 * morning check is reading them, scenarios.json `readDone` of them so far); everything they hold isn't yet.
 */
const LOADING: AgentData = { ...DATA, ...NOTHING_YET, status: 'loading', routines: [], skills: [], skillSuggestions: [] }
/** At the cap: this month's own usage with spend at the cap (usage.json `capReached`), so the chart, the cost per
 *  conversation and the breakdowns agree with it. Earlier months don't change. */
const CAP_REACHED: AgentData = { ...DATA, usage: usageAtCap, usageMonths: [usageAtCap, ...usageHistory] }
const DATA_FOR: Record<Scenario, AgentData> = { Normal: DATA, 'Tool disconnected': DATA, 'Cap reached': CAP_REACHED, 'First day': FIRST_DAY, Loading: LOADING }
if (!Object.hasOwn(tools.details, DATA.scenarios.toolDisconnected.tool)) throw new Error('Sample data: the Tool disconnected scenario names an unknown tool.')
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
type RawNotification = { text: string | Record<string, string>; who: string; at: string; unread: boolean; opens: string | Record<string, string> }

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
  return time && next ? { id: r.id as string, name: r.name as string, freq: r.freq as string, day: r.day as string, time, next, note: r.note as string, what: r.what as string } : null
}
/** A request to the Inhouse team, saved now or before C1 ("New tool · sent by Sam, just now", sent in that session: now). */
const savedRequest = (r: unknown, now: Instant): TeamRequest | null => {
  if (!hasStrs(r, ['icon', 'title', 'sub', 'status'])) return null
  const base = { icon: r.icon as string, title: r.title as string, status: r.status as string, ...(isInstant(r.statusAt) ? { statusAt: r.statusAt } : {}) }
  if (isInstant(r.at)) return { ...base, sub: r.sub as string, at: r.at }
  return { ...base, sub: (r.sub as string).replace(/, just now$/, ''), at: now }
}
/** A stamp (when and who), saved now or before C1. */
const savedStamp = (x: unknown): StampRecord | null => {
  if (!isRec(x) || !str(x.by) || !x.by.trim()) return null
  const at = savedAt(x)
  return at ? { at, by: x.by } : null
}
/** The entries of a saved record that `conv` keeps. */
const recConv = <T,>(v: unknown, conv: (x: unknown) => T | null): Record<string, T> =>
  isRec(v) ? Object.fromEntries(Object.entries(v).flatMap(([k, x]) => { const c = conv(x); return c === null ? [] : [[k, c]] })) : {}

const sanitize = (raw: unknown): AgentState => {
  const init = initialState()
  if (!isRec(raw)) return init
  const demoStartedAt = typeof raw.demoStartedAt === 'number' && Number.isFinite(raw.demoStartedAt) ? raw.demoStartedAt : init.demoStartedAt
  const approved: AgentState['approved'] = {}
  for (const [id, r] of Object.entries(isRec(raw.approved) ? raw.approved : {})) {
    if (!hasStrs(r, ['by', 'title', 'doneText']) || !(r.by as string).trim()) continue
    const at = savedAt(r), loggedAt = savedLoggedAt(r)
    if (!at || !loggedAt) continue
    approved[id] = { at, by: r.by as string, loggedAt, title: r.title as string, doneText: r.doneText as string, partial: r.partial === true }
  }
  const routinesExtra = (isArr(raw.routinesExtra) ? raw.routinesExtra : [])
    .map(savedRoutine).filter((r): r is RoutineCard => r !== null)
    // An id twice keeps the first.
    .filter((r, i, all) => all.findIndex(x => x.id === r.id) === i)
  // Routine entries and runs that name no routine are dropped.
  const known = (id: string) => DATA.routines.some(r => r.id === id) || routinesExtra.some(r => r.id === id)
  const now = instantOf(demoNow(demoStartedAt).getTime())
  return {
    approved,
    sent: flagsOf(raw.sent),
    undone: recConv(raw.undone, savedStamp),
    edits: recOf(raw.edits, str),
    paused: savedPause(raw.paused),
    toggles: recOf(raw.toggles, (x): x is boolean => typeof x === 'boolean'),
    routinesExtra,
    skillsExtra: (isArr(raw.skillsExtra) ? raw.skillsExtra : []).filter((r): r is SkillDef => hasStrs(r, ['n', 'd', 'icon', 'by', 'used']) && !!(r.by as string).trim() && [0, 1, 2].includes(r.need as number)),
    requestedTools: flagsOf(raw.requestedTools),
    requestedSkills: flagsOf(raw.requestedSkills),
    toolPaused: flagsOf(raw.toolPaused),
    forgot: flagsOf(raw.forgot),
    settings: recOf(raw.settings, str),
    teamRequests: (isArr(raw.teamRequests) ? raw.teamRequests : []).map(r => savedRequest(r, now)).filter((r): r is TeamRequest => r !== null),
    // The old notificationsRead / notificationRead flags are dropped: their notifications show unread once more.
    readNotices: flagsOf(raw.readNotices),
    libraryDeleted: flagsOf(raw.libraryDeleted),
    setAside: recConv(raw.setAside, (x): SetAsideRecord | null => {
      if (!isRec(x) || !SET_ASIDE.includes(x.reason as SetAsideReason)) return null
      const stamp = savedStamp(x), loggedAt = savedLoggedAt(x)
      return stamp && loggedAt ? { reason: x.reason as SetAsideReason, ...stamp, loggedAt } : null
    }),
    routinesDeleted: Object.fromEntries(Object.keys(flagsOf(raw.routinesDeleted)).filter(known).map(id => [id, true as const])),
    routineRuns: (isArr(raw.routineRuns) ? raw.routineRuns : []).flatMap((r): RoutineRun[] => {
      if (!hasStrs(r, ['routine']) || !known(r.routine as string) || !(r.trace === undefined || str(r.trace)) || !(r.result === undefined || str(r.result))) return []
      const at = savedAt(r)
      return at ? [{ routine: r.routine as string, at, ...(r.trace !== undefined ? { trace: r.trace as string } : {}), ...(r.result !== undefined ? { result: r.result as string } : {}) }] : []
    }),
    // managing chats. A started chat's title, pin and delete are kept until Reset demo: its id is unique per page load
    // (chatIds.ts), so it can't be taken by a newer chat, and the app keeps the chat itself across a reload.
    chatTitles: Object.fromEntries(Object.entries(recOf(raw.chatTitles, (x): x is string => str(x) && x.trim() !== '')).map(([k, t]) => [k, t.slice(0, CHAT_TITLE_MAX)])),
    chatPinned: flagsOf(raw.chatPinned),
    chatDeleted: flagsOf(raw.chatDeleted),
    demoStartedAt,
  }
}


// ---------- request parsing for scripted routine and skill replies ----------

const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']

/** A clock time read from a request: hours 0 to 23 and minutes. */
type Clock = { h: number; m: number }
/** Words that may follow a bare "at 7" when it is a time ("at 7 every day"), unlike "at 3 weeks of stock". A full stop
 * counts only when no digit follows ("at 9.30" is not 9 o'clock). */
const AFTER_BARE = "(?=\\s*(?:$|[,;:!?]|\\.(?!\\d)|(?:on|every|each|and|to|in|for|with|the|o['\u2019]clock|sharp|daily|weekly|tomorrow|tonight|morning|evening|night|afternoon)\\b))"
const DAY_WORD = '(?:mondays?|tuesdays?|wednesdays?|thursdays?|fridays?|saturdays?|sundays?|day|morning|evening|night|afternoon|week|weekdays?)'
const WEEKDAY = '(?:mon|tues|wednes|thurs|fri|satur|sun)days?'
const PART_OF_DAY = '(?:morning|afternoon|evening|night)'
/** "every Monday", "each weekday", "daily": the phrase that makes a request a schedule. */
const SCHEDULE_PHRASE = `(?:(?:every|each)\\s+${DAY_WORD}|daily|weekly)`
/** The days a schedule runs on: "every Monday", "each Tuesday and Thursday", "every week on Friday", "weekly on Friday".
 *  A weekday the task names ("send the Friday numbers") isn't one. */
const SCHEDULE_DAYS = new RegExp(`\\b(?:(?:every|each)\\s+(?:week,?\\s+on\\s+)?|weekly,?\\s+on\\s+)${WEEKDAY}(?:\\s*(?:,|and|&|or)\\s*(?:(?:every|each|on)\\s+)?${WEEKDAY})*`, 'gi')
/** The schedule phrase straight before its time, with a day or a part of the day between ("every week on Monday at 9",
 *  "every Monday morning at 6"). */
const SCHEDULE_LEAD = new RegExp(`\\b${SCHEDULE_PHRASE}(?:\\s+on\\s+${WEEKDAY})?(?:\\s+(?:in\\s+the\\s+)?${PART_OF_DAY})?,?\\s+(?=at\\s)`, 'i')
/** Counts that follow a number and make it not an hour: "at 3 weeks of stock", "at 2 SKUs", "at 10 minutes past 9". */
const NOT_AN_HOUR = '(?!\\s*(?:%|(?:weeks?|days?|hours?|minutes?|units?|orders?|items?|skus?|products?|pieces?|percent|times|of)\\b))'
/** The time straight after the schedule phrase. A bare "at N" is a time whatever word follows ("Every morning at 6
 *  summarize refunds"), unless a count does ("every Monday at 3 orders late") or it goes on as a number ("at 9.30"). */
const LEAD_FORMS: [RegExp, 'ampm' | 'clock' | 'bare'][] = [
  [/^at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)(?![a-z])/i, 'ampm'],
  [/^at\s+(\d{1,2}):(\d{2})\b/, 'clock'],
  [new RegExp(`^at\\s+(\\d{1,2})(?![\\d:]|\\.\\d)${NOT_AN_HOUR}`, 'i'), 'bare'],
]
const TIME_FORMS: [RegExp, 'ampm' | 'clock' | 'bare'][] = [
  [/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)(?![a-z])/i, 'ampm'],
  [/\b(\d{1,2}):(\d{2})\b/, 'clock'],
  [new RegExp(`\\bat\\s+(\\d{1,2})${AFTER_BARE}`, 'i'), 'bare'],
]
/** A part of the day right after the time ("at 7 in the evening", "at 9 tonight"). */
const PART_AFTER = /^\s*(?:in\s+the\s+)?(?:mornings?|afternoons?|evenings?|nights?|tonight)\b/i
/** A time a form matched, or null when it can't be one ("at 25", "7:75", "13pm"). `ctx` is the text whose part of the day counts. */
const clockOf = (m: RegExpExecArray, form: 'ampm' | 'clock' | 'bare', ctx: string): Clock | null => {
  let h = Number(m[1])
  const min = form === 'bare' ? 0 : Number(m[2] ?? 0)
  if (min > 59) return null
  if (form === 'ampm') {
    if (h < 1 || h > 12) return null
    const pm = m[3].toLowerCase() === 'pm'
    return { h: (h % 12) + (pm ? 12 : 0), m: min }
  }
  if (h > 23 || (form === 'bare' && (h < 1 || h > 12))) return null
  if (h <= 12) {
    if (/\bmornings?\b/i.test(ctx)) h %= 12
    else if (/\b(afternoons?|evenings?|nights?|tonight)\b/i.test(ctx)) h = h === 12 && /\b(evenings?|nights?|tonight)\b/i.test(ctx) ? 0 : (h % 12) + 12
    else if (h >= 1 && h <= 6) h += 12
  }
  return { h, m: min }
}
/**
 * The time a request names, or null when it names none or one that can't be ("at 25", "7:75", "13pm"): the agent then
 * asks for the time. The time straight after the schedule phrase wins over later times in the task ("every day at 7 list
 * what sold at 6"), and only its own part of the day counts. Morning means AM; afternoon, evening and night mean PM.
 * Otherwise a bare hour from 1 to 6 is PM ("at 4" is 4:00 PM) and from 7 to 11 AM. "16:00" is read as 24-hour.
 */
const timeIn = (q: string): Clock | null => {
  const lead = SCHEDULE_LEAD.exec(q)
  if (lead) {
    const rest = q.slice(lead.index + lead[0].length)
    for (const [re, form] of LEAD_FORMS) {
      const m = re.exec(rest)
      if (m) return clockOf(m, form, lead[0] + (PART_AFTER.exec(rest.slice(m[0].length))?.[0] ?? ''))
    }
  }
  for (const [re, form] of TIME_FORMS) {
    const m = re.exec(q)
    if (m) return clockOf(m, form, q)
  }
  if (/\bnoon\b/i.test(q)) return { h: 12, m: 0 }
  if (/\bmidnight\b/i.test(q)) return { h: 0, m: 0 }
  return null
}

/** The next run on the demo clock, after now. */
const nextRun = (freq: string, day: string, at: Clock, now: Date): Instant => {
  const d = new Date(now)
  d.setHours(at.h, at.m, 0, 0)
  const ok = (x: Date) => x > now && (freq === 'Weekly' ? WEEKDAYS[(x.getDay() + 6) % 7] === day : day !== 'Weekdays' || (x.getDay() > 0 && x.getDay() < 6))
  while (!ok(d)) d.setDate(d.getDate() + 1)
  return instantOf(d.getTime())
}

/** A name from a request's first words, with the person's own capitals (product and tool names stay as typed). */
const shortName = (clause: string, fallback: string) => {
  const words = clause.replace(/[.?!]+$/, '').split(/\s+/).filter(Boolean).slice(0, 4)
  return words.length ? cap1(words.join(' ')) : fallback
}

/** The schedule and time phrases in a request, wherever they are, so what's left names the routine. */
const NOT_THE_NAME = [
  /^\s*(?:(?:can|could|would|will)\s+you\s+)?(?:please\s+)?(?:remind\s+me\s+(?:to\s+)?)?/i,
  // "every Monday morning": the part of the day goes with the schedule.
  new RegExp(`\\b(?:on\\s+)?(?:(?:every|each)\\s+${DAY_WORD}|daily|weekly|weekdays?|(?:mon|tues|wednes|thurs|fri|satur|sun)days?)\\b(?:\\s+(?:in\\s+the\\s+)?${PART_OF_DAY}\\b)?`, 'gi'),
  /\b(?:at\s+)?\d{1,2}(?::\d{2})?\s*(?:am|pm)(?![a-z])(?:\s*(?:o['\u2019]clock|sharp)\b)?/gi,
  /\bat\s+\d{1,2}(?::\d{2})?\b(?:\s*(?:o['\u2019]clock|sharp)\b)?/gi,
  /\b(?:at\s+)?(?:noon|midnight)\b(?:\s*sharp\b)?/gi,
  /\bin the (?:morning|afternoon|evening)\b/gi,
  /\bplease\b/gi,
]
const nameOf = (q: string) => {
  // A name is a few words: past 500 characters is never needed, and keeps the trims below quick on a long paste.
  let rest = q.slice(0, 500)
  for (const re of NOT_THE_NAME) rest = rest.replace(re, ' ')
  rest = rest.replace(/\s+/g, ' ').replace(/^[\s,;:.-]+|[\s,;:.?!-]+$/g, '').replace(/^(?:and|to|then)\s+/i, '')
  return shortName(rest, 'New routine')
}

/** A routine from a request, or null when it doesn't say the day and time clearly enough: the agent asks for them. */
function routineFromRequest(q: string, stage: number, id: string, now: Date): RoutineCard | null {
  const script = chatScript.scripted.find(x => x.match.startsWith('every|'))! as unknown as { example: { ask: string; routine: { name: string; freq: string; day: string; time: string } }; ActRun: { type: string; note?: Record<string, string> }[] }
  const notes = script.ActRun.find(x => x.type === 'routine')?.note
  if (!notes) throw new Error('chat-script.json: the routine reply has no routine part with notes.')
  const note = stage === 2 ? notes.Run : notes.Act
  let name: string, freq: string, day: string, at: Clock | null
  if (q.trim().toLowerCase() === script.example.ask.toLowerCase()) {
    let time: string
    ;({ name, freq, day, time } = script.example.routine)
    const tm = /^(\d{1,2}):(\d\d)[ \u00a0](AM|PM)$/.exec(time)
    if (!tm) throw new Error(`chat-script.json: the routine time "${time}" isn't like "7:00 AM".`)
    at = { h: Number(tm[1]) % 12 + (tm[3] === 'PM' ? 12 : 0), m: Number(tm[2]) }
  } else {
    // Only the days the schedule names: "every Monday at 9 send the Friday numbers" runs on Monday.
    const named = [...q.matchAll(SCHEDULE_DAYS)].map(x => x[0]).join(' ')
    const weekdays = WEEKDAYS.filter(d => new RegExp(`\\b${d}s?\\b`, 'i').test(named))
    const weekday = weekdays[0]
    // "every Tuesday and Thursday": a routine runs on one day of the week, so the agent asks rather than pick one.
    if (weekdays.length > 1) return null
    if (/\bweekdays?\b/i.test(q)) { freq = 'Daily'; day = 'Weekdays' }
    else if (weekday) { freq = 'Weekly'; day = weekday }
    else if (/\b(daily|every day|each day|every (morning|evening|night|afternoon)|each (morning|evening|night|afternoon))\b/i.test(q)) { freq = 'Daily'; day = 'Every day' }
    // "Weekly" with no day: the agent asks rather than picking Monday.
    else return null
    at = timeIn(q)
    name = nameOf(q)
  }
  if (!at) return null
  return { id, name, freq, day, time: { hour: at.h, minute: at.m }, next: nextRun(freq, day, at, now), note, what: q }
}

// A routine is made only from a request (not a question) with a schedule and a time. "How much did we refund each customer
// last week?" is a plain question; "Remind me every Friday" gets asked for a time and makes nothing yet. A polite request
// ("Can you email me daily at 9am?") is a request, question mark or not.
const QUESTION_WORD = /^(how|what|which|why|when|where|who|whom|whose|is|are|was|were|do|does|did|can|could|should|would|will|has|have|had|any)\b/i
const POLITE = /^(?:(?:can|could|would|will)\s+you\b|please\b)/i
/** A polite opener that asks to be told something is a question, schedule words or not ("Can you explain how routines run every morning?"). */
const ASKS_TO_BE_TOLD = /^(?:(?:can|could|would|will)\s+you\s+)?(?:please\s+)?(?:explain|tell\s+me\s+why|show\s+me\s+how)\b/i
const SCHEDULE = new RegExp(`\\b(?:(?:every|each)\\s+${DAY_WORD}|daily|weekly)\\b`, 'i')
/** A request, not a question: no question mark and no question word first, unless it opens with "can you" or "please". */
const isRequest = (q: string) => !ASKS_TO_BE_TOLD.test(q.trim()) && (POLITE.test(q.trim()) || (!q.includes('?') && !QUESTION_WORD.test(q.trim())))
const isScheduleRequest = (q: string) => isRequest(q) && SCHEDULE.test(q)
const ASK_FOR_TIME = 'What time should it run? Tell me the day and the time, like "every Friday at 9\u00a0AM", and I\'ll set it up.'

function skillFromRequest(q: string, stage: number): SkillCard {
  const modes = (chatScript.scripted.find(x => x.match.endsWith('skill'))! as unknown as { reply: { type: string; mode?: Record<string, string> }[] }).reply.find(x => x.type === 'skill')?.mode
  if (!modes) throw new Error('chat-script.json: the skill reply has no skill part with modes.')
  // A skill's name and description are a few words: past 500 characters is never needed, and keeps the trim below quick on a long paste.
  const m = /\bskill\b\s*(?:that|to|which|for|who)?\s*(.*)$/i.exec(q.slice(0, 500))
  // "Can you build a skill?" names nothing after the word: the description is the request itself, never a lone ".".
  const rest = (m?.[1] ?? '').replace(/[\s.?!]+$/, '').trim()
  const desc = rest ? cap1(`${rest}.`) : q
  const toolNames = Object.values(tools.details).map(d => d.name).filter(n => new RegExp(`\\b${n}\\b`, 'i').test(q))
  return {
    name: shortName(rest, 'New skill'),
    desc,
    tools: toolNames.length ? toolNames.join(' · ') : 'Shopify',
    mode: ['Watch', 'Act', 'Run'].map(s => modes[s])[stage],
  }
}

// ---------- the mock ----------

type Script = { thinking: string[]; delayMs: number; parts: MessagePart[]; trace: TraceKey; after?: (info: RunInfo, replaces?: string) => void }

// ---------- a formatted answer (code block, wide table, list, quote, link) ----------

/** Asked for a query or formula, the agent answers in markdown: the one sample answer with a code block and a wide table. */
const QUERY_ASK = /\b(sql|query|formula)\b/i
const QUERY_ANSWER = [
  "Here's the query I ran on **Shopify** for last week (Nov 7 to 13), grouped by SKU:",
  '',
  '```sql',
  'SELECT sku, product, SUM(quantity) AS units, SUM(total_price) AS sales, COUNT(refund_id) AS refunds',
  'FROM orders',
  "WHERE created_at BETWEEN '2026-11-07' AND '2026-11-13'",
  'GROUP BY sku, product',
  'ORDER BY units DESC;',
  '```',
  '',
  '### Last week by SKU',
  '',
  '| SKU | Product | Units | Sales | Average order | Refunds | Channel | Best day |',
  '|---|---|---|---|---|---|---|---|',
  '| CB-750-OL | Cairn Insulated Bottle, Olive | 126 | $3,150 | $25.00 | 2 | Shopify | Thu, Nov 12 |',
  '| SF-M-BLK | Summit Fleece, Black, M | 94 | $7,990 | $85.00 | 3 | Shopify | Sat, Nov 7 |',
  '| TS-L-NAV | Trail Shell Jacket, Navy, L | 71 | $16,898 | $238.00 | 4 | Shopify | Sun, Nov 8 |',
  '',
  '- **Cairn Insulated Bottle** sold the most units.',
  '- Refunds were `14` in total, about the same as the week before.',
  '1. Copy the query to run it again.',
  '2. Open [Shopify](#/tools/shopify) to see the orders.',
  '',
  "> These are Shopify orders only. [Amazon orders](javascript:void(0)) aren't in this query.",
].join('\n')

/** What a run replayed and made: its recorded trace, and the routine or skill it created (Regenerate updates those in place).
 *  `kept` is a routine an earlier run made that this failed run left standing: the next answer updates it in place, so it
 *  isn't made twice, but never takes it back (this run didn't make it). A failed run carries the earlier `skill` as its own.
 *  One per turn: the first turn's id is the run's, a turn started by `send` is `${runId}-t${n}`. */
type RunInfo = { trace: TraceKey; routine?: string; kept?: string; skill?: string }
/** A message sent into a running answer, waiting for its turn. */
type Queued = { text: string; priority: SendPriority; attachments?: Attachment[] }
/** A run in progress: `stop` ends it, `turn` ends only the current turn (interrupt), `queue` is what was sent into it. */
type LiveRun = { stop: AbortController; turn: AbortController; queue: Queued[] }

const TRACE_KEYS = Object.keys(traces)
/** A trace named in the sample data ("routine (without the approval step)" names `routine`). An unknown one stops the app. */
function traceKey(t: string): TraceKey {
  const k = t.split(' ')[0]
  // Not TRACE_KEYS: the chats are loaded (and call this) before that constant is set.
  if (!Object.hasOwn(traces, k)) throw new Error(`Sample data: unknown trace "${t}".`)
  return k
}
/** A question as typed, for matching a seeded one: case, spaces and the closing punctuation don't count. */
const norm = (q: string) => q.trim().toLowerCase().replace(/\s+/g, ' ').replace(/[.?!]+$/, '')

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

export class MockAgent implements AgentClient {
  private state: AgentState
  private listeners = new Set<() => void>()
  private noticeListeners = new Set<(n: AgentNotice) => void>()
  private holdTimers: Record<string, ReturnType<typeof setTimeout>> = {}
  private runs = new Map<string, LiveRun>()
  /** Run id to what it replayed and made, saved (bounded) so a saved chat's run ids keep their steps after a reload. */
  private runInfo = loadRunInfo()
  private runSeq = 0
  /** Chats the app made with `createChat`. `ask` takes these and the sample chats, nothing else. */
  private created = new Set<string>()
  private demo: DemoContext = { stage: 'Act', scenario: 'Normal' }

  constructor() {
    const { state, started } = this.loadSaved()
    this.state = state
    // The demo clock counts from the first load: save that moment now, so a reload before any other write doesn't
    // start the clock again at 8:00 AM while the app already shows later times.
    if (!started) this.commit({})
    this.resumeHolds()
    // Another tab changed the saved state: take it, so two open tabs don't overwrite each other.
    if (typeof window !== 'undefined') {
      window.addEventListener('storage', e => { if (e.key === STORAGE_KEY || e.key === null) this.syncFromStorage() })
    }
  }

  // ----- state plumbing -----

  private load(): AgentState { return this.loadSaved().state }
  /** The saved state, and whether it carried its own `demoStartedAt` (false: the clock starts now and isn't saved yet). */
  private loadSaved(): { state: AgentState; started: boolean } {
    try {
      const raw: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null')
      return { state: sanitize(raw), started: isRec(raw) && typeof raw.demoStartedAt === 'number' && Number.isFinite(raw.demoStartedAt) }
    } catch (e) {
      console.warn('Inhouse demo: could not read saved state, starting fresh.', e)
      return { state: initialState(), started: false }
    }
  }

  /** Apply a change and save it. A failed save is reported to the UI; `revert` also drops the change from memory. False when the save failed. */
  private commit(next: Partial<AgentState>, revert = false): boolean {
    const before = this.state
    this.state = { ...this.state, ...next }
    let ok = true
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(this.state)) }
    catch (e) {
      console.warn('Inhouse demo: could not save state.', e)
      ok = false
      if (revert) this.state = before
      this.notify({ type: 'save.failed', text: SAVE_FAILED })
    }
    this.listeners.forEach(l => l())
    return ok
  }

  /** A failed write: an AgentError the caller can await. `tell` also sends it as a notice (a failed save already sent one). */
  private rejected(code: AgentErrorCode, text: string, tell: boolean): Promise<never> {
    if (tell) this.notify({ type: 'error', code, text })
    const p = Promise.reject(new AgentError(code, text))
    // The person was told by a notice and the console has the cause, so a caller that doesn't await must not also
    // raise an unhandled rejection. A caller that awaits still gets the rejection: this handler is on `p` only.
    p.catch(() => undefined)
    return p
  }

  /** A write: applied at once, taken back if it can't be saved. */
  private write(next: Partial<AgentState>): Promise<void> { return this.writeThen(next, undefined) }
  /** A write that resolves to `value`. A failed save rejects through `rejected()`, so a caller that doesn't await raises nothing. */
  private writeThen<T>(next: Partial<AgentState>, value: T): Promise<T> {
    return this.commit(next, true) ? Promise.resolve(value) : this.rejected('unknown', SAVE_FAILED, false)
  }

  /**
   * Another tab changed the saved state. Drop holds that are no longer pending, take over holds this tab
   * has no timer for (the tab that started one may have closed), and tell this tab when a hold went out.
   */
  private syncFromStorage() {
    const wasSent = this.state.sent
    this.state = this.load()
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
    return { at: instantOf(demoNow(this.state.demoStartedAt).getTime()), by: this.state.settings['g:name']?.trim() || meta.currentUser.name }
  }

  getSnapshot = () => this.state
  read = () => DATA_FOR[this.demo.scenario]
  allChatIds = () => [...chats.map(c => c.id), ...this.created]
  subscribe = (l: () => void) => { this.listeners.add(l); return () => { this.listeners.delete(l) } }
  onNotice = (l: (n: AgentNotice) => void) => { this.noticeListeners.add(l); return () => { this.noticeListeners.delete(l) } }
  setDemo(ctx: DemoContext) {
    const changed = ctx.stage !== this.demo.stage || ctx.scenario !== this.demo.scenario
    this.demo = ctx
    // What `read`, `listFiles` and `listNotifications` return follows the scenario and stage.
    if (changed) this.listeners.forEach(l => l())
  }

  reset() {
    Object.values(this.holdTimers).forEach(clearTimeout)
    this.holdTimers = {}
    this.runs.forEach(r => r.stop.abort())
    this.created.clear()
    this.runInfo.clear()
    try { localStorage.removeItem(RUNS_KEY) } catch (e) { console.warn('Inhouse demo: could not clear saved runs.', e) }
    try { localStorage.removeItem(DATA_OVERRIDE_KEY) } catch (e) { console.warn('Inhouse demo: could not clear the data override.', e) }
    this.commit(initialState())
  }

  // ----- approvals -----

  /** Run: Inhouse agent did part of this job and nobody undid it. Mirrors `ranByAgent && partial` in derive.ts. */
  private isPartial(p: ProblemSeed) {
    return stageIndex(this.demo.stage) === 2 && !!p.done && !!p.partial && !this.state.undone[p.id]
  }

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
    // Wording is fixed now, so history never rewrites itself when the stage or an undo changes later.
    const part = this.isPartial(p)
    const record = {
      ...this.stamp(), loggedAt: instantOf(Date.now()),
      title: part && p.draft.runTitle ? p.draft.runTitle : p.draft.title,
      doneText: (part && p.runDoneText) || p.doneText,
      partial: part,
    }
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

  pause(): Promise<Instant> { const { at } = this.stamp(); return this.writeThen({ paused: at }, at) }
  resume() { return this.write({ paused: null }) }

  // ----- plain reads and writes -----

  setToggle(key: string, on: boolean) { return this.write({ toggles: { ...this.state.toggles, [key]: on } }) }
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
  forgetMemory(key: string, forgotten: boolean) {
    const forgot = { ...this.state.forgot }
    if (forgotten) forgot[key] = true; else delete forgot[key]
    return this.write({ forgot })
  }
  setSetting(key: string, value: string | null) {
    const settings = { ...this.state.settings }
    if (value === null) delete settings[key]; else settings[key] = value
    return this.write({ settings })
  }
  setPhoto(personId: string, dataUrl: string | null) {
    return this.setSetting(photoKey(personId), dataUrl ?? '')
  }
  sendTeamRequest(req: TeamRequest) { return this.write({ teamRequests: [req, ...this.state.teamRequests] }) }
  markNoticesRead(ids: string[]) {
    const fresh = ids.filter(id => !this.state.readNotices[id])
    return fresh.length ? this.write({ readNotices: { ...this.state.readNotices, ...Object.fromEntries(fresh.map(id => [id, true as const])) } }) : Promise.resolve()
  }

  // ----- notifications -----

  private notesFor: [AgentState, Stage, Scenario] | null = null
  private notes: AgentNotification[] = []
  /** Rebuilt only when state, stage or scenario change, so React sees the same array until then. */
  listNotifications = (): AgentNotification[] => {
    const { stage, scenario } = this.demo
    const f = this.notesFor
    if (f && f[0] === this.state && f[1] === stage && f[2] === scenario) return this.notes
    this.notesFor = [this.state, stage, scenario]
    this.notes = this.buildNotifications(stage, scenario)
    return this.notes
  }

  private buildNotifications(stage: Stage, scenario: Scenario): AgentNotification[] {
    // On day one, and while loading, nothing has happened yet.
    if (isNoData(scenario)) return []
    const S = stageIndex(stage)
    const st = this.state
    const data = this.read()
    const ctx = { S, scenario, agent: st, data }
    // The same counts as Today: what's waiting in Act and Run, what Today lists in Watch.
    const nNeed = S >= 1 ? pendingIds(ctx).length : visibleProblems(ctx).length
    const out: AgentNotification[] = []
    for (const n of notifications.notifications as RawNotification[]) {
      if (typeof n.text !== 'string') {
        // The waiting line. Its id carries the count, so a higher count arrives unread again; a count that fell (a draft
        // was approved) stays read.
        if (nNeed === 0) continue
        const kind = `waiting-${S >= 1 ? 'drafts' : 'today'}`
        const read = Object.keys(st.readNotices).some(k => k.startsWith(`${kind}-`) && Number(k.slice(kind.length + 1)) >= nNeed)
        out.push({
          id: `${kind}-${nNeed}`, icon: 'task_alt', who: n.who, at: sampleAt('a notification', n.at), unread: n.unread && !read, waiting: true,
          text: S >= 1 ? `${nNeed} ${nNeed === 1 ? 'draft is' : 'drafts are'} waiting for your approval.` : `Today has ${nNeed} ${nNeed === 1 ? 'thing' : 'things'} that need${nNeed === 1 ? 's' : ''} you.`,
          link: { to: 'page', page: S >= 1 ? 'approvals' : 'today' },
        })
        continue
      }
      if (typeof n.opens !== 'string') throw new Error(`Sample data: notification "${n.text}" opens a stage-specific place, which only the waiting line may.`)
      const link = linkOf(n.opens)
      const person = data.people.members.some(m => m.name === n.who) ? n.who : undefined
      const id = noticeId(n.text)
      out.push({
        id, text: n.text, who: n.who, person, at: sampleAt(`the notification "${n.text}"`, n.at), unread: n.unread && !st.readNotices[id], link,
        icon: person ? 'check_circle' : link.to === 'tool' ? 'support_agent' : link.to === 'chat' ? 'summarize' : 'notifications',
      })
    }
    return out
  }

  // ----- library -----

  private filesFor: [AgentState['libraryDeleted'], boolean] | null = null
  private files: LibraryFile[] = []
  /** Rebuilt only when the deleted set or the scenario's data changes, so React sees the same array until then. */
  listFiles = () => {
    const none = isNoData(this.demo.scenario)
    if (!this.filesFor || this.filesFor[0] !== this.state.libraryDeleted || this.filesFor[1] !== none) {
      this.filesFor = [this.state.libraryDeleted, none]
      const deleted = this.state.libraryDeleted
      this.files = none ? [] : library.files.filter(f => !deleted[f.id])
    }
    return this.files
  }
  deleteFiles(ids: string[]) {
    const libraryDeleted = { ...this.state.libraryDeleted }
    for (const id of ids) libraryDeleted[id] = true
    return this.write({ libraryDeleted })
  }
  restoreFiles(ids: string[]) {
    const libraryDeleted = { ...this.state.libraryDeleted }
    for (const id of ids) delete libraryDeleted[id]
    return this.write({ libraryDeleted })
  }

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
  deleteRoutine(id: string) { return this.write({ routinesDeleted: { ...this.state.routinesDeleted, [id]: true } }) }
  restoreRoutine(id: string) {
    const routinesDeleted = { ...this.state.routinesDeleted }
    delete routinesDeleted[id]
    return this.write({ routinesDeleted })
  }

  // ----- traces -----

  getTrace(id: string): Trace | null {
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
    // In Run the message to ShipBob was sent within limits, so nothing waited.
    if (stageIndex(this.demo.stage) === 2) steps = steps.filter(s => s.kind !== 'approval')
    return { ...base, id, steps }
  }

  /** Remembers what a run replayed and made, keeping the newest RUNS_KEPT. */
  private saveRunInfo(runId: string, info: RunInfo) {
    this.runInfo.delete(runId)
    this.runInfo.set(runId, { ...info })
    while (this.runInfo.size > RUNS_KEPT) this.runInfo.delete(this.runInfo.keys().next().value!)
    try { localStorage.setItem(RUNS_KEY, JSON.stringify([...this.runInfo])) }
    catch (e) { console.warn("Inhouse demo: could not save the run's steps; they won't open after a reload.", e) }
  }

  // ----- chat -----

  /** A seeded turn's own answer when the question is one a chat already asked: this chat's first, then any chat's. */
  private seeded(q: string, chatId: string): Script | null {
    const stage = this.demo.stage
    const want = norm(q)
    const order = [...chats.filter(c => c.id === chatId), ...chats.filter(c => c.id !== chatId)]
    for (const c of order) {
      for (let t = 0; t < c.turns.length; t++) {
        const turn = c.turns[t]
        if (turn.role !== 'user' || norm(turn.text) !== want) continue
        const answers: Extract<SeedTurn, { role: 'agent' }>[] = []
        for (let j = t + 1; j < c.turns.length; j++) {
          const a = c.turns[j]
          if (a.role === 'user') break
          if (!a.stage || a.stage === stage) answers.push(a)
        }
        if (!answers.length) continue
        const fb = chatScript.fallback
        return { thinking: fb.thinking, delayMs: fb.delayMs, trace: traceKey(answers[0].trace), parts: answers.flatMap(a => a.parts) }
      }
    }
    return null
  }

  private script(q: string, chatId: string): Script {
    const S = stageIndex(this.demo.stage)
    const sc = chatScript.scripted
    const pick = (match: string) => {
      const e = sc.find(x => x.match === match)
      if (!e) throw new Error(`chat-script.json has no entry for ${match}`)
      return e
    }
    const fb = chatScript.fallback
    const text = (t: string): MessagePart => ({ type: 'text', text: t })

    // Nothing read yet: even a seeded question gets "I can't see your tools yet" (day one) or "still reading" (loading).
    if (this.demo.scenario === 'First day') {
      return { thinking: fb.thinking, delayMs: fb.delayMs, parts: [text(chatScript.firstDay)], trace: traceKey(chatScript.firstDayTrace) }
    }
    if (this.demo.scenario === 'Loading') {
      return { thinking: fb.thinking, delayMs: fb.delayMs, parts: [text(chatScript.loading)], trace: traceKey(chatScript.loadingTrace) }
    }
    const disc = pick('gorgias|ticket|refund|customer service') as { match: string; delayMs: number; reply: { text: string }[]; trace: string }
    if (this.demo.scenario === 'Tool disconnected' && new RegExp(disc.match, 'i').test(q)) {
      return { thinking: fb.thinking, delayMs: fb.delayMs, parts: [{ type: 'error', text: disc.reply[0].text, retryQuestion: q }], trace: traceKey(disc.trace) }
    }
    // A question a chat already asked gets that chat's own answer (Regenerate on a seeded chat, the suggestions).
    const seeded = this.seeded(q, chatId)
    if (seeded) return seeded
    const more = /^Tell me more about: (.+)$/i.exec(q.trim())
    const p = more && problems.find(x => x.title === more[1].trim())
    if (p) {
      const s = pick('Tell me more about: {problem title}') as { thinking: string[]; delayMs: number }
      const found = p.found.map(([t]) => t).join('')
      return { thinking: s.thinking, delayMs: s.delayMs, trace: 'generic', parts: [text(`${found} Suggested next step: ${p.next}.`)] }
    }
    // The same guard as routines: "Any new skill ideas?" is a question, not a request to make one.
    if (isRequest(q) && /\b(create|make|build|add|new|teach)\b.{0,14}\bskill\b/i.test(q)) {
      const s = pick('(create|make|build|add|new|teach) … skill') as { thinking: string[]; delayMs: number; reply: { type: string; text?: string }[]; trace: string }
      const skill = skillFromRequest(q, S)
      // The answer's footer links its steps, so the reply carries no work row of its own (one link per answer).
      return {
        thinking: s.thinking, delayMs: s.delayMs, trace: traceKey(s.trace),
        parts: [text(s.reply.find(x => x.type === 'text')!.text!), { type: 'skill', skill }],
        after: (info, replaces) => {
          const def: SkillDef = { n: skill.name, d: skill.desc, icon: 'menu_book', need: 0, by: `${this.stamp().by}, in a chat`, used: 'New today', mine: true }
          // Regenerate or Edit of the question that made a skill updates that skill instead of adding a second.
          const old = replaces ? this.runInfo.get(replaces)?.skill : undefined
          const at = old === undefined ? -1 : this.state.skillsExtra.findIndex(x => x.n === old)
          const skillsExtra = at < 0 ? [def, ...this.state.skillsExtra] : this.state.skillsExtra.map((x, i) => (i === at ? def : x))
          this.commit({ skillsExtra })
          info.skill = def.n
        },
      }
    }
    const r = pick('every|each|daily|weekly|remind|routine|schedule') as { match: string; thinking: string[]; delayMs: number; Watch: { type: string; text: string }[]; ActRun: { type: string; text?: string }[]; trace: string }
    if (isScheduleRequest(q)) {
      if (S === 0) {
        return { thinking: r.thinking, delayMs: r.delayMs, trace: 'generic', parts: [text(r.Watch[0].text), { type: 'notInThisStage', text: r.Watch[1].text }] }
      }
      // A schedule with no time (or no day, or a time that can't be) makes nothing yet: the agent asks.
      const routine = routineFromRequest(q, S, '', demoNow(this.state.demoStartedAt))
      if (!routine) return { thinking: r.thinking.slice(0, 1), delayMs: fb.delayMs, trace: 'generic', parts: [text(ASK_FOR_TIME)] }
      return {
        thinking: r.thinking, delayMs: r.delayMs, trace: traceKey(r.trace),
        parts: [text(r.ActRun.find(x => x.type === 'text')!.text!), { type: 'routine', routine }],
      }
    }
    if (/stuck/i.test(q)) {
      const s = pick('stuck') as { thinking: string[]; delayMs: number }
      const seedText = (chatScript.seedThread.turns[1] as { agent: { text?: string }[] }).agent[0].text!
      return { thinking: s.thinking, delayMs: s.delayMs, trace: 'stuck', parts: [text(seedText), { type: 'table', table: seedTable }] }
    }
    if (QUERY_ASK.test(q)) {
      return { thinking: fb.thinking, delayMs: fb.delayMs, trace: 'query', parts: [text(QUERY_ANSWER)] }
    }
    const plain = (match: string, re: RegExp): Script | null => {
      const s = pick(match) as { thinking: string[]; delayMs: number; reply: { text: string }[]; trace: string }
      return re.test(q) ? { thinking: s.thinking, delayMs: s.delayMs, trace: traceKey(s.trace), parts: [text(s.reply[0].text)] } : null
    }
    // "Black Friday" is checked before "Friday", so the dictated question gets its own answer.
    const scripted = plain('refund', /refund/i) ?? plain('black friday|run out', /black friday|run out/i) ?? plain('friday|feature|email', /friday|feature|email/i)
    if (scripted) return scripted
    // Off-script (decision D8): what the agent can't answer from the tools, then the suggested questions as chips.
    // The tools it can read now: not the one whose login expired.
    const off = this.demo.scenario === 'Tool disconnected' ? DATA.scenarios.toolDisconnected.tool : null
    const readable = listNames(tools.connected.filter(k => k !== off).map(k => tools.details[k].name))
    return { thinking: fb.thinking, delayMs: fb.delayMs, trace: traceKey(fb.trace), parts: [text(fb.reply[0].text.replace('{tools}', readable)), { type: 'suggestions', questions: chatScript.suggestions }] }
  }

  /** A routine part's card, saved as it appears. With `replaces`, the routine that run made is updated in place (same id). */
  private saveRoutine(part: Extract<MessagePart, { type: 'routine' }>, replaces: string | undefined, info: RunInfo): MessagePart {
    const was = replaces ? this.runInfo.get(replaces) : undefined
    const old = was?.routine ?? was?.kept
    const reuse = old !== undefined && this.state.routinesExtra.some(x => x.id === old) ? old : null
    const routine = { ...part.routine, id: reuse ?? nextChatRoutineId(this.state.routinesExtra) }
    const routinesDeleted = { ...this.state.routinesDeleted }; delete routinesDeleted[routine.id]
    this.commit({
      routinesExtra: reuse ? this.state.routinesExtra.map(x => (x.id === reuse ? routine : x)) : [...this.state.routinesExtra, routine],
      routinesDeleted,
    })
    info.routine = routine.id
    return { ...part, routine }
  }

  /**
   * The replacing answer made no routine in place of the one the replaced run made: that routine is deleted the way a
   * person deletes one (`routinesDeleted`), so Regenerate's Undo can restore it. A skill is never taken back.
   */
  private takeBack(replaced: string, info: RunInfo) {
    const old = this.runInfo.get(replaced)
    if (old?.routine && !info.routine) this.commit({ routinesDeleted: { ...this.state.routinesDeleted, [old.routine]: true } })
  }

  private knownChat(id: string) { return this.created.has(id) || chats.some(c => c.id === id) }

  createChat(chat: { id: string; title: string }): Promise<void> {
    if (!chat.id.trim()) return this.rejected('unknown', "Couldn't start the chat.", true)
    this.created.add(chat.id)
    return Promise.resolve()
  }

  async *ask(question: string, opts: AskOptions): AsyncGenerator<RunEvent> {
    // A chat the agent doesn't know is a wiring bug in the app: fail loud.
    if (!this.knownChat(opts.chatId)) throw new Error(`ask: unknown chat id "${opts.chatId}". Make it with createChat first.`)
    const runId = `run-${SESSION}-${++this.runSeq}`
    const run: LiveRun = { stop: new AbortController(), turn: new AbortController(), queue: [] }
    this.runs.set(runId, run)
    // Waits, or ends early on Stop (the run) or interrupt (this turn).
    const wait = (ms: number) => new Promise<void>(resolve => {
      const signals = [run.stop.signal, run.turn.signal]
      if (signals.some(x => x.aborted)) { resolve(); return }
      let t: ReturnType<typeof setTimeout> | undefined = undefined
      const done = () => { clearTimeout(t); signals.forEach(x => x.removeEventListener('abort', done)); resolve() }
      t = setTimeout(done, ms)
      signals.forEach(x => x.addEventListener('abort', done, { once: true }))
    })
    let info: RunInfo = { trace: 'generic' }
    // Each turn has its own trace id: the run's for the first, `${runId}-t${n}` for a message sent into it.
    let turnId = runId
    // Over before it says so: the run is removed first, so a message sent once it's stopped is refused, not queued and lost.
    const stopped = (): RunEvent => { this.runs.delete(runId); return { type: 'run.stopped', runId } }
    try {
      yield { type: 'run.started', runId }
      let q = question
      // Only the first turn replaces the earlier run's answer; messages sent in later are new questions.
      let replaces = opts.replacesRun
      for (let first = true, n = 1; ; first = false, n++) {
        if (!first) {
          turnId = `${runId}-t${n}`
          info = { trace: 'generic' }
          yield { type: 'turn.started', text: q }
        }
        const s = this.script(q.trim(), opts.chatId)
        info.trace = s.trace
        this.saveRunInfo(turnId, info)
        yield { type: 'step', label: 'Reading your question…' }
        let elapsed = 0, i = 0
        while (elapsed < s.delayMs && !run.turn.signal.aborted) {
          const slice = Math.min(THINKING_STEP_MS, s.delayMs - elapsed)
          await wait(slice)
          if (run.stop.signal.aborted) { yield stopped(); return }
          if (run.turn.signal.aborted) break
          elapsed += slice
          if (elapsed < s.delayMs) yield { type: 'step', label: s.thinking[Math.min(i++, s.thinking.length - 1)] }
        }
        if (run.stop.signal.aborted) { yield stopped(); return }
        if (!run.turn.signal.aborted) {
          for (const part of s.parts) {
            // A routine from a request is saved as its card appears, so its id comes from what is saved at that moment.
            const out = part.type === 'routine' && part.routine.id === '' ? this.saveRoutine(part, replaces, info) : part
            yield { type: 'part', part: out, trace: turnId }
            if (out.type === 'approval') yield { type: 'approval.requested', approvalId: out.problemId }
          }
          s.after?.(info, replaces)
          const failed = s.parts.find(x => x.type === 'error')
          // An answer that failed replaces nothing: what the earlier run made stays, and this run carries it on, so the
          // next answer in the chain (Try again, or Regenerate of the error) updates it instead of making a second.
          if (replaces && !failed) this.takeBack(replaces, info)
          const was = replaces && failed ? this.runInfo.get(replaces) : undefined
          if (was) { info.kept = was.routine ?? was.kept; info.skill = was.skill }
          this.saveRunInfo(turnId, info)
          if (failed && failed.type === 'error') {
            // Over before it says so, like run.finished: a message sent now is refused, not queued and lost.
            this.runs.delete(runId)
            yield { type: 'run.failed', runId, message: failed.text }
            return
          }
        }
        replaces = undefined
        const next = run.queue.shift()
        if (!next) {
          // Interrupted with nothing waiting: the run ends there.
          if (run.turn.signal.aborted) { yield stopped(); return }
          break
        }
        run.turn = new AbortController()
        q = next.text
      }
      const t = this.getTrace(turnId)
      if (!t) throw new Error(`No recorded trace for ${info.trace}`)
      // Over before it says so: a message sent after this point is refused, not queued and lost.
      this.runs.delete(runId)
      yield { type: 'run.finished', runId, steps: t.steps.length - 1, durationMs: t.durationMs, cost: t.cost }
    } finally {
      this.runs.delete(runId)
    }
  }

  send(runId: string, text: string, opts: { priority?: SendPriority; attachments?: Attachment[] } = {}): Promise<void> {
    const run = this.runs.get(runId)
    if (!run) return this.rejected('conflict', FINISHED, true)
    const priority = opts.priority ?? 'next'
    const item: Queued = { text, priority, attachments: opts.attachments }
    if (priority === 'later') run.queue.push(item)
    else {
      // `now` and `next` go before anything sent as `later`; `now` goes first and ends the current turn (the mock's
      // steer: the engine would take it at its next step).
      const at = priority === 'now' ? 0 : (i => (i < 0 ? run.queue.length : i))(run.queue.findIndex(x => x.priority === 'later'))
      run.queue.splice(at, 0, item)
      if (priority === 'now') run.turn.abort()
    }
    return Promise.resolve()
  }

  interrupt(runId: string): Promise<void> {
    const run = this.runs.get(runId)
    if (!run) return this.rejected('conflict', FINISHED, true)
    run.turn.abort()
    return Promise.resolve()
  }

  stop(runId: string) { this.runs.get(runId)?.stop.abort() }

  // ----- managing chats -----

  renameChat(id: string, title: string | null) {
    const chatTitles = { ...this.state.chatTitles }
    const t = title?.trim().replace(/\s+/g, ' ').slice(0, CHAT_TITLE_MAX).trimEnd()
    if (t) chatTitles[id] = t; else delete chatTitles[id]
    return this.write({ chatTitles })
  }
  pinChat(id: string, pinned: boolean) {
    const chatPinned = { ...this.state.chatPinned }
    if (pinned) chatPinned[id] = true; else delete chatPinned[id]
    return this.write({ chatPinned })
  }
  deleteChats(ids: string[]) {
    const chatDeleted = { ...this.state.chatDeleted }
    for (const id of ids) chatDeleted[id] = true
    return this.write({ chatDeleted })
  }
  restoreChats(ids: string[]) {
    const chatDeleted = { ...this.state.chatDeleted }
    for (const id of ids) delete chatDeleted[id]
    return this.write({ chatDeleted })
  }
}
