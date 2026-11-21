// The file-name rule both sides hold: a chat file's path must survive the runner's files route (`/files/<path>`, each
// segment `encodeURIComponent`-encoded, behind a proxy that refuses dot segments, backslashes and fragments).

/** NUL, the C0 controls, DEL and the C1 controls: never in a file name (a header, a log line or a terminal breaks). */
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/
/** The longest segment, in UTF-8 bytes (the common file system limit, NAME_MAX). */
export const MAX_SEGMENT_BYTES = 255
const utf8 = new TextEncoder()

/**
 * True for a path the files route can't carry: an empty, `.` or `..` segment (a leading or trailing `/` too), a `#` or
 * `\` anywhere, a control character (NUL, C0, DEL, C1), a segment over 255 UTF-8 bytes, or an unpaired surrogate.
 */
export function badFileName(path: string): boolean {
  if (CONTROL.test(path)) return true
  const segments = path.split('/')
  if (segments.some((s) => s === '' || s === '.' || s === '..' || s.includes('#') || s.includes('\\'))) return true
  try {
    encodeURIComponent(path)
  } catch {
    return true // URIError: an unpaired surrogate
  }
  return segments.some((s) => utf8.encode(s).length > MAX_SEGMENT_BYTES)
}
