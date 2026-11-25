// Draws one diagram. This is the only file that imports `mermaid`, and only with a dynamic import() from the first call
// that needs it: Mermaid and its diagram parsers are far larger than Streamdown, so a text with no diagram never loads
// them (not in the entry chunk, not in the renderer chunk; build-support/markdown-entry.test.ts pins both).
import { MERMAID_CONFIG } from './diagram-theme'
import type { DiagramTheme } from './diagram-theme'
import { tidySvg } from './diagram-svg'

type Mermaid = typeof import('mermaid').default

let loading: Promise<Mermaid> | undefined
function loadMermaid(): Promise<Mermaid> {
  // A failed load is not kept, so the next diagram tries again (and the failure is logged by the caller).
  return (loading ??= import('mermaid').then(m => m.default, err => { loading = undefined; throw err }))
}

/** The sanitized figure for `source`, in `theme`. Throws what Mermaid throws for a diagram it can't parse or draw. */
export async function drawDiagram(source: string, id: string, label: string, theme: DiagramTheme): Promise<string> {
  const mermaid = await loadMermaid()
  // Per draw: the colours change with the theme. Mermaid keeps one global config, and queues its renders.
  mermaid.initialize({ ...MERMAID_CONFIG, fontFamily: theme.fontFamily, themeVariables: theme.themeVariables })
  const { svg } = await mermaid.render(id, source)
  return tidySvg(svg, label)
}
