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
  /** Starts the restart command in its own process group with SHOPIFY_SHOP set. */
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

  /** Stops the running build, if any, and waits until it is gone. */
  async stop(): Promise<void> {
    const old = this.child
    if (!old) return
    this.child = null
    let gone = false
    void old.exited.then(() => { gone = true })
    this.d.killGroup(old.pid, 'SIGTERM')
    try {
      await this.until('the old build exiting', () => gone)
    } catch {
      this.d.killGroup(old.pid, 'SIGKILL')
      await this.until('the old build exiting after SIGKILL', () => gone)
    }
    await this.until('the old build to stop answering', async () => !(await this.d.answers()))
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
