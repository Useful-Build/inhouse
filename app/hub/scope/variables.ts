// GraphQL variables as plain JSON, capped (P5 W2, review round 1 H1). A script's `variables` cross RPC, where a
// function or an RpcTarget arrives as a callable stub and a plain object may carry a `toJSON` stub that JSON.stringify
// would call back into the sandbox. So the value is walked first, without calling anything: only null, booleans,
// finite numbers, strings, arrays and plain objects, at every depth. Then it's serialised and capped. ScriptApi and
// SignIn.query both apply it.

/** The most a document's variables may serialise to (UTF-8). */
export const MAX_VARIABLES_BYTES = 16 * 1024
const MAX_DEPTH = 32

/** Walks `v`, spending `budget.left` on string lengths and keys so a huge value stops early (a lower bound on JSON). */
function plain(v: unknown, depth: number, budget: { left: number }): boolean {
  if (depth > MAX_DEPTH || --budget.left < 0) return false
  if (typeof v === 'string') return (budget.left -= v.length) >= 0
  if (v === null || typeof v === 'boolean') return true
  if (typeof v === 'number') return Number.isFinite(v)
  if (typeof v !== 'object') return false
  if (Array.isArray(v)) {
    if (Object.getPrototypeOf(v) !== Array.prototype) return false
    for (let i = 0; i < v.length; i++) if (!Object.hasOwn(v, i) || !plain(v[i], depth + 1, budget)) return false
    return true
  }
  const proto = Object.getPrototypeOf(v)
  if (proto !== Object.prototype && proto !== null) return false
  for (const key of Object.keys(v)) {
    if ((budget.left -= key.length) < 0) return false
    const d = Object.getOwnPropertyDescriptor(v, key)
    // A getter is never called.
    if (!d || !('value' in d) || !plain(d.value, depth + 1, budget)) return false
  }
  return true
}

export type VariablesCheck = { ok: true; value: Record<string, unknown> | undefined } | { ok: false }

/** Undefined passes as undefined. Otherwise a plain JSON object within MAX_VARIABLES_BYTES, returned as a fresh copy. */
export function checkVariables(variables: unknown): VariablesCheck {
  if (variables === undefined) return { ok: true, value: undefined }
  if (typeof variables !== 'object' || variables === null || Array.isArray(variables) || !plain(variables, 0, { left: MAX_VARIABLES_BYTES })) return { ok: false }
  const json = JSON.stringify(variables)
  if (new TextEncoder().encode(json).byteLength > MAX_VARIABLES_BYTES) return { ok: false }
  return { ok: true, value: JSON.parse(json) as Record<string, unknown> }
}
