// A Library file's `kind` and type badge from its stored content type (p4-w5 section 1): a literal table. P3's type list
// has no audio or video, so `media` stays empty in P4; a type outside the table is `other` with a plain badge.
import type { LibraryKind } from '../../shared/contract/library.ts'

export const KINDS: Readonly<Record<string, { kind: LibraryKind; type: string }>> = {
  'application/pdf': { kind: 'documents', type: 'PDF' },
  'image/png': { kind: 'images', type: 'PNG' },
  'image/jpeg': { kind: 'images', type: 'JPG' },
  'image/webp': { kind: 'images', type: 'WEBP' },
  'text/csv': { kind: 'documents', type: 'CSV' },
  'text/plain': { kind: 'documents', type: 'TXT' },
  'text/markdown': { kind: 'documents', type: 'MD' },
  'application/json': { kind: 'code', type: 'JSON' },
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': { kind: 'documents', type: 'XLSX' },
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': { kind: 'documents', type: 'DOCX' },
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': { kind: 'documents', type: 'PPTX' },
}

export const kindOf = (contentType: string): { kind: LibraryKind; type: string } => KINDS[contentType] ?? { kind: 'other', type: 'FILE' }

/** The types whose contents the Library sends as a text preview (under `TEXT_PREVIEW_MAX` bytes). */
export const TEXT_PREVIEW_TYPES: readonly string[] = ['text/plain', 'text/markdown', 'text/csv', 'application/json']
export const TEXT_PREVIEW_MAX = 16 * 1024

/** A size as the screen shows it (`312 B`, `2.4 KB`, `1.3 MB`): what the Size sort reads back. */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB'] as const
  let v = bytes / 1024
  let u = 0
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024
    u++
  }
  const shown = v < 10 ? Math.round(v * 10) / 10 : Math.round(v)
  // 1023.96 KB rounds to 1024 KB: show it as the next unit.
  if (shown >= 1024 && u < units.length - 1) return `1 ${units[u + 1]}`
  return `${shown} ${units[u]}`
}
