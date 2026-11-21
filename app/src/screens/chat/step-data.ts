// What an answer's steps and sources say, read from its trace and its parts. A trace's tool step is labelled
// "<tool> · <what it read>" (the tool's name as the Tools page spells it); a step that names no connected tool has no logo.
import type { AgentData, MessagePart, Trace } from '../../agent/types'

const cap1 = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

/** The key (and logo) of a connected tool by its name ("Meta Ads" is `meta-ads`), or null when no tool has that name. */
export function toolKeyOf(data: AgentData, name: string): string | null {
  const n = name.trim().toLowerCase()
  return Object.keys(data.tools.details).find(k => data.tools.details[k].name.toLowerCase() === n) ?? null
}

/** The first tool whose name a step's text mentions ("Reading Shopify orders…"), as its key; null when it names none. */
export function toolInText(data: AgentData, text: string): string | null {
  const t = text.toLowerCase()
  return Object.keys(data.tools.details).find(k => t.includes(data.tools.details[k].name.toLowerCase())) ?? null
}

/** A tool step's label as the tool's name and what it read; any other label is only text. */
export function splitStep(label: string): { tool: string | null; text: string } {
  const i = label.indexOf(' · ')
  return i < 0 ? { tool: null, text: label } : { tool: label.slice(0, i), text: label.slice(i + 3) }
}

export interface StepRow { tool: string | null; text: string; ms: number }

/** Every step but the run's own root line, as a finished row: its tool when it names a connected one, its done text, how long it took. */
export function stepRows(data: AgentData, trace: Trace): StepRow[] {
  return trace.steps.filter(s => s.kind !== 'root').map(s => {
    const { tool, text } = splitStep(s.label)
    const key = s.kind === 'tool' && tool !== null ? toolKeyOf(data, tool) : null
    return key !== null ? { tool: key, text: cap1(text), ms: s.endMs - s.startMs } : { tool: null, text: s.label, ms: s.endMs - s.startMs }
  })
}

/** The distinct connected tools the run read, as their names, in the order it read them. */
export function toolNames(data: AgentData, rows: readonly StepRow[]): string[] {
  const keys = [...new Set(rows.flatMap(r => (r.tool === null ? [] : [r.tool])))]
  return keys.map(k => data.tools.details[k].name)
}

export interface Source { id: string; /** The tool's key when it is a connected one (its logo), else null. */ tool: string | null; toolName: string; title: string; read?: string; ms?: number }

/** The sources an answer cites: its tables' sources ("Shopify · Orders"), each with what the run read from that tool and how long it took when the trace says. */
export function sourcesOf(data: AgentData, parts: readonly MessagePart[], trace: Trace | null | undefined): Source[] {
  const seen = new Set<string>()
  const out: Source[] = []
  for (const p of parts) {
    if (p.type !== 'table') continue
    for (const src of p.table.sources) {
      if (seen.has(src)) continue
      seen.add(src)
      const { tool, text } = splitStep(src)
      const toolName = tool ?? src
      const step = trace?.steps.find(s => s.kind === 'tool' && splitStep(s.label).tool?.toLowerCase() === toolName.toLowerCase())
      const ms = step ? step.endMs - step.startMs : 0
      out.push({
        id: src, tool: toolKeyOf(data, toolName), toolName, title: tool === null ? src : text,
        ...(step ? { read: splitStep(step.label).text } : {}), ...(ms > 0 ? { ms } : {}),
      })
    }
  }
  return out
}
