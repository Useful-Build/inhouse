// Pure selectors: stage + agent state + agent data -> what the screens show. The demo's scenario switch isn't an input:
// what a scenario changes on screen is in the agent's data.
import type { AgentData, AgentState, ChatMessage, ClockTime, Instant, Money, ToolChannel, Effort, Problem, Prose, StageIndex, TeamRequest, ThinkingMode, ToolDetail, ToolSetup } from '../agent/types'
import { calendarOf, fmtAgo, fmtClock, fmtDay, fmtDayWord, fmtMoney, fmtProse, fmtTime, fmtWeekday, majorOf, moneyOf, type Display } from '../lib/format'
import { display, nowOf } from './display'

export const STAGE_TAGS = ['Watch', 'Act', 'Run'] as const

export interface Ctx { S: StageIndex; agent: AgentState; data: AgentData }

/** The channel the team hears from the agent on at a stage: the first one whose stage is reached. None: no channel wording. */
export const channelFrom = (data: AgentData, stage: StageIndex): ToolChannel | undefined => data.tools.channels.find(c => stage >= c.need)
/** The channel connected now. Copy that describes a later stage uses `channelFrom(data, stage)`. */
export const activeChannel = (ctx: Ctx): ToolChannel | undefined => channelFrom(ctx.data, ctx.S)

export const problemById = (data: AgentData, id: string): Problem => {
  const p = data.problems.find(x => x.id === id)
  if (!p) throw new Error(`Unknown problem id: ${id}`)
  return p
}
export const toolDetail = (data: AgentData, key: string): ToolDetail => {
  const d = data.tools.details[key]
  if (!d) throw new Error(`Unknown tool key: ${key}`)
  return d
}

// ---------- tools: connected, paused by a person, disconnected (M17) ----------

/**
 * A tool's state now. `connecting`: the Inhouse team is still connecting it. `disconnected`: its login failed (the agent's
 * data says so, in `tools.connection`). `paused`: a person paused the agent's access. `connected`: the agent reads it.
 */
export type ToolState = 'connecting' | 'connected' | 'paused' | 'disconnected'
export const toolState = (ctx: Ctx, key: string): ToolState => {
  const d = toolDetail(ctx.data, key)
  if (d.progress || !ctx.data.tools.connected.includes(key)) return 'connecting'
  if (ctx.data.tools.connection[key]?.status === 'disconnected') return 'disconnected'
  if (ctx.agent.toolPaused[key]) return 'paused'
  return 'connected'
}
/** The first connected tool whose login failed, with since when, or null when every one reads. The banner and Activity name it. */
export const lostTool = (ctx: Ctx): { key: string; since: Instant } | null => {
  for (const key of ctx.data.tools.connected) {
    const c = ctx.data.tools.connection[key]
    if (c?.status === 'disconnected') return { key, since: c.since }
  }
  return null
}
/**
 * Day one: the agent's data has arrived and no tool is connected yet, so it has nothing to read. Today lists the setup
 * instead of problems. A client that is still loading isn't there yet: it doesn't know its tools.
 */
export const isFirstDay = (data: AgentData): boolean => data.status === 'ready' && data.tools.connected.length === 0
/**
 * The tool the Inhouse team is connecting now (it has a `liveBy` date), with that date as shown ("Fri, Nov 20"), or null:
 * none is, or it's day one, when nothing is live yet and Today lists the setup instead.
 */
export const goingLive = (ctx: Ctx): { name: string; by: string } | null => {
  if (isFirstDay(ctx.data)) return null
  for (const key of Object.keys(ctx.data.tools.details)) {
    const d = toolDetail(ctx.data, key)
    if (d.liveBy && toolState(ctx, key) === 'connecting') return { name: d.name, by: fmtWeekday(d.liveBy, display()) }
  }
  return null
}
/**
 * A request to the Inhouse team as listed: "New tool · asked by Priya, Nov 9" and "Live by Fri, Nov 20". One the person
 * sent (`sentHere`) says "just now" however long ago it went, as it did before C1; P2 shows `fmtAgo` from its instant.
 */
export const teamRequestLine = (q: Omit<TeamRequest, 'icon'>, now: number, sentHere: boolean): { sub: string; status: string } => {
  const d0 = display()
  return { sub: `${q.sub}, ${sentHere ? 'just now' : fmtAgo(q.at, now, d0)}`, status: q.statusAt ? `${q.status} ${fmtWeekday(q.statusAt, d0)}` : q.status }
}
/** When a tool being set up should connect, as Today's setup list and its row on Tools say it. */
const SETUP_DUE: Record<ToolSetup['due'], string> = { today: 'Connecting today', tomorrow: 'Tomorrow', 'this-week': 'This week' }
export interface SetupRow { key: string; name: string; when: string }
/** Day one's setup list: the tools being connected that have a setup entry, in that order, each with when it should connect. */
export const setupRows = (data: AgentData): SetupRow[] =>
  data.tools.beingConnected.filter(key => Object.hasOwn(data.tools.setup, key)).map(key => ({ key, name: toolDetail(data, key).name, when: SETUP_DUE[data.tools.setup[key].due] }))
/** The connected tools the agent can read right now, in display order: not paused, not disconnected. */
export const readingTools = (ctx: Ctx): string[] => ctx.data.tools.connected.filter(k => toolState(ctx, k) === 'connected')
/** The tools this morning's check read: every connected tool but one whose login had failed. Pausing one later doesn't change what was read. */
export const morningReadTools = (ctx: Ctx): string[] => ctx.data.tools.connected.filter(k => toolState(ctx, k) !== 'disconnected')
/** The Tools page's counts. `reading` is what "Connected" can honestly claim the agent reads now. */
export const toolCounts = (ctx: Ctx) => {
  const states = ctx.data.tools.connected.map(k => toolState(ctx, k))
  return {
    connected: states.length,
    reading: states.filter(x => x === 'connected').length,
    paused: states.filter(x => x === 'paused').length,
    disconnected: states.filter(x => x === 'disconnected').length,
  }
}

/** The last morning check before the one at `at`: the weekday before it (the check runs on weekdays). */
const lastCheckBefore = (at: Instant, d: Display): number => {
  let ms = at.ms
  do ms -= 86_400_000; while ([0, 6].includes(calendarOf(ms, d).weekday))
  return ms
}

export interface ToolAbility { key: 'read' | 'draft' | 'run'; icon: string; title: string; text: string; need: StageIndex; locked: boolean; tag: string }
export interface ToolView {
  key: string
  name: string
  state: ToolState
  /** The status chip: "Connected", "Access paused", "Disconnected · login expired at 5:41 AM", "Being connected". */
  statusText: string
  /** The Tools list row's second line. */
  listLine: string
  /** The tool page's "Connected" row: when and by whom, or "Not yet" while it is being connected. */
  connectedRow: string
  /** "Last read" on the tool page: today's check, the check before a failed login, or "Not yet". */
  lastRead: string
  /** Read, Draft and Do by itself: a stage tag when the stage hasn't reached it, else On, Paused, Off or Not yet. */
  abilities: ToolAbility[]
  /** Suggested questions: only while the agent can read the tool. */
  examples: string[]
}
/** When a tool was connected ("Nov 2"), or when one being connected goes live ("Live by Fri, Nov 20"). */
export const sinceLine = (d: ToolDetail, d0: Display): string => {
  if (d.since) return fmtDay(d.since, d0)
  if (d.liveBy) return `Live by ${fmtWeekday(d.liveBy, d0)}`
  throw new Error(`Tools data: "${d.name}" has no connected or going-live date.`)
}

export function toolView(ctx: Ctx, key: string): ToolView {
  const d = toolDetail(ctx.data, key)
  const state = toolState(ctx, key)
  const d0 = display()
  // `disconnected` means `tools.connection` has this tool (toolState), with when its login failed.
  const lostAt = state === 'disconnected' ? fmtTime(ctx.data.tools.connection[key]!.since, d0) : ''
  const lastRead = ctx.data.tools.lastRead[key] ?? ctx.data.tools.lastRead.default
  const readAt = fmtTime(lastRead, d0)
  const tagOf = { connected: 'On', paused: 'Paused', disconnected: 'Off', connecting: 'Not yet' }[state]
  const setup = Object.hasOwn(ctx.data.tools.setup, key) ? SETUP_DUE[ctx.data.tools.setup[key].due] : null
  const ability = (k: ToolAbility['key'], icon: string, title: string, text: string, need: StageIndex): ToolAbility =>
    ({ key: k, icon, title, text, need, locked: ctx.S < need, tag: ctx.S < need ? STAGE_TAGS[need] : tagOf })
  return {
    key, name: d.name, state,
    statusText: { connecting: 'Being connected', connected: 'Connected', paused: 'Access paused', disconnected: `Disconnected · login expired at ${lostAt}` }[state],
    // Being connected: on day one, when Today's setup list says it connects; else when it goes live ("Live by Fri, Nov 20").
    listLine: { connecting: setup ?? sinceLine(d, d0), connected: `Read ${readAt}`, paused: 'Access paused', disconnected: 'Needs reconnecting' }[state],
    connectedRow: state === 'connecting' ? 'Not yet' : `${sinceLine(d, d0)}, by your Inhouse team`,
    lastRead: state === 'connecting' ? 'Not yet' : state === 'disconnected' ? `${fmtWeekday(lastCheckBefore(lastRead, d0), d0)}, ${readAt}` : `Today, ${readAt}`,
    abilities: [
      ability('read', 'visibility', 'Read', d.read, 0),
      ability('draft', 'edit_note', 'Draft for your approval', d.draft, 1),
      ability('run', 'bolt', 'Do by itself', d.run, 2),
    ],
    examples: state === 'connected' ? d.ex : [],
  }
}

const cap1 = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)
const lower1 = (s: string) => s.charAt(0).toLowerCase() + s.slice(1)

/** Names as a sentence lists them: "Shopify, Amazon and Meta Ads" (no Oxford comma). */
export const listNames = (names: string[]) => names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`

// ---------- the person and the cap, from Settings ----------

/** The signed-in person's name: the Name they set in Settings, else the agent's current user. */
export const userName = (ctx: Pick<Ctx, 'agent' | 'data'>) => ctx.agent.settings['g:name']?.trim() || ctx.data.meta.currentUser.name
/** The name of the member a record's `by` names (records carry member ids; the name comes from the members list). */
export const byName = (data: AgentData, id: string) => data.people.members.find(m => m.id === id)?.name ?? 'A former member'
/** The first word of a name: what the greeting uses. */
export const firstName = (name: string) => name.trim().split(/\s+/)[0] ?? name

/** A money field as typed in Settings ("$400", "1,200", "$0") as dollars, or null when it isn't an amount. */
const dollarsIn = (v: string | undefined): number | null => {
  if (v === undefined || !v.trim()) return null
  const n = Number(v.replace(/[$,\s%]/g, ''))
  return Number.isFinite(n) && n >= 0 ? n : null
}
/** This month's spending cap: the Monthly cap set in Settings, else the agent's. */
export const usageCap = (ctx: Ctx): Money => {
  const typed = dollarsIn(ctx.agent.settings['s:cap'])
  return typed === null ? ctx.data.usage.cap : moneyOf(typed, ctx.data.usage.cap.currency)
}
/** The alert level, percent of the cap: set in Settings, else the agent's. */
export const usageAlertAt = (ctx: Ctx) => dollarsIn(ctx.agent.settings['s:alert']) ?? ctx.data.usage.alertAt

export interface CapStatus {
  /** What was spent this month: from the agent's data, never rescaled by the cap. */
  spent: Money
  cap: Money
  alertAt: number
  /** Spend reached the cap: routines and jobs pause. */
  reached: boolean
  /** The banner's line at the cap, from those values. */
  bannerText: string
}
/** Spend against the cap. A new cap never rewrites what was spent; only these comparisons move with it. */
export function capStatus(ctx: Ctx): CapStatus {
  const spent = ctx.data.usage.total
  const cap = usageCap(ctx)
  const alertAt = usageAlertAt(ctx)
  return {
    spent, cap, alertAt,
    reached: spent.minor >= cap.minor,
    bannerText: `Your Inhouse agent has used ${fmtMoney(spent, display())} of ${fmtMoney(cap, display())} this month, so routines and jobs are paused. Questions still work, and waiting drafts can still be approved.`,
  }
}

/**
 * The sentence under a month's amount on Usage and the note beside its cap bar. `thisMonth` with `reached`: at the cap.
 * A month's projection is its average day times 30.
 */
export function usageSummary(m: { total: Money; cap: Money; alertAt: number; daily: Money[] }, thisMonth: boolean, reached: boolean): { hint: string; capNote: string } {
  const d0 = display()
  const total = majorOf(m.total), cap = majorOf(m.cap), days = m.daily.length
  const pct = Math.min(100, Math.round(total / cap * 100)) + '%'
  const over = total > cap
  const capText = fmtMoney(m.cap, d0)
  const hint = !thisMonth
    ? over ? `Went over your ${capText} cap` : `Finished under your ${capText} cap`
    : reached
      ? `Cap reached with ${30 - days} days of the month left`
      : `On track for about ${fmtMoney(moneyOf(Math.round(total / days * 30), m.total.currency), d0)} this month, ${total / days * 30 > cap ? 'over' : 'under'} your cap`
  const capNote = !thisMonth
    ? over ? `Closed at ${Math.round(total / cap * 100)}% of the cap.` : `Closed at ${pct} of the cap. Nothing was paused.`
    : reached
      ? 'Cap reached today. Routines and jobs are paused until an admin raises it.'
      : `Admins get an email at ${m.alertAt}%. Your Inhouse agent pauses routines and jobs at the cap.`
  return { hint, capNote }
}

export function flags(ctx: Ctx) {
  const { S, agent } = ctx
  // Day one and loading are what the agent's data says (a real client starts loading), not a scenario name.
  const isFirst = isFirstDay(ctx.data)
  const isLoading = ctx.data.status === 'loading'
  // A tool's login failed: the agent's data says so (`tools.connection`), not a scenario name.
  const disc = lostTool(ctx) !== null
  // At the cap when this month's spend reached it: the Cap reached scenario's data spends exactly the cap, and a cap set
  // below the spend in Settings reaches it too.
  const cap = !isFirst && !isLoading && capStatus(ctx).reached
  return {
    isFirst, isLoading, disc, cap,
    noData: isFirst || isLoading,
    /** Routines and jobs are stopped: paused by a person (Act and up) or at the cap. */
    pausedEff: (S >= 1 && !!agent.paused) || cap,
    paused: S >= 1 && !!agent.paused,
  }
}

/** Run: Inhouse agent finished (part of) this job by itself and nobody undid it. */
export const ranByAgent = ({ S, agent }: Ctx, p: Problem) => S === 2 && !!p.done && !agent.undone[p.id]
/** Run: fully handled, nothing waits. */
export const isHandled = (ctx: Ctx, p: Problem) => ranByAgent(ctx, p) && !p.partial

/** The problems a person hasn't set aside (snoozed, dismissed or chose not to send): what Today lists and every count uses. */
export const visibleProblems = (ctx: Ctx): Problem[] => ctx.data.problems.filter(p => !ctx.agent.setAside[p.id])

export function pendingIds(ctx: Ctx): string[] {
  const { S, agent } = ctx
  if (flags(ctx).noData) return []
  return ctx.data.problems
    .filter(p => !agent.approved[p.id] && !agent.setAside[p.id] && !isHandled(ctx, p) && (S === 1 || (S === 2 && (!!p.wait || !!agent.undone[p.id]))))
    .map(p => p.id)
}

/** What the agent did by itself, without its time: "Paused the variant at {at:time}. Customer emails wait" is "Paused the variant". */
const doneLine = (done: Prose) => fmtProse({ text: done.text.split('. ')[0].replace(' at {at:time}', ''), times: done.times }, display())

export function handled(ctx: Ctx) {
  const list = ctx.data.problems.filter(p => ranByAgent(ctx, p))
  return {
    count: list.length,
    // A no-break space after a number keeps "11 units" from splitting across lines.
    summary: list.map(p => doneLine(p.done!)).join(' · ').replace(/(\d) (?=[a-z])/g, '$1\u00a0'),
  }
}

export interface TodayCopy {
  greeting: string; headline: string; headSub: string; countLabel: string; sortLabel: string
}

export function todayCopy(ctx: Ctx): TodayCopy {
  const { S } = ctx
  const f = flags(ctx)
  const n = pendingIds(ctx).length
  const h = handled(ctx).count
  const shown = visibleProblems(ctx).length
  const aside = ctx.data.problems.length - shown
  const approvedN = ctx.data.problems.filter(p => ctx.agent.approved[p.id]).length
  const total = ctx.data.problems.length
  const read = morningReadTools(ctx)
  const connected = ctx.data.tools.connected
  const missed = connected.filter(k => !read.includes(k)).map(k => toolDetail(ctx.data, k).name)
  // With nothing waiting in Act: say what happened to the drafts, so a set-aside one isn't counted as approved.
  const doneLabel = aside === 0 ? 'all approved' : approvedN ? `${approvedN} approved, ${aside} set aside` : `${aside} set aside`
  const copy = [
    {
      headline: shown ? `${shown} ${shown === 1 ? 'thing needs' : 'things need'} you today.` : 'Nothing needs you today.',
      headSub: missed.length
        ? `Your Inhouse agent read ${read.length} of your ${connected.length} tools and changed nothing. ${listNames(missed)} ${missed.length === 1 ? 'needs' : 'need'} reconnecting.`
        : `Your Inhouse agent read ${listNames(read.map(k => toolDetail(ctx.data, k).name))} and changed nothing.`,
      countLabel: `${shown} to look at`, sortLabel: 'Most urgent first',
    },
    {
      headline: n && n === total ? `${n} things need you. A fix is drafted for each.` : n ? `${n} left to approve today.` : total && shown === total ? `All ${total} approved. Nothing is waiting on you.` : 'Nothing is waiting on you.',
      headSub: 'Nothing goes out until you approve it. Money and customer messages ask you to look first.',
      countLabel: n ? `${n} drafted and waiting` : doneLabel, sortLabel: 'Most urgent first',
    },
    {
      headline: `${h} handled before you woke up. ${n} need${n === 1 ? 's' : ''} you.`,
      headSub: 'Money and customer messages always wait for a person. Every step is logged and can be undone.',
      countLabel: `${n} waiting on you`, sortLabel: 'Exceptions first',
    },
  ][S]
  let headSub = copy.headSub, headline = copy.headline
  if (f.paused) headSub = 'Your Inhouse agent is paused, so routines and jobs are stopped. Questions still work.'
  if (f.cap) headSub = 'Routines and jobs are paused at the spending cap. Drafts already waiting can still be approved.'
  if (f.isFirst) { headline = 'Your Inhouse agent is being set up.'; headSub = 'Your Inhouse team connects each tool for you. There is nothing to install.' }
  if (f.isLoading) { headline = 'Your Inhouse agent is reading your tools.'; headSub = 'The morning check takes about two minutes. Your list appears as soon as it finishes.' }
  const first = firstName(userName(ctx))
  return { ...copy, headline, headSub, greeting: f.isFirst ? `Welcome, ${first}.` : `Good morning, ${first}.` }
}

export type Tone = 'grey' | 'blue' | 'amber' | 'ink'
/** The text color class for each tone. */
export const TONE_TEXT: Record<Tone, string> = { grey: 'text-foreground-3', blue: 'text-brand', amber: 'text-warning-text', ink: 'text-foreground-2' }

export interface IssueCard {
  problem: Problem
  status: string
  statusIcon: string
  tone: Tone
  /** Black button: one-tap Approve for low risk, Review (opens the panel) for money or customers. */
  primary: 'Approve' | 'Review' | null
  /** Grey button, shown only when there is no primary. */
  quiet: 'Ask about this' | 'Undo' | 'Review' | null
  /** Run: what a waiting draft's card says on its draft sheet besides the draft ("Paused · emails wait for you"). */
  sheetNote: string | null
  handled: boolean
  dimmed: boolean
}

export function issueCards(ctx: Ctx): IssueCard[] {
  const { S, agent } = ctx
  const cards = visibleProblems(ctx).map((p): IssueCard => {
    const sens = !!(p.draft.money || p.draft.customer)
    const at = agent.approved[p.id]
    if (at) {
      return { problem: p, status: `Approved by ${firstName(byName(ctx.data, at.by))} at ${fmtTime(at.at, display())}${p.draft.rev || agent.sent[p.id] ? '' : ' · going out'}`, statusIcon: 'check_circle', tone: 'ink', primary: null, quiet: null, sheetNote: null, handled: false, dimmed: true }
    }
    if (S === 0) return { problem: p, status: `Suggested: ${p.next}`, statusIcon: 'lightbulb', tone: 'grey', primary: null, quiet: 'Ask about this', sheetNote: null, handled: false, dimmed: false }
    if (isHandled(ctx, p)) return { problem: p, status: 'Handled by Inhouse agent', statusIcon: 'check_circle', tone: 'blue', primary: null, quiet: 'Undo', sheetNote: null, handled: true, dimmed: true }
    if (S === 2 && agent.undone[p.id] && !p.wait) return { problem: p, status: 'Undone · back to you', statusIcon: 'undo', tone: 'grey', primary: null, quiet: 'Review', sheetNote: 'Undone · back to you', handled: false, dimmed: false }
    const part = ranByAgent(ctx, p) && p.partial
    return {
      problem: p,
      status: part ? p.partialShort! : (S === 2 || sens) && p.wait ? `Drafted · ${p.wait}` : 'Drafted · ready to approve',
      statusIcon: S === 2 || sens ? 'front_hand' : 'edit_note',
      tone: S === 2 || sens ? 'amber' : 'blue',
      primary: sens ? 'Review' : 'Approve', quiet: null, sheetNote: part ? p.partialShort! : null, handled: false, dimmed: false,
    }
  })
  if (S === 2) cards.sort((a, b) => Number(a.handled) - Number(b.handled))
  return cards
}

export type DraftMode = 'watch' | 'waiting' | 'approved' | 'handled'

export interface DraftView {
  problem: Problem
  mode: DraftMode
  draftTitle: string
  lines: [string, string][]
  body: string | null
  bodyLabel: string | null
  /** "Spends money" or "Goes to customers", or null for low risk. */
  waitsLabel: string | null
  /** What the draft is ("Email", "Purchase order"): the Today sheet's header and the panel's document label. */
  kind: string
  /** One line for the Today sheet, never cut. */
  summary: string
  /** Where it goes, for the panel's progress line ("Kestrel"). Null shows "Sent". */
  destination: string | null
  /** The sources' names, deduplicated ("Amazon · Xero"). */
  sourceNames: string
  cta: string
  memory: string | null
  doneNote: string | null
  approverNote: string | null
  askApprover: string | null
  approvedAt: string | null
  sent: boolean
  /** Reversible drafts keep Undo; others lose it once sent. */
  canUndo: boolean
  doneText: string
  approvedLine: string
  meta: string
  /** The full name of who approved it, for the avatar: `meta` shows only the first name. */
  metaBy: string
  suggestedNext: string
}

export function draftView(ctx: Ctx, id: string): DraftView {
  const { S, agent } = ctx
  const p = problemById(ctx.data, id)
  const dr = p.draft
  const rec = agent.approved[id]
  // An approved item keeps what it was when approved: a later stage switch or undo doesn't change its lines or note.
  const part = rec ? rec.partial : ranByAgent(ctx, p) && !!p.partial
  const at = rec ? fmtTime(rec.at, display()) : null
  const sent = !!agent.sent[id]
  // Approved items show the wording taken at approval time, so history never rewrites itself.
  const title = rec ? rec.title : part && dr.runTitle ? dr.runTitle : dr.title
  const srcLine = p.sources.map(s => s.name).filter((v, i, a) => a.indexOf(v) === i).join(' · ')
  const lines = part && dr.runLines ? dr.runLines : dr.lines
  return {
    problem: p,
    mode: S === 0 ? 'watch' : at ? 'approved' : isHandled(ctx, p) ? 'handled' : 'waiting',
    draftTitle: title,
    lines,
    // A draft with no text of its own takes a note once a person writes one.
    body: agent.edits[id] ?? dr.body ?? null,
    bodyLabel: dr.bodyLabel ?? (agent.edits[id] !== undefined ? 'Your note' : null),
    waitsLabel: dr.money ? 'Spends money' : dr.customer ? 'Goes to customers' : null,
    kind: dr.kind ?? (dr.body ? 'Email' : 'Draft'),
    summary: dr.summary ?? (lines[0] ? `${lines[0][0]}: ${lines[0][1]}` : ''),
    destination: dr.destination ?? null,
    sourceNames: srcLine,
    cta: dr.cta || 'Approve',
    memory: S >= 1 && dr.memory ? dr.memory : null,
    doneNote: part && dr.doneNote ? fmtProse(dr.doneNote, display()) : null,
    approverNote: S >= 1 && dr.approver ? dr.approver : null,
    askApprover: S >= 1 && dr.ask ? dr.ask : null,
    approvedAt: at,
    sent,
    canUndo: !!dr.rev || !sent,
    doneText: rec ? (!dr.rev && !sent ? `Approved: ${lower1(title)}` : rec.doneText) : (part && p.runDoneText) || p.doneText,
    approvedLine: `Approved by ${firstName(rec ? byName(ctx.data, rec.by) : userName(ctx))} at ${at}${dr.rev ? '' : sent ? ' · sent' : ' · goes out in a few seconds'} · logged in Activity`,
    meta: `${firstName(rec ? byName(ctx.data, rec.by) : userName(ctx))} · ${at}${dr.rev ? '' : sent ? ' · sent' : ' · going out'}`,
    metaBy: rec ? byName(ctx.data, rec.by) : userName(ctx),
    suggestedNext: cap1(p.next),
  }
}

/**
 * The one risk text the cards and the panel show: what approving it does that a person should look at ("Spends money",
 * "Goes to customers"). Null when it's neither, which is low risk unless the draft waits for another reason.
 */
export const riskLabel = (dv: DraftView): string | null => {
  const amount = dv.problem.draft.amount
  // The amount reads only on a draft that is about money: low risk is decided by `money` and `customer`.
  if (!amount || !dv.problem.draft.money) return dv.waitsLabel
  return `${amount.direction === 'claim' ? 'Claims' : 'Spends'} ${fmtMoney(amount.money, display())}`
}

/** The icon for a draft's kind, on the Today sheet's small tile. */
export const kindIcon = (kind: string): string =>
  /mail|email/i.test(kind) ? 'mail' : /purchase order/i.test(kind) ? 'inventory_2' : /case/i.test(kind) ? 'description'
    : /ticket/i.test(kind) ? 'support_agent' : /shopify/i.test(kind) ? 'storefront' : 'edit_note'

/**
 * Exactly the waiting drafts Today offers one-tap Approve for: no money and no customers involved, and not a Run job a
 * person undid (Today offers Review for those).
 */
export const lowRiskIds = (ctx: Ctx): string[] => {
  const pending = new Set(pendingIds(ctx))
  return issueCards(ctx).filter(c => c.primary === 'Approve' && pending.has(c.problem.id)).map(c => c.problem.id)
}

/** The money at stake on a problem's card, in its minor unit: what the money sort compares. */
export const amountOf = (p: Problem) => p.cost.minor

// ---------- Activity ----------

export type ActivityKind = 'read' | 'change' | 'needs' | 'problem'
export interface ActivityRow {
  key: string
  /** The day it's listed under, as shown ("Today", "Fri, Nov 13"). */
  day: string
  /** The time, as shown. Never sort on it: use `at`. */
  t: string
  /** When: what a day's rows sort by. */
  at: Instant
  /** When a person did it on the real clock: breaks a tie on `at` (the demo clock stops at 11:59 AM). */
  loggedAt?: Instant
  icon: string
  text: string
  who: string
  /** The full name of the person who did it, for the avatar, when `who` shows only the first name. */
  whoBy?: string
  kind: ActivityKind
  /** What `getTrace` takes. Missing when the agent has no run to show. */
  trace?: string
  /** Background and text color classes for the row's icon tile. */
  iconTone: string
  why: string
  result: string
  by: string
  fix?: string
  /** What Undo reverses, when it still applies. */
  undo?: { type: 'approval' | 'handled' | 'setAside'; id: string }
  review?: string
}

export function activityRows(ctx: Ctx): ActivityRow[] {
  const { S, agent } = ctx
  const f = flags(ctx)
  const rows: Omit<ActivityRow, 'key'>[] = []
  const d0 = display()
  const base = { day: 'Today', iconTone: 'bg-background text-foreground-3' }
  /** A row's shown time and its instant. */
  const when = (at: Instant) => ({ t: fmtTime(at, d0), at })
  for (const p of ctx.data.problems.filter(x => agent.approved[x.id])) {
    const dv = draftView(ctx, p.id)
    const { at, by: byId, loggedAt } = agent.approved[p.id]
    const by = byName(ctx.data, byId)
    rows.push({ ...base, ...when(at), loggedAt, icon: 'check_circle', text: dv.doneText, who: `${firstName(by)} approved`, whoBy: by, kind: 'change', trace: p.trace, iconTone: 'bg-background text-foreground',
      undo: dv.canUndo ? { type: 'approval', id: p.id } : undefined,
      why: `${p.title}.`, result: dv.doneText + (dv.canUndo ? '. You can still undo it.' : '. It has gone out, so it can no longer be undone.'),
      by: `Drafted by Inhouse agent at ${fmtTime(p.draftedAt, d0)}, approved by ${by} at ${fmtTime(at, d0)}.` })
  }
  if (S === 2) {
    for (const p of ctx.data.problems.filter(x => ranByAgent(ctx, x)).reverse()) {
      const done = p.done!
      rows.push({ ...base, ...when(done.times.at), icon: 'bolt', text: doneLine(done), who: 'Inhouse agent, inside your limits', kind: 'change', trace: p.trace,
        iconTone: 'bg-brand-tint text-brand', undo: { type: 'handled', id: p.id },
        why: `${p.title}.`, result: `${fmtProse(done, d0)}.`, by: 'Inhouse agent, by itself. This job is switched on in Run limits.' })
    }
  }
  for (const id of pendingIds(ctx)) {
    const p = problemById(ctx.data, id), dv = draftView(ctx, id)
    rows.push({ ...base, ...when(p.draftedAt), icon: 'front_hand', text: `Drafted: ${lower1(dv.draftTitle)}`, who: 'Waits for you', kind: 'needs', trace: p.trace,
      iconTone: 'bg-warning-tint text-warning-text', review: id,
      why: `${p.title}.`, result: 'Nothing has gone out. The draft waits in Approvals' + (dv.waitsLabel ? ` (${dv.waitsLabel.toLowerCase()}).` : '.'),
      by: 'Drafted by Inhouse agent. ' + (p.draft.approver ? p.draft.approver.split('. ')[0] + '.' : 'Anyone who approves can send it.') })
  }
  // Every set-aside problem is logged too, with Undo, as the toast offered.
  for (const p of ctx.data.problems) {
    const rec = agent.setAside[p.id]
    if (!rec) continue
    const dv = draftView(ctx, p.id)
    const line = {
      snoozed: { icon: 'snooze', text: `Snoozed: ${p.title}`, result: 'Off Today and Approvals until tomorrow. Nothing has gone out.' },
      dismissed: { icon: 'do_not_disturb_on', text: `Dismissed: ${p.title}`, result: "Marked as not a problem, so it won't come back today. Nothing has gone out." },
      declined: { icon: 'cancel_schedule_send', text: `Not sent: ${lower1(dv.draftTitle)}`, result: 'The draft left Approvals and nothing went out.' },
    }[rec.reason]
    rows.push({ ...base, ...when(rec.at), loggedAt: rec.loggedAt, icon: line.icon, text: line.text, who: firstName(byName(ctx.data, rec.by)), whoBy: byName(ctx.data, rec.by), kind: 'change', trace: p.trace, iconTone: 'bg-background text-foreground-3',
      undo: { type: 'setAside', id: p.id }, why: `${p.title}.`, result: line.result, by: `${byName(ctx.data, rec.by)}, at ${fmtTime(rec.at, d0)}. Drafted by Inhouse agent at ${fmtTime(p.draftedAt, d0)}.` })
  }
  const { today, earlier } = ctx.data.activity
  const morning = today[0]
  if (morning) {
    if (f.disc) {
      const { key: tool, since: at } = lostTool(ctx)!
      const name = toolDetail(ctx.data, tool).name
      rows.push({ ...base, ...when(morning.at), icon: 'link_off', text: `Couldn't read ${name}: the login expired`, who: 'Skipped', kind: 'problem', trace: morning.trace,
        iconTone: 'bg-destructive-tint text-destructive', why: `The ${name} login expired at ${fmtTime(at, d0)}.`,
        result: "It tried 3 times, then carried on without it. Customer issues may be missing from today's list. Nothing was changed.",
        by: 'Inhouse agent, on schedule.', fix: `Reconnect ${name} in Tools. It reads it again at the next check.` })
    }
    // The morning line's counts and tool names come from what the check read and found.
    const read = morningReadTools(ctx)
    // With no tool connected yet (day one), the morning check read nothing, so it has no line.
    if (read.length) {
      const fill = fillActivity(ctx)
      rows.push({ ...base, ...when(morning.at), icon: 'visibility', kind: 'read', trace: morning.trace, who: morning.who, why: morning.why, by: fmtProse(morning.by, d0),
        text: fill(morning.text), result: fill(morning.result) })
      // The routines that ran today, after the morning check (none on day one: nothing was connected to read).
      for (const e of today.slice(1)) {
        if (e.minStage === 'Act' && S < 1) continue
        rows.push({ ...base, ...when(e.at), icon: 'visibility', kind: e.kind, trace: e.trace, who: e.who, why: e.why, by: fmtProse(e.by, d0), text: e.text, result: e.result })
      }
    }
  }
  for (const e of earlier) {
    if (e.minStage === 'Act' && S < 1) continue
    const change = e.kind === 'change'
    rows.push({ day: fmtWeekday(e.at, d0), ...when(e.at), icon: change ? 'check_circle' : e.text.startsWith('Saved the weekly') ? 'summarize' : 'visibility', text: e.text, who: e.who,
      kind: e.kind, trace: e.trace, iconTone: change ? 'bg-background text-foreground' : 'bg-background text-foreground-3', why: e.why, result: e.result, by: fmtProse(e.by, d0) })
  }
  return rows.map(r => ({ ...r, key: `${r.day}|${r.t}|${r.text}` }))
}

/** Group by day (order of first appearance), newest first inside a day. */
export function groupByDay(rows: ActivityRow[]) {
  const days: { label: string; rows: ActivityRow[] }[] = []
  for (const r of rows) {
    let g = days.find(d => d.label === r.day)
    if (!g) { g = { label: r.day, rows: [] }; days.push(g) }
    g.rows.push(r)
  }
  for (const g of days) {
    g.rows = g.rows.map((r, i) => [r, i] as const).sort((a, b) => b[0].at.ms - a[0].at.ms || (b[0].loggedAt?.ms ?? 0) - (a[0].loggedAt?.ms ?? 0) || a[1] - b[1]).map(x => x[0])
  }
  return days
}

// ---------- Chats ----------

/**
 * The conversation a chat starts with, for the current stage. Ids come from the chat, the turn and the part
 * index in the agent's full thread, so they stay the same when the stage changes or an approval event appears.
 */
export function chatMessages(ctx: Ctx, chatId: string): ChatMessage[] {
  const { S, agent } = ctx
  const stage = STAGE_TAGS[S]
  const out: ChatMessage[] = []
  ctx.data.chat.chats.find(c => c.id === chatId)?.turns.forEach((turn, t) => {
    if (turn.role === 'user') { out.push({ id: `${chatId}-t${t}`, role: 'user', text: turn.text }); return }
    if (turn.stage && turn.stage !== stage) return
    // The approval note goes after the whole turn, so the turn's parts stay together (one set of thumbs, one Regenerate).
    let note: ChatMessage | undefined
    turn.parts.forEach((part, k) => {
      out.push({ id: `${chatId}-t${t}-p${k}`, role: 'agent', trace: turn.trace, model: turn.model, part })
      if (part.type !== 'approval') return
      const at = agent.approved[part.problemId]
      if (at) note = { id: `${chatId}-t${t}-approved`, role: 'event', text: `${firstName(byName(ctx.data, at.by))} approved: ${lower1(at.title)} · ${fmtTime(at.at, display())}` }
    })
    if (note) out.push(note)
  })
  return out
}

/** "Every weekday at 6:00 AM" style schedule sentence. */
export const whenOf = (r: { freq?: string; day?: string; time?: ClockTime }) =>
  !r.freq || !r.time ? '' : (r.freq === 'Daily' ? (r.day === 'Weekdays' ? 'Every weekday' : 'Every day') : `Every ${r.day}`) + ` at ${fmtClock(r.time, display())}`

/** A routine's last run: "Last run today at 6:00 AM · found 6 things", "Last run Fri, Nov 13 · saved to Library". */
export const lastRunLine = (last: { at: Instant; result?: string }, now: number): string => {
  const d0 = display()
  const day = fmtDayWord(last.at, now, d0)
  return `Last run ${day === 'today' ? `today at ${fmtTime(last.at, d0)}` : day}${last.result ? ` · ${last.result}` : ''}`
}

/** Up to two capital letters from a name. */
export const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join('') || '?'

/**
 * The team member a label points at: an id, a full name, or text starting with a full name or first name ("Dana
 * approved"). The signed-in person's own label (`me`, their name as set in Settings) is always them, never a teammate
 * who shares the first name. A line that shows only a first name passes the record's full name here, not the label.
 */
export const memberFor = (data: AgentData, who: string, me: string) => {
  const { members } = data.people
  const self = members.find(m => m.id === data.meta.currentUser.id)
  // Yourself on your full name (the Name setting, as records written now carry it): "Dana" doesn't take Dana Kim's lines.
  if (self && who === me) return self
  return members.find(m => m.id === who || m.name === who)
    ?? members.find(m => who.startsWith(m.name) || who.split(/\s+/)[0] === m.name.split(' ')[0])
}

/** A member's photo: what they uploaded, else the sample photo. Null when they removed it or have none. */
export const photoOf = (data: AgentData, id: string): string | null =>
  data.people.members.find(m => m.id === id)?.photo || null

/** The effort choices of a model, as the engine names them and as the Settings dropdown shows them. */
export const EFFORTS: [Effort, string][] = [['low', 'Low'], ['medium', 'Medium'], ['high', 'High'], ['xhigh', 'Extra high'], ['max', 'Highest']]
/** The settings key of a mode's effort (value: its label in EFFORTS) and of its on switch (value: "off" when the team can't use it). */
export const modeEffortKey = (id: string) => `tm:${id}:effort`
export const modeOnKey = (id: string) => `tm:${id}:on`

/** Every model, strongest first, with the effort and on/off an admin set in Settings. */
export const thinkingModes = (data: AgentData, saved: Record<string, string>): ThinkingMode[] =>
  data.models.map(m => ({
    ...m,
    effort: EFFORTS.find(([, label]) => label === saved[modeEffortKey(m.id)])?.[0] ?? m.effort,
    on: saved[modeOnKey(m.id)] !== 'off',
  }))

/** The model a new question uses: the saved Default model if it is on, else the agent's default, else the first mode that is on. */
export const defaultModeId = (data: AgentData, saved: Record<string, string>): string => {
  const on = thinkingModes(data, saved).filter(m => m.on)
  return (on.find(m => m.label === saved['g:mode']) ?? on.find(m => m.id === data.defaultModel) ?? on[0])?.id ?? data.defaultModel
}

/** The mode a question uses: the one picked in the composer if the team can still use it, else the default. Undefined when the agent has no models. */
export const activeMode = (data: AgentData, saved: Record<string, string>, picked: string | null): ThinkingMode | undefined => {
  const modes = thinkingModes(data, saved)
  const id = modes.find(m => m.id === picked && m.on)?.id ?? defaultModeId(data, saved)
  return modes.find(m => m.id === id) ?? modes[0]
}


/** Fills the {read}, {found} and {readNames} placeholders in the sample morning-check text. */
export function fillActivity(ctx: Ctx) {
  const read = morningReadTools(ctx)
  return (t: string) => t.replace('{read}', String(read.length)).replace('{found}', String(ctx.data.problems.length))
    .replace('{readNames}', listNames(read.map(k => toolDetail(ctx.data, k).name)))
}

/** One line in a routine's last runs. `trace` is set only when the agent has the run's steps. */
export interface RoutineRunLine { key: string; day: string; t: string; text: string; trace?: string; inActivity: boolean }

/**
 * A routine's last runs, newest first: the Run nows from this session, then the Activity lines it wrote (matched by
 * its name), else the sample data's last-run note.
 */
export function routineRuns(ctx: Ctx, r: { id: string; name: string; last?: { at: Instant; result: string } }): RoutineRunLine[] {
  const { S, agent, data } = ctx
  const d0 = display()
  const now = agent.routineRuns.filter(x => x.routine === r.id)
    .map((x, i): RoutineRunLine => ({ key: `now|${i}|${fmtTime(x.at, d0)}`, day: 'Today', t: fmtTime(x.at, d0), text: x.result ? `Run now · ${x.result}` : 'Run now', trace: x.trace, inActivity: false }))
  const name = r.name.toLowerCase()
  const fill = fillActivity(ctx)
  const lines = [...data.activity.today.map(l => ({ ...l, day: 'Today' })), ...data.activity.earlier.map(l => ({ ...l, day: fmtWeekday(l.at, d0) }))]
    .filter(l => !(l.minStage === 'Act' && S < 1) && l.text.toLowerCase().includes(name))
    .map((l): RoutineRunLine => ({ key: `${l.day}|${fmtTime(l.at, d0)}|${l.text}`, day: l.day, t: fmtTime(l.at, d0), text: fill(l.text), trace: l.trace, inActivity: true }))
  if (lines.length === 0 && r.last) lines.push({ key: 'last', day: '', t: '', text: lastRunLine(r.last, nowOf()), inActivity: false })
  return [...now, ...lines]
}
