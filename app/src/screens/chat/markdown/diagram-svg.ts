// The finishing pass over the figure Mermaid returns, in the browser (it needs a DOM). Mermaid's strict mode already runs
// its own sanitizer over the output; this removes what that one allows and a diagram has no business holding: links
// (unwrapped, so a linked node stays drawn), images, embedded pages, animations, any address in the figure's style or
// attributes (same-origin ones too: the CSP lets a same-origin or data: image load, with the session's cookies), and
// event handlers. A figure that needs HTML (a `foreignObject`) is refused, so the card shows the source instead of a
// figure with missing text. (The page's CSP is the backstop, not the plan.)
// Then it makes the figure an image for a screen reader and gives it its natural size, so a wide one scrolls sideways.

const SVG_NS = 'http://www.w3.org/2000/svg'

/** Elements removed with what they hold (lower-cased local names). */
const REMOVE = new Set(['image', 'feimage', 'script', 'iframe', 'object', 'embed', 'animate', 'set', 'animatetransform', 'animatemotion'])
const HREF = /^(xlink:)?href$/i
/**
 * CSS that can reach an address or hide one: a `url()` that is not a `#fragment` (a marker or gradient inside the figure),
 * `image-set()`, `image()`, `src()`, `@import`, and any backslash escape (which can spell any of those).
 */
const UNSAFE_CSS = /url\(\s*(?!['"]?#)|image-set\(|image\(|src\(|@import|\\/i

/**
 * Refuses a diagram whose own text names an address in CSS (`url(`, `image-set(`, `image(`, `src(`, `@import`) or holds a
 * backslash (a CSS escape can spell any of those). Mermaid lays a figure out in the live page before returning it, so a
 * `classDef` or `style` line's address would be fetched (same-origin ones with the session's cookies) before `tidySvg`
 * ever sees the figure: such a diagram is not drawn at all, and the card shows its source.
 */
export function checkSource(source: string): void {
  if (/url\s*\(|image-set\s*\(|image\s*\(|src\s*\(|@import|\\/i.test(source)) {
    throw new Error('The diagram names an address in its style, so it is not drawn')
  }
}

/** CSS text without any rule part or declaration that holds unsafe CSS. Parts are cut at `{`, `}` and `;`, so removing one can't join its neighbours into a new token. */
export function cleanCss(css: string): string {
  return css.replace(/[^{};]+/g, part => (UNSAFE_CSS.test(part) ? '' : part))
}

/** The sanitized figure as markup, named for a screen reader: `label` plus the diagram's own title when it has one. Throws for a figure that needs HTML. */
export function tidySvg(markup: string, label: string): string {
  const holder = document.createElement('template')
  holder.innerHTML = markup
  const svg = holder.content.querySelector('svg')
  if (!svg) throw new Error('Mermaid returned no figure')
  for (const el of [...svg.querySelectorAll('*')]) {
    const name = el.localName.toLowerCase()
    if (name === 'foreignobject') throw new Error('The diagram needs HTML labels, which are not drawn')
    // HTML inside the figure (in a <title> or <desc>, say): Mermaid's sanitizer strips it today; refuse it if that ever slips.
    if (el.namespaceURI !== SVG_NS) throw new Error(`The diagram holds a non-SVG element (${name})`)
    if (REMOVE.has(name)) el.remove()
    // A link: it becomes a plain group. Mermaid wraps a linked node in it and puts the node's place (`transform`) and
    // classes on the link itself, so those stay; the address goes (with every other attribute the pass below drops).
    else if (name === 'a') {
      const g = document.createElementNS(SVG_NS, 'g')
      for (const attr of [...el.attributes]) if (!HREF.test(attr.name) && attr.name.toLowerCase() !== 'target') g.setAttribute(attr.name, attr.value)
      g.append(...el.childNodes)
      el.replaceWith(g)
    }
  }
  for (const el of [svg, ...svg.querySelectorAll('*')]) {
    for (const attr of [...el.attributes]) {
      const name = attr.name.toLowerCase()
      if (name === 'style') el.setAttribute(attr.name, attr.value.split(';').filter(d => !UNSAFE_CSS.test(d)).join(';'))
      else if (name.startsWith('on') || (HREF.test(name) && !attr.value.startsWith('#')) || UNSAFE_CSS.test(attr.value)) el.removeAttribute(attr.name)
    }
  }
  svg.querySelectorAll('style').forEach(style => { style.textContent = cleanCss(style.textContent ?? '') })
  const title = svg.querySelector(':scope > title')?.textContent?.trim()
  svg.setAttribute('role', 'img')
  svg.setAttribute('aria-label', title ? `${label}: ${title}` : label)
  svg.removeAttribute('aria-roledescription')
  svg.removeAttribute('aria-labelledby')
  // Natural size (Mermaid sets width to 100% and a max-width), so the card scrolls a wide diagram instead of shrinking it.
  const [, , width, height] = (svg.getAttribute('viewBox') ?? '').trim().split(/[\s,]+/).map(Number)
  if (width > 0 && height > 0) {
    svg.setAttribute('width', String(Math.ceil(width)))
    svg.setAttribute('height', String(Math.ceil(height)))
  }
  svg.style.maxWidth = 'none'
  return svg.outerHTML
}
