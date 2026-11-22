// The files a run made, read for the grader (grade.ts FileEvidence): docx and xlsx XML, PDF objects, CSV cells and the text the
// agent wrote. Node's zlib only, no new dependency. Anything this reader can't take apart completely comes back as null, which
// fails the case closed ("an artifact could not be inspected"): an encrypted or zip64 archive, a compression other than stored or
// deflate, a PDF that is encrypted or uses a stream filter other than Flate or an image codec, an unknown file type, anything
// over the caps. Never executes, renders or fetches anything in a file.
import { inflateRawSync } from 'node:zlib'
import type { FileEvidence } from '../grade.ts'
import { readPdf } from './pdf.ts'

/** Hard caps: bytes of one download, of one archive entry or PDF stream once inflated, and archive entries. */
export const EXTRACT_CAPS = { fileBytes: 16 * 1024 * 1024, entryBytes: 32 * 1024 * 1024, entries: 2000 }

type Reference = FileEvidence['references'][number]

const utf8 = (b: Uint8Array): string => new TextDecoder('utf-8', { fatal: false }).decode(b)

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

/**
 * Relationship types that make a package reach outside itself or run something, whatever the part is called: data connections,
 * query tables, external links, an altChunk (aFChunk: HTML or another document merged in), OLE objects, embedded packages,
 * ActiveX controls, VBA, sub-documents and attached templates. Any of them, or any External target, is an `external` reference.
 */
const REACHING_TYPES = /\/(?:connections|queryTable|externalLink|aFChunk|oleObject|package|control|vbaProject|subDocument|attachedTemplate)$/i

/** Every Relationship in an OPC package's `.rels` parts: hyperlinks are links, reaching types external, any other External target external or an image. */
function relationships(parts: Map<string, Uint8Array>): Reference[] {
  const refs: Reference[] = []
  for (const [name, data] of parts) {
    if (!name.endsWith('.rels')) continue
    for (const m of utf8(data).matchAll(/<(?:\w+:)?Relationship\b([^>]*)\/?>/g)) {
      const attrs = m[1]!
      const target = xmlText(/\bTarget\s*=\s*"([^"]*)"|\bTarget\s*=\s*'([^']*)'/.exec(attrs)?.slice(1).find((x) => x !== undefined) ?? '')
      const type = /\bType\s*=\s*["']([^"']*)["']/.exec(attrs)?.[1] ?? ''
      const external = /\bTargetMode\s*=\s*["']External["']/i.test(attrs)
      if (REACHING_TYPES.test(type)) refs.push({ kind: 'external', url: target || type })
      else if (/\/hyperlink$/i.test(type)) refs.push({ kind: 'link', url: target })
      else if (external && /\/image$/i.test(type)) refs.push({ kind: 'image', url: target })
      else if (external) refs.push({ kind: 'external', url: target })
    }
  }
  return refs
}

/** VML attributes that fetch by URL with no relationship: `imagedata src`, `o:href`, `fill src` and the like, when absolute. */
function vmlReferences(xml: string): Reference[] {
  const refs: Reference[] = []
  for (const m of xml.matchAll(/<(?:[A-Za-z_][\w.-]*:)?(?:imagedata|fill|stroke|textpath|shape|image)\b[^>]*?\b(?:[A-Za-z_][\w.-]*:)?(?:src|href)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    const url = xmlText(m[1] ?? m[2] ?? '')
    if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|\\\\)/i.test(url)) refs.push({ kind: 'image', url })
  }
  return refs
}

const stripTags = (xml: string): string => xmlText(xml.replace(/<[^>]+>/g, ' '))
/** Every XML part (VML included), wherever it lives in the package. */
const allXml = (parts: Map<string, Uint8Array>): string =>
  [...parts].filter(([n]) => /\.(?:xml|vml)$/i.test(n)).map(([, d]) => utf8(d)).join('\n')
/** The parts a package may hold and still be read in full: XML, relationships, content types, and images under a media folder. */
const KNOWN_PART = /(?:\.(?:xml|vml|rels)$)|(?:^|\/)media\/[^/]+\.(?:png|jpe?g|gif|bmp|tiff?|emf|wmf)$|^docProps\/thumbnail\.(?:jpe?g|png)$/i

/**
 * Whether the package can be read in full with its main part at `expected`: every part is one KNOWN_PART allows, no two part
 * names differ only in case (a reader that folds case could open another part than this one reads), and the root relationships
 * part (`_rels/.rels`) names exactly `expected` as the office document.
 */
export function mainPartIs(parts: Map<string, Uint8Array>, expected: string): boolean {
  const lower = new Set<string>()
  for (const n of parts.keys()) {
    if (lower.has(n.toLowerCase()) || !KNOWN_PART.test(n)) return false
    lower.add(n.toLowerCase())
  }
  const root = parts.get('_rels/.rels')
  if (!root || !parts.has(expected)) return false
  const mains = [...utf8(root).matchAll(/<(?:\w+:)?Relationship\b([^>]*)\/?>/g)]
    .map((m) => m[1]!)
    .filter((a) => /\bType\s*=\s*["'][^"']*\/officeDocument["']/.test(a))
    .map((a) => xmlText(/\bTarget\s*=\s*["']([^"']*)["']/.exec(a)?.[1] ?? '').replace(/^\//, ''))
  return mains.length === 1 && mains[0] === expected
}

export function docxEvidence(parts: Map<string, Uint8Array>): FileEvidence | null {
  if (!mainPartIs(parts, 'word/document.xml')) return null
  const xml = allXml(parts)
  // Fields under any namespace prefix (a prefix is only a local name for the WordprocessingML URI), with either quote style.
  // A complex field's instruction can be split across runs: the runs between a begin and a separate (or end) are one field.
  const P = '(?:[A-Za-z_][\\w.-]*:)?'
  const fields: string[] = []
  const instrText = new RegExp(`<${P}instrText\\b[^>]*>([\\s\\S]*?)<\\/${P}instrText>`, 'g')
  for (const body of xml.split(new RegExp(`<${P}fldChar\\b[^>]*${P}fldCharType\\s*=\\s*["']begin["'][^>]*\\/?>`)).slice(1)) {
    const until = body.split(new RegExp(`<${P}fldChar\\b[^>]*${P}fldCharType\\s*=\\s*["'](?:separate|end)["'][^>]*\\/?>`))[0]!
    fields.push([...until.matchAll(instrText)].map((m) => xmlText(m[1]!)).join(''))
  }
  for (const m of xml.matchAll(new RegExp(`<${P}fldSimple\\b[^>]*\\b${P}instr\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'g'))) fields.push(xmlText(m[1] ?? m[2] ?? ''))
  // A field instruction left outside a begin marker still counts.
  for (const m of xml.matchAll(instrText)) {
    const t = xmlText(m[1]!)
    if (!fields.some((f) => f.includes(t))) fields.push(t)
  }
  // VML can fetch an image by its own attribute, with no relationship: `v:imagedata src` (and `o:href`) with a URL.
  const references = [...relationships(parts), ...vmlReferences(xml)]
  return { format: 'docx', text: stripTags(xml), references, fields }
}

export function xlsxEvidence(parts: Map<string, Uint8Array>): FileEvidence | null {
  if (!mainPartIs(parts, 'xl/workbook.xml')) return null
  const xml = allXml(parts)
  // Cell formulas, defined names, and conditional-format and data-validation formulas: all of them evaluate.
  // Cell formulas, defined names, conditional-format, data-validation and table calculated-column formulas, and pivot cache
  // fields' formula attributes: all of them evaluate.
  const formulas = [
    ...[...xml.matchAll(/<(?:[A-Za-z_][\w.-]*:)?(f|definedName|formula|formula1|formula2|calculatedColumnFormula|totalsRowFormula)\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?\1>/g)].map((m) => xmlText(m[2]!)),
    ...[...xml.matchAll(/<(?:[A-Za-z_][\w.-]*:)?cacheField\b[^>]*\bformula\s*=\s*(?:"([^"]*)"|'([^']*)')/g)].map((m) => xmlText(m[1] ?? m[2] ?? '')),
  ]
  const references = [...relationships(parts), ...vmlReferences(xml)]
  // Data connections, query tables and external links reach out even with no relationship pointing at them.
  for (const name of parts.keys()) {
    if (/(?:^|\/)(?:connections\.xml|queryTables?\/|externalLinks?\/)/i.test(name)) references.push({ kind: 'external', url: name })
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

/** A PDF's evidence: the strict allowlist reader in pdf.ts (null unless every byte that matters is accounted for). */
export const pdfEvidence = (bytes: Uint8Array): FileEvidence | null => readPdf(bytes)

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
