// One request at a time: a second call while the first is in flight does nothing (Grant, End now, Load more).

/** Wraps a request so it runs only when none of its own is in flight. `onBusy` hears each change (a button's disabled state). */
export function single<A extends unknown[]>(run: (...a: A) => Promise<unknown>, onBusy?: (busy: boolean) => void): (...a: A) => boolean {
  let busy = false
  return (...a: A) => {
    if (busy) return false
    busy = true
    onBusy?.(true)
    // A rejection was already told by the agent (a notice, or `tell`); this only ends the wait.
    run(...a).catch(() => undefined).finally(() => { busy = false; onBusy?.(false) })
    return true
  }
}
