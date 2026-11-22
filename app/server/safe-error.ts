// What a log line or a stored row may say about a caught error (P8a P-auth): its name and a known code (an errno, a
// status, our own `code` field), never its message, stack, cause or the caught value. A message can quote chat,
// customer, tool or file content, or a secret (a JSON.parse error quotes the text; a D1 error can name a value), and
// Workers Logs and DO SQLite must not hold any of it. Pair it with a fixed event name that says what failed.
// build-support/no-raw-error-text.test.ts fails on a new raw read of a message or stack.

const NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/
const CODE = /^[A-Za-z0-9_.-]{1,64}$/

/** `TypeError`, `Error:ENOENT`, `StoreUnavailableError`; `unknown` for a thrown non-Error. */
export function safeError(err: unknown): string {
  if (!(err instanceof Error)) return 'unknown'
  const name = NAME.test(err.name) ? err.name : 'Error'
  const code: unknown = (err as { code?: unknown }).code
  return (typeof code === 'string' || typeof code === 'number') && CODE.test(String(code)) ? `${name}:${code}` : name
}
