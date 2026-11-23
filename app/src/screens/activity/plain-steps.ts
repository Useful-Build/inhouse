// "How your agent worked it out": a run's steps as plain sentences for the Activity sheet. A brand operator reads what
// the agent did, never how: no timings, costs, token counts or model names (DESIGN.md, "Who it's for").
import type { Trace, TraceStep } from '../../agent/types'
import { isWrite, splitStep } from '../chat/step-data'

const cap1 = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)
const lower1 = (s: string) => s.charAt(0).toLowerCase() + s.slice(1)
/** Ends it as a sentence: one full stop, unless it already ends on a mark. */
export const sentence = (s: string) => { const t = s.trim(); return t === '' ? '' : /[.!?]$/.test(t) ? cap1(t) : `${cap1(t)}.` }

/** The product's live step labels say what's happening ("Searching memory"); a finished run says what it did. */
const PAST: Readonly<Record<string, string>> = {
  asking: 'Asked', finding: 'Found', forgetting: 'Forgot', planning: 'Planned', reading: 'Read', running: 'Ran',
  saving: 'Saved', searching: 'Searched', updating: 'Updated', using: 'Used', waiting: 'Waited', checking: 'Checked', hand: 'Handed',
}
const toPast = (label: string) => {
  const [first, ...rest] = label.split(' ')
  const past = PAST[first.toLowerCase()]
  return past ? [past, ...rest].join(' ') : label
}
const PAST_WORDS = new Set(Object.values(PAST).map(w => w.toLowerCase()))
/** Whether the label already says what was done ("Read this morning's findings", "Searched memory"). */
const saysDone = (label: string) => { const w = label.split(' ')[0].toLowerCase(); return PAST_WORDS.has(w) || /ed$/.test(w) }
/** A place that isn't a name reads in lower case mid-sentence ("in your tools", "in past cases"). */
const place = (tool: string) => (/^(your|past)\b/i.test(tool) ? lower1(tool) : tool)

/** One step as a sentence, or null for a step a person doesn't need: the run's root, a bare "Answer", a model's id. */
function plainStep(s: TraceStep): string | null {
  if (s.kind === 'root') return null
  // A real run's model step is labelled with the model's id ("claude-sonnet-5-5"): mechanics, so it's left out.
  if (s.kind === 'model' && !/\s/.test(s.label.trim())) return null
  if (s.kind === 'answer' && s.label.trim().toLowerCase() === 'answer') return null
  // "Waiting for ShipBob (rate limit)": the reason in brackets is mechanics.
  const label = toPast(s.label.replace(/\s*\([^)]*\)\s*$/, '').trim())
  if (label === '') return null
  const { tool, text } = splitStep(label)
  if (tool === null) return sentence(s.kind === 'tool' && !saysDone(label) ? `Looked at ${label}` : label)
  if (s.kind === 'agent') return sentence(text)
  if (s.kind !== 'tool') return sentence(`${tool}: ${text}`)
  if (tool.toLowerCase() === 'memory') return sentence(`Remembered ${text}`)
  // "Library · saved the report" is a change, said as one; "Shopify · orders, stock, returns" a look.
  if (isWrite(text)) return sentence(`${cap1(text)} in ${place(tool)}`)
  return sentence(`Looked at ${text} in ${place(tool)}`)
}

/** Every step a person would follow, in order, with a repeat of the line before it dropped ("Used a tool." twice). */
export function plainSteps(trace: Trace): string[] {
  const out: string[] = []
  for (const s of trace.steps) {
    const line = plainStep(s)
    if (line !== null && line !== out[out.length - 1]) out.push(line)
  }
  return out
}
