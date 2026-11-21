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
  const walk = new ZipWalk()
  walk.push(bytes)
  return walk.type()
}

const LOCAL_HEADER = [0x50, 0x4b, 0x03, 0x04]

/**
 * A walk over a zip's local file headers (PK\x03\x04, flags at 6, size at 18, name length at 26, extra length at 28,
 * name at 30), fed its bytes in order in pieces of any size: what tells the OOXML formats apart. It holds at most one
 * header that straddles two pieces (30 bytes and its name), never the entries' data. It stops for good at a header that
 * isn't one, or at an entry whose size is known only after its data (bit 3), which can't be skipped over.
 */
export class ZipWalk {
  /** `[Content_Types].xml` has been seen. */
  contentTypes = false
  /** The Office type of the first entry under `xl/`, `word/` or `ppt/`, or null. */
  folder: string | null = null
  /** The walk ended before the bytes did (not a header, or a bit-3 entry). */
  stopped = false
  private pos = 0
  private next = 0
  private header: Uint8Array | null = null

  push(piece: Uint8Array): void {
    const start = this.pos
    this.pos += piece.length
    let i = 0
    while (!this.stopped) {
      if (this.header === null) {
        if (this.next >= this.pos) return
        i = this.next - start
        this.header = new Uint8Array(0)
      }
      const h: Uint8Array = this.header
      const need = h.length < 30 ? 30 : 30 + (h[26]! | (h[27]! << 8))
      const take = Math.min(need - h.length, piece.length - i)
      const grown = new Uint8Array(h.length + take)
      grown.set(h)
      grown.set(piece.subarray(i, i + take), h.length)
      this.header = grown
      i += take
      if (grown.length >= 30 && !startsWith(grown, LOCAL_HEADER)) {
        this.stopped = true
        return
      }
      const full = grown.length >= 30 && grown.length === 30 + (grown[26]! | (grown[27]! << 8))
      if (!full) {
        if (i >= piece.length) return
        continue
      }
      const view = new DataView(grown.buffer, grown.byteOffset, grown.byteLength)
      const nameLen = view.getUint16(26, true)
      const n = new TextDecoder().decode(grown.subarray(30, 30 + nameLen))
      if (n === '[Content_Types].xml') this.contentTypes = true
      this.folder ??= OFFICE.find(([f]) => n.startsWith(f))?.[1] ?? null
      if (view.getUint16(6, true) & 0x08) {
        this.stopped = true
        return
      }
      this.next += 30 + nameLen + view.getUint16(28, true) + view.getUint32(18, true)
      this.header = null
    }
  }

  /** The type the headers so far say: an Office type once both its folder and `[Content_Types].xml` were seen. */
  type(): string {
    return this.contentTypes && this.folder !== null ? this.folder : 'application/zip'
  }
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
