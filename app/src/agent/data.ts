// Typed access to src/agent/sample-data. Only the mock agent imports this
// module; screens read the same data through AgentClient.read() (AgentData).
import metaRaw from '@sample/meta.json'
import problemsRaw from '@sample/problems.json'
import toolsRaw from '@sample/tools.json'
import routinesRaw from '@sample/routines.json'
import skillsRaw from '@sample/skills.json'
import tracesRaw from '@sample/traces.json'
import chatRaw from '@sample/chat-script.json'
import chatsRaw from '@sample/chats.json'
import helpRaw from '@sample/help.json'
import usageRaw from '@sample/usage.json'
import usageHistoryRaw from '@sample/usage-history.json'
import peopleRaw from '@sample/people-and-rules.json'
import memoryRaw from '@sample/memory.json'
import auditRaw from '@sample/audit-log.json'
import activityRaw from '@sample/activity.json'
import notificationsRaw from '@sample/notifications.json'
import scenariosRaw from '@sample/scenarios.json'
import modelsRaw from '@sample/models.json'
import libraryRaw from '@sample/library.json'
import { keepTimesTogether } from './clock'
import { demoAt } from './demo-clock'
import { moneyOf } from '../lib/format'
import type {
  ActivityLine, AuditEntry, CatalogTool, ClockTime, Draft, Effort, Instant, LibraryFile, LibraryKind, LibraryPlace, MemoryLine, ModelMode, Money, Problem, Prose, RoutineDef, SkillDef,
  SkillSuggestion, StageIndex, Attachment, TablePart, TeamRequest, ToolChannel, ToolDetail, Trace, TraceStep, TraceStepKind, UsageData, UsageRow,
} from './types'

// Every shown time in the sample data keeps its digits and AM or PM on one line ("5:41\u00a0AM"), like fmtTime.
const metaJson = keepTimesTogether(metaRaw)
const problemsJson = keepTimesTogether(problemsRaw)
const toolsJson = keepTimesTogether(toolsRaw)
const routinesJson = keepTimesTogether(routinesRaw)
const skillsJson = keepTimesTogether(skillsRaw)
const tracesJson = keepTimesTogether(tracesRaw)
const chatJson = keepTimesTogether(chatRaw)
const chatsJson = keepTimesTogether(chatsRaw)
const helpJson = keepTimesTogether(helpRaw)
const usageJson = keepTimesTogether(usageRaw)
const usageHistoryJson = keepTimesTogether(usageHistoryRaw)
const peopleJson = keepTimesTogether(peopleRaw)
const memoryJson = keepTimesTogether(memoryRaw)
const auditJson = keepTimesTogether(auditRaw)
const activityJson = keepTimesTogether(activityRaw)
const notificationsJson = keepTimesTogether(notificationsRaw)
const scenariosJson = keepTimesTogether(scenariosRaw)
const modelsJson = keepTimesTogether(modelsRaw)
const libraryJson = keepTimesTogether(libraryRaw)

/** A sample instant ("-1d 16:40": days from the demo's Monday and a local time), checked: anything else stops the app. */
export const sampleAt = (what: string, v: unknown): Instant => {
  if (typeof v !== 'string') throw new Error(`Sample data: ${what} has no time like "-1d 16:40".`)
  return demoAt(v)
}
/**
 * A sentence with times in it as the sample data writes it (`{ "text": "Paused it at {at:time}", "times": { "at": "0d 06:04" } }`),
 * checked: every `{key:time}` or `{key:weekday}` has its time, and every time is used. `need` names keys it must have.
 */
const proseIn = (what: string, v: unknown, need: string[] = []): Prose => {
  const p = v as { text?: unknown; times?: unknown }
  if (typeof p !== 'object' || p === null || typeof p.text !== 'string' || typeof p.times !== 'object' || p.times === null) throw new Error(`Sample data: ${what} needs { "text": ..., "times": { ... } }.`)
  const text = p.text
  const raw = p.times as Record<string, unknown>
  const used = [...text.matchAll(/\{(\w+)(?::(\w+))?\}/g)]
  for (const [token, key, form] of used) {
    if (!Object.hasOwn(raw, key) || (form !== 'time' && form !== 'weekday')) throw new Error(`Sample data: ${what} has ${token} with no time in "times" or no form (time or weekday).`)
  }
  for (const key of [...Object.keys(raw), ...need]) {
    if (!used.some(m => m[1] === key)) throw new Error(`Sample data: ${what} needs {${key}:time} in its text.`)
  }
  return { text, times: Object.fromEntries(Object.entries(raw).map(([k, t]) => [k, sampleAt(what, t)])) }
}
/** A schedule's time of day as the sample data writes it ("06:00", 24-hour), checked. */
export const clockTimeOf = (what: string, v: unknown): ClockTime => {
  const m = typeof v === 'string' ? /^(\d\d):(\d\d)$/.exec(v) : null
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) throw new Error(`Sample data: ${what} has no time of day like "06:00".`)
  return { hour: Number(m[1]), minute: Number(m[2]) }
}
/** An amount as the sample data writes it (`{ "minor": 119000, "currency": "USD" }`), checked. */
const moneyIn = (what: string, v: unknown): Money => {
  const m = v as Money
  if (typeof m !== 'object' || m === null || !Number.isInteger(m.minor) || typeof m.currency !== 'string' || !/^[A-Z]{3}$/.test(m.currency)) throw new Error(`Sample data: ${what} has no amount like { "minor": 119000, "currency": "USD" }.`)
  return { minor: m.minor, currency: m.currency }
}
/** The sample data's amounts are in US dollars. */
const CURRENCY = 'USD'

/** A stage index (0 Watch, 1 Act, 2 Run), checked: anything else stops the app with a message. */
const needOf = (what: string, need: unknown): StageIndex => {
  if (need !== 0 && need !== 1 && need !== 2) throw new Error(`Sample data: ${what} has an unknown stage "${String(need)}".`)
  return need
}

// The file's own notes (`note`, `fixedClock`) document the sample data: the agent returns only who the brand, agent and person are.
export const meta = { brand: metaJson.brand, agent: metaJson.agent, currentUser: metaJson.currentUser }
/** A problem as the sample data has it: the mock adds the draft time from the Library (see `DATA` in mock.ts). */
export type ProblemSeed = Omit<Problem, 'draftedAt'>
type RawProblem = Omit<ProblemSeed, 'cost' | 'done' | 'draft'> & { cost: unknown; done?: unknown; draft: Omit<Draft, 'doneNote'> & { doneNote?: unknown } }
/** Each problem with its amount checked and, when the agent did it by itself in Run, what it did and when (`done.times.at`). */
export const problems: ProblemSeed[] = (problemsJson.problems as unknown as RawProblem[]).map(p => {
  const what = `the problem "${p.id}"`
  const { done, draft, ...rest } = p
  const { doneNote, ...dr } = draft
  return {
    ...rest,
    cost: moneyIn(what, p.cost),
    ...(done !== undefined ? { done: proseIn(`${what}'s done`, done, ['at']) } : {}),
    draft: { ...dr, ...(doneNote !== undefined ? { doneNote: proseIn(`${what}'s doneNote`, doneNote) } : {}) },
  }
})
export const problemById = (id: string): ProblemSeed => {
  const p = problems.find(x => x.id === id)
  if (!p) throw new Error(`Unknown problem id: ${id}`)
  return p
}

/** The sample records the composer can attach, checked once at load. */
const loadAttachExamples = (): (Attachment & { sources: string[]; label?: string })[] => {
  const out = (toolsJson.attachExamples ?? []) as (Attachment & { sources: string[]; label?: string })[]
  for (const a of out) {
    for (const k of ['name', 'meta', 'icon'] as const) {
      if (typeof a[k] !== 'string' || !a[k]) throw new Error(`Tools data: an attach example is missing "${k}".`)
    }
    if (a.label !== undefined && (typeof a.label !== 'string' || !a.label)) throw new Error(`Tools data: the attach example "${a.name}" needs "label" to be a non-empty string.`)
    if (Array.isArray(a.sources) && a.sources.length === 0) throw new Error(`Tools data: the attach example "${a.name}" needs at least one entry in "sources".`)
    if (!Array.isArray(a.sources) || a.sources.some(k => !Object.hasOwn(toolsJson.details, k))) throw new Error(`Tools data: the attach example "${a.name}" needs "sources" to be a list of known tool keys.`)
  }
  return out
}

/** The channels, checked once at load (decision D6: Slack is a channel from Act, not a tool the agent reads). */
const loadChannels = (): ToolChannel[] => {
  const raw = toolsJson.channels as unknown as (Omit<ToolChannel, 'since'> & { since: string })[]
  for (const c of raw) {
    for (const k of ['key', 'name', 'desc', 'since', 'site'] as const) {
      if (typeof c[k] !== 'string' || !c[k]) throw new Error(`Tools data: channel "${String(c.key)}" is missing "${k}".`)
    }
    if (![0, 1, 2].includes(c.need)) throw new Error(`Tools data: channel "${c.key}" has an unknown stage "${String(c.need)}".`)
    for (const k of ['channel', 'ask'] as const) {
      if (c[k] !== undefined && (typeof c[k] !== 'string' || !c[k])) throw new Error(`Tools data: channel "${c.key}" has an empty or non-text "${k}".`)
    }
    if (c.sends !== undefined && (!Array.isArray(c.sends) || c.sends.some(x => typeof x !== 'string' || !x))) throw new Error(`Tools data: channel "${c.key}" needs "sends" to be a list of non-empty text.`)
    if (toolsJson.connected.includes(c.key) || toolsJson.beingConnected.includes(c.key) || Object.hasOwn(toolsJson.details, c.key) || toolsJson.catalog.some(t => t.k === c.key)) throw new Error(`Tools data: "${c.key}" is a channel, so it can't also be a tool.`)
  }
  return raw.map(c => ({ ...c, since: sampleAt(`the channel "${c.key}"`, c.since) }))
}

/** Each tool's dates: connected `since`, or `liveBy` while the Inhouse team is connecting it. One or the other, checked. */
type RawToolDetail = Omit<ToolDetail, 'since' | 'liveBy'> & { since?: string; liveBy?: string }
const loadDetails = (): Record<string, ToolDetail> => Object.fromEntries(Object.entries(toolsJson.details as Record<string, RawToolDetail>).map(([k, d]) => {
  if ((d.since === undefined) === (d.liveBy === undefined)) throw new Error(`Tools data: "${k}" needs either "since" (connected) or "liveBy" (being connected).`)
  const { since, liveBy, ...rest } = d
  return [k, { ...rest, ...(since !== undefined ? { since: sampleAt(`the tool "${k}"`, since) } : { liveBy: sampleAt(`the tool "${k}"`, liveBy) }) }]
}))

export const tools = {
  connected: toolsJson.connected,
  channels: loadChannels(),
  attachExamples: loadAttachExamples(),
  beingConnected: toolsJson.beingConnected,
  lastRead: Object.fromEntries(Object.entries(toolsJson.lastRead).map(([k, v]) => [k, sampleAt(`the last read of "${k}"`, v)])) as Record<string, Instant> & { default: Instant },
  catalog: (toolsJson.catalog as CatalogTool[]).map(t => (t.need === undefined ? t : { ...t, need: needOf(`the tool "${t.k}"`, t.need) })),
  details: loadDetails(),
}

/** A routine as the sample data has it: the mock gives each its id. */
type RawRoutine = Omit<RoutineDef, 'id' | 'time' | 'next' | 'last' | 'need' | 'rev'> & { time: string; next: string; need: number; last?: { at: string; result: string } }
const routineOf = (r: RawRoutine): Omit<RoutineDef, 'id'> => {
  const what = `the routine "${r.name}"`
  const { last, ...rest } = r
  return {
    ...rest, rev: 1, need: needOf(what, r.need), time: clockTimeOf(what, r.time), next: sampleAt(what, r.next),
    ...(last ? { last: { at: sampleAt(what, last.at), result: last.result } } : {}),
  }
}
export const routines = (routinesJson.routines as RawRoutine[]).map(routineOf)
export const seedRoutine = routineOf(routinesJson.createdInSeedChat as RawRoutine)

export const skills = (skillsJson.skills as SkillDef[]).map(x => ({ ...x, need: needOf(`the skill "${x.n}"`, x.need) }))
export const skillSuggestions = skillsJson.suggested as SkillSuggestion[]
export const skillSuggestionsTitle = skillsJson.suggestedTitle

/** A recorded trace's key in traces.json: one per seeded or scripted answer, plus the morning check and a draft. */
export type TraceKey = string
type RawStep = { label: string; kind: string; startSeconds: number; endSeconds: number; depth: number; detail: string }
type RawTrace = { title: string; durationSeconds: number; cost: unknown; tokens: string; steps: RawStep[] }
const msOfSeconds = (s: number) => Math.round(s * 1000)
const rawTraces = tracesJson.traces as Record<string, RawTrace>
const STEP_KINDS: TraceStepKind[] = ['root', 'model', 'tool', 'agent', 'wait', 'handoff', 'approval', 'answer', 'fail']
const toStep = (id: string) => (s: RawStep): TraceStep => {
  if (!STEP_KINDS.includes(s.kind as TraceStepKind)) throw new Error(`Traces data: "${id}" has a step of unknown kind "${s.kind}".`)
  return { label: s.label, kind: s.kind as TraceStepKind, startMs: msOfSeconds(s.startSeconds), endMs: msOfSeconds(s.endSeconds), depth: s.depth, detail: s.detail }
}
/** The recorded traces, checked once at load: the first step is the whole run, so the time an answer shows is its trace's. */
export const traces: Record<string, Trace> = Object.fromEntries(
  Object.keys(rawTraces).map(id => {
    const t = rawTraces[id]
    const steps = t.steps.map(toStep(id))
    const durationMs = msOfSeconds(t.durationSeconds)
    if (steps[0]?.kind !== 'root' || steps[0].endMs !== durationMs) throw new Error(`Traces data: "${id}" must start with a root step as long as the run.`)
    if (steps.some(s => s.startMs < 0 || s.endMs < s.startMs || s.endMs > durationMs)) throw new Error(`Traces data: "${id}" has a step outside the run.`)
    return [id, { id, title: t.title, durationMs, cost: moneyIn(`the trace "${id}"`, t.cost), tokens: t.tokens, steps }]
  }),
)
const v = tracesJson.toolDisconnectedVariant
/** Tool disconnected: the morning check's step that failed, with its end in ms from the start of the run. */
export const traceDisconnectedVariant = { ...v, with: { label: v.with.label, kind: v.with.kind, endMs: msOfSeconds(v.with.endSeconds), detail: v.with.detail } }

export const chatScript = chatJson
export const chatList = chatsJson
export const helpGuides = helpJson.guides
// The seed reply's table part without its `type`: the part around it carries that.
const { type: _seedType, ...seedTablePart } = (chatJson.seedThread.turns[1] as { agent: { type: string }[] }).agent[1] as unknown as TablePart & { type: 'table' }
export const seedTable: TablePart = seedTablePart

// The usage files hold plain dollar figures. They are checked in dollars, then turned into amounts (`Money`).
type RawRow = { name: string; sub: string; dollars: number; conversations: number; subWithChannel?: string }
type RawBreakdown = Record<'person' | 'job' | 'model' | 'tool', RawRow[]>
type RawUsage = Omit<UsageData, 'cap' | 'total' | 'daily' | 'breakdown'> & { cap: number; total: number; daily: number[]; breakdown: RawBreakdown }
const usageRows = (b: Record<string, unknown[]>) => Object.fromEntries(
  Object.entries(b).map(([k, rows]) => [k, (rows as [string, string, number, number, string?][]).map(([name, sub, dollars, conversations, subWithChannel]) => ({ name, sub, dollars, conversations, ...(subWithChannel ? { subWithChannel } : {}) }))]),
) as RawBreakdown

const rawUsage: RawUsage = {
  month: usageJson.month,
  cap: usageJson.capDollars,
  alertAt: usageJson.alertAtPercent,
  total: usageJson.totalDollars,
  conversations: usageJson.conversations,
  questionsAsked: usageJson.questionsAsked,
  jobsRun: usageJson.jobsRun,
  daily: usageJson.dailyDollars,
  breakdown: usageRows(usageJson.breakdown),
}

/** This month in the Cap reached scenario: spend at the cap, with its own chart, conversations and breakdowns. */
const cr = usageJson.capReached
const rawUsageAtCap: RawUsage = {
  ...rawUsage,
  total: cr.totalDollars,
  conversations: cr.conversations,
  questionsAsked: cr.questionsAsked,
  jobsRun: cr.jobsRun,
  daily: cr.dailyDollars,
  breakdown: usageRows(cr.breakdown),
}
const sum = (xs: number[]) => Math.round(xs.reduce((a, b) => a + b, 0) * 100) / 100
// A chart or breakdown that doesn't add up to the month's spend stops the app here, not on the Usage page.
for (const [name, u] of [['this month', rawUsage], ['at the cap', rawUsageAtCap]] as const) {
  if (Math.abs(sum(u.daily) - u.total) > 0.011) throw new Error(`Usage data: the daily figures ${name} add up to ${sum(u.daily)}, not ${u.total}.`)
  for (const [k, rows] of Object.entries(u.breakdown)) {
    if (Math.abs(sum(rows.map(x => x.dollars)) - u.total) > 0.011) throw new Error(`Usage data: the ${k} breakdown ${name} doesn't add up to ${u.total}.`)
  }
  if (u.questionsAsked + u.jobsRun !== u.conversations) throw new Error(`Usage data: questions and jobs ${name} don't add up to the conversations.`)
}
if (rawUsageAtCap.total !== rawUsage.cap) throw new Error('Usage data: the Cap reached month must spend exactly the cap.')

/** A month's usage with its dollar figures as amounts. */
const usageOf = (u: RawUsage): UsageData => {
  const usd = (n: number) => moneyOf(n, CURRENCY)
  const rows = (rs: RawRow[]): UsageRow[] => rs.map(({ dollars, ...r }) => ({ ...r, spent: usd(dollars) }))
  return {
    ...u, cap: usd(u.cap), total: usd(u.total), daily: u.daily.map(usd),
    breakdown: { person: rows(u.breakdown.person), job: rows(u.breakdown.job), model: rows(u.breakdown.model), tool: rows(u.breakdown.tool) },
  }
}
export const usage = usageOf(rawUsage)
export const usageAtCap = usageOf(rawUsageAtCap)

/** Earlier months, newest first, in the same shape as `usage` (none yet: November is the first month with spend). */
type RawMonth = { month: string; totalDollars: number; conversations: number; questionsAsked: number; jobsRun: number; dailyDollars: number[]; breakdown: Record<string, unknown[]> }
export const usageHistory = (usageHistoryJson.months as RawMonth[]).map(m => usageOf({
  month: m.month,
  cap: usageHistoryJson.capDollars,
  alertAt: usageJson.alertAtPercent,
  total: m.totalDollars,
  conversations: m.conversations,
  questionsAsked: m.questionsAsked,
  jobsRun: m.jobsRun,
  daily: m.dailyDollars,
  breakdown: usageRows(m.breakdown),
}))

/** Each job the agent may finish has a stable id (its Run limits toggle is saved as `l:<id>`), checked once at load. */
for (const j of peopleJson.runLimits.jobsAgentMayFinish as { id?: unknown }[]) {
  if (typeof j.id !== 'string' || !j.id) throw new Error('Sample data: a job in runLimits.jobsAgentMayFinish has no id.')
}
if (new Set(peopleJson.runLimits.jobsAgentMayFinish.map(j => j.id)).size !== peopleJson.runLimits.jobsAgentMayFinish.length) throw new Error('Sample data: runLimits.jobsAgentMayFinish has a repeated id.')
// `placeholders` is a note on the sample data, not something the agent returns.
const { placeholders: _placeholders, ...runLimits } = peopleJson.runLimits
export const people = { ...peopleJson, runLimits }

type RawMemoryLine = { text: string; source: string; at?: string; used?: string; lastUsed?: string }
const memLines = (group: string, rows: RawMemoryLine[]): MemoryLine[] =>
  rows.map((r, i) => {
    const what = `the memory "${r.text}"`
    return {
      key: `${group}:${i}`, text: r.text, source: r.source, rev: 1,
      ...(r.at !== undefined ? { at: sampleAt(what, r.at) } : {}),
      ...(r.used !== undefined ? { used: r.used } : {}),
      ...(r.lastUsed !== undefined ? { lastUsed: sampleAt(what, r.lastUsed) } : {}),
    }
  })
export const memory = {
  team: Object.entries(memoryJson.team).map(([group, rows]) => ({ group, lines: memLines(`team:${group}`, rows) })),
  personal: memLines('me', memoryJson.personal.sam),
}

export const auditLog: AuditEntry[] = auditJson.entries.map(e => ({ ...e, at: sampleAt(`the audit line "${e.what}"`, e.at) }))
/** Activity's fixed lines, each with its instant (a stage or time the app doesn't know stops it). */
type RawActivityLine = Omit<ActivityLine, 'at' | 'minStage' | 'by'> & { at: string; minStage?: string; by: unknown }
const STAGE_NAMES = ['Watch', 'Act', 'Run']
const activityLine = (l: RawActivityLine): ActivityLine => {
  if (l.minStage !== undefined && !STAGE_NAMES.includes(l.minStage)) throw new Error(`Activity data: "${l.text}" has an unknown stage "${l.minStage}".`)
  const what = `the Activity line "${l.text}"`
  return { ...l, at: sampleAt(what, l.at), by: proseIn(what, l.by) } as ActivityLine
}
export const activityFixed = {
  today: (activityJson.today as RawActivityLine[]).map(activityLine),
  earlier: (activityJson.earlier as RawActivityLine[]).map(activityLine),
}
const CLOSED = ['done', 'declined', 'withdrawn'] as const
/** How a sample team request ended: bad sample data stops the app with a message. */
const closedOf = (title: string, v: string): NonNullable<TeamRequest['closed']> => {
  const c = CLOSED.find(x => x === v)
  if (!c) throw new Error(`Sample data: the team request "${title}" has closed "${v}"; use one of ${CLOSED.join(', ')}.`)
  return c
}
export const notifications = {
  notifications: notificationsJson.notifications,
  teamRequests: notificationsJson.teamRequests.map((r): Omit<TeamRequest, 'icon'> => ({
    title: r.title, sub: r.sub, at: sampleAt(`the team request "${r.title}"`, r.at), status: r.status,
    ...(r.statusAt !== undefined ? { statusAt: sampleAt(`the team request "${r.title}"`, r.statusAt) } : {}),
    ...(r.text !== undefined ? { text: r.text } : {}),
    ...(r.closed !== undefined ? { closed: closedOf(r.title, r.closed) } : {}),
  })),
}
export const scenarios = scenariosJson.scenarios
/** The models, checked once at load: bad sample data stops the app with a message. */
const loadModels = (): { models: ModelMode[]; defaultModel: string } => {
  const modes = modelsJson.modes as ModelMode[]
  const efforts: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']
  const ids = new Set<string>()
  for (const m of modes) {
    if (!m.id || !m.label || !m.model) throw new Error(`Models data: a mode needs id, label and model (${JSON.stringify(m)}).`)
    if (!efforts.includes(m.effort)) throw new Error(`Models data: mode "${m.id}" has an unknown effort "${String(m.effort)}".`)
    if (ids.has(m.id)) throw new Error(`Models data: the mode id "${m.id}" is used twice.`)
    ids.add(m.id)
  }
  if (!ids.has(modelsJson.default)) throw new Error(`Models data: the default "${modelsJson.default}" is not a mode id.`)
  return { models: modes, defaultModel: modelsJson.default }
}
export const { models, defaultModel } = loadModels()


/** The Library data, checked once at load: bad sample data stops the app with a message instead of showing the wrong place or type. */
type RawFile = Omit<LibraryFile, 'at' | 'durationMs' | 'rev'> & { at: string; durationSeconds?: number }
const loadLibrary = (): { places: LibraryPlace[]; files: LibraryFile[] } => {
  const places = libraryJson.places as LibraryPlace[]
  const raw = libraryJson.files as unknown as RawFile[]
  const kinds: LibraryKind[] = ['images', 'documents', 'code', 'media', 'other']
  const ids = new Set<string>()
  for (const p of places) {
    if (!p.id || !p.name || !p.icon) throw new Error(`Library data: a place needs id, name and icon (${JSON.stringify(p)}).`)
  }
  for (const f of raw) {
    for (const k of ['id', 'name', 'type', 'kind', 'place', 'from', 'by', 'size', 'at'] as const) {
      if (typeof f[k] !== 'string' || !f[k]) throw new Error(`Library data: file "${String(f.id)}" is missing "${k}".`)
    }
    if (!kinds.includes(f.kind)) throw new Error(`Library data: file "${f.id}" has an unknown kind "${f.kind}".`)
    if (!places.some(p => p.id === f.place)) throw new Error(`Library data: file "${f.id}" has an unknown place "${f.place}".`)
    // The Size sort reads it, so an unreadable size stops the app here rather than in a sort.
    if (!/^\d+(\.\d+)? (B|KB|MB|GB)$/.test(f.size)) throw new Error(`Library data: file "${f.id}" has an unreadable size "${f.size}".`)
    if (ids.has(f.id)) throw new Error(`Library data: the file id "${f.id}" is used twice.`)
    ids.add(f.id)
  }
  const files = raw.map(({ at, durationSeconds, ...f }): LibraryFile => ({
    ...f, rev: 1, at: sampleAt(`the file "${f.id}"`, at), ...(durationSeconds !== undefined ? { durationMs: durationSeconds * 1000 } : {}),
  }))
  return { places, files }
}
export const library = loadLibrary()
