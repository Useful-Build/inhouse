// A file's type from its bytes, not its name (P3: "types by magic bytes"). The name only picks between text flavours
// and between the zip-based Office formats, once the bytes say text or zip. HTML and SVG are detected as such, so a
// brand's allowed list can leave them out (they'd never render in the app's origin anyway: downloads are attachments).

const startsWith = (b: Uint8Array, sig: number[], at = 0) => sig.every((x, i) => b[at + i] === x)
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0))
const utf8 = new TextDecoder('utf-8', { fatal: true })

/** The OOXML formats, told apart by the folder their main part lives in (a zip's local file names). */
const OFFICE: [string, string][] = [
  ['xl/', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  ['word/', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  ['ppt/', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
]

export function sniffType(bytes: Uint8Array, name: string): string {
  if (startsWith(bytes, ascii('%PDF-'))) return 'application/pdf'
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png'
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg'
  if (startsWith(bytes, ascii('GIF87a')) || startsWith(bytes, ascii('GIF89a'))) return 'image/gif'
  if (startsWith(bytes, ascii('RIFF')) && startsWith(bytes, ascii('WEBP'), 8)) return 'image/webp'
  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])) return zipType(bytes)
  return textType(bytes, name)
}

function zipType(bytes: Uint8Array): string {
  // Walk the local file headers' names (PK\x03\x04, name length at 26, extra length at 28, name at 30).
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let contentTypes = false
  let folder: string | null = null
  for (let at = 0; at + 30 <= bytes.length && startsWith(bytes, [0x50, 0x4b, 0x03, 0x04], at); ) {
    const nameLen = view.getUint16(at + 26, true)
    const extraLen = view.getUint16(at + 28, true)
    const size = view.getUint32(at + 18, true)
    const flags = view.getUint16(at + 6, true)
    const n = new TextDecoder().decode(bytes.subarray(at + 30, at + 30 + nameLen))
    if (n === '[Content_Types].xml') contentTypes = true
    folder ??= OFFICE.find(([f]) => n.startsWith(f))?.[1] ?? null
    // A size known only after the data (bit 3) can't be skipped over: stop at what we have.
    if (flags & 0x08) break
    at += 30 + nameLen + extraLen + size
  }
  return contentTypes && folder !== null ? folder : 'application/zip'
}

function textType(bytes: Uint8Array, name: string): string {
  if (bytes.includes(0)) return 'application/octet-stream'
  let text: string
  try {
    text = utf8.decode(bytes)
  } catch {
    return 'application/octet-stream'
  }
  const ext = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase()
  // A text file named as text stays text even when it opens with a tag (Markdown often does): it's served with nosniff
  // and the sandbox CSP, so a browser never runs it as HTML.
  if (ext === 'txt') return 'text/plain'
  if (ext === 'md' || ext === 'markdown') return 'text/markdown'
  const markup = markupType(text)
  if (markup !== null) return markup
  if (ext === 'json') {
    try {
      JSON.parse(text)
      return 'application/json'
    } catch {
      return 'text/plain'
    }
  }
  if (ext === 'csv') return 'text/csv'
  return 'text/plain'
}

/** Tags that make a browser take a text as HTML when one opens it (as in the WHATWG sniffing table), lower case. */
const HTML_TAGS = ['!doctype html', 'html', 'head', 'script', 'iframe', 'h1', 'div', 'font', 'table', 'a', 'style', 'title', 'b', 'body', 'br', 'p']

/**
 * SVG or HTML, by the first tag after any whitespace, comments, processing instructions (`<?xml ...?>`) and byte order
 * mark: `<svg` or `<!DOCTYPE svg` is SVG, an HTML tag is HTML. A comment or instruction that never closes is HTML too
 * (what follows it can't be told). Looks at the first 4 KiB.
 */
function markupType(text: string): string | null {
  const head = text.slice(0, 4096).toLowerCase()
  let at = 0
  for (;;) {
    while (at < head.length && (/\s/.test(head[at]!) || head[at] === '\ufeff')) at++
    const closeAt = head.startsWith('<!--', at) ? head.indexOf('-->', at + 4) : head.startsWith('<?', at) ? head.indexOf('?>', at + 2) : null
    if (closeAt === null) break
    if (closeAt === -1) return 'text/html'
    at = closeAt + (head.startsWith('<!--', at) ? 3 : 2)
  }
  const rest = head.slice(at)
  const tagEnds = (tag: string) => rest.startsWith(`<${tag}`) && /^[\s>/]|^$/.test(rest.slice(tag.length + 1))
  if (tagEnds('svg') || tagEnds('!doctype svg')) return 'image/svg+xml'
  if (HTML_TAGS.some(tagEnds)) return 'text/html'
  return null
}
