// What an answer's steps and sources say, read from its trace and its parts. A trace's tool step is labelled
// "<tool> · <what it read>" (the tool's name as the Tools page spells it); a step that names no connected tool has no logo.
import type { AgentData, MessagePart, Trace } from '../../agent/types'

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

/** A step that changed something (saved, sent, wrote) rather than read it: its row says what it did. */
const WROTE = /^(saved|sent|created|posted|updated|wrote|drafted|deleted|changed|added|scheduled|replied|approved)\b/i

export interface StepRow { tool: string | null; text: string; ms: number; /** It read, so the steps line may say "Checked". */ read: boolean }

/** Every step but the run's own root line, as a finished row: its tool when it names a connected one, its done text, how long it took. */
export function stepRows(data: AgentData, trace: Trace): StepRow[] {
  return trace.steps.filter(s => s.kind !== 'root').map(s => {
    const { tool, text } = splitStep(s.label)
    const key = s.kind === 'tool' && tool !== null ? toolKeyOf(data, tool) : null
    const ms = s.endMs - s.startMs
    return key !== null ? { tool: key, text: cap1(text), ms, read: !WROTE.test(text) } : { tool: null, text: s.label, ms, read: false }
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
 * how long it took when the trace says. Each source gets its own read: the tool's step that shares a word with it, else the
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
      const hit = own.find(x => words(splitStep(x.s.label).text).some(w => mine.has(w))) ?? own.find(x => !taken.has(x.i))
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
