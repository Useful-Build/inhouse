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
import { keepTimesTogether, minuteOfTime } from './clock'
import type {
  ActivityLine, CatalogTool, Effort, LibraryFile, LibraryKind, LibraryPlace, MemoryLine, ModelMode, Problem, RoutineDef, SkillDef, SkillSuggestion, StageIndex,
  TablePart, ToolChannel, ToolDetail, Trace, TraceStep, TraceStepKind, UsageRow,
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

/** A stage index (0 Watch, 1 Act, 2 Run), checked: anything else stops the app with a message. */
const needOf = (what: string, need: unknown): StageIndex => {
  if (need !== 0 && need !== 1 && need !== 2) throw new Error(`Sample data: ${what} has an unknown stage "${String(need)}".`)
  return need
}

export const meta = metaJson
/** A problem as the sample data has it: the mock adds the draft time from the Library (see `DATA` in mock.ts). */
export type ProblemSeed = Omit<Problem, 'draftedAt' | 'draftedMin'>
export const problems = problemsJson.problems as unknown as ProblemSeed[]
export const problemById = (id: string): ProblemSeed => {
  const p = problems.find(x => x.id === id)
  if (!p) throw new Error(`Unknown problem id: ${id}`)
  return p
}

/** The channels, checked once at load (decision D6: Slack is a channel from Act, not a tool the agent reads). */
const loadChannels = (): ToolChannel[] => {
  const out = toolsJson.channels as unknown as ToolChannel[]
  for (const c of out) {
    for (const k of ['key', 'name', 'desc', 'since', 'site'] as const) {
      if (typeof c[k] !== 'string' || !c[k]) throw new Error(`Tools data: channel "${String(c.key)}" is missing "${k}".`)
    }
    if (![0, 1, 2].includes(c.need)) throw new Error(`Tools data: channel "${c.key}" has an unknown stage "${String(c.need)}".`)
    if (toolsJson.connected.includes(c.key) || toolsJson.catalog.some(t => t.k === c.key)) throw new Error(`Tools data: "${c.key}" is a channel, so it can't also be a tool.`)
  }
  return out
}

export const tools = {
  connected: toolsJson.connected,
  channels: loadChannels(),
  beingConnected: toolsJson.beingConnected,
  lastRead: toolsJson.lastRead as Record<string, string> & { default: string },
  catalog: (toolsJson.catalog as CatalogTool[]).map(t => (t.need === undefined ? t : { ...t, need: needOf(`the tool "${t.k}"`, t.need) })),
  details: toolsJson.details as Record<string, ToolDetail>,
}

/** A routine as the sample data has it: the mock gives each its id. */
export const routines = (routinesJson.routines as Omit<RoutineDef, 'id'>[]).map(r => ({ ...r, need: needOf(`the routine "${r.name}"`, r.need) }))
export const seedRoutine = routinesJson.createdInSeedChat

export const skills = (skillsJson.skills as SkillDef[]).map(x => ({ ...x, need: needOf(`the skill "${x.n}"`, x.need) }))
export const skillSuggestions = skillsJson.suggested as SkillSuggestion[]

/** A recorded trace's key in traces.json: one per seeded or scripted answer, plus the morning check and a draft. */
export type TraceKey = string
type RawStep = { label: string; kind: string; startSeconds: number; endSeconds: number; depth: number; detail: string }
type RawTrace = { title: string; durationSeconds: number; cost: string; tokens: string; steps: RawStep[] }
const rawTraces = tracesJson.traces as Record<string, RawTrace>
const STEP_KINDS: TraceStepKind[] = ['root', 'model', 'tool', 'agent', 'wait', 'handoff', 'approval', 'answer', 'fail']
const toStep = (id: string) => (s: RawStep): TraceStep => {
  if (!STEP_KINDS.includes(s.kind as TraceStepKind)) throw new Error(`Traces data: "${id}" has a step of unknown kind "${s.kind}".`)
  return { label: s.label, kind: s.kind as TraceStepKind, start: s.startSeconds, end: s.endSeconds, depth: s.depth, detail: s.detail }
}
/** The recorded traces, checked once at load: the first step is the whole run, so the time an answer shows is its trace's. */
export const traces: Record<string, Trace> = Object.fromEntries(
  Object.keys(rawTraces).map(id => {
    const t = rawTraces[id]
    const steps = t.steps.map(toStep(id))
    if (steps[0]?.kind !== 'root' || steps[0].end !== t.durationSeconds) throw new Error(`Traces data: "${id}" must start with a root step as long as the run.`)
    if (steps.some(s => s.start < 0 || s.end < s.start || s.end > t.durationSeconds)) throw new Error(`Traces data: "${id}" has a step outside the run.`)
    return [id, { id, title: t.title, duration: t.durationSeconds, cost: t.cost, tokens: t.tokens, steps }]
  }),
)
export const traceDisconnectedVariant = tracesJson.toolDisconnectedVariant

export const chatScript = chatJson
export const chatList = chatsJson
export const helpGuides = helpJson.guides
export const seedTable = (chatJson.seedThread.turns[1] as { agent: { type: string }[] }).agent[1] as unknown as TablePart & { type: 'table' }

type UsageBreakdown = Record<'person' | 'job' | 'model' | 'tool', UsageRow[]>
const usageRows = (b: Record<string, unknown[]>) => Object.fromEntries(
  Object.entries(b).map(([k, rows]) => [k, (rows as [string, string, number, number][]).map(([name, sub, dollars, conversations]) => ({ name, sub, dollars, conversations }))]),
) as UsageBreakdown

export const usage = {
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
export const usageAtCap = {
  ...usage,
  total: cr.totalDollars,
  conversations: cr.conversations,
  questionsAsked: cr.questionsAsked,
  jobsRun: cr.jobsRun,
  daily: cr.dailyDollars,
  breakdown: usageRows(cr.breakdown),
}
const sum = (xs: number[]) => Math.round(xs.reduce((a, b) => a + b, 0) * 100) / 100
// A chart or breakdown that doesn't add up to the month's spend stops the app here, not on the Usage page.
for (const [name, u] of [['this month', usage], ['at the cap', usageAtCap]] as const) {
  if (Math.abs(sum(u.daily) - u.total) > 0.011) throw new Error(`Usage data: the daily figures ${name} add up to ${sum(u.daily)}, not ${u.total}.`)
  for (const [k, rows] of Object.entries(u.breakdown)) {
    if (Math.abs(sum(rows.map(x => x.dollars)) - u.total) > 0.011) throw new Error(`Usage data: the ${k} breakdown ${name} doesn't add up to ${u.total}.`)
  }
  if (u.questionsAsked + u.jobsRun !== u.conversations) throw new Error(`Usage data: questions and jobs ${name} don't add up to the conversations.`)
}
if (usageAtCap.total !== usage.cap) throw new Error('Usage data: the Cap reached month must spend exactly the cap.')

/** Earlier months, newest first, in the same shape as `usage` (none yet: November is the first month with spend). */
type RawMonth = { month: string; totalDollars: number; conversations: number; questionsAsked: number; jobsRun: number; dailyDollars: number[]; breakdown: Record<string, unknown[]> }
export const usageHistory = (usageHistoryJson.months as RawMonth[]).map(m => ({
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

export const people = peopleJson

const memLines = (group: string, rows: { text: string; source: string }[]): MemoryLine[] =>
  rows.map((r, i) => ({ key: `${group}:${i}`, text: r.text, source: r.source }))
export const memory = {
  team: Object.entries(memoryJson.team).map(([group, rows]) => ({ group, lines: memLines(`team:${group}`, rows) })),
  personal: memLines('me', memoryJson.personal.sam),
}

export const auditLog = auditJson.entries
/** Activity's fixed lines, each with the minute its shown time stands for (a time that isn't "6:00 AM" style stops the app). */
type RawActivityLine = Omit<ActivityLine, 'atMin' | 'minStage'> & { minStage?: string }
const STAGE_NAMES = ['Watch', 'Act', 'Run']
const withMinute = (l: RawActivityLine): ActivityLine => {
  if (l.minStage !== undefined && !STAGE_NAMES.includes(l.minStage)) throw new Error(`Activity data: "${l.text}" has an unknown stage "${l.minStage}".`)
  return { ...l, atMin: minuteOfTime(l.t) } as ActivityLine
}
export const activityFixed = {
  today: (activityJson.today as RawActivityLine[]).map(withMinute),
  earlier: (activityJson.earlier as RawActivityLine[]).map(withMinute),
}
export const notifications = notificationsJson
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
const loadLibrary = (): { places: LibraryPlace[]; files: LibraryFile[] } => {
  const places = libraryJson.places as LibraryPlace[]
  const files = libraryJson.files as unknown as LibraryFile[]
  const kinds: LibraryKind[] = ['images', 'documents', 'code', 'media', 'other']
  const ids = new Set<string>()
  for (const p of places) {
    if (!p.id || !p.name || !p.icon) throw new Error(`Library data: a place needs id, name and icon (${JSON.stringify(p)}).`)
  }
  for (const f of files) {
    for (const k of ['id', 'name', 'type', 'kind', 'place', 'from', 'by', 'size', 'date', 'at'] as const) {
      if (typeof f[k] !== 'string' || !f[k]) throw new Error(`Library data: file "${String(f.id)}" is missing "${k}".`)
    }
    if (!kinds.includes(f.kind)) throw new Error(`Library data: file "${f.id}" has an unknown kind "${f.kind}".`)
    if (!places.some(p => p.id === f.place)) throw new Error(`Library data: file "${f.id}" has an unknown place "${f.place}".`)
    // The Size sort reads it, so an unreadable size stops the app here rather than in a sort.
    if (!/^\d+(\.\d+)? (B|KB|MB|GB)$/.test(f.size)) throw new Error(`Library data: file "${f.id}" has an unreadable size "${f.size}".`)
    if (ids.has(f.id)) throw new Error(`Library data: the file id "${f.id}" is used twice.`)
    ids.add(f.id)
  }
  return { places, files }
}
export const library = loadLibrary()
