// A ```mermaid fence in an answer, drawn as a diagram. Mermaid itself loads the first time one is drawn (diagram-engine.ts).
// States: while the fence is still open (the answer is streaming) or Mermaid is drawing, a quiet line; once drawn, a
// bordered card with the figure (scrolls sideways when wide), Copy and Show source; if the diagram can't be drawn, a note
// above its source as a plain code block, and the error is logged.
import { useContext, useEffect, useId, useState, useSyncExternalStore } from 'react'
import { IconButton } from '../../../ui'
import { CodeSnippet } from '../../../ui/code-snippet'
import { copyText } from '../copy'
import { drawDiagram } from './diagram-engine'
import { readTheme } from './diagram-theme'
import { OpenFenceContext } from './open-fence'

export type DiagramView = { kind: 'drawing' } | { kind: 'ready'; svg: string } | { kind: 'failed' }

// The page's theme is the `dark` class on <html> (lib/theme.ts). Watched here rather than imported: that module needs a window at load.
const subscribeTheme = (onChange: () => void) => {
  const observer = new MutationObserver(onChange)
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
  return () => observer.disconnect()
}
const isDark = () => document.documentElement.classList.contains('dark')
function useDark() { return useSyncExternalStore(subscribeTheme, isDark, () => false) }

export function Diagram({ source, n, last }: { source: string; n: number; last: boolean }) {
  const open = useContext(OpenFenceContext) && last
  const dark = useDark()
  const id = `ih-diagram-${useId().replace(/\W/g, '')}`
  const [view, setView] = useState<DiagramView>({ kind: 'drawing' })
  useEffect(() => {
    if (open) return
    let stale = false
    const draw = async () => {
      const style = getComputedStyle(document.documentElement)
      return drawDiagram(source, id, `Diagram ${n}`, readTheme(name => style.getPropertyValue(name), dark))
    }
    // The last good figure stays up while a redraw (a theme change) runs.
    draw().then(
      svg => { if (!stale) setView({ kind: 'ready', svg }) },
      err => { if (stale) return; console.error(`Inhouse: could not draw diagram ${n}.`, err); setView({ kind: 'failed' }) },
    )
    return () => { stale = true }
  }, [source, n, open, dark, id])
  return <DiagramCard n={n} source={source} view={open ? { kind: 'drawing' } : view} />
}

const SOURCE_COPIED = 'Diagram source copied'

/** The look of each state. Takes the state, so a test can render every one. */
export function DiagramCard({ n, source, view }: { n: number; source: string; view: DiagramView }) {
  const [showSource, setShowSource] = useState(false)
  const snippet = <CodeSnippet text={source} label={`Diagram ${n} source`} copyLabel={`Copy diagram ${n} source code`} onCopy={t => copyText(t, SOURCE_COPIED)} />
  if (view.kind === 'failed') {
    return (
      <div data-md-diagram data-state="failed" className="flex min-w-0 flex-col gap-2">
        <p className="text-sm text-foreground-3">Couldn't draw this diagram.</p>
        {snippet}
      </div>
    )
  }
  if (view.kind === 'drawing') {
    return <div data-md-diagram data-state="drawing" aria-busy="true" className="min-w-0 rounded-xl border border-border bg-card px-4 py-3 text-sm text-foreground-3">Drawing diagram…</div>
  }
  return (
    <div data-md-diagram data-state="ready" className="min-w-0 rounded-xl border border-border bg-card">
      <div className="flex items-center justify-between gap-2 py-1.5 pr-1.5 pl-4">
        <span className="text-xs text-foreground-3">Diagram {n}</span>
        <span className="flex gap-0.5">
          <IconButton icon="code" label={showSource ? `Hide diagram ${n} source` : `Show diagram ${n} source`} size={16} box="icon-sm" aria-pressed={showSource} onClick={() => setShowSource(v => !v)} />
          <IconButton icon="content_copy" label={`Copy diagram ${n} source`} size={16} box="icon-sm" onClick={() => copyText(source, SOURCE_COPIED)} />
        </span>
      </div>
      {/* Focusable so a keyboard can scroll a wide diagram sideways. The figure inside is the image (role="img", its label). */}
      <div role="region" aria-label={`Diagram ${n}`} tabIndex={0} className="min-w-0 overflow-x-auto px-4 pb-4">
        <div className="mx-auto w-fit" dangerouslySetInnerHTML={{ __html: view.svg }} />
      </div>
      {showSource && <div className="border-t border-border p-2">{snippet}</div>}
    </div>
  )
}
