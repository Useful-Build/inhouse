// The Streamdown renderer against the one it replaced (a hand-written parser, deleted in the same PR). Ways it could go
// wrong, written first: an answer that looked one way now looks another; a heading level, a region name or a Copy button
// moves; a table loses a cell or a wide row is cut; text the old renderer kept as text (">100", raw HTML, "<order-id>")
// becomes a quote or vanishes.
// `was` is the old renderer's output for the text, recorded on 2026-11-25 before it was deleted, as an outline (tags, text
// and the attributes the specs and screen readers use; classes are left out, the tokens are checked in the browser). A
// case with no `now` must still come out as `was`. A case with `now` is an intended difference: `why` says which.
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, test, vi } from 'vitest'
import { Markdown } from './renderer'

vi.mock('../../../ui', () => ({ IconButton: ({ label }: { label: string }) => createElement('button', { 'aria-label': label }) }))
vi.mock('../copy', () => ({ copyText: () => undefined }))

const KEEP = new Set(['href', 'src', 'alt', 'start', 'role', 'aria-label', 'tabindex', 'scope', 'target', 'rel', 'loading', 'referrerpolicy', 'data-md-code', 'data-md-table'])
/** Tags and text, with only the attributes in KEEP (sorted), no `start="1"`, and no whitespace the renderers add between tags. */
function outline(html: string): string {
  return html.replace(/<(\/?)([a-z0-9]+)((?:\s+[^\s=>]+(?:="[^"]*")?)*)\s*(\/?)>/g, (_, close, tag, attrs, self) => {
    const kept = [...attrs.matchAll(/\s+([^\s=>]+)(?:="([^"]*)")?/g)]
      .filter(m => KEEP.has(m[1]) && !(m[1] === 'start' && m[2] === '1'))
      .map(m => (m[2] === undefined ? m[1] : `${m[1]}="${m[2]}"`)).sort()
    return `<${close}${tag}${kept.length ? ' ' + kept.join(' ') : ''}${self}>`
  }).replace(/\n(?=<)|(?<=>)\n/g, '').replace(/ +<br\/>/g, '<br/>')
}

interface Case { name: string; md: string; look?: 'chat' | 'page'; hosts?: string[]; was: string; now?: string; why?: string }
const CASES: Case[] = [
  { name: 'headings', md: '# a\n## b\n### c\n#### d\n##### e\n###### f\n####### g', was: '<div><h2>a</h2><h3>b</h3><h4>c</h4><h5>d</h5><h6>e</h6><h6>f</h6><p>####### g</p></div>' },
  { name: 'page headings', md: '# a\n## b\n### c\n#### d', look: 'page', was: '<div><h2>a</h2><h2>b</h2><h3>c</h3><h4>d</h4></div>' },
  { name: 'paragraphs and breaks', md: 'one\ntwo\n\nthree  \nfour', was: '<div><p>one<br/>two</p><p>three<br/>four</p></div>' },
  { name: 'inline', md: '**b** *i* _i_ `c` snake_case_name 2*3*4 **bold *and* it**', was: '<div><p><strong>b</strong> <em>i</em> <em>i</em> <code>c</code> snake_case_name 2*3*4 **bold <em>and</em> it**</p></div>', now: '<div><p><strong>b</strong> <em>i</em> <em>i</em> <code>c</code> snake_case_name 2<em>3</em>4 <strong>bold <em>and</em> it</strong></p></div>', why: 'CommonMark emphasis: a star inside a word (2*3*4) and bold around italic (**bold *and* it**) now format.' },
  { name: 'links', md: '[Tools](#/tools/shopify) [n](#note) [x](https://a.test/p) [y](https://b.test/) <https://a.test/q> https://a.test/r. www.a.test/z a@b.test', hosts: ['a.test', 'www.a.test'], was: '<div><p><a href="#/tools/shopify">Tools</a> n <a href="https://a.test/p" rel="noreferrer" target="_blank">x</a> y <a href="https://a.test/q" rel="noreferrer" target="_blank">https://a.test/q</a> <a href="https://a.test/r" rel="noreferrer" target="_blank">https://a.test/r</a>. <a href="https://www.a.test/z" rel="noreferrer" target="_blank">www.a.test/z</a> a@b.test</p></div>' },
  { name: 'images', md: '![i](https://a.test/i.png) ![j](https://b.test/j.png) ![k](<https://a.test/k.png>)', hosts: ['a.test'], was: '<div><p><img alt="i" loading="lazy" src="https://a.test/i.png"/> j <img alt="k" loading="lazy" src="https://a.test/k.png"/></p></div>' },
  { name: 'page links', md: '[x](https://b.test/) [m](mailto:a@b.test) [n](#note) [o](/rel) ![i](https://b.test/i.png)', look: 'page', was: '<div><p><a href="https://b.test/" rel="noreferrer" target="_blank">x</a> <a href="mailto:a@b.test">m</a> <a href="#note">n</a> o !<a href="https://b.test/i.png" rel="noreferrer" target="_blank">i</a></p></div>', now: '<div><p><a href="https://b.test/" rel="noreferrer" target="_blank">x</a> <a href="mailto:a@b.test">m</a> <a href="#note">n</a> o i</p></div>', why: 'A page shows an image as its text (the old renderer drew "!" and a link).' },
  { name: 'quotes', md: '> a\n> b\n\n>100 units\n\n>\n\n> *q*', was: '<div><blockquote>a<br/>b</blockquote><p>&gt;100 units</p><blockquote></blockquote><blockquote><em>q</em></blockquote></div>', now: '<div><blockquote><p>a<br/>b</p></blockquote><p>&gt;100 units</p><blockquote></blockquote><blockquote><p><em>q</em></p></blockquote></div>', why: 'A quote holds paragraphs (blockquote > p), not bare text.' },
  { name: 'lists', md: '- one\n- two\n  - sub\n  - sub2\n\n1. a\n2. b\n\n3. c\n4. d', was: '<div><ul><li>one</li><li>two<ul><li>sub</li><li>sub2</li></ul></li></ul><ol><li>a</li><li>b</li></ol><ol start="3"><li>c</li><li>d</li></ol></div>', now: '<div><ul><li>one</li><li>two<ul><li>sub</li><li>sub2</li></ul></li></ul><ol><li><p>a</p></li><li><p>b</p></li><li><p>c</p></li><li><p>d</p></li></ol></div>', why: 'A list that goes on after a blank line is one list with paragraph items (the old renderer made one list per run).' },
  { name: 'numbered from 3', md: '3. a\n4. b', was: '<div><ol start="3"><li>a</li><li>b</li></ol></div>' },
  { name: 'mixed kinds', md: '- a\n1. b\n- c', was: '<div><ul><li>a</li></ul><ol><li>b</li></ol><ul><li>c</li></ul></div>' },
  { name: 'wrapped item', md: '- a very\n  long item\n- next', was: '<div><ul><li>a very long item</li><li>next</li></ul></div>', now: '<div><ul><li>a very<br/>long item</li><li>next</li></ul></div>', why: 'A wrapped list-item line is a line break (the old renderer joined it with a space).' },
  { name: 'year', md: 'intro\n2024. Revenue grew', was: '<div><p>intro<br/>2024. Revenue grew</p></div>' },
  { name: 'loose list', md: '- a\n\n- b\n\n- c', was: '<div><ul><li>a</li></ul><ul><li>b</li></ul><ul><li>c</li></ul></div>', now: '<div><ul><li><p>a</p></li><li><p>b</p></li><li><p>c</p></li></ul></div>', why: 'Items split by blank lines are one list with paragraph items (the old renderer made a list per item).' },
  { name: 'rules', md: 'a\n\n---\n\n***\n\n___\n\nb', was: '<div><p>a</p><hr/><hr/><hr/><p>b</p></div>' },
  { name: 'code', md: '```sql\nSELECT 1\nFROM x\n```\n\n```\nplain\n```\n\n```js\n# not a heading\n| a | b |\n|---|---|\n```', was: '<div><div data-md-code="true"><pre aria-label="Code block 1, sql" role="region" tabindex="0"><code>SELECT 1\nFROM x</code></pre><button aria-label="Copy code block 1, sql"></button></div><div data-md-code="true"><pre aria-label="Code block 2" role="region" tabindex="0"><code>plain</code></pre><button aria-label="Copy code block 2"></button></div><div data-md-code="true"><pre aria-label="Code block 3, js" role="region" tabindex="0"><code># not a heading\n| a | b |\n|---|---|</code></pre><button aria-label="Copy code block 3, js"></button></div></div>' },
  { name: 'unclosed fence', md: 'text\n\n```py\nprint(1)\n', was: '<div><p>text</p><div data-md-code="true"><pre aria-label="Code block 1, py" role="region" tabindex="0"><code>print(1)</code></pre><button aria-label="Copy code block 1, py"></button></div></div>' },
  { name: 'table', md: '| SKU | Product | Units |\n|---|---|---:|\n| A | **Shirt** | 3 |\n| B | `Hat` | 4 |', was: '<div><div aria-label="Table 1: SKU, Product, Units" data-md-table="true" role="region" tabindex="0"><table><thead><tr><th scope="col">SKU</th><th scope="col">Product</th><th scope="col">Units</th></tr></thead><tbody><tr><td>A</td><td><strong>Shirt</strong></td><td>3</td></tr><tr><td>B</td><td><code>Hat</code></td><td>4</td></tr></tbody></table></div></div>' },
  { name: 'wide and short rows', md: '| a | b |\n|---|---|\n| 1 | 2 | 3 |\n| 4 |', was: '<div><div aria-label="Table 1: a, b" data-md-table="true" role="region" tabindex="0"><table><thead><tr><th scope="col">a</th><th scope="col">b</th><th scope="col"></th></tr></thead><tbody><tr><td>1</td><td>2</td><td>3</td></tr><tr><td>4</td><td></td><td></td></tr></tbody></table></div></div>' },
  { name: 'escaped pipe', md: '| a | b |\n|---|---|\n| x \\| y | z |', was: '<div><div aria-label="Table 1: a, b" data-md-table="true" role="region" tabindex="0"><table><thead><tr><th scope="col">a</th><th scope="col">b</th></tr></thead><tbody><tr><td>x | y</td><td>z</td></tr></tbody></table></div></div>' },
  { name: 'no edge pipes', md: 'a | b\n--|--\n1 | 2', was: '<div><p>a | b<br/>--|--<br/>1 | 2</p></div>', now: '<div><div aria-label="Table 1: a, b" data-md-table="true" role="region" tabindex="0"><table><thead><tr><th scope="col">a</th><th scope="col">b</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table></div></div>', why: 'GFM reads a table whose rows have no edge pipes.' },
  { name: 'table in text', md: 'before\n| a | b |\n|---|---|\n| 1 | 2 |\nafter', was: '<div><p>before</p><div aria-label="Table 1: a, b" data-md-table="true" role="region" tabindex="0"><table><thead><tr><th scope="col">a</th><th scope="col">b</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table></div><p>after</p></div>', now: '<div><p>before</p><div aria-label="Table 1: a, b" data-md-table="true" role="region" tabindex="0"><table><thead><tr><th scope="col">a</th><th scope="col">b</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr><tr><td>after</td><td></td></tr></tbody></table></div></div>', why: 'GFM keeps taking lines into a table: a text line right under the rows is a row (a blank line ends the table).' },
  { name: 'html', md: '<img src=x onerror=alert(1)> <script>alert(1)</script>\n\n<div>\nblock\n</div>\n\n<order-id>', was: '<div><p>&lt;img src=x onerror=alert(1)&gt; &lt;script&gt;alert(1)&lt;/script&gt;</p><p>&lt;div&gt;<br/>block<br/>&lt;/div&gt;</p><p>&lt;order-id&gt;</p></div>' },
  { name: 'frontmatter', md: '---\nname: x\ndescription: y\n---\n\n## When\n\n- a\n\n---\n\n## Steps\n\n1. b', look: 'page', was: '<div><h2>When</h2><ul><li>a</li></ul><hr/><h2>Steps</h2><ol><li>b</li></ol></div>' },
  { name: 'setext', md: 'Title\n=====\n\nSub\n---', was: '<div><p>Title<br/>=====</p><p>Sub</p><hr/></div>', now: '<div><h2>Title</h2><h3>Sub</h3></div>', why: 'Setext headings (a line under the title) are headings.' },
  { name: 'strike', md: '~~gone~~ and ~one~', was: '<div><p>~~gone~~ and ~one~</p></div>', now: '<div><p><del>gone</del> and <del>one</del></p></div>', why: 'Strikethrough (~~x~~ and ~x~) formats.' },
  { name: 'task list', md: '- [ ] todo\n- [x] done', was: '<div><ul><li>[ ] todo</li><li>[x] done</li></ul></div>', now: '<div><ul><li><input aria-label="To do"/> todo</li><li><input aria-label="Done"/> done</li></ul></div>', why: 'A task-list box shows as a named, read-only checkbox.' },
  { name: 'indented code', md: 'text\n\n    indented\n    more', was: '<div><p>text</p><p>    indented<br/>    more</p></div>', now: '<div><p>text</p><div data-md-code="true"><pre aria-label="Code block 1" role="region" tabindex="0"><code>indented\nmore</code></pre><button aria-label="Copy code block 1"></button></div></div>', why: 'Four spaces of indent make a code block (CommonMark).' },
  { name: 'link reference', md: '[a][1]\n\n[1]: https://a.test/', was: '<div><p>[a][1]</p><p>[1]: https://a.test/</p></div>', now: '<div><p>a</p></div>', why: 'Reference-style links resolve.' },
  { name: 'escapes', md: '\\*not bold\\* &amp; &lt;', was: '<div><p>\\<em>not bold\\</em> &amp;amp; &amp;lt;</p></div>', now: '<div><p>*not bold* &amp; &lt;</p></div>', why: 'Backslash escapes and entities are decoded (CommonMark).' },
  { name: 'empty', md: '', was: '<div></div>' },
]

describe('the corpus', () => {
  test.each(CASES)('$name', ({ md, look = 'chat', hosts = [], was, now }) => {
    expect(outline(renderToStaticMarkup(createElement(Markdown, { text: md, look, linkHosts: hosts })))).toBe(now ?? was)
  })

  test('every intended difference says why, and differs', () => {
    for (const c of CASES) {
      if (c.now === undefined) { expect(c.why, c.name).toBeUndefined(); continue }
      expect(c.why?.length, c.name).toBeGreaterThan(10)
      expect(c.now, c.name).not.toBe(c.was)
    }
  })
})
