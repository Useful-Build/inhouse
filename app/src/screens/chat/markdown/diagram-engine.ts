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

// Mermaid keeps one global config, and `initialize` changes it at once, outside the queue `render` keeps. So each draw
// (initialize, then render) waits for the one before it: two diagrams, or a theme change mid-draw, can't swap colours.
let queue: Promise<unknown> = Promise.resolve()

/** The sanitized figure for `source`, in `theme`. Throws what Mermaid throws for a diagram it can't parse or draw. */
export function drawDiagram(source: string, id: string, label: string, theme: DiagramTheme): Promise<string> {
  const run = queue.then(async () => {
    const mermaid = await loadMermaid()
    // Per draw: the colours change with the theme.
    mermaid.initialize({ ...MERMAID_CONFIG, fontFamily: theme.fontFamily, themeVariables: theme.themeVariables })
    const { svg } = await mermaid.render(id, source)
    return tidySvg(svg, label)
  })
  // The next draw waits for this one whether it worked or not; its error reaches its own caller through `run`.
  queue = run.then(() => undefined, () => undefined)
  return run
}
