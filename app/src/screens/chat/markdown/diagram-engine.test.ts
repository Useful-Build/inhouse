// The weight guard at run time: importing the engine (or a whole renderer) loads no Mermaid; the first diagram loads it
// once; a failed draw throws what Mermaid threw (the card shows the source and logs it).
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DiagramTheme } from './diagram-theme'

const mermaid = vi.hoisted(() => ({ loaded: 0, initialize: vi.fn(), render: vi.fn() }))
vi.mock('mermaid', () => { mermaid.loaded++; return { default: { initialize: mermaid.initialize, render: mermaid.render } } })
vi.mock('../../../ui', () => ({ IconButton: () => null }))
vi.mock('../copy', () => ({ copyText: () => undefined }))
vi.mock('./diagram-svg', async orig => ({ ...(await orig<typeof import('./diagram-svg')>()), tidySvg: (svg: string, label: string) => `${label}|${svg}` }))

const theme: DiagramTheme = { dark: false, fontFamily: 'Geist', themeVariables: { primaryColor: 'fill-value' } }

describe('the diagram engine', () => {
  beforeEach(() => { mermaid.initialize.mockReset(); mermaid.render.mockReset() })

  it('loads Mermaid on the first draw, not on import, and only once', async () => {
    const { drawDiagram } = await import('./diagram-engine')
    // Rendering a whole text with no diagram does not load it either.
    const { renderToStaticMarkup } = await import('react-dom/server')
    const { createElement } = await import('react')
    renderToStaticMarkup(createElement((await import('./renderer')).Markdown, { text: '# Hi\n\n```sql\nselect 1\n```' }))
    expect(mermaid.loaded).toBe(0)
    mermaid.render.mockResolvedValue({ svg: '<svg/>' })
    await drawDiagram('flowchart LR\n A-->B', 'ih-diagram-x', 'Diagram 1', theme)
    await drawDiagram('flowchart LR\n A-->B', 'ih-diagram-y', 'Diagram 2', theme)
    expect(mermaid.loaded).toBe(1)
  })

  it('never hands Mermaid a diagram that names an address in its style (Mermaid lays it out in the live page first)', async () => {
    const { drawDiagram } = await import('./diagram-engine')
    mermaid.render.mockResolvedValue({ svg: '<svg/>' })
    await expect(drawDiagram('stateDiagram-v2\n  classDef x background-image:url(/logout)\n  class A x', 'ih-diagram-h', 'Diagram 1', theme)).rejects.toThrow(/address/)
    expect(mermaid.render).not.toHaveBeenCalled()
    expect(mermaid.initialize).not.toHaveBeenCalled()
  })

  it('draws with the strict config and the theme of the moment, and returns the tidied figure', async () => {
    const { drawDiagram } = await import('./diagram-engine')
    mermaid.render.mockResolvedValue({ svg: '<svg/>' })
    const out = await drawDiagram('flowchart LR\n A-->B', 'ih-diagram-x', 'Diagram 1', theme)
    expect(mermaid.initialize).toHaveBeenCalledWith(expect.objectContaining({
      securityLevel: 'strict', htmlLabels: false, theme: 'base', fontFamily: 'Geist', themeVariables: { primaryColor: 'fill-value' },
    }))
    // A diagram's own init or frontmatter can't change how labels are drawn, the theme or its CSS (Mermaid's defaults kept).
    const { secure } = mermaid.initialize.mock.calls[0][0] as { secure: string[] }
    for (const key of ['secure', 'securityLevel', 'startOnLoad', 'maxTextSize', 'suppressErrorRendering', 'maxEdges',
      'htmlLabels', 'flowchart', 'theme', 'themeCSS', 'themeVariables', 'fontFamily', 'altFontFamily', 'look', 'layout', 'arrowMarkerAbsolute']) {
      expect(secure, key).toContain(key)
    }
    expect(mermaid.render).toHaveBeenCalledWith('ih-diagram-x', 'flowchart LR\n A-->B')
    expect(out).toBe('Diagram 1|<svg/>')
  })

  it('draws one at a time, so two draws in different themes never swap configs', async () => {
    const { drawDiagram } = await import('./diagram-engine')
    // Mermaid's config is global: `initialize` sets it at once, `render` reads it while it runs (across awaits).
    let config: unknown
    mermaid.initialize.mockImplementation(c => { config = c })
    mermaid.render.mockImplementation(async (id: string) => {
      const before = config
      await new Promise(r => setTimeout(r, 5))
      return { svg: `<svg data-id="${id}" data-same="${before === config}" data-dark="${(config as { themeVariables: { darkMode: boolean } }).themeVariables.darkMode}"/>` }
    })
    const light: DiagramTheme = { dark: false, fontFamily: 'Geist', themeVariables: { darkMode: false } }
    const dark: DiagramTheme = { dark: true, fontFamily: 'Geist', themeVariables: { darkMode: true } }
    const [a, b] = await Promise.all([
      drawDiagram('flowchart LR\n A-->B', 'ih-diagram-a', 'Diagram 1', light),
      drawDiagram('flowchart LR\n A-->B', 'ih-diagram-b', 'Diagram 2', dark),
    ])
    expect(a).toBe('Diagram 1|<svg data-id="ih-diagram-a" data-same="true" data-dark="false"/>')
    expect(b).toBe('Diagram 2|<svg data-id="ih-diagram-b" data-same="true" data-dark="true"/>')
  })

  it('a failed draw does not stop the next one', async () => {
    const { drawDiagram } = await import('./diagram-engine')
    mermaid.render.mockRejectedValueOnce(new Error('Parse error')).mockResolvedValueOnce({ svg: '<svg/>' })
    const [bad, good] = await Promise.allSettled([
      drawDiagram('nope', 'ih-diagram-c', 'Diagram 1', theme),
      drawDiagram('flowchart LR\n A-->B', 'ih-diagram-d', 'Diagram 2', theme),
    ])
    expect(bad.status).toBe('rejected')
    expect(good).toEqual({ status: 'fulfilled', value: 'Diagram 2|<svg/>' })
  })

  it('throws what Mermaid throws for a diagram it cannot parse', async () => {
    const { drawDiagram } = await import('./diagram-engine')
    mermaid.render.mockRejectedValue(new Error('Parse error on line 2'))
    await expect(drawDiagram('not a diagram', 'ih-diagram-x', 'Diagram 1', theme)).rejects.toThrow('Parse error on line 2')
  })
})
