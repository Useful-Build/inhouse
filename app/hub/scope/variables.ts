// GraphQL variables as plain JSON, capped (P5 W2, review rounds 1 and 2: H1, H1b). A script's `variables` cross RPC,
// where a function or an RpcTarget arrives as a callable stub, a plain object or an array may carry a `toJSON` stub
// that JSON.stringify would call back into the sandbox, and an array keeps named own properties. So the value is walked
// without calling anything and a plain copy is built during the walk: only null, booleans, finite numbers, strings,
// arrays with index keys only and plain objects with data properties, at every depth. Only the copy is ever serialised;
// the input never is. Anything that throws while walked (a revoked Proxy, a trap) is refused. ScriptApi and
// SignIn.query both apply it, and SignIn sends the copy.

/** The most a document's variables may serialise to (UTF-8). */
export const MAX_VARIABLES_BYTES = 16 * 1024
const MAX_DEPTH = 32

class Refused extends Error {}
const refuse = (): never => {
  throw new Refused()
}

/** Copies `v`, spending `budget.left` on values, keys and string lengths so a huge value stops early. */
function copy(v: unknown, depth: number, budget: { left: number }): unknown {
  if (depth > MAX_DEPTH || --budget.left < 0) refuse()
  if (typeof v === 'string') {
    if ((budget.left -= v.length) < 0) refuse()
    return v
  }
  if (v === null || typeof v === 'boolean') return v
  if (typeof v === 'number') return Number.isFinite(v) ? v : refuse()
  if (typeof v !== 'object') return refuse()
  const keys = Object.keys(v)
  if (Object.getOwnPropertySymbols(v).length > 0) refuse()
  if (Array.isArray(v)) {
    if (Object.getPrototypeOf(v) !== Array.prototype) refuse()
    // Index keys only: a named own property (`toJSON`, anything) is refused.
    if (keys.length !== v.length) refuse()
    const out: unknown[] = []
    for (let i = 0; i < v.length; i++) {
      if (keys[i] !== String(i)) refuse()
      out.push(copy(dataValue(v, String(i)), depth + 1, budget))
    }
    return out
  }
  const proto = Object.getPrototypeOf(v)
  if (proto !== Object.prototype && proto !== null) refuse()
  const out: Record<string, unknown> = {}
  for (const key of keys) {
    if ((budget.left -= key.length) < 0) refuse()
    // defineProperty, so a `__proto__` key is a plain key on the copy, never its prototype.
    Object.defineProperty(out, key, { value: copy(dataValue(v, key), depth + 1, budget), enumerable: true, writable: true, configurable: true })
  }
  return out
}

/** An own data property's value; a getter is never called. */
function dataValue(v: object, key: string): unknown {
  const d = Object.getOwnPropertyDescriptor(v, key)
  return d && 'value' in d ? d.value : refuse()
}

export type VariablesCheck = { ok: true; value: Record<string, unknown> | undefined } | { ok: false }

/** Undefined passes as undefined. Otherwise a plain copy of a JSON object within MAX_VARIABLES_BYTES. */
export function checkVariables(variables: unknown): VariablesCheck {
  if (variables === undefined) return { ok: true, value: undefined }
  try {
    if (typeof variables !== 'object' || variables === null || Array.isArray(variables)) return { ok: false }
    const value = copy(variables, 0, { left: MAX_VARIABLES_BYTES }) as Record<string, unknown>
    // The copy is plain data built above, so this stringify calls no user code.
    if (new TextEncoder().encode(JSON.stringify(value)).byteLength > MAX_VARIABLES_BYTES) return { ok: false }
    return { ok: true, value }
  } catch {
    return { ok: false }
  }
}
