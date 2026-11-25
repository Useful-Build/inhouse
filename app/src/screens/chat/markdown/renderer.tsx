// The renderer itself, on Streamdown. Heavy (Streamdown with its parsers is about 170 KB gzip), so the app loads it on
// its own (index.tsx), and tests import this file. The agent's text parts and a skill's instructions as markdown (a maintained renderer that also copes
// with half-written markdown while an answer streams). Paragraphs, a single newline as a line break, headings, rules,
// bold, italic, inline code, code blocks (with Copy), quotes, lists, links, images and tables (which scroll sideways when
// wide). Raw HTML is never passed through: it shows as text. Links and images follow policy.ts.
import { useMemo } from 'react'
import { Streamdown, defaultRehypePlugins, defaultRemarkPlugins } from 'streamdown'
import remarkBreaks from 'remark-breaks'
import { cn } from '@/lib/utils'
import { componentsFor } from './components'
import { OpenFenceContext } from './open-fence'
import { rehypeLowercaseSchemes, rehypeNumberBlocks, remarkHtmlAsText, remarkTableWidth } from './plugins'
import { endsInOpenFence, hostPrefixes, keepBareGreaterThan, stripFrontmatter } from './policy'
import type { Look } from './policy'

export type { Look }

// The default plugins, filtered rather than rebuilt so a new Streamdown release's change to them shows up here:
// `raw` (HTML passthrough) goes, and `harden` is set up per call below. Whatever else the default holds stays.
const { raw: _raw, harden, ...keptRehype } = defaultRehypePlugins
if (!Array.isArray(harden)) throw new Error('Streamdown changed its harden plugin: update markdown/index.tsx and adopted-libraries.')
const [hardenPlugin] = harden

// The default remark plugins (GFM, code meta), then ours: html as text, a single newline as a line break, wide table rows.
const REMARK = [...Object.values(defaultRemarkPlugins), remarkHtmlAsText, remarkBreaks, remarkTableWidth]
// Ours last, once the sanitizer and `harden` are done with the tree.
const NUMBER = [rehypeNumberBlocks]
// Only a listed host can pass `harden`; the components check each address again (policy.ts).
const ORIGIN = 'https://app.invalid'

const NO_HOSTS: readonly string[] = []
const single = (markdown: string) => [markdown]

export interface MarkdownProps { text: string; look?: Look; linkHosts?: readonly string[]; live?: boolean }

/**
 * `look`: `chat` for an answer, `page` for a document on its own page (frontmatter stripped, larger type, its headings from h2).
 * `linkHosts`: the exact hosts an https link, image or bare address may go to (none by default).
 * `live`: the text is still being written or revealed, so half-written markdown is closed for the moment (a code fence, a bold).
 */
export function Markdown({ text, look = 'chat', linkHosts = NO_HOSTS, live = false }: MarkdownProps) {
  const page = look === 'page'
  const hosts = linkHosts.join(',')
  const rehype = useMemo(() => {
    // A page is written by the team: any https address may pass here (the components still allow no image on it). In chat only the listed hosts do.
    const prefixes = page ? ['*'] : hostPrefixes(linkHosts)
    return [
      rehypeLowercaseSchemes,
      ...Object.values(keptRehype),
      [hardenPlugin, {
        defaultOrigin: ORIGIN, allowedLinkPrefixes: prefixes, allowedImagePrefixes: prefixes, allowedProtocols: [], allowDataImages: false,
        linkBlockPolicy: 'text-only', imageBlockPolicy: 'text-only', blockedLinkClass: '', blockedImageClass: '',
      }],
      ...NUMBER,
    ]
  }, [page, hosts]) // eslint-disable-line react-hooks/exhaustive-deps
  const components = useMemo(() => componentsFor(look, linkHosts), [look, hosts]) // eslint-disable-line react-hooks/exhaustive-deps
  // A diagram waits for its closing fence: while the text streams and ends inside an open one, its last code block is unfinished.
  const openFence = live && endsInOpenFence(text)
  return (
    <OpenFenceContext value={openFence}>
      <Streamdown
        // One block, so the numbering and the quote and table rules see the whole text. `static` leaves the text as it is.
        mode={live ? 'streaming' : 'static'} isAnimating={live} parseMarkdownIntoBlocksFn={single}
        skipHtml controls={false} lineNumbers={false} linkSafety={{ enabled: false }} disableAutolinkProtocols={['mailto']}
        remarkPlugins={REMARK} rehypePlugins={rehype as never} components={components}
        // The default root is `space-y-4`: ours is a column with its own gap.
        className={cn('flex min-w-0 flex-col space-y-0', page ? 'gap-4 text-lg leading-reading' : 'gap-6')}
      >
        {keepBareGreaterThan(page ? stripFrontmatter(text) : text)}
      </Streamdown>
    </OpenFenceContext>
  )
}
