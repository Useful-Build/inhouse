// The finishing pass over the figure Mermaid returns, in the browser (it needs a DOM). Mermaid's strict mode already runs
// its own sanitizer over the output; this removes what that one allows and a diagram has no business holding: links, images,
// embedded pages, external addresses in the figure or its style, and event handlers. (The page's CSP is the backstop, not the plan.)
// Then it makes the figure an image for a screen reader and gives it its natural size, so a wide one scrolls sideways.

const REMOVE = 'a, image, foreignObject, script, iframe, object, embed'
const HREF = /^(xlink:)?href$/i
// `@import` and any url() that is not a #fragment (a marker or gradient inside the figure).
const EXTERNAL_CSS = /@import[^;]*;?|url\(\s*(?!['"]?#)[^)]*\)/gi

/** The sanitized figure as markup, named for a screen reader: `label` plus the diagram's own title when it has one. */
export function tidySvg(markup: string, label: string): string {
  const holder = document.createElement('template')
  holder.innerHTML = markup
  const svg = holder.content.querySelector('svg')
  if (!svg) throw new Error('Mermaid returned no figure')
  svg.querySelectorAll(REMOVE).forEach(el => el.remove())
  for (const el of [svg, ...svg.querySelectorAll('*')]) {
    for (const attr of [...el.attributes]) {
      const name = attr.name.toLowerCase()
      if (name.startsWith('on') || (HREF.test(name) && !attr.value.startsWith('#'))) el.removeAttribute(attr.name)
    }
  }
  svg.querySelectorAll('style').forEach(style => { style.textContent = (style.textContent ?? '').replace(EXTERNAL_CSS, '') })
  const title = svg.querySelector(':scope > title')?.textContent?.trim()
  svg.setAttribute('role', 'img')
  svg.setAttribute('aria-label', title ? `${label}: ${title}` : label)
  svg.removeAttribute('aria-roledescription')
  svg.removeAttribute('aria-labelledby')
  // Natural size (Mermaid sets width to 100% and a max-width), so the card scrolls a wide diagram instead of shrinking it.
  const box = svg.viewBox.baseVal
  if (box && box.width > 0 && box.height > 0) {
    svg.setAttribute('width', String(Math.ceil(box.width)))
    svg.setAttribute('height', String(Math.ceil(box.height)))
  }
  svg.style.maxWidth = 'none'
  return svg.outerHTML
}
