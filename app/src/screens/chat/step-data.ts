// What an answer's steps and sources say, read from its trace and its parts. A trace's tool step is labelled
// "<tool> · <what it read>" (the tool's name as the Tools page spells it); a step that names no connected tool has no logo.
import type { AgentData, MessagePart, Trace, TraceStep, TraceStepKind } from '../../agent/types'
import type { IconName } from '../../ui/icon-manifest'

const cap1 = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

/** The key (and logo) of a connected tool by its name ("Meta Ads" is `meta-ads`), or null when no tool has that name. */
export function toolKeyOf(data: AgentData, name: string): string | null {
  const n = name.trim().toLowerCase()
  return Object.keys(data.tools.details).find(k => data.tools.details[k].name.toLowerCase() === n) ?? null
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * The tool a step's text names first ("Reading Shopify orders…" is `shopify`), as its key. Only among `keys` (the brand's
 * connected tools), by whole words, and the one named earliest in the text wins; null when it names none.
 */
export function toolInText(data: AgentData, text: string, keys: readonly string[]): string | null {
  let best: { key: string; at: number } | null = null
  for (const key of keys) {
    const name = data.tools.details[key]?.name
    if (!name) continue
    const m = new RegExp(`(^|\\W)${escapeRe(name)}(?!\\w)`, 'i').exec(text)
    const at = m ? m.index + m[1].length : -1
    if (at >= 0 && (best === null || at < best.at)) best = { key, at }
  }
  return best?.key ?? null
}

/** A tool step's label as the tool's name and what it read; any other label is only text. */
export function splitStep(label: string): { tool: string | null; text: string } {
  const i = label.indexOf(' · ')
  return i < 0 ? { tool: null, text: label } : { tool: label.slice(0, i), text: label.slice(i + 3) }
}

/**
 * A step that changed something (saved, sent, wrote) rather than read it: its row says what it did. A label that starts
 * with a write verb is a write ("saved notes", "sent email to Sam", "created draft order #12"), unless it reads as a look
 * at what was sent or saved: a period ("sent campaigns, last 30 days") or a bare plural of messages or files ("sent
 * mail"). When unsure it says what it did rather than claim a read, so a change is never shown as "Checked".
 */
const WROTE = /^(saved|sent|created|posted|updated|wrote|drafted|deleted|changed|added|scheduled|replied|approved)\b/i
const READ_RANGE = /,\s*(last|past|previous)\b|,\s*this\s+(week|month|quarter|year)\b|\b(last|past)\s+\d+\s+\w+$/i
const READ_OF = /^(sent|saved)\s+(mail|emails|messages|campaigns|files|items)$/i
export const isWrite = (text: string) => WROTE.test(text) && !READ_RANGE.test(text) && !READ_OF.test(text)

export interface StepRow { tool: string | null; text: string; ms: number; /** It read, so the steps line may say "Checked". */ read: boolean }

/** Every step but the run's own root line, as a finished row: its tool when it names a connected one, its done text, how long it took. */
export function stepRows(data: AgentData, trace: Trace): StepRow[] {
  return trace.steps.filter(s => s.kind !== 'root').map(s => {
    const { tool, text } = splitStep(s.label)
    const key = s.kind === 'tool' && tool !== null ? toolKeyOf(data, tool) : null
    const ms = s.endMs - s.startMs
    return key !== null ? { tool: key, text: cap1(text), ms, read: !isWrite(text) } : { tool: null, text: s.label, ms, read: false }
  })
}

/** The distinct connected tools the run read (not wrote to), as their names, in the order it read them. */
export function toolNames(data: AgentData, rows: readonly StepRow[]): string[] {
  const keys = [...new Set(rows.flatMap(r => (r.tool === null || !r.read ? [] : [r.tool])))]
  return keys.map(k => data.tools.details[k].name)
}

export interface Source { id: string; /** The tool's key when it is a connected one (its logo), else null. */ tool: string | null; toolName: string; title: string; read?: string; ms?: number }

const words = (t: string) => t.toLowerCase().match(/[a-z0-9#]{3,}/g) ?? []

/**
 * The sources an answer cites: its tables' sources ("Shopify · Orders"), each with the read the run made from that tool and
 * how long it took when the trace says. Each source gets its own read: the tool's step that shares a word with it and no source has taken, else the
 * next step of that tool no source has taken; a source with no step to match shows none (never another source's).
 */
export function sourcesOf(data: AgentData, parts: readonly MessagePart[], trace: Trace | null | undefined): Source[] {
  const seen = new Set<string>()
  const taken = new Set<number>()
  const out: Source[] = []
  const steps = (trace?.steps ?? []).map((s, i) => ({ s, i })).filter(x => x.s.kind === 'tool')
  for (const p of parts) {
    if (p.type !== 'table') continue
    for (const src of p.table.sources) {
      if (seen.has(src)) continue
      seen.add(src)
      const { tool, text } = splitStep(src)
      const toolName = tool ?? src
      const own = steps.filter(x => splitStep(x.s.label).tool?.toLowerCase() === toolName.toLowerCase())
      const mine = new Set(words(text))
      const hit = own.find(x => !taken.has(x.i) && words(splitStep(x.s.label).text).some(w => mine.has(w))) ?? own.find(x => !taken.has(x.i))
      if (hit) taken.add(hit.i)
      const ms = hit ? hit.s.endMs - hit.s.startMs : 0
      out.push({
        id: src, tool: toolKeyOf(data, toolName), toolName, title: tool === null ? src : text,
        ...(hit ? { read: splitStep(hit.s.label).text } : {}), ...(ms > 0 ? { ms } : {}),
      })
    }
  }
  return out
}

export type TraceRowStatus = 'done' | 'running' | 'error' | 'pending'
export type TraceLiveOutcome = 'running' | 'done' | 'failed' | 'stopped' | 'interrupted' | 'cancelled'

/** A single row in the nested Trace tree rendered by LiveSteps, StepsLine and TraceWindow. */
export interface TraceRow {
  id: string
  /** The full raw label from the event or trace step (`Shopify · orders, stock, returns`). */
  label: string
  /** Display title: strips the connected `<Tool> · ` prefix when a tool logo is shown beside it. */
  title: string
  status: TraceRowStatus
  /** Connected tool key when one matches (`LogoTile`), else null (`Icon` uses `icon`). */
  tool: string | null
  /** Fallback Material Symbols icon name in the subset (`icon-manifest.ts`). */
  icon: IconName
  depth: number
  kind?: TraceStepKind
  startMs?: number
  endMs?: number
  detail?: string
  io?: TraceStep['io']
  plainDetail?: string
  slowest?: boolean
  children: TraceRow[]
}

/** Icon for each trace step kind when no connected tool logo applies. Every name is in `ICON_NAMES`. */
export const KIND_ICON: Record<TraceStepKind, IconName> = {
  root: 'hub',
  model: 'neurology',
  tool: 'build',
  agent: 'account_tree',
  wait: 'hourglass_empty',
  handoff: 'swap_horiz',
  answer: 'chat_bubble',
  fail: 'error',
  approval: 'front_hand',
}

export interface LiveStepInput { id?: string; stepId?: string; label: string; tool?: string; depth?: number }

/** Nest flat rows in arrival order by `depth`: every node appears once and `parent.depth < child.depth` always holds. */
function buildTree(flat: readonly TraceRow[]): TraceRow[] {
  const roots: TraceRow[] = []
  const stack: TraceRow[] = []
  for (const node of flat) {
    while (stack.length > 0 && stack[stack.length - 1].depth >= node.depth) stack.pop()
    if (stack.length === 0) roots.push(node)
    else stack[stack.length - 1].children.push(node)
    stack.push(node)
  }
  return roots
}

const stripModelAndTokens = (detail: string): string => {
  const rest = detail.split(' · ').slice(1).filter(seg => !/^(?:\d+\s+(?:in|out)|.*tokens?)$/i.test(seg.trim())).join(' · ')
  return cap1(rest || 'It worked this out itself, without reading a tool')
}

export const plainStepDetail = (s: Pick<TraceStep, 'kind' | 'detail'>): string => (
  s.kind === 'model'
    ? stripModelAndTokens(s.detail)
    : s.detail.replace('Input: ', 'Asked for: ').replace('Output: ', 'Got back: ')
)

/**
 * Maps live `step` events of a running turn into `TraceRow`s: the latest step is `running` and earlier ones are `done`;
 * `failed` marks the last row `error`, while `stopped`, `interrupted`, `cancelled`, or `done` clears running state.
 */
export function mapLiveStepsToTraceRows(
  data: AgentData,
  steps: readonly LiveStepInput[],
  opts: { outcome?: TraceLiveOutcome; keys?: readonly string[] } = {},
): TraceRow[] {
  const outcome = opts.outcome ?? 'running'
  const keys = opts.keys ?? Object.keys(data.tools.details)
  const flat: TraceRow[] = steps.map((s, i) => {
    const isLast = i === steps.length - 1
    const status: TraceRowStatus = isLast
      ? (outcome === 'running' ? 'running' : outcome === 'failed' ? 'error' : 'done')
      : 'done'
    const { tool: labelTool, text } = splitStep(s.label)
    const tool = (s.tool ? toolKeyOf(data, s.tool) : null)
      ?? (labelTool !== null ? toolKeyOf(data, labelTool) : null)
      ?? toolInText(data, s.label, keys)
    const icon: IconName = status === 'error' ? 'error' : status === 'running' ? 'progress_activity' : 'check'
    const title = labelTool !== null && tool !== null ? cap1(text) : s.label
    return {
      id: s.id ?? s.stepId ?? `live-${i}`,
      label: s.label,
      title,
      status,
      tool,
      icon,
      depth: Math.max(0, s.depth ?? 0),
      children: [],
    }
  })
  return buildTree(flat)
}

/**
 * Maps a finished `Trace` into a nested `TraceRow` tree from `depth`.
 * `fail` maps to `error`, `approval` to `pending`, connected tools get their logo via `toolKeyOf`, and replay time `t`
 * maps each step to `pending`, `running`, or its finished status.
 */
export function mapTraceToTraceRows(
  data: AgentData,
  trace: Trace,
  opts: { t?: number | null } = {},
): TraceRow[] {
  const t = opts.t ?? null
  const slow = trace.steps
    .filter(s => s.kind === 'model' || s.kind === 'tool' || s.kind === 'agent')
    .reduce<TraceStep | null>((a, s) => (!a || s.endMs - s.startMs > a.endMs - a.startMs ? s : a), null)

  const flat: TraceRow[] = trace.steps.map((s, i) => {
    const { tool: labelTool, text } = splitStep(s.label)
    const tool = s.kind === 'tool' && labelTool !== null ? toolKeyOf(data, labelTool) : null
    const finishedStatus: TraceRowStatus = s.kind === 'fail' ? 'error' : s.kind === 'approval' ? 'pending' : 'done'
    let status: TraceRowStatus
    if (t == null) {
      status = finishedStatus
    } else if (t < s.startMs) {
      status = 'pending'
    } else if (t < s.endMs) {
      status = 'running'
    } else {
      status = finishedStatus
    }
    return {
      id: `${trace.id}-${i}`,
      label: s.label,
      title: tool !== null ? cap1(text) : s.label,
      status,
      tool,
      icon: KIND_ICON[s.kind],
      depth: Math.max(0, s.depth),
      kind: s.kind,
      startMs: s.startMs,
      endMs: s.endMs,
      detail: s.detail,
      ...(s.io ? { io: s.io } : {}),
      plainDetail: plainStepDetail(s),
      ...(s === slow ? { slowest: true } : {}),
      children: [],
    }
  })
  return buildTree(flat)
}
