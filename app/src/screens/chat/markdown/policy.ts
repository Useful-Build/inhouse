// What an answer's markdown may link to and show, and the one rewrite of its text before it is parsed. Pure, so a test
// can load it. The WebFetch setting can be empty and allow public web reads, but an answer's text is untrusted: chat uses
// only the hosts the caller lists (exact host, no port, no credentials, https only), plus in-app hash routes. A page (a
// skill's instructions, written by the team) may link to any https address.

/** `page`: a document read on its own page (a skill's instructions), in larger type with room between sections. */
export type Look = 'chat' | 'page'

const HASH_ROUTE = /^#\//
const HTTPS = /^https:\/\//i
const PAGE_HREF = /^(https?:|mailto:|#)/i

/** A listed https address as the browser will fetch it, or null when it is not one. */
export function chatUrl(href: string, linkHosts: readonly string[]): string | null {
  if (!HTTPS.test(href) || /[\\\s]/.test(href)) return null
  try {
    const url = new URL(href)
    if (url.port || url.username || url.password || !linkHosts.includes(url.hostname)) return null
    return url.href
  } catch {
    return null // A malformed destination is ordinary text.
  }
}

/**
 * Where a link goes, or null when it stays text. `label` is the link's text: a bare `www.` address is read as https
 * (GFM's autolink writes http for it).
 */
export function linkTarget(href: string | undefined, look: Look, linkHosts: readonly string[], label: string): { href: string; external: boolean } | null {
  if (!href) return null
  if (look === 'page') {
    if (/^https?:/i.test(href)) return { href, external: true }
    return PAGE_HREF.test(href) ? { href, external: false } : null
  }
  const asWritten = /^www\./i.test(label) && /^http:\/\//i.test(href) ? `https://${href.slice('http://'.length)}` : href
  const external = chatUrl(asWritten, linkHosts)
  if (external) return { href: external, external: true }
  return HASH_ROUTE.test(href) ? { href, external: false } : null
}

/** The address of an image to load, or null when only its text shows. A page loads none (a skill's text is not a place for a remote picture). */
export function imageSrc(src: string | undefined, look: Look, linkHosts: readonly string[]): string | null {
  return src && look === 'chat' ? chatUrl(src, linkHosts) : null
}

/** The prefixes the sanitizer step lets through: each listed host over https (and http, for the `www.` rewrite above, which `linkTarget` upgrades). */
export const hostPrefixes = (linkHosts: readonly string[]): string[] => linkHosts.flatMap(h => [`https://${h}/`, `http://${h}/`])

const FENCE = /^\s{0,3}(```|~~~)/
// Only "> " (or a bare ">") starts a quote, so ">100 units" stays text. CommonMark would read it as a quote.
const BARE_QUOTE = /^(\s{0,3})>(?! |\s*$)/

/** Escapes a `>` that is not followed by a space (or the line's end) so it stays text. Fenced code is left as written. */
export function keepBareGreaterThan(text: string): string {
  let fence: string | null = null
  return text.split('\n').map(line => {
    const f = FENCE.exec(line)
    if (f) { if (fence === null) fence = f[1]; else if (fence === f[1]) fence = null; return line }
    return fence === null ? line.replace(BARE_QUOTE, '$1\\>') : line
  }).join('\n')
}

/** A SKILL.md's frontmatter (a `---` block at the very top): not part of what a person reads. */
const FRONTMATTER = /^\uFEFF?---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/
export const stripFrontmatter = (text: string) => text.replace(FRONTMATTER, '')
