// @vitest-environment jsdom
// The finishing pass over Mermaid's figure, fed hostile figures directly (Mermaid's own sanitizer is not in the way here,
// so each case is what reaches tidySvg if Mermaid lets it through). Ways it could break, written first: a linked node
// vanishes with its link; a link, image, embedded page, script or animation survives; an event handler survives; an
// address survives in a `<style>`, a `style` attribute or a presentation attribute (same-origin ones included: the CSP
// lets those load with the session's cookies); a backslash escape spells one; a figure that needs HTML labels shows with
// its text missing instead of failing.
import { describe, expect, it } from 'vitest'
import { cleanCss, tidySvg } from './diagram-svg'

const svg = (inner: string, attrs = '') => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100" ${attrs}>${inner}</svg>`
const tidy = (inner: string, attrs = '') => {
  const holder = document.createElement('div')
  holder.innerHTML = tidySvg(svg(inner, attrs), 'Diagram 1')
  return holder.querySelector('svg')!
}
const all = (root: Element) => [root, ...root.querySelectorAll('*')]
const attrValues = (root: Element) => all(root).flatMap(el => [...el.attributes].map(a => `${a.name}=${a.value}`))

describe('tidySvg', () => {
  it('unwraps a link: the linked node stays drawn, the link goes', () => {
    const out = tidy('<g class="nodes"><a href="https://evil.example/" xlink:href="https://evil.example/"><g class="node" id="n1"><rect width="10" height="10"/><text>Refund</text></g></a></g>')
    expect(all(out).some(el => el.localName === 'a')).toBe(false)
    expect(out.querySelector('#n1 rect')).not.toBeNull()
    expect(out.textContent).toContain('Refund')
    expect(attrValues(out).join(' ')).not.toContain('evil.example')
  })

  it('removes images, embedded pages, scripts and animations with what they hold', () => {
    // The rect and filter come first: in HTML, an `<embed>` or `<object>` inside an svg ends the svg.
    const out = tidy([
      '<filter id="f"><feImage href="/x"/></filter>',
      '<rect width="1" height="1"><animate attributeName="href" to="https://evil.example/"/><set attributeName="fill" to="url(/x)"/>',
      '<animateTransform attributeName="transform"/><animateMotion path="M0 0"/></rect>',
      '<image href="https://evil.example/a.png"/>', '<image href="/cdn-cgi/access/logout"/>',
      '<script>alert(1)</script>', '<iframe src="https://evil.example/"></iframe>', '<object data="x"></object>', '<embed src="x"/>',
    ].join(''))
    const names = all(out).map(el => el.localName.toLowerCase())
    for (const gone of ['image', 'script', 'iframe', 'object', 'embed', 'feimage', 'animate', 'set', 'animatetransform', 'animatemotion']) expect(names, gone).not.toContain(gone)
    expect(out.querySelector('rect')).not.toBeNull()
    expect(out.querySelector('filter#f')).not.toBeNull()
  })

  it('removes event handlers and any href that is not a #fragment', () => {
    const out = tidy('<g onclick="alert(1)" onmouseover="x()"><use href="https://evil.example/s.svg#a"/><use href="#ok"/><rect onload="x()"/></g>', 'onload="alert(1)"')
    const attrs = attrValues(out)
    expect(attrs.filter(a => a.startsWith('on'))).toEqual([])
    expect(attrs).toContain('href=#ok')
    expect(attrs.join(' ')).not.toContain('evil.example')
  })

  it('refuses a figure that needs HTML labels, so the card shows the source', () => {
    expect(() => tidySvg(svg('<g><foreignObject width="10" height="10"><div xmlns="http://www.w3.org/1999/xhtml">Refund</div></foreignObject></g>'), 'Diagram 1')).toThrow(/HTML labels/)
    expect(() => tidySvg(svg('<a href="#x"><foreignObject><span>x</span></foreignObject></a>'), 'Diagram 1')).toThrow(/HTML labels/)
  })

  it.each([
    ['an external url()', '.node rect { stroke-width: 2; background-image: url(https://evil.example/a.png); }'],
    ['a same-origin url()', '.node rect { background: url(/cdn-cgi/access/logout); }'],
    ['a quoted url()', '.a { background: url("https://evil.example/") }'],
    ['image-set()', '.a { background-image: image-set("https://evil.example/a.png" 1x); }'],
    ['-webkit-image-set()', '.a { background-image: -webkit-image-set("/x" 1x); }'],
    ['image()', '.a { background-image: image("/x"); }'],
    ['src()', '.a { background-image: src("/x"); }'],
    ['@import', '@import "https://evil.example/a.css"; .a { stroke-width: 2; }'],
    ['@import url()', '@import url(/x.css) screen; .a { stroke-width: 2; }'],
    ['a backslash escape', '.a { background: \\75 rl(/x); }'],
    ['an escaped @import', '@\\69mport "/x.css"; .a { stroke-width: 2; }'],
    ['@font-face src', '@font-face { font-family: x; src: url(/font.woff2); }'],
  ])('drops %s from a <style>', (_, css) => {
    const out = tidy(`<style>${css}</style><rect class="a"/>`)
    const text = out.querySelector('style')!.textContent ?? ''
    expect(text).not.toMatch(/url\(\s*(?!['"]?#)|image-set\(|image\(|src\(|@import|\\/i)
    // The parser kept the style's text (so the check above is not looking at an empty one).
    expect(text).toContain('{')
  })

  it('refuses HTML inside the figure (a <title> or <desc> is an HTML integration point)', () => {
    expect(() => tidySvg('<svg viewBox="0 0 10 10"><title><img src="/x"></title><rect/></svg>', 'Diagram 1')).toThrow(/non-SVG/)
    expect(() => tidySvg('<svg viewBox="0 0 10 10"><desc><video poster="/x"></video></desc></svg>', 'Diagram 1')).toThrow(/non-SVG/)
  })

  it('keeps the rest of the style, and #fragment url()s (markers, filters)', () => {
    const out = tidy('<style>.a { stroke-width: 2; background: url(/x); opacity: 0.5; } .b { filter: url(#drop-shadow); }</style>')
    const text = out.querySelector('style')!.textContent ?? ''
    expect(text).toContain('stroke-width: 2')
    expect(text).toContain('opacity: 0.5')
    expect(text).toContain('url(#drop-shadow)')
    expect(text).not.toContain('url(/x)')
  })

  it('drops an address from a style attribute and keeps the rest', () => {
    const out = tidy('<g style="stroke-width:2;background-image:url(/cdn-cgi/access/logout);opacity:0.5"/><g style="stroke-width:3;background:image-set(&quot;/x&quot; 1x)"/><g style="opacity:\\31"/>')
    const styles = [...out.querySelectorAll('g')].map(g => g.getAttribute('style') ?? '')
    expect(styles[0]).toContain('stroke-width:2')
    expect(styles[0]).toContain('opacity:0.5')
    for (const s of styles) expect(s).not.toMatch(/url\(|image-set\(|\\/i)
  })

  it.each(['fill', 'stroke', 'filter', 'clip-path', 'mask', 'marker-start', 'marker-mid', 'marker-end', 'cursor'])('drops an address from the %s attribute, keeps a #fragment one', attr => {
    const out = tidy(`<path id="p1" ${attr}="url(/x)"/><path id="p2" ${attr}="url(https://evil.example/#a)"/><path id="p3" ${attr}="url(#m)"/>`)
    expect(out.querySelector('#p1')!.hasAttribute(attr)).toBe(false)
    expect(out.querySelector('#p2')!.hasAttribute(attr)).toBe(false)
    expect(out.querySelector('#p3')!.getAttribute(attr)).toBe('url(#m)')
  })

  it('names the figure for a screen reader and gives it its natural size', () => {
    const out = tidy('<title>Refunds</title><rect/>', 'aria-roledescription="flowchart" aria-labelledby="t" width="100%" style="max-width: 200px;"')
    expect(out.getAttribute('role')).toBe('img')
    expect(out.getAttribute('aria-label')).toBe('Diagram 1: Refunds')
    expect(out.hasAttribute('aria-roledescription')).toBe(false)
    expect(out.getAttribute('width')).toBe('200')
    expect(out.getAttribute('height')).toBe('100')
  })
})

describe('cleanCss', () => {
  it('never joins the parts around a removed one into a new address', () => {
    expect(cleanCss('a{x:u@import "y";rl(/z)}')).not.toMatch(/url\(/)
    expect(cleanCss('a{x:ur;l(/z)}')).toBe('a{x:ur;l(/z)}')
  })
})
