// The Runner Durable Object with its container (P3, p3-design section 7): `runner-0` .. `runner-<N-1>`. Owner: W2.
// The BrandAgent's pool (pool.ts) calls `admit`, `status`, `interrupt`, `stop` and `warm`; the egress calls `touch` on
// every push (design 8.6). The logic is in runner.ts, behind a container port; this class hands it `ctx.container`.
// `ctx.container` only: no deprecated `Container` class, no beta scheduling or snapshots.
import { DurableObject } from 'cloudflare:workers'
import type { RunStart } from '../../../shared/protocol/index.ts'
import { brandAgent } from '../brand-agent/client.ts'
import { RunnerCore, sqlRunnerState, type AdmitResult, type StatusResult, type WarmResult } from './runner.ts'

export class Runner extends DurableObject<Env> {
  #core: RunnerCore<Fetcher> | undefined

  /** Built on first use: the test pool has no container, and a Runner there is only ever asked for its storage. */
  get #runner(): RunnerCore<Fetcher> {
    if (this.#core) return this.#core
    const container = this.ctx.container
    if (!container) throw new Error('this Runner has no container (containers are not enabled here)')
    const name = this.ctx.id.name
    if (name === undefined) throw new Error('a Runner is addressed by name (runner-<n>)')
    const env = this.env
    const exports = this.ctx.exports
    this.#core = new RunnerCore<Fetcher>({
      name,
      container,
      state: sqlRunnerState(this.ctx.storage.sql),
      bindings: {
        egress: props => exports.Egress({ props }),
        web: props => exports.WebEgress({ props }),
        deny: props => exports.DenyEgress({ props }),
      },
      exited: (runner, gen) => brandAgent(env).containerExited(runner, gen),
    })
    return this.#core
  }

  admit(rs: RunStart): Promise<AdmitResult> {
    return this.#runner.admit(rs)
  }
  touch(): Promise<void> {
    return this.#runner.touch()
  }
  status(turnId: string): Promise<StatusResult> {
    return this.#runner.status(turnId)
  }
  interrupt(turnId: string): Promise<void> {
    return this.#runner.interrupt(turnId)
  }
  stop(turnId: string): Promise<void> {
    return this.#runner.stop(turnId)
  }
  warm(newerThan: number | null): Promise<WarmResult> {
    return this.#runner.warm(newerThan)
  }

  async fetch(): Promise<Response> {
    return new Response('not found', { status: 404 })
  }
}
