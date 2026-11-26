// A Workers RPC answer, kept as plain data and released. Docs read 2026-11-26:
// https://developers.cloudflare.com/workers/runtime-apis/rpc/lifecycle/ ("When an RPC returns any kind of object, that
// object will have a disposer added by the system"; code "should dispose stubs explicitly when it is done with them").
// Only an answer that carries a disposer or stubs keeps its call open. A method that returns another RPC call's answer
// as is (the hub's gateways passing on a SignIn object's answer) returns a disposer, and the runtime then keeps that
// call open until its caller disposes; when the caller is a Durable Object (BrandAgent), the object never goes idle.
// The fix is on the hub side, where each such answer is copied and released; the product's copies of the hub's answers
// are backstops. Used on both sides of the hub's bindings; imports nothing, so the hub bundles it as is.

/** `Symbol.dispose` (the runtime has it; the projects' TypeScript libs don't all name it yet). */
const DISPOSE = (Symbol as unknown as { dispose?: symbol }).dispose

/** Runs the answer's disposer, if it has one (an object, or a callable stub). */
export function releaseAnswer(answer: unknown): void {
  if ((typeof answer !== 'object' && typeof answer !== 'function') || answer === null || DISPOSE === undefined) return
  const dispose = (answer as Record<symbol, unknown>)[DISPOSE]
  if (typeof dispose === 'function') (dispose as () => void).call(answer)
}

/**
 * The answer's plain data, the answer itself released. The copy is a structured clone, which never carries a symbol key
 * (so never the disposer). An answer that isn't data throws after it is released: a function or a stub at the top
 * (a `TypeError`) or inside it (the clone's `DataCloneError`).
 */
export function plainAnswer<T>(answer: T): T {
  if (typeof answer === 'function') {
    releaseAnswer(answer)
    throw new TypeError('an RPC answer is a function or a stub, not data')
  }
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
