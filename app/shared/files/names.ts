// The file-name rule both sides hold: a chat file's path must survive the runner's files route (`/files/<path>`, each
// segment `encodeURIComponent`-encoded, behind a proxy that refuses dot segments, backslashes and fragments).

/**
 * True for a path the files route can't carry: an empty, `.` or `..` segment (a leading or trailing `/` too), a `#` or
 * `\` anywhere, or an unpaired surrogate.
 */
export function badFileName(path: string): boolean {
  const segments = path.split('/')
  if (segments.some((s) => s === '' || s === '.' || s === '..' || s.includes('#') || s.includes('\\'))) return true
  try {
    encodeURIComponent(path)
  } catch {
    return true // URIError: an unpaired surrogate
  }
  return false
}
