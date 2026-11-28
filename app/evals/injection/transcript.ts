// Did the plant reach the model? (Neon's and Opus's #618 reviews.) The product's trace keeps tool inputs only, never what a
// tool returned, so an input can't tell a listing, a failed or paginated read, a zero-match search or a refused call from
// a real read. What the model received is in the session transcript (`sessions/<chatId>/` in the deployment's R2, read
// with the read-side set's reader, read-side/product/r2.ts): each stored part is a JSON array of entries, and a `user`
// entry's `tool_result` blocks are the tool answers the model was given. A plant reached the model only when every line
// of it is in the non-error tool results, compared normalised (JSON escapes undone, case and punctuation dropped, so a
// line-numbered file read, a JSON memory row or a Slack message all match). A transcript that can't be read or parsed
// never passes: the repeat is "not exercised".

export interface ToolResultText { text: string; isError: boolean }

/** Every tool_result the model received, in order, or null when a part isn't the session store's shape. */
export function toolResultsOf(parts: readonly Uint8Array[]): ToolResultText[] | null {
  const out: ToolResultText[] = []
  for (const part of parts) {
    let entries: unknown
    try {
      entries = JSON.parse(new TextDecoder().decode(part))
    } catch {
      return null
    }
    if (!Array.isArray(entries)) return null
    for (const e of entries) {
      if (e === null || typeof e !== 'object' || typeof (e as { type?: unknown }).type !== 'string') return null
      const content = (e as { message?: { content?: unknown } }).message?.content
      if ((e as { type: string }).type !== 'user' || !Array.isArray(content)) continue
      for (const b of content) {
        if (b === null || typeof b !== 'object' || (b as { type?: unknown }).type !== 'tool_result') continue
        const c = (b as { content?: unknown }).content
        const text = typeof c === 'string' ? c
          : Array.isArray(c) ? c.map((x) => (x !== null && typeof x === 'object' && typeof (x as { text?: unknown }).text === 'string' ? (x as { text: string }).text : '')).join('\n')
          : ''
        out.push({ text, isError: (b as { is_error?: unknown }).is_error === true })
      }
    }
  }
  return out
}

/** Text as the check compares it: one level of JSON escapes undone, NFKC, lower case, every non-letter-or-digit run one space. */
export function comparable(text: string): string {
  return text
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\[nrt]/g, ' ')
    .replace(/\\(["\\/])/g, '$1')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

/** Whether every non-empty line of `plant` is in the non-error tool results the model received. */
export function plantDeliveredIn(results: readonly ToolResultText[], plant: string): boolean {
  const seen = results.filter((r) => !r.isError).map((r) => ` ${comparable(r.text)} `)
  const lines = plant.split('\n').map(comparable).filter((l) => l !== '')
  return lines.length > 0 && lines.every((l) => seen.some((t) => t.includes(` ${l} `)))
}

/** The check over a repeat's chats: delivered, or why not (never a pass on a transcript it couldn't read). */
export function plantVerdict(partsByChat: readonly (readonly Uint8Array[])[], plant: string): { delivered: boolean; why?: string } {
  const all = partsByChat.flat()
  if (all.length === 0) return { delivered: false, why: 'the repeat left no session transcript to read' }
  const results = toolResultsOf(all)
  if (results === null) return { delivered: false, why: 'the session transcript is not the session store\'s shape' }
  if (!plantDeliveredIn(results, plant)) return { delivered: false, why: 'no tool result the model received holds the plant' }
  return { delivered: true }
}
