// Text helpers for shown times. Pure functions, no React. Formatting lives in src/lib/format.ts; the demo's own clock is in
// demo-clock.ts (only the demo entry and the mock import it), and the readers of times saved before C1 in upgrade-times.ts.

/** A shown time ("6:04 AM", as `fmtTime` in format.ts writes it) found in a text. */
export const TIME_RE = /\b(1[0-2]|[1-9]):([0-5]\d)[ \u00a0](AM|PM)\b/

/** Text leaving the screen (a copy, a CSV, a search): no-break spaces become plain ones, so "6:04 AM" typed or pasted matches. */
export const plainSpaces = (s: string): string => s.replaceAll('\u00a0', ' ')

/** A number kept with its unit at a line break ("3 days"). For display only: data and search text keep plain spaces. */
export const keepUnitsTogether = (s: string): string => s.replace(/(\d) (days?|things)\b/g, '$1\u00a0$2')

/** Every shown time in `x` (a string, or any JSON value's strings) with a no-break space before AM or PM, as `fmtTime` writes it. */
export const keepTimesTogether = <T,>(x: T): T => {
  if (typeof x === 'string') return x.replace(/(\d) (AM|PM)\b/g, '$1\u00a0$2') as T
  if (Array.isArray(x)) return x.map(keepTimesTogether) as T
  if (typeof x === 'object' && x !== null) return Object.fromEntries(Object.entries(x).map(([k, v]) => [k, keepTimesTogether(v)])) as T
  return x
}
/** Minutes since midnight of the first shown time ("6:04 AM") in a text. Throws when there is none. */
export const minuteOfTime = (text: string): number => {
  const m = TIME_RE.exec(text)
  if (!m) throw new Error(`No time like "6:04 AM" in "${text}"`)
  return (Number(m[1]) % 12 + (m[3] === 'PM' ? 12 : 0)) * 60 + Number(m[2])
}
