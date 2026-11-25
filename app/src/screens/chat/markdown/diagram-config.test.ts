// @vitest-environment jsdom
// The config lock, against the real Mermaid (parsing only: drawing needs a browser's layout). Ways it could break, written
// first: a diagram's own `%%{init}%%` or frontmatter turns HTML labels back on (its text then comes as HTML in a
// foreignObject), or sets the theme, its CSS (an address in `themeCSS`), fonts, the look, the layout or absolute marker
// addresses; or what one diagram sets stays in force for the next.
import { describe, expect, it } from 'vitest'
import { MERMAID_CONFIG } from './diagram-theme'

const INIT = '%%{init: {"htmlLabels": true, "flowchart": {"htmlLabels": true}, "theme": "dark", "themeCSS": ".node rect { background: url(/x) }", "themeVariables": {"fontSize": "40px"}, "fontFamily": "x", "altFontFamily": "y", "look": "handDrawn", "layout": "dagre", "arrowMarkerAbsolute": true, "darkMode": true}}%%'
const FRONTMATTER = ['---', 'config:', '  htmlLabels: true', '  theme: dark', '  themeCSS: ".a { background: image-set(\\"/x\\" 1x) }"', '  look: handDrawn', '---'].join('\n')

describe('a diagram cannot change the locked config', () => {
  it.each([
    ['an init directive', `${INIT}\nflowchart LR\n  A --> B`],
    ['frontmatter', `${FRONTMATTER}\nstateDiagram-v2\n  [*] --> A`],
  ])('%s', async (_, source) => {
    const mermaid = (await import('mermaid')).default
    mermaid.initialize({ ...MERMAID_CONFIG, themeVariables: { fontSize: '13px' } })
    // `parse` sets the config the way `render` does (processAndSetConfigs), and leaves it in force for a look.
    await mermaid.parse(source)
    const c = mermaid.mermaidAPI.getConfig()
    expect(c.htmlLabels).toBe(false)
    expect(c.flowchart?.htmlLabels).toBeUndefined()
    expect(c.theme).toBe('base')
    expect(c.themeCSS).toBe(MERMAID_CONFIG.themeCSS)
    expect(c.themeVariables?.fontSize).toBe('13px')
    expect(c.fontFamily).not.toBe('x')
    expect(c.altFontFamily).not.toBe('y')
    expect(c.look).not.toBe('handDrawn')
    expect(c.layout).not.toBe('dagre')
    expect(c.arrowMarkerAbsolute).toBe(false)
    expect(c.darkMode).not.toBe(true)
    expect(c.securityLevel).toBe('strict')
  })
})

describe('a journey draws its text as SVG', () => {
  // Its default text placement is a foreignObject per section and task, which tidySvg refuses: every journey would fail.
  it('uses tspan text, and a diagram cannot switch it back', async () => {
    const mermaid = (await import('mermaid')).default
    mermaid.initialize({ ...MERMAID_CONFIG })
    await mermaid.parse('%%{init: {"journey": {"textPlacement": "fo"}}}%%\njourney\n  title Refund\n  section Ask\n    Customer writes: 3: Customer')
    expect(mermaid.mermaidAPI.getConfig().journey?.textPlacement).toBe('tspan')
  })
})
