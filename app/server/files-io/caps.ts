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
