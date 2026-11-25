// The app's way in to the markdown renderer: `Markdown({ text, look, linkHosts, live })` (see renderer.tsx for the props).
// Streamdown and the parsers under it are about 170 KB gzip, and Today's first load is held to a budget
// (scripts/check-bundle.mjs), so the renderer is its own chunk: it loads when the browser is idle after the page, well before
// a first answer, and until it is there a text shows as plain lines. Nothing else imports renderer.tsx at run time
// (build-support/markdown-entry.test.ts pins that); tests import it directly.
import { Suspense, lazy } from 'react'
import { stripFrontmatter } from './policy'
import type { MarkdownProps } from './renderer'

export type { Look } from './policy'
export type { MarkdownProps }

let loading: Promise<typeof import('./renderer')> | undefined
const load = () => (loading ??= import('./renderer'))
const Renderer = lazy(async () => ({ default: (await load()).Markdown }))
// Not after a failed load: that fails loud where the chunk is wanted (a Vite preload error reloads the page).
if (typeof window !== 'undefined') {
  if (typeof requestIdleCallback === 'function') requestIdleCallback(() => void load(), { timeout: 4000 })
  else setTimeout(() => void load(), 2000)
}

export function Markdown(props: MarkdownProps) {
  return (
    <Suspense fallback={<p className="whitespace-pre-wrap">{props.look === 'page' ? stripFrontmatter(props.text) : props.text}</p>}>
      <Renderer {...props} />
    </Suspense>
  )
}
