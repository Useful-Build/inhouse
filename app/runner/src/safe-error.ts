// What a container log line may say about a caught error (P8a P-auth): its name and its errno code, never its message,
// stack or the caught value. A message can quote chat, tool or file content (a Node fs error names the path, and a
// session's file names are chat content), and the container logs must not hold any of it. Pair it with a fixed event
// name that says what failed. The same rule as server/safe-error.ts, copied: the runner's image holds runner/src and two
// shared/ folders only (Dockerfile). app/build-support/no-raw-error-text.test.ts fails on a new raw read.

const NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/
const CODE = /^[A-Za-z0-9_.-]{1,64}$/

/** `TypeError`, `Error:ENOENT`, `StoreUnavailableError`; `unknown` for a thrown non-Error. */
export function safeError(err: unknown): string {
  if (!(err instanceof Error)) return 'unknown'
  const name = NAME.test(err.name) ? err.name : 'Error'
  const code: unknown = (err as { code?: unknown }).code
  return (typeof code === 'string' || typeof code === 'number') && CODE.test(String(code)) ? `${name}:${code}` : name
}
