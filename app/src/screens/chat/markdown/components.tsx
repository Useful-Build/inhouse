// How each markdown element looks, on the app's tokens. One set per look, built once (Streamdown re-renders only what
// changed, and only while the components keep their identity). Every element Streamdown knows is set here, so none of
// its own Tailwind classes (which this app's build never generates) reach the page.
import type { ComponentProps } from 'react'
import type { Components, ExtraProps } from 'streamdown'
import { cn } from '@/lib/utils'
import { CodeSnippet } from '../../../ui/code-snippet'
import { copyText } from '../copy'
import { imageSrc, linkTarget } from './policy'
import type { Look } from './policy'

type HastNode = NonNullable<ExtraProps['node']>
type Props<K extends keyof HTMLElementTagNameMap> = ComponentProps<K> & ExtraProps

/** The text of a node and everything inside it. */
const textOf = (node: { type: string; value?: string; children?: unknown[] } | undefined): string =>
  !node ? '' : node.type === 'text' ? node.value ?? '' : (node.children ?? []).map(c => textOf(c as never)).join('')

const ANCHOR = 'font-medium underline underline-offset-2 hover:text-foreground-2'
const HEADING_LOOK = ['text-xl font-semibold tracking-section', 'text-lg font-semibold', 'text-md font-semibold']

/** The chat page has no h1 or h2 of its own (its title is in the top bar), so an answer's # is an h2, ## an h3 and so on down to h6. */
const CHAT_TAGS = ['h2', 'h3', 'h4', 'h5', 'h6', 'h6'] as const
/** A page's document has its own h1 above it, so # and ## are both its h2, a section heading, with room above it. */
const PAGE_TAGS = ['h2', 'h2', 'h3', 'h4', 'h5', 'h6'] as const

const listClass = (page: boolean, ordered: boolean) => cn(
  ordered ? 'list-decimal' : 'list-disc',
  page ? 'flex max-w-reading-measure flex-col gap-2.5 pl-6.5 marker:text-foreground-3 marker:tabular-nums [li_&]:mt-2.5' : 'flex flex-col gap-1 pl-5 [li_&]:mt-1',
)

function build(look: Look, linkHosts: readonly string[]): Components {
  const page = look === 'page'
  // On a page, text keeps a readable measure while tables and code blocks use the full width.
  const measure = page && 'max-w-reading-measure'
  const heading = (level: number) => function Heading({ children }: Props<'h2'>) {
    const Tag = (page ? PAGE_TAGS : CHAT_TAGS)[level - 1]
    return page
      ? <Tag className={cn('leading-card font-semibold tracking-section not-first:mt-6', measure, level <= 2 ? 'text-xl' : 'text-lg')}>{children}</Tag>
      : <Tag className={`-mb-3 leading-heading ${HEADING_LOOK[Math.min(level, 3) - 1]}`}>{children}</Tag>
  }
  return {
    h1: heading(1), h2: heading(2), h3: heading(3), h4: heading(4), h5: heading(5), h6: heading(6),
    p: ({ children }: Props<'p'>) => <p className={cn(measure)}>{children}</p>,
    strong: ({ children }: Props<'strong'>) => <strong className="font-semibold">{children}</strong>,
    hr: () => <hr className="border-0 border-t border-divider" />,
    blockquote: ({ children }: Props<'blockquote'>) => <blockquote className={cn('flex flex-col gap-3 border-l-2 border-border-strong pl-3.5 text-foreground-2', measure)}>{children}</blockquote>,
    ul: ({ children }: Props<'ul'>) => <ul className={listClass(page, false)}>{children}</ul>,
    ol: ({ children, start }: Props<'ol'>) => <ol start={start} className={listClass(page, true)}>{children}</ol>,
    li: ({ children }: Props<'li'>) => <li className={cn(page && 'pl-1')}>{children}</li>,
    code: ({ children }: Props<'code'>) => <code className="rounded-sm bg-muted px-1 py-0.5 font-mono text-sm">{children}</code>,
    a: ({ href, children, node }: Props<'a'>) => {
      const to = linkTarget(href, look, linkHosts, textOf(node))
      if (!to) return <>{children}</>
      return <a href={to.href} {...(to.external ? { target: '_blank', rel: 'noreferrer' } : {})} className={ANCHOR}>{children}</a>
    },
    img: ({ src, alt }: Props<'img'>) => {
      const url = typeof src === 'string' ? imageSrc(src, look, linkHosts) : null
      return url ? <img src={url} alt={alt} loading="lazy" referrerPolicy="no-referrer" /> : <>{alt || (typeof src === 'string' ? src : '')}</>
    },
    // The sanitizer step turns a link or image it blocks into a span of its text: plain text, as the old renderer showed it.
    span: ({ children }: Props<'span'>) => <>{children}</>,
    // A task list's box (`- [ ] x`): shown, not editable, and named.
    input: ({ checked }: Props<'input'>) => <input type="checkbox" checked={!!checked} readOnly disabled aria-label={checked ? 'Done' : 'To do'} className="mr-1.5 align-middle" />,
    // A code block: its text and language come from the tree (the `code` inside), not from rendered children.
    pre: ({ node }: Props<'pre'>) => {
      const code = node?.children.find((c): c is HastNode => c.type === 'element' && c.tagName === 'code')
      // The tree's code text ends with a newline the fence did not hold.
      const text = textOf(code).replace(/\n$/, '')
      const cls = code?.properties?.className
      const lang = (Array.isArray(cls) ? cls.map(String) : []).find(c => c.startsWith('language-'))?.slice('language-'.length) ?? ''
      const n = Number(node?.properties?.dataMdN)
      const name = `code block ${n}${lang ? `, ${lang}` : ''}`
      return <CodeSnippet text={text} label={`Code block ${n}${lang ? `, ${lang}` : ''}`} copyLabel={`Copy ${name}`} onCopy={t => copyText(t, 'Code copied')} />
    },
    table: ({ children, node }: Props<'table'>) => {
      const n = Number(node?.properties?.dataMdN)
      // The first three named columns name the table.
      const head = node?.children.find((c): c is HastNode => c.type === 'element' && c.tagName === 'thead')
      const cols = textOfCells(head).slice(0, 3).filter(Boolean).join(', ')
      return (
        // Focusable so a keyboard can scroll a wide table sideways.
        <div data-md-table role="region" aria-label={cols ? `Table ${n}: ${cols}` : `Table ${n}`} tabIndex={0} className="min-w-0 overflow-x-auto rounded-xl border border-border">
          <table className="w-full border-collapse text-sm tabular-nums">{children}</table>
        </div>
      )
    },
    thead: 'thead', tbody: 'tbody',
    tr: ({ children }: Props<'tr'>) => <tr className="border-b border-divider last:border-b-0">{children}</tr>,
    th: ({ children }: Props<'th'>) => <th scope="col" className="border-b border-divider px-3 py-2 text-left font-strong whitespace-nowrap">{children}</th>,
    td: ({ children }: Props<'td'>) => <td className="px-3 py-2 whitespace-nowrap text-foreground-2">{children}</td>,
    sub: 'sub', sup: 'sup', section: 'section',
  }
}

/** The text of each header cell of a `thead` node. */
function textOfCells(thead: HastNode | undefined): string[] {
  const row = thead?.children.find((c): c is HastNode => c.type === 'element' && c.tagName === 'tr')
  return (row?.children ?? []).filter(c => c.type === 'element').map(c => textOf(c as never).trim())
}

// One set of components per look and host list: the same hosts give the same objects.
const built = new Map<string, Components>()
export function componentsFor(look: Look, linkHosts: readonly string[]): Components {
  const key = `${look}|${linkHosts.join(',')}`
  let c = built.get(key)
  if (!c) { c = build(look, linkHosts); built.set(key, c); if (built.size > 50) built.delete(built.keys().next().value as string) }
  return c
}

