// How a diagram is set up: Mermaid's config (an answer is untrusted text, so the strict mode) and its colours, read
// from the app's role tokens at the moment of drawing, so a diagram follows light and dark. Pure apart from the colour
// fallback, so a test can load it. Never imports `mermaid` (that stays a dynamic import, diagram-engine.ts).
import type { MermaidConfig } from 'mermaid'

/** Mermaid's own default `secure` keys (12.3.0): a diagram can never set these. */
const MERMAID_SECURE = ['secure', 'securityLevel', 'startOnLoad', 'maxTextSize', 'suppressErrorRendering', 'maxEdges']
const SECURE: string[] = [
  ...MERMAID_SECURE, 'htmlLabels', 'flowchart', 'theme', 'themeCSS', 'themeVariables', 'fontFamily', 'altFontFamily',
  'look', 'layout', 'arrowMarkerAbsolute', 'darkMode', 'journey',
]

/**
 * - `securityLevel: 'strict'`: no click handlers, no links to scripts, and Mermaid runs its own sanitizer on the output.
 * - `htmlLabels: false`: labels are SVG text, never HTML. A diagram's own `%%{init}%%` or frontmatter can't turn it back
 *   on, because it is in `secure` (below). Some diagram types draw text in a `foreignObject` whatever this says:
 *   `tidySvg` refuses those, and the card shows the source.
 * - `secure`: Mermaid's defaults plus every key that changes the look or how labels are drawn, so only this config sets
 *   them: HTML labels (root and `flowchart`, which holds the deprecated `flowchart.htmlLabels`), the theme and its CSS,
 *   fonts, the look, the layout engine, and absolute marker addresses. Mermaid drops a secure key from a diagram's own
 *   config at any depth.
 * - `suppressErrorRendering`: a bad diagram throws and the caller shows the source; Mermaid draws no error figure of its own.
 * - `theme: 'base'`: the only theme that takes `themeVariables`, set per draw (below).
 * - `startOnLoad: false`: nothing scans the page; only what the renderer hands it is drawn.
 */
export const MERMAID_CONFIG = {
  startOnLoad: false, securityLevel: 'strict', htmlLabels: false, suppressErrorRendering: true, theme: 'base', logLevel: 'error',
  // A journey draws its section and task text in a `foreignObject` by default ("fo"), which `tidySvg` refuses: SVG text instead.
  journey: { textPlacement: 'tspan' },
  secure: SECURE,
} as const satisfies MermaidConfig

/** Mermaid's theme variable to the app's CSS custom property that feeds it. */
const TOKENS = {
  background: '--card', textColor: '--foreground', lineColor: '--foreground-3',
  primaryColor: '--fill', primaryTextColor: '--foreground', primaryBorderColor: '--border-strong',
  secondaryColor: '--fill-hover', secondaryTextColor: '--foreground', secondaryBorderColor: '--border-strong',
  tertiaryColor: '--muted', tertiaryTextColor: '--foreground', tertiaryBorderColor: '--border-strong',
  mainBkg: '--fill', nodeBorder: '--border-strong', nodeTextColor: '--foreground',
  clusterBkg: '--muted', clusterBorder: '--border-strong', edgeLabelBackground: '--card', titleColor: '--foreground',
  noteBkgColor: '--brand-tint', noteTextColor: '--foreground', noteBorderColor: '--border-strong',
} as const

export interface DiagramTheme { dark: boolean; fontFamily: string; themeVariables: Record<string, string | boolean> }

const SIMPLE = /^(#[0-9a-f]{3,8}|rgba?\(.*\))$/i

/** A colour Mermaid's colour maths can read: hex and rgb pass; anything else (oklch, color-mix) is converted by the browser's canvas, to 8-digit hex. */
export function simpleColor(value: string): string {
  if (SIMPLE.test(value)) return value
  const ctx = document.createElement('canvas').getContext('2d', { willReadFrequently: true })
  if (!ctx) throw new Error(`Diagram theme: no canvas to convert ${value}`)
  ctx.clearRect(0, 0, 1, 1)
  ctx.fillStyle = value
  ctx.fillRect(0, 0, 1, 1)
  const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data
  if (a === 0) throw new Error(`Diagram theme: ${value} is not a colour`)
  return `#${[r, g, b, a].map(x => x.toString(16).padStart(2, '0')).join('')}`
}

/** The theme from the page's tokens. `read` gives one custom property's value (`getComputedStyle(root).getPropertyValue`); `toSimple` is the colour conversion (a test passes its own). Fails loud on a missing token. */
export function readTheme(read: (name: string) => string, dark: boolean, toSimple: (colour: string) => string = simpleColor): DiagramTheme {
  const get = (name: string) => {
    const v = read(name).trim()
    if (!v) throw new Error(`Diagram theme: ${name} is not set`)
    return v
  }
  const themeVariables: Record<string, string | boolean> = { darkMode: dark, fontSize: '14px' }
  for (const [key, token] of Object.entries(TOKENS)) themeVariables[key] = toSimple(get(token))
  return { dark, fontFamily: get('--font-sans'), themeVariables }
}
