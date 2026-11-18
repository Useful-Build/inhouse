// Pure selectors: stage + scenario + agent state -> what the screens show.
import { photoKey } from '../agent/types'
import type { AgentData, AgentState, ChatMessage, Effort, Problem, Scenario, StageIndex, ThinkingMode, ToolDetail } from '../agent/types'
import { DEMO_START, TIME_RE, fmtWeekday, minuteOfTime } from '../agent/clock'

export const STAGE_TAGS = ['Watch', 'Act', 'Run'] as const

export interface Ctx { S: StageIndex; scenario: Scenario; agent: AgentState; data: AgentData }

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
 * A tool's state now. `connecting`: the Inhouse team is still connecting it. `disconnected`: its login failed (the Tool
 * disconnected scenario). `paused`: a person paused the agent's access. `connected`: the agent reads it.
 */
export type ToolState = 'connecting' | 'connected' | 'paused' | 'disconnected'
export const toolState = (ctx: Ctx, key: string): ToolState => {
  const d = toolDetail(ctx.data, key)
  if (d.progress || !ctx.data.tools.connected.includes(key)) return 'connecting'
  if (ctx.scenario === 'Tool disconnected' && key === ctx.data.scenarios.toolDisconnected.tool) return 'disconnected'
  if (ctx.agent.toolPaused[key]) return 'paused'
  return 'connected'
}
/**
 * The tool the Inhouse team is connecting now, from tools.json (its `since` is "Live by <date>"), or null: none is, or
 * it's First day, when nothing is live yet and Today lists the setup instead.
 */
export const goingLive = (ctx: Ctx): { name: string; by: string } | null => {
  if (ctx.scenario === 'First day') return null
  for (const key of Object.keys(ctx.data.tools.details)) {
    const d = toolDetail(ctx.data, key)
    const by = /^Live by (.+)$/.exec(d.since)?.[1]
    if (by && toolState(ctx, key) === 'connecting') return { name: d.name, by }
  }
  return null
}
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

/** The last morning check before today's: the weekday before the demo's Monday (the check runs on weekdays). */
const lastCheckBefore = (): Date => {
  const d = new Date(DEMO_START)
  do d.setDate(d.getDate() - 1); while (d.getDay() === 0 || d.getDay() === 6)
  return d
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
export function toolView(ctx: Ctx, key: string): ToolView {
  const d = toolDetail(ctx.data, key)
  const state = toolState(ctx, key)
  const { at } = ctx.data.scenarios.toolDisconnected
  const readAt = ctx.data.tools.lastRead[key] ?? ctx.data.tools.lastRead.default
  const tagOf = { connected: 'On', paused: 'Paused', disconnected: 'Off', connecting: 'Not yet' }[state]
  const ability = (k: ToolAbility['key'], icon: string, title: string, text: string, need: StageIndex): ToolAbility =>
    ({ key: k, icon, title, text, need, locked: ctx.S < need, tag: ctx.S < need ? STAGE_TAGS[need] : tagOf })
  return {
    key, name: d.name, state,
    statusText: { connecting: 'Being connected', connected: 'Connected', paused: 'Access paused', disconnected: `Disconnected · login expired at ${at}` }[state],
    // Being connected: on day one, when Today's setup list says it connects; else when it goes live ("Live by Fri, Nov 20").
    listLine: { connecting: (ctx.scenario === 'First day' && ctx.data.scenarios.firstDay.setup.find(([n]) => n === d.name)?.[1]) || d.since, connected: `Read ${readAt}`, paused: 'Access paused', disconnected: 'Needs reconnecting' }[state],
    connectedRow: state === 'connecting' ? 'Not yet' : `${d.since}, by your Inhouse team`,
    lastRead: state === 'connecting' ? 'Not yet' : state === 'disconnected' ? `${fmtWeekday(lastCheckBefore())}, ${readAt}` : `Today, ${readAt}`,
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
/** The first word of a name: what the greeting uses. */
export const firstName = (name: string) => name.trim().split(/\s+/)[0] ?? name

/** A money field as typed in Settings ("$400", "1,200", "$0") as dollars, or null when it isn't an amount. */
const dollarsIn = (v: string | undefined): number | null => {
  if (v === undefined || !v.trim()) return null
  const n = Number(v.replace(/[$,\s%]/g, ''))
  return Number.isFinite(n) && n >= 0 ? n : null
}
/** This month's spending cap: the Monthly cap set in Settings, else the agent's. */
export const usageCap = (ctx: Ctx) => dollarsIn(ctx.agent.settings['s:cap']) ?? ctx.data.usage.cap
/** The alert level, percent of the cap: set in Settings, else the agent's. */
export const usageAlertAt = (ctx: Ctx) => dollarsIn(ctx.agent.settings['s:alert']) ?? ctx.data.usage.alertAt

const usd = (n: number) => '$' + n.toLocaleString('en-US', { minimumFractionDigits: Number.isInteger(n) ? 0 : 2, maximumFractionDigits: 2 })
export interface CapStatus {
  /** What was spent this month: from the agent's data, never rescaled by the cap. */
  spent: number
  cap: number
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
    reached: spent >= cap,
    bannerText: `Your Inhouse agent has used ${usd(spent)} of ${usd(cap)} this month, so routines and jobs are paused. Questions still work, and waiting drafts can still be approved.`,
  }
}

export function flags(ctx: Ctx) {
  const { S, scenario, agent } = ctx
  const isFirst = scenario === 'First day'
  // Loading is the agent's data status (a real client starts there), not a scenario name.
  const isLoading = ctx.data.status === 'loading'
  const disc = scenario === 'Tool disconnected'
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

/** What the agent did by itself, without its time: "Paused the variant at 6:04 AM. Customer emails wait" is "Paused the variant". */
const doneLine = (p: Problem) => p.done!.split('. ')[0].replace(new RegExp(' at ' + TIME_RE.source), '')

export function handled(ctx: Ctx) {
  const list = ctx.data.problems.filter(p => ranByAgent(ctx, p))
  return {
    count: list.length,
    // A no-break space after a number keeps "11 units" from splitting across lines.
    summary: list.map(p => doneLine(p)).join(' · ').replace(/(\d) (?=[a-z])/g, '$1\u00a0'),
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
  handled: boolean
  dimmed: boolean
}

export function issueCards(ctx: Ctx): IssueCard[] {
  const { S, agent } = ctx
  const cards = visibleProblems(ctx).map((p): IssueCard => {
    const sens = !!(p.draft.money || p.draft.customer)
    const at = agent.approved[p.id]
    if (at) {
      return { problem: p, status: `Approved by ${firstName(at.by)} at ${at.at}${p.draft.rev || agent.sent[p.id] ? '' : ' · going out'}`, statusIcon: 'check_circle', tone: 'ink', primary: null, quiet: null, handled: false, dimmed: true }
    }
    if (S === 0) return { problem: p, status: `Suggested: ${p.next}`, statusIcon: 'lightbulb', tone: 'grey', primary: null, quiet: 'Ask about this', handled: false, dimmed: false }
    if (isHandled(ctx, p)) return { problem: p, status: 'Handled by Inhouse agent', statusIcon: 'check_circle', tone: 'blue', primary: null, quiet: 'Undo', handled: true, dimmed: true }
    if (S === 2 && agent.undone[p.id] && !p.wait) return { problem: p, status: 'Undone · back to you', statusIcon: 'undo', tone: 'grey', primary: null, quiet: 'Review', handled: false, dimmed: false }
    const part = ranByAgent(ctx, p) && p.partial
    return {
      problem: p,
      status: part ? p.partialShort! : (S === 2 || sens) && p.wait ? `Drafted · ${p.wait}` : 'Drafted · ready to approve',
      statusIcon: S === 2 || sens ? 'front_hand' : 'edit_note',
      tone: S === 2 || sens ? 'amber' : 'blue',
      primary: sens ? 'Review' : 'Approve', quiet: null, handled: false, dimmed: false,
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
  cta: string
  memory: string | null
  doneNote: string | null
  approverNote: string | null
  askApprover: string | null
  /** Foot note on the Approvals card: usual approver, or the sources. */
  footNote: string
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
  const at = rec?.at ?? null
  const sent = !!agent.sent[id]
  // Approved items show the wording taken at approval time, so history never rewrites itself.
  const title = rec ? rec.title : part && dr.runTitle ? dr.runTitle : dr.title
  const srcLine = p.sources.map(s => s.name).filter((v, i, a) => a.indexOf(v) === i).join(' · ')
  return {
    problem: p,
    mode: S === 0 ? 'watch' : at ? 'approved' : isHandled(ctx, p) ? 'handled' : 'waiting',
    draftTitle: title,
    lines: part && dr.runLines ? dr.runLines : dr.lines,
    // A draft with no text of its own takes a note once a person writes one.
    body: agent.edits[id] ?? dr.body ?? null,
    bodyLabel: dr.bodyLabel ?? (agent.edits[id] !== undefined ? 'Your note' : null),
    waitsLabel: dr.money ? 'Spends money' : dr.customer ? 'Goes to customers' : null,
    cta: dr.cta || 'Approve',
    memory: S >= 1 && dr.memory ? dr.memory : null,
    doneNote: part && dr.doneNote ? dr.doneNote : null,
    approverNote: S >= 1 && dr.approver ? dr.approver : null,
    askApprover: S >= 1 && dr.ask ? dr.ask : null,
    footNote: dr.approver ? dr.approver.split('. ')[0] + '.' : `From ${srcLine}`,
    approvedAt: at,
    sent,
    canUndo: !!dr.rev || !sent,
    doneText: rec ? (!dr.rev && !sent ? `Approved: ${lower1(title)}` : rec.doneText) : (part && p.runDoneText) || p.doneText,
    approvedLine: `Approved by ${firstName(rec?.by ?? userName(ctx))} at ${at}${dr.rev ? '' : sent ? ' · sent' : ' · goes out in a few seconds'} · logged in Activity`,
    meta: `${firstName(rec?.by ?? userName(ctx))} · ${at}${dr.rev ? '' : sent ? ' · sent' : ' · going out'}`,
    metaBy: rec?.by ?? userName(ctx),
    suggestedNext: cap1(p.next),
  }
}


/**
 * Exactly the waiting drafts Today offers one-tap Approve for: no money and no customers involved, and not a Run job a
 * person undid (Today offers Review for those).
 */
export const lowRiskIds = (ctx: Ctx): string[] => {
  const pending = new Set(pendingIds(ctx))
  return issueCards(ctx).filter(c => c.primary === 'Approve' && pending.has(c.problem.id)).map(c => c.problem.id)
}

/** The money figure on a problem's card, as a number ("$8,400" is 8400). */
export const amountOf = (p: Problem) => Number(p.cost.replace(/[^\d.]/g, ''))

// ---------- Activity ----------

export type ActivityKind = 'read' | 'change' | 'needs' | 'problem'
export interface ActivityRow {
  key: string
  day: string
  /** Shown. Never sort on it: use `atMin`. */
  t: string
  /** Minutes since midnight: what a day's rows sort by. */
  atMin: number
  /** Epoch ms of something a person did: breaks a tie on `atMin` (the demo clock stops at 11:59 AM). */
  ms?: number
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
  const base = { day: 'Today', iconTone: 'bg-background text-foreground-3' }
  for (const p of ctx.data.problems.filter(x => agent.approved[x.id])) {
    const dv = draftView(ctx, p.id)
    const { at, atMin, by, ms } = agent.approved[p.id]
    rows.push({ ...base, t: at, atMin, ms, icon: 'check_circle', text: dv.doneText, who: `${firstName(by)} approved`, whoBy: by, kind: 'change', trace: p.trace, iconTone: 'bg-background text-foreground',
      undo: dv.canUndo ? { type: 'approval', id: p.id } : undefined,
      why: `${p.title}.`, result: dv.doneText + (dv.canUndo ? '. You can still undo it.' : '. It has gone out, so it can no longer be undone.'),
      by: `Drafted by Inhouse agent at ${p.draftedAt}, approved by ${by} at ${at}.` })
  }
  if (S === 2) {
    for (const p of ctx.data.problems.filter(x => ranByAgent(ctx, x)).reverse()) {
      const t = TIME_RE.exec(p.done!)
      if (!t) throw new Error(`Sample data: problem "${p.id}" says what it did with no time ("${p.done}").`)
      rows.push({ ...base, t: t[0], atMin: minuteOfTime(t[0]), icon: 'bolt', text: doneLine(p), who: 'Inhouse agent, inside your limits', kind: 'change', trace: p.trace,
        iconTone: 'bg-brand-tint text-brand', undo: { type: 'handled', id: p.id },
        why: `${p.title}.`, result: `${p.done}.`, by: 'Inhouse agent, by itself. This job is switched on in Run limits.' })
    }
  }
  for (const id of pendingIds(ctx)) {
    const p = problemById(ctx.data, id), dv = draftView(ctx, id)
    rows.push({ ...base, t: p.draftedAt, atMin: p.draftedMin, icon: 'front_hand', text: `Drafted: ${lower1(dv.draftTitle)}`, who: 'Waits for you', kind: 'needs', trace: p.trace,
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
    rows.push({ ...base, t: rec.at, atMin: rec.atMin, ms: rec.ms, icon: line.icon, text: line.text, who: firstName(rec.by), whoBy: rec.by, kind: 'change', trace: p.trace, iconTone: 'bg-background text-foreground-3',
      undo: { type: 'setAside', id: p.id }, why: `${p.title}.`, result: line.result, by: `${rec.by}, at ${rec.at}. Drafted by Inhouse agent at ${p.draftedAt}.` })
  }
  const { today, earlier } = ctx.data.activity
  const morning = today[0]
  if (morning) {
    if (f.disc) {
      const { tool, at } = ctx.data.scenarios.toolDisconnected
      const name = toolDetail(ctx.data, tool).name
      rows.push({ ...base, t: morning.t, atMin: morning.atMin, icon: 'link_off', text: `Couldn't read ${name}: the login expired`, who: 'Skipped', kind: 'problem', trace: morning.trace,
        iconTone: 'bg-destructive-tint text-destructive', why: `The ${name} login expired at ${at}.`,
        result: "It tried 3 times, then carried on without it. Customer issues may be missing from today's list. Nothing was changed.",
        by: 'Inhouse agent, on schedule.', fix: `Reconnect ${name} in Tools. It reads it again at the next check.` })
    }
    // The morning line's counts and tool names come from what the check read and found.
    const read = morningReadTools(ctx)
    // With no tool connected yet (day one), the morning check read nothing, so it has no line.
    if (read.length) {
      const fill = fillActivity(ctx)
      rows.push({ ...base, t: morning.t, atMin: morning.atMin, icon: 'visibility', kind: 'read', trace: morning.trace, who: morning.who, why: morning.why, by: morning.by,
        text: fill(morning.text), result: fill(morning.result) })
      // The routines that ran today, after the morning check (none on day one: nothing was connected to read).
      for (const e of today.slice(1)) {
        if (e.minStage === 'Act' && S < 1) continue
        rows.push({ ...base, t: e.t, atMin: e.atMin, icon: 'visibility', kind: e.kind, trace: e.trace, who: e.who, why: e.why, by: e.by, text: e.text, result: e.result })
      }
    }
  }
  for (const e of earlier) {
    if (e.minStage === 'Act' && S < 1) continue
    const change = e.kind === 'change'
    rows.push({ day: e.day!, t: e.t, atMin: e.atMin, icon: change ? 'check_circle' : e.text.startsWith('Saved the weekly') ? 'summarize' : 'visibility', text: e.text, who: e.who,
      kind: e.kind, trace: e.trace, iconTone: change ? 'bg-background text-foreground' : 'bg-background text-foreground-3', why: e.why, result: e.result, by: e.by })
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
    g.rows = g.rows.map((r, i) => [r, i] as const).sort((a, b) => b[0].atMin - a[0].atMin || (b[0].ms ?? 0) - (a[0].ms ?? 0) || a[1] - b[1]).map(x => x[0])
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
      out.push({ id: `${chatId}-t${t}-p${k}`, role: 'agent', trace: turn.trace, part })
      if (part.type !== 'approval') return
      const at = agent.approved[part.problemId]
      if (at) note = { id: `${chatId}-t${t}-approved`, role: 'event', text: `${firstName(at.by)} approved: ${lower1(at.title)} · ${at.at}` }
    })
    if (note) out.push(note)
  })
  return out
}

/** "Every weekday at 6:00 AM" style schedule sentence. */
export const whenOf = (r: { freq?: string; day?: string; time?: string }) =>
  !r.freq ? '' : (r.freq === 'Daily' ? (r.day === 'Weekdays' ? 'Every weekday' : 'Every day') : `Every ${r.day}`) + ` at ${r.time}`

export const fmtSeconds = (s: number) =>
  s < 1 ? Math.round(s * 1000) + 'ms' : s < 60 ? (Math.round(s * 10) / 10) + 's' : Math.floor(s / 60) + 'm ' + Math.round(s % 60) + 's'

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
export const photoOf = (data: AgentData, st: AgentState, id: string): string | null =>
  (st.settings[photoKey(id)] ?? data.people.members.find(m => m.id === id)?.photo) || null

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

/** The mode a question uses: the one picked in the composer if the team can still use it, else the default. */
export const activeMode = (data: AgentData, saved: Record<string, string>, picked: string | null): ThinkingMode => {
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
export function routineRuns(ctx: Ctx, r: { id: string; name: string; last?: string }): RoutineRunLine[] {
  const { S, agent, data } = ctx
  const now = agent.routineRuns.filter(x => x.routine === r.id)
    .map((x, i): RoutineRunLine => ({ key: `now|${i}|${x.at}`, day: 'Today', t: x.at, text: x.result ? `Run now · ${x.result}` : 'Run now', trace: x.trace, inActivity: false }))
  const name = r.name.toLowerCase()
  const fill = fillActivity(ctx)
  const lines = [...data.activity.today.map(l => ({ ...l, day: 'Today' })), ...data.activity.earlier]
    .filter(l => !(l.minStage === 'Act' && S < 1) && l.text.toLowerCase().includes(name))
    .map((l): RoutineRunLine => ({ key: `${l.day}|${l.t}|${l.text}`, day: l.day ?? 'Today', t: l.t, text: fill(l.text), trace: l.trace, inActivity: true }))
  if (lines.length === 0 && r.last) lines.push({ key: 'last', day: '', t: '', text: r.last, inActivity: false })
  return [...now, ...lines]
}
