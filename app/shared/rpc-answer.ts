// A Workers RPC answer, kept as plain data and released. Docs read 2026-11-26:
// https://developers.cloudflare.com/workers/runtime-apis/rpc/lifecycle/ ("When an RPC returns any kind of object, that
// object will have a disposer added by the system"; code "should dispose stubs explicitly when it is done with them").
// An answer passed on as is (the hub's gateways returning a SignIn object's answer) or held undisposed by a Durable
// Object (BrandAgent) keeps that call open: the object then never goes idle. Used on both sides of the hub's bindings;
// imports nothing, so the hub bundles it as is.

/** `Symbol.dispose` (the runtime has it; the projects' TypeScript libs don't all name it yet). */
const DISPOSE = (Symbol as unknown as { dispose?: symbol }).dispose

/** Runs the answer's disposer, if it has one. */
export function releaseAnswer(answer: unknown): void {
  if (typeof answer !== 'object' || answer === null || DISPOSE === undefined) return
  const dispose = (answer as Record<symbol, unknown>)[DISPOSE]
  if (typeof dispose === 'function') (dispose as () => void).call(answer)
}

/**
 * The answer's plain data, the answer itself released. The copy is a structured clone, which never carries a symbol key
 * (so never the disposer); an answer that can't be cloned (a stub inside it) throws after it is released.
 */
export function plainAnswer<T>(answer: T): T {
  if (typeof answer !== 'object' || answer === null) return answer
  try {
    return structuredClone(answer)
  } finally {
    releaseAnswer(answer)
  }
}

/**
 * Awaits an RPC call and returns its answer's plain data (`plainAnswer`). Typed over the call itself: a typed stub's
 * method answers a union of RPC promises, which one `PromiseLike<T>` can't name.
 */
export async function settledAnswer<P>(call: P): Promise<Awaited<P>> {
  return plainAnswer(await call)
}
