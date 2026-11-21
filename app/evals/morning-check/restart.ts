// Restarting the test build for a case (the shop is a var of the hub, so a case needs its own start). A restart is safe only
// when the old build is gone and the new one is the one answering: the wrapper `sh -c` the command runs under dies on a
// signal without taking wrangler and workerd with it, and a new build started over a live one can't bind its port, so the
// next case would run on the old shop. So: the whole process group is signalled, its exit awaited, the build's port seen
// DOWN, the new build started in its own group, seen UP, and its own startup output must show the case's shop. Every effect
// is injected; `run.mjs` passes the real ones, a unit test passes a fake process and a fake health endpoint.

export interface Child {
  pid: number
  /** Resolves when the process has exited. */
  exited: Promise<void>
  /** Everything it has printed so far (stdout and stderr). */
  output(): string
}

export interface RestartDeps {
  /** Starts the restart command in its own process group, on the case's hub config. */
  start(shop: string): Child
  /** Signals the whole group (`process.kill(-pid, signal)`). */
  killGroup(pid: number, signal: 'SIGTERM' | 'SIGKILL'): void
  /** True when the product Worker answers at all (any HTTP status: its health route wants a token); false when the connection fails. */
  answers(): Promise<boolean>
  pause(): Promise<void>
  nowMs(): number
  /** The most each wait may take. */
  waitMs: number
  /** Whether the startup output shows the live shop (wrangler prints its vars: `SHOPIFY_SHOP ("example-mc-late-orders")`). */
  shopShown(output: string, shop: string): boolean
}

/**
 * What the startup output must show, with `{shop}` for the shop: wrangler prints a config `vars` value as
 * `env.SHOPIFY_SHOP ("example-mc-late-orders")`. The right edge keeps `late-orders` from matching `late-orders-red`.
 */
export const DEFAULT_SHOP_PATTERN = 'SHOPIFY_SHOP\\W{1,4}{shop}(?![A-Za-z0-9-])'

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** `RestartDeps.shopShown` for a pattern. */
export const shopShownBy = (pattern: string) => (output: string, shop: string): boolean => new RegExp(pattern.replace('{shop}', escapeRe(shop))).test(output)

export class RestartError extends Error {
  readonly step: string
  constructor(step: string, detail: string) {
    super(`${step}: ${detail}`)
    this.name = 'RestartError'
    this.step = step
  }
}

export class Build {
  private child: Child | null = null
  private readonly d: RestartDeps
  constructor(d: RestartDeps) {
    this.d = d
  }

  private async until(what: string, ok: () => Promise<boolean> | boolean): Promise<void> {
    const end = this.d.nowMs() + this.d.waitMs
    while (!(await ok())) {
      if (this.d.nowMs() >= end) throw new RestartError(what, `not within ${Math.round(this.d.waitMs / 1000)} s`)
      await this.d.pause()
    }
  }

  /**
   * Stops the running build, if any, and waits until it is gone. The build stays tracked until the stop is confirmed (its port
   * seen down), so a failed stop can be retried: when the leader exits but a child (workerd) keeps the port, the group is
   * SIGKILLed.
   */
  async stop(): Promise<void> {
    const old = this.child
    if (!old) return
    let gone = false
    void old.exited.then(() => { gone = true })
    this.d.killGroup(old.pid, 'SIGTERM')
    try {
      await this.until('the old build exiting', () => gone)
    } catch {
      this.d.killGroup(old.pid, 'SIGKILL')
      await this.until('the old build exiting after SIGKILL', () => gone)
    }
    const down = async () => !(await this.d.answers())
    try {
      await this.until('the old build to stop answering', down)
    } catch {
      // The leader is gone and something in its group still holds the port: the group's pgid outlives the leader.
      this.d.killGroup(old.pid, 'SIGKILL')
      await this.until('the old build to stop answering after SIGKILL', down)
    }
    this.child = null
  }

  /** Restarts the build for `shop` and returns once it answers and its output shows that shop. */
  async restart(shop: string): Promise<void> {
    await this.stop()
    if (await this.d.answers()) throw new RestartError('before starting', 'something already answers at the build\'s address (an old build?)')
    const child = this.d.start(shop)
    this.child = child
    let exited = false
    void child.exited.then(() => { exited = true })
    await this.until('the new build answering', async () => {
      if (exited) throw new RestartError('the new build', `exited while starting: ${child.output().slice(-400)}`)
      return this.d.answers()
    })
    try {
      await this.until(`the build showing SHOPIFY_SHOP ${shop}`, () => {
        if (exited) throw new RestartError('the new build', 'exited after it answered')
        return this.d.shopShown(child.output(), shop)
      })
    } catch (e) {
      await this.stop()
      throw e
    }
  }
}
