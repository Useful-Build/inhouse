// The chat file caps (p3-design 8.5, CHOICE kept by both reviews), in exact bytes, one constant: what the egress's PUT
// and route 39 enforce and what `RunStart.fileCaps` tells the runner.
import type { FileCaps } from '../../shared/protocol/index.ts'

export const FILE_CAPS: FileCaps = {
  maxFileBytes: 20_971_520,
  maxFilesPerTurn: 20,
  maxRestoreBytes: 104_857_600,
  /** As the shared sniffer names them (app/shared/files/sniff.ts). HTML and SVG are never here. */
  allowedTypes: [
    'application/pdf', 'image/png', 'image/jpeg', 'image/webp', 'text/csv', 'text/plain', 'text/markdown', 'application/json',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  ],
}

export const typeAllowed = (type: string): boolean => FILE_CAPS.allowedTypes.includes(type)

/**
 * Each allowed type's file extensions, the canonical one first. A download's name must end in one of its type's own
 * (`downloadName`): a text body named `page.html` must never land on a disk as `page.html`.
 */
export const TYPE_EXTENSIONS: Readonly<Record<string, readonly string[]>> = {
  'application/pdf': ['pdf'],
  'image/png': ['png'],
  'image/jpeg': ['jpg', 'jpeg'],
  'image/webp': ['webp'],
  'text/csv': ['csv'],
  'text/plain': ['txt'],
  'text/markdown': ['md', 'markdown'],
  'application/json': ['json'],
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['xlsx'],
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['docx'],
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': ['pptx'],
}

/**
 * The name a file downloads under: its own name when its last extension is one of its stored type's, else that name
 * with the type's canonical extension added (`page.html` stored as text/plain downloads as `page.html.txt`). The stored
 * path never changes (the agent's own path stays stable in the container); only the download's name does.
 */
export function downloadName(name: string, contentType: string): string {
  const exts = TYPE_EXTENSIONS[contentType]
  if (!exts) throw new Error(`downloadName: ${contentType} is not an allowed type`)
  const dot = name.lastIndexOf('.')
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
  return exts.includes(ext) ? name : `${name}.${exts[0]}`
}
