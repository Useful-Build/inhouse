// A small markdown renderer for the agent's text parts: paragraphs and line breaks, headings, rules, bold, italic,
// inline code, code blocks (with Copy), quotes, bullet and numbered lists (one level of nesting), links and tables
// (which scroll sideways when wide). No HTML is ever passed through: everything renders as React text.
import { Fragment } from 'react'
import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { IconButton } from '../../ui'
import { copyText } from './copy'
import { FENCE, ROW, SEP } from './md-syntax'

interface List { ordered: boolean; start: number; items: { text: string; sub?: List }[] }
type Block =
  | { k: 'p'; lines: string[] }
  | { k: 'h'; level: number; text: string }
  | { k: 'hr' }
  | { k: 'code'; text: string; lang: string }
  | { k: 'quote'; lines: string[] }
  | { k: 'list'; list: List }
  | { k: 'table'; head: string[]; rows: string[][] }

const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/
const HR = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/
const LIST = /^(\s*)(?:[-*+]|(\d+)[.)])\s+(.*)$/
// Only "> " (or a bare ">") starts a quote, so ">100 units" stays text.
const QUOTE = /^\s*>(?: (.*)|\s*$)/

/** A table row's cells: split on pipes that aren't escaped, then `\|` becomes `|`. */
function cells(line: string): string[] {
  const t = line.trim().replace(/^\|/, '')
  const out: string[] = []
  let cur = ''
  for (let i = 0; i < t.length; i++) {
    const c = t[i]
    if (c === '\\' && t[i + 1] === '|') { cur += '|'; i++ }
    else if (c === '|') { out.push(cur.trim()); cur = '' }
    else cur += c
  }
  if (cur.trim()) out.push(cur.trim())
  return out
}
const startsOtherBlock = (line: string, next: string | undefined) =>
  FENCE.test(line) || HEADING.test(line) || HR.test(line) || QUOTE.test(line) || (ROW.test(line) && next !== undefined && SEP.test(next))
/** A list item that may interrupt a paragraph: a bullet, or a numbered one that starts at 1 (so a wrapped "2024. Revenue" stays text). */
const interruptsParagraph = (line: string) => { const m = LIST.exec(line); return !!m && (m[2] === undefined || Number(m[2]) === 1) }
const startsBlock = (line: string, next: string | undefined) => startsOtherBlock(line, next) || interruptsParagraph(line)

function parseBlocks(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, '\n').split('\n')
  const out: Block[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (!line.trim()) { i++; continue }
    const fence = FENCE.exec(line)
    if (fence) {
      const body: string[] = []
      i++
      while (i < lines.length && !FENCE.test(lines[i])) body.push(lines[i++])
      i++ // the closing fence (or the end)
      out.push({ k: 'code', text: body.join('\n'), lang: fence[1] })
      continue
    }
    const h = HEADING.exec(line)
    if (h) { out.push({ k: 'h', level: h[1].length, text: h[2] }); i++; continue }
    if (HR.test(line)) { out.push({ k: 'hr' }); i++; continue }
    if (ROW.test(line) && i + 1 < lines.length && SEP.test(lines[i + 1])) {
      const head = cells(line)
      const rows: string[][] = []
      i += 2
      while (i < lines.length && ROW.test(lines[i])) rows.push(cells(lines[i++]))
      out.push({ k: 'table', head, rows })
      continue
    }
    if (QUOTE.test(line)) {
      const got: string[] = []
      let m: RegExpExecArray | null
      while (i < lines.length && (m = QUOTE.exec(lines[i]))) { got.push(m[1] ?? ''); i++ }
      out.push({ k: 'quote', lines: got })
      continue
    }
    const first = LIST.exec(line)
    if (first) {
      // Items at the first item's indent (or one space off) are the list's own, of its kind; deeper ones nest under the
      // item above them, one level deep. Another kind at the top level starts a new list.
      const base = first[1].length
      const list: List = { ordered: first[2] !== undefined, start: Number(first[2] ?? 1), items: [] }
      let m: RegExpExecArray | null
      let latest = list.items[0]
      while (i < lines.length) {
        m = LIST.exec(lines[i])
        if (!m) {
          // A line that continues the item above it (indented or wrapped) stays with that item.
          if (!lines[i].trim() || startsOtherBlock(lines[i], lines[i + 1]) || !latest) break
          latest.text += ' ' + lines[i].trim()
          i++
          continue
        }
        const ordered = m[2] !== undefined
        const deeper = m[1].length > base + 1
        const parent = list.items[list.items.length - 1]
        if (deeper && parent) {
          parent.sub ??= { ordered, start: Number(m[2] ?? 1), items: [] }
          latest = { text: m[3] }
          parent.sub.items.push(latest)
        } else if (ordered === list.ordered) { latest = { text: m[3] }; list.items.push(latest) }
        else break
        i++
      }
      out.push({ k: 'list', list })
      continue
    }
    const para: string[] = []
    while (i < lines.length && lines[i].trim() && (para.length === 0 || !startsBlock(lines[i], lines[i + 1]))) para.push(lines[i++])
    out.push({ k: 'p', lines: para })
  }
  return out
}

// Inline code first (nothing inside it is formatted), then links (a URL may hold one level of parentheses), bold and
// italic. The word-boundary checks before `*` and `_` are done in code, not with a lookbehind (Safari before 16.4).
const INLINE = /(`[^`\n]+`)|(\[[^\]\n]+\]\((?:[^()\s]|\([^()\s]*\))+\))|(\*\*[^*\n]+\*\*)|(\*[^*\s][^*\n]*\*(?![\w*]))|(_[^_\s][^_\n]*_(?!\w))/g
const LINK = /^\[([^\]]+)\]\((.+)\)$/
const SAFE_HREF = /^(https?:|mailto:|#)/i
const WORD = /\w/

/** Plain text as words, each in its own span. A span keeps its key as the text grows, so only the words that are new mount, and the mount fades them in. */
function words(text: string, key: string): ReactNode {
  return <Fragment key={key}>{(text.match(/\S+\s*|\s+/g) ?? []).map((w, i) => <span key={i} className="animate-word-in">{w}</span>)}</Fragment>
}

function inline(text: string, key = 'i', fade = false): ReactNode[] {
  const out: ReactNode[] = []
  const plain = (t: string) => (fade ? words(t, `${key}-s${out.length}`) : t)
  const re = new RegExp(INLINE.source, 'g')
  let from = 0, n = 0
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const before = text[m.index - 1] ?? ''
    // An italic star or underscore must not follow a letter (or another star): try again one character on.
    if ((m[4] && (WORD.test(before) || before === '*')) || (m[5] && WORD.test(before))) { re.lastIndex = m.index + 1; continue }
    if (m.index > from) out.push(plain(text.slice(from, m.index)))
    const tok = m[0], k = `${key}-${n++}`
    if (m[1]) out.push(<code key={k} className="rounded-sm bg-muted px-1 py-0.5 font-mono text-sm">{tok.slice(1, -1)}</code>)
    else if (m[2]) {
      const [, label, href] = LINK.exec(tok)!
      const external = /^https?:/i.test(href)
      out.push(SAFE_HREF.test(href)
        ? <a key={k} href={href} {...(external ? { target: '_blank', rel: 'noreferrer' } : {})} className="font-medium underline underline-offset-2 hover:text-foreground-2">{inline(label, k, fade)}</a>
        : label)
    }
    else if (m[3]) out.push(<strong key={k} className="font-semibold">{inline(tok.slice(2, -2), k, fade)}</strong>)
    else out.push(<em key={k}>{inline(tok.slice(1, -1), k, fade)}</em>)
    from = m.index + tok.length
  }
  if (from < text.length) out.push(plain(text.slice(from)))
  return out
}

const withBreaks = (lines: string[], key: string, fade: boolean) =>
  lines.flatMap((l, j) => (j ? [<br key={`${key}-br${j}`} />, ...inline(l, `${key}-${j}`, fade)] : inline(l, `${key}-${j}`, fade)))

const HEADING_LOOK = ['text-xl font-semibold tracking-section', 'text-lg font-semibold', 'text-md font-semibold']

/** `page`: a document read on its own page (a skill's instructions), in larger type with room between sections. */
type Look = 'chat' | 'page'

function ListView({ list, k, fade, look }: { list: List; k: string; fade: boolean; look: Look }) {
  const items = list.items.map((it, j) => (
    <li key={j} className={cn(look === 'page' && 'pl-1')}>
      {inline(it.text, `${k}-${j}`, fade)}
      {it.sub && <ListView list={it.sub} k={`${k}-${j}s`} fade={fade} look={look} />}
    </li>
  ))
  const cls = look === 'page' ? 'flex flex-col gap-2.5 pl-6.5 marker:text-foreground-3 marker:tabular-nums [li_&]:mt-2.5' : 'flex flex-col gap-1 pl-5 [li_&]:mt-1'
  return list.ordered
    ? <ol start={list.start} className={cn('list-decimal', cls)}>{items}</ol>
    : <ul className={cn('list-disc', cls)}>{items}</ul>
}

/** A SKILL.md's frontmatter (a `---` block at the very top): not part of what a person reads. */
const FRONTMATTER = /^\uFEFF?---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/
const stripFrontmatter = (text: string) => text.replace(FRONTMATTER, '')

/** The blocks of a text part. A blank line between paragraphs keeps its old height (one line). */
/** `fade`: the text is being revealed, so its plain words each fade in as they first show (reveal.ts). */
/** `look`: `chat` for an answer, `page` for a document on its own page (frontmatter stripped, larger type, its headings from h2). */
export function Markdown({ text, fade = false, look = 'chat' }: { text: string; fade?: boolean; look?: Look }) {
  const page = look === 'page'
  const blocks = parseBlocks(page ? stripFrontmatter(text) : text)
  // Code blocks and tables are numbered, so each scroll area and Copy button has its own name.
  const numbered = (kind: Block['k']) => { let n = 0; return blocks.map(b => (b.k === kind ? ++n : 0)) }
  const codeNo = numbered('code'), tableNo = numbered('table')
  return (
    <div className={cn('flex min-w-0 flex-col', page ? 'gap-4 text-lg leading-reading' : 'gap-6')}>
      {blocks.map((b, i) => {
        const key = `b${i}`
        switch (b.k) {
          case 'p': return <p key={key}>{withBreaks(b.lines, key, fade)}</p>
          case 'h': {
            // The chat page has no h1 or h2 of its own (its title is in the top bar), so an answer's # is an h2, ## an h3
            // and so on down to h6.
            const Tag = (['h2', 'h3', 'h4', 'h5', 'h6', 'h6'] as const)[b.level - 1]
            // A page's document has its own h1 above it, so # and ## are both its h2, a section heading, with room above it.
            if (page) {
              const PageTag = (['h2', 'h2', 'h3', 'h4', 'h5', 'h6'] as const)[b.level - 1]
              return <PageTag key={key} className={cn('leading-card font-semibold tracking-section not-first:mt-6', b.level <= 2 ? 'text-xl' : 'text-lg')}>{inline(b.text, key, fade)}</PageTag>
            }
            return <Tag key={key} className={`-mb-3 leading-heading ${HEADING_LOOK[Math.min(b.level, 3) - 1]}`}>{inline(b.text, key, fade)}</Tag>
          }
          case 'hr': return <hr key={key} className="border-0 border-t border-divider" />
          case 'quote': return <blockquote key={key} className="border-l-2 border-border-strong pl-3.5 text-foreground-2">{withBreaks(b.lines, key, fade)}</blockquote>
          case 'list': return <ListView key={key} list={b.list} k={key} fade={fade} look={look} />
          case 'code': {
            const label = `Code block ${codeNo[i]}${b.lang ? `, ${b.lang}` : ''}`
            return (
              <div key={key} data-md-code className="relative min-w-0 rounded-xl bg-muted">
                {/* Focusable so a keyboard can scroll a long line sideways. */}
                <pre role="region" aria-label={label} tabIndex={0} className="overflow-x-auto rounded-xl py-3 pr-11 pl-3.5 font-mono text-sm leading-prose wrap-normal whitespace-pre"><code>{b.text}</code></pre>
                <IconButton icon="content_copy" label={`Copy code block ${codeNo[i]}${b.lang ? `, ${b.lang}` : ''}`} size={16} box="icon-sm" className="absolute top-1.5 right-1.5 bg-muted hover:bg-fill-hover" onClick={() => copyText(b.text, 'Code copied')} />
              </div>
            )
          }
          case 'table': {
            const n = tableNo[i]
            const cols = b.head.slice(0, 3).filter(Boolean).join(', ')
            // Rows with more cells than the header widen the table (the extra headers are blank), none are dropped.
            const width = Math.max(b.head.length, ...b.rows.map(r => r.length))
            const span = Array.from({ length: width }, (_, j) => j)
            return (
              // Focusable so a keyboard can scroll a wide table sideways.
              <div key={key} data-md-table role="region" aria-label={cols ? `Table ${n}: ${cols}` : `Table ${n}`} tabIndex={0} className="min-w-0 overflow-x-auto rounded-xl border border-border">
                <table className="w-full border-collapse text-sm tabular-nums">
                  <thead>
                    <tr>{span.map(j => <th key={j} scope="col" className="border-b border-divider px-3 py-2 text-left font-strong whitespace-nowrap">{inline(b.head[j] ?? '', `${key}-h${j}`)}</th>)}</tr>
                  </thead>
                  <tbody>
                    {b.rows.map((r, ri) => (
                      <tr key={ri} className="border-b border-divider last:border-b-0">
                        {span.map(j => <td key={j} className="px-3 py-2 whitespace-nowrap text-foreground-2">{inline(r[j] ?? '', `${key}-${ri}-${j}`)}</td>)}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
          }
        }
      })}
    </div>
  )
}
