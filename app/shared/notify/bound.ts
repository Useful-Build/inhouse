// What a notice may carry (P5 W4, p5-w4.md section 5, OC-W4-1 and OC-W4-8). Pure, with no imports at all, so the hub's
// bundle can include it as well as the server. One escaper, at the hub: the server runs steps 1, 2 and 4 and sends the
// unescaped text; the hub runs 1 and 2 again (idempotent), then step 3 (the escape) exactly once, then step 5. Step 4
// measures the text as it will be after the escape (`escapedLength`), so the server's refusal and the hub's agree.
// Slack formatting docs read 2026-11-21: https://docs.slack.dev/messaging/formatting-message-text (escape only `&`,
// `<`, `>`; mentions and links are `<...>` sequences; a bare URL in top-level `text` is auto-linked).

export const TITLE_MAX = 120
export const TEXT_MAX = 1500
export const LINK_REMOVED = '[link removed]'

export type NoticeFormat = 'message' | 'report'

// ---------- step 1: characters ----------

/** C0 except \n and \t, DEL, C1, bidi controls, zero-width and joiners, BOM, tag characters, lone surrogates. */
// eslint-disable-next-line no-control-regex -- the strip list is control characters by design
const STRIP = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u061C\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF\u{E0000}-\u{E007F}]|[\uD800-\uDFFF]/gu

/** Step 1. NFC, `\t` and the Unicode line and paragraph separators as plain whitespace, then the strip list. */
export function cleanChars(s: string, format: NoticeFormat): string {
  let out = s.normalize('NFC').replace(/\r\n?/g, '\n').replace(/[\u2028\u2029]/g, '\n').replace(/\t/g, ' ').replace(STRIP, '')
  if (format === 'message') out = out.replace(/\n/g, ' ')
  return out
}

// ---------- step 2: links ----------

/** Dots written another way (full-width, ideographic, halfwidth, one-dot leader, small full stop) and `[.]`, `(dot)`. */
const ODD_DOT = /[\uFF0E\u3002\uFF61\u2024\uFE52]/g
const WRAPPED_DOT = /\s*[[({]\s*(?:\.|dot)\s*[\])}]\s*/giu

/** Schemes that open something without `//`, with something right after the colon ("Raw data: 5 rows" stays). */
const BARE_SCHEME = /(?<![a-z0-9])(?:mailto|tel|sms|slack|data|javascript|vbscript|file|callto|skype|ftp|https?):(?=\S)/i
/**
 * A host: `label(.label)+.tld`. Deliberately wide (it over-removes rather than miss one): a label is any run of letters,
 * digits, `-`, `_` or non-ASCII characters (IDNs, look-alikes, unassigned code points), and the last label is at least
 * two such characters not starting with a digit (so `3.5 kg` and `v1.2` stay, `file.txt` and `Mr.Smith` go).
 */
const LABEL = String.raw`[^\s.!"#$%&'()*+,/:;<=>?@[\\\]^${'`'}{|}~]`
const HOST = new RegExp(String.raw`${LABEL}+\.(?:${LABEL}+\.)*(?!\d)${LABEL}{2}`, 'u')
const IPV4 = /(?<!\d)\d{1,3}(?:\.\d{1,3}){3}(?!\d)/

/** Whether one whitespace-free token would make a link anywhere: a scheme, `www.`, a host or an IP address. */
export function isLinkToken(token: string): boolean {
  // Also without `@`: the escape drops the `@` of `@here`, which must not leave a host behind (`e.g.@here`).
  const bare = token.replace(/@/g, '')
  return token.includes('://') || /www\./i.test(token) || BARE_SCHEME.test(token) || [token, bare].some(t => HOST.test(t) || IPV4.test(t))
}

/** Step 2. Every token that could be a link becomes `[link removed]`; the app's own link only ever comes from `link`. */
export function removeLinks(s: string): { text: string; removed: boolean } {
  const plain = s.replace(ODD_DOT, '.').replace(WRAPPED_DOT, '.')
  let removed = false
  const text = plain.replace(/\S+/gu, token => {
    if (token === '[link' || token === 'removed]') return token
    if (!isLinkToken(token)) return token
    removed = true
    return LINK_REMOVED
  })
  return { text, removed }
}

// ---------- step 3: the escape (hub only) ----------

const PLAIN_MENTION = /@+(?=(?:here|channel|everyone))/giu

/** Step 3. `&`, `<`, `>` in that order, then a plain `@here`, `@channel`, `@everyone` loses its `@`. */
export function slackEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(PLAIN_MENTION, '')
}

/** Whether the escape would neutralise a mention (`<@U…>`, `<!here>`, `<!subteam^…>`, `<#C…>`, plain `@here`). */
export const hasMention = (s: string): boolean => /<\s*[@!#]/.test(s) || /@(?:here|channel|everyone)/i.test(s)

const codePoints = (s: string): number => [...s].length

/** Step 4's measure: code points after the escape. */
export const escapedLength = (s: string): number => codePoints(slackEscape(s))

// ---------- steps 1 to 4 ----------

export type BoundChanges = { links: boolean; mentions: boolean }
export type Bounded = { ok: true; title: string; text: string; changed: BoundChanges }
export type BoundRefusal = { ok: false; reason: 'too_long' | 'empty' }

/**
 * Steps 1, 2 and 4 (`escape: false`, the server and the bell), or 1 to 4 (`escape: true`, the hub). Over a limit is
 * refused, never truncated. A title is always one line.
 */
export function boundNotice(input: { title: string; text: string; format: NoticeFormat }, opts: { escape: boolean }): Bounded | BoundRefusal {
  const t1 = removeLinks(cleanChars(input.title, 'message'))
  const x1 = removeLinks(cleanChars(input.text, input.format))
  if (t1.text.trim().length === 0 || x1.text.trim().length === 0) return { ok: false, reason: 'empty' }
  if (escapedLength(t1.text) > TITLE_MAX || escapedLength(x1.text) > TEXT_MAX) return { ok: false, reason: 'too_long' }
  const changed = { links: t1.removed || x1.removed, mentions: hasMention(t1.text) || hasMention(x1.text) }
  if (!opts.escape) return { ok: true, title: t1.text, text: x1.text, changed }
  return { ok: true, title: slackEscape(t1.text), text: slackEscape(x1.text), changed }
}

/** A system notice's body (section 3a): steps 1, 2 and 4 with a 300 code point cap, refused over it. */
export const SYSTEM_BODY_MAX = 300

export function boundBody(body: string, opts: { escape: boolean; max: number }): { ok: true; text: string; changed: BoundChanges } | BoundRefusal {
  const x = removeLinks(cleanChars(body, 'report'))
  if (x.text.trim().length === 0) return { ok: false, reason: 'empty' }
  if (escapedLength(x.text) > opts.max) return { ok: false, reason: 'too_long' }
  const changed = { links: x.removed, mentions: hasMention(x.text) }
  return { ok: true, text: opts.escape ? slackEscape(x.text) : x.text, changed }
}

// ---------- step 5: compose (hub only) ----------

/** `APP_ORIGIN` as the hub var must hold it: an https origin with no path. */
export const isAppOrigin = (v: unknown): v is string => typeof v === 'string' && /^https:\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)*(?::\d{1,5})?$/.test(v)

/** Step 5. `*title*`, a line break, the text, and the app link when there is one. Title and text are already escaped. */
export function composeSlack(escapedTitle: string, escapedText: string, appLink: { origin: string; path: string } | null): string {
  const head = `*${escapedTitle}*\n${escapedText}`
  return appLink ? `${head}\n<${appLink.origin}${appLink.path}|Open in Inhouse>` : head
}
