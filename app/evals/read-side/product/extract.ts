// The files a run made, read for the grader (grade.ts FileEvidence): docx and xlsx XML, PDF objects, CSV cells and the text the
// agent wrote. Node's zlib only, no new dependency. Anything this reader can't take apart completely comes back as null, which
// fails the case closed ("an artifact could not be inspected"): an encrypted or zip64 archive, a compression other than stored or
// deflate, a PDF that is encrypted or uses a stream filter other than Flate or an image codec, an unknown file type, anything
// over the caps. Never executes, renders or fetches anything in a file.
import { inflateRawSync, inflateSync } from 'node:zlib'
import type { FileEvidence } from '../grade.ts'

/** Hard caps: bytes of one download, of one archive entry or PDF stream once inflated, and archive entries. */
export const EXTRACT_CAPS = { fileBytes: 16 * 1024 * 1024, entryBytes: 32 * 1024 * 1024, entries: 2000 }

type Reference = FileEvidence['references'][number]

const utf8 = (b: Uint8Array): string => new TextDecoder('utf-8', { fatal: false }).decode(b)
const latin1 = (b: Uint8Array): string => Buffer.from(b.buffer, b.byteOffset, b.byteLength).toString('latin1')

/** XML character references and the five named entities, decoded. */
export function xmlText(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => safeCodePoint(parseInt(h, 16)))
    .replace(/&#([0-9]+);/g, (_, d: string) => safeCodePoint(parseInt(d, 10)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')
}
const safeCodePoint = (n: number): string => (Number.isInteger(n) && n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '')

/**
 * A ZIP archive's entries by name, or null when any part of it can't be read in full: a missing or repeated end record, zip64,
 * encryption, a method other than stored (0) or deflate (8), a size that disagrees, or a cap.
 */
export function unzip(bytes: Uint8Array): Map<string, Uint8Array> | null {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  // The end of central directory record: signature, then at most a 65535-byte comment after its 22 bytes.
  let eocd = -1
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break }
  }
  if (eocd < 0) return null
  const count = buf.readUInt16LE(eocd + 10)
  const cdSize = buf.readUInt32LE(eocd + 12)
  const cdOffset = buf.readUInt32LE(eocd + 16)
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) return null // zip64
  if (count > EXTRACT_CAPS.entries || cdOffset + cdSize > eocd) return null
  const out = new Map<string, Uint8Array>()
  let p = cdOffset
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) return null
    const flags = buf.readUInt16LE(p + 8)
    const method = buf.readUInt16LE(p + 10)
    const compressed = buf.readUInt32LE(p + 20)
    const size = buf.readUInt32LE(p + 24)
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    const local = buf.readUInt32LE(p + 42)
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8')
    p += 46 + nameLen + extraLen + commentLen
    if (flags & 0x1) return null // encrypted
    if (compressed === 0xffffffff || size === 0xffffffff || local === 0xffffffff) return null
    if (size > EXTRACT_CAPS.entryBytes || out.has(name)) return null
    if (local + 30 > buf.length || buf.readUInt32LE(local) !== 0x04034b50) return null
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28)
    if (start + compressed > buf.length) return null
    const raw = buf.subarray(start, start + compressed)
    let data: Uint8Array
    if (method === 0) data = raw
    else if (method === 8) {
      try {
        data = inflateRawSync(raw, { maxOutputLength: EXTRACT_CAPS.entryBytes })
      } catch {
        return null
      }
    } else return null
    if (data.byteLength !== size) return null
    if (!name.endsWith('/')) out.set(name, data)
  }
  return out
}

/** Every Relationship in an OPC package's `.rels` parts: hyperlinks are links, external images images, any other external target external. */
function relationships(parts: Map<string, Uint8Array>): Reference[] {
  const refs: Reference[] = []
  for (const [name, data] of parts) {
    if (!name.endsWith('.rels')) continue
    for (const m of utf8(data).matchAll(/<(?:\w+:)?Relationship\b([^>]*)\/?>/g)) {
      const attrs = m[1]!
      const target = xmlText(/\bTarget\s*=\s*"([^"]*)"|\bTarget\s*=\s*'([^']*)'/.exec(attrs)?.slice(1).find((x) => x !== undefined) ?? '')
      const type = /\bType\s*=\s*["']([^"']*)["']/.exec(attrs)?.[1] ?? ''
      const external = /\bTargetMode\s*=\s*["']External["']/i.test(attrs)
      if (/\/hyperlink$/i.test(type)) refs.push({ kind: 'link', url: target })
      else if (external && /\/image$/i.test(type)) refs.push({ kind: 'image', url: target })
      else if (external) refs.push({ kind: 'external', url: target })
    }
  }
  return refs
}

const stripTags = (xml: string): string => xmlText(xml.replace(/<[^>]+>/g, ' '))
const allXml = (parts: Map<string, Uint8Array>, test: (name: string) => boolean): string =>
  [...parts].filter(([n]) => test(n) && /\.xml$/i.test(n)).map(([, d]) => utf8(d)).join('\n')

export function docxEvidence(parts: Map<string, Uint8Array>): FileEvidence | null {
  if (!parts.has('word/document.xml')) return null
  const xml = allXml(parts, (n) => n.startsWith('word/') || n.startsWith('docProps/'))
  // A complex field's instruction can be split across runs: the runs between a begin and a separate (or end) are one field.
  const fields: string[] = []
  for (const body of xml.split(/<w:fldChar\b[^>]*w:fldCharType\s*=\s*["']begin["'][^>]*\/?>/).slice(1)) {
    const until = body.split(/<w:fldChar\b[^>]*w:fldCharType\s*=\s*["'](?:separate|end)["'][^>]*\/?>/)[0]!
    fields.push([...until.matchAll(/<w:instrText\b[^>]*>([\s\S]*?)<\/w:instrText>/g)].map((m) => xmlText(m[1]!)).join(''))
  }
  for (const m of xml.matchAll(/<w:fldSimple\b[^>]*\bw:instr\s*=\s*"([^"]*)"/g)) fields.push(xmlText(m[1]!))
  // A field instruction left outside a begin marker still counts.
  for (const m of xml.matchAll(/<w:instrText\b[^>]*>([\s\S]*?)<\/w:instrText>/g)) {
    const t = xmlText(m[1]!)
    if (!fields.some((f) => f.includes(t))) fields.push(t)
  }
  return { format: 'docx', text: stripTags(xml), references: relationships(parts), fields }
}

export function xlsxEvidence(parts: Map<string, Uint8Array>): FileEvidence | null {
  if (!parts.has('xl/workbook.xml')) return null
  const xml = allXml(parts, (n) => n.startsWith('xl/') || n.startsWith('docProps/'))
  const formulas = [...xml.matchAll(/<(?:\w+:)?f\b[^>]*>([\s\S]*?)<\/(?:\w+:)?f>/g)].map((m) => xmlText(m[1]!))
  const references = relationships(parts)
  // Data connections, query tables and external links reach out even with no relationship pointing at a URL.
  for (const name of parts.keys()) {
    if (/^xl\/(connections\.xml|queryTables\/|externalLinks\/)/.test(name)) references.push({ kind: 'external', url: name })
  }
  return { format: 'xlsx', text: stripTags(xml), references, formulas }
}

/** RFC 4180 cells: quoted fields with doubled quotes, commas and CR or LF line ends. */
export function csvCells(text: string): string[] {
  const cells: string[] = []
  let cell = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++ }
      else if (ch === '"') quoted = false
      else cell += ch
    } else if (ch === '"' && cell === '') quoted = true
    else if (ch === ',' || ch === '\n' || ch === '\r') {
      cells.push(cell)
      cell = ''
      if (ch === '\r' && text[i + 1] === '\n') i++
    } else cell += ch
  }
  if (cell !== '' || (text.length > 0 && !/[\r\n]$/.test(text))) cells.push(cell)
  return cells
}

/** PDF literal string escapes (`\n`, `\(`, octal) decoded. */
function pdfLiteral(s: string): string {
  return s.replace(/\\([nrtbf()\\]|[0-7]{1,3}|\r?\n)/g, (_, e: string) => {
    const map: Record<string, string> = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '(': '(', ')': ')', '\\': '\\' }
    if (e in map) return map[e]!
    if (/^[0-7]+$/.test(e)) return String.fromCharCode(parseInt(e, 8) & 0xff)
    return ''
  })
}
const hexString = (h: string): string => {
  const clean = h.replace(/\s+/g, '')
  const even = clean.length % 2 === 0 ? clean : `${clean}0`
  return Buffer.from(even, 'hex').toString('latin1')
}
/** Image codecs: their streams hold pixels, never dictionaries or text, so they are skipped rather than decoded. */
const IMAGE_FILTERS = new Set(['DCTDecode', 'JPXDecode', 'CCITTFaxDecode', 'JBIG2Decode'])

/**
 * A PDF's dictionaries and text: every object, and every stream inflated (FlateDecode) or skipped (an image codec), object
 * streams included. Null when it is encrypted or a stream uses any other filter (LZW, ASCII85, a chain), so nothing stays unread.
 */
export function pdfEvidence(bytes: Uint8Array): FileEvidence | null {
  const raw = latin1(bytes)
  if (!raw.startsWith('%PDF-')) return null
  if (/\/Encrypt\b/.test(raw)) return null
  const bodies: string[] = []
  // Streams: the dictionary before `stream`, the bytes up to `endstream`.
  const streamRe = /<<((?:(?!>>\s*stream)[\s\S]){0,20000})>>\s*stream\r?\n/g
  let m: RegExpExecArray | null
  const outside: string[] = []
  let last = 0
  while ((m = streamRe.exec(raw)) !== null) {
    const dict = m[1]!
    const start = m.index + m[0].length
    const end = raw.indexOf('endstream', start)
    if (end < 0) return null
    outside.push(raw.slice(last, m.index), `<<${dict}>>`)
    last = end + 'endstream'.length
    streamRe.lastIndex = last
    const filters = [...(/\/Filter\s*(\[[^\]]*\]|\/\w+)/.exec(dict)?.[1] ?? '').matchAll(/\/(\w+)/g)].map((f) => f[1]!)
    const data = bytes.subarray(start, end)
    if (filters.length === 0) bodies.push(latin1(data))
    else if (filters.length === 1 && filters[0] === 'FlateDecode') {
      try {
        bodies.push(latin1(inflateSync(data, { maxOutputLength: EXTRACT_CAPS.entryBytes, finishFlush: 2 })))
      } catch {
        return null
      }
    } else if (filters.length === 1 && IMAGE_FILTERS.has(filters[0]!)) continue
    else return null
  }
  outside.push(raw.slice(last))
  const rest = outside.join('\n')
  const all = `${rest}\n${bodies.join('\n')}`
  // Every innermost dictionary that names an action, a URI or an additional action, as written.
  const actions: string[] = []
  let scan = all
  for (let round = 0; round < 50; round++) {
    let found = false
    scan = scan.replace(/<<((?:(?!<<|>>)[\s\S])*)>>/g, (whole, inner: string) => {
      found = true
      if (/\/(?:S|JS|JavaScript|URI|Launch|SubmitForm|ImportData|GoToR|GoToE|AA|OpenAction)\b/.test(inner)) actions.push(whole)
      return ' '
    })
    if (!found) break
  }
  const references: Reference[] = []
  for (const u of all.matchAll(/\/URI\s*\(((?:\\.|[^\\)])*)\)/g)) references.push({ kind: 'link', url: pdfLiteral(u[1]!) })
  for (const u of all.matchAll(/\/URI\s*<([0-9A-Fa-f\s]*)>/g)) references.push({ kind: 'link', url: hexString(u[1]!) })
  // Remote content a viewer would fetch: a URL file specification or a remote go-to.
  for (const u of all.matchAll(/\/FS\s*\/URL[\s\S]{0,200}?\/F\s*\(((?:\\.|[^\\)])*)\)/g)) references.push({ kind: 'external', url: pdfLiteral(u[1]!) })
  const text = [
    ...[...all.matchAll(/\(((?:\\.|[^\\)])*)\)\s*(?:Tj|'|")/g)].map((t) => pdfLiteral(t[1]!)),
    ...[...all.matchAll(/\[((?:\\.|[^\]])*)\]\s*TJ/g)].map((t) => [...t[1]!.matchAll(/\(((?:\\.|[^\\)])*)\)/g)].map((s) => pdfLiteral(s[1]!)).join('')),
    ...[...all.matchAll(/<([0-9A-Fa-f\s]+)>\s*Tj/g)].map((t) => hexString(t[1]!)),
    // Metadata strings (Title, Author, Subject, Keywords) count as text.
    ...[...all.matchAll(/\/(?:Title|Author|Subject|Keywords|Creator|Producer)\s*\(((?:\\.|[^\\)])*)\)/g)].map((t) => pdfLiteral(t[1]!)),
  ].join('\n')
  return { format: 'pdf', text, references, actions }
}

/** The format a file is read as, from its name, else its content type. Null for anything this reader doesn't take apart. */
export function formatOf(name: string, contentType: string): 'docx' | 'xlsx' | 'pdf' | 'csv' | 'text' | null {
  const ext = /\.([A-Za-z0-9]+)$/.exec(name)?.[1]?.toLowerCase()
  if (ext === 'docx') return 'docx'
  if (ext === 'xlsx') return 'xlsx'
  if (ext === 'pdf') return 'pdf'
  if (ext === 'csv') return 'csv'
  if (ext === 'md' || ext === 'markdown' || ext === 'txt') return 'text'
  if (ext !== undefined) return null
  const type = contentType.split(';')[0]!.trim().toLowerCase()
  if (type === 'text/plain' || type === 'text/markdown') return 'text'
  if (type === 'text/csv') return 'csv'
  if (type === 'application/pdf') return 'pdf'
  return null
}

/** One file's evidence, or null when it can't be read in full (the grader fails the case on null). */
export function extractFile(name: string, contentType: string, bytes: Uint8Array): FileEvidence | null {
  if (bytes.byteLength > EXTRACT_CAPS.fileBytes) return null
  const format = formatOf(name, contentType)
  if (format === null) return null
  if (format === 'docx' || format === 'xlsx') {
    const parts = unzip(bytes)
    if (parts === null) return null
    return format === 'docx' ? docxEvidence(parts) : xlsxEvidence(parts)
  }
  if (format === 'pdf') return pdfEvidence(bytes)
  const text = utf8(bytes)
  if (format === 'csv') return { format: 'csv', text, references: [], cells: csvCells(text) }
  return { format: 'text', text, references: [] }
}
