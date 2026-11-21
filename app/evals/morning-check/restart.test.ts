// The test build's restart (p4-w3 runner review H1). Ways it can fail, written down first:
//  1. the next case starts while the old build still answers, so it runs on the previous shop (the signal reached only the
//     `sh -c` wrapper, or nothing waited for the exit);
//  2. a new build is started over a live one (it can't bind, and the old one keeps serving);
//  3. the new build isn't up yet, or died while starting, and the case goes ahead anyway;
//  4. the live build isn't on the case's shop and the case runs there instead of being refused.
// The process and the health endpoint are fakes on one clock: nothing sleeps.
import { describe, expect, it } from 'vitest'
import { Build, RestartError } from './restart.ts'
import type { RestartDeps } from './restart.ts'

interface World {
  now: number
  /** Who answers on the port: the generation of the build, or null. */
  listening: number | null
  log: string[]
}

/**
 * One fake machine. A started build (generation g) begins answering `bootMs` later and prints its shop line `printMs` after
 * that. A group signal ends it after `dieMs` (never, for `immune` to SIGTERM; SIGKILL always ends it at once).
 */
function machine(o: { bootMs?: number; printMs?: number; dieMs?: number; immune?: boolean; printed?: (shop: string) => string; crashAt?: number } = {}) {
  const w: World = { now: 0, listening: null, log: [] }
  let gen = 0
  const kids = new Map<number, { born: number; gen: number; signalledAt: number | null; killed: boolean; shop: string; dead: boolean; resolve: () => void }>()
  const settle = () => {
    for (const k of kids.values()) {
      if (k.dead) continue
      const sig = k.signalledAt !== null && (k.killed || (!o.immune && w.now - k.signalledAt >= (o.dieMs ?? 0)))
      const crashed = o.crashAt !== undefined && w.now - k.born >= o.crashAt
      if (sig || crashed) {
        k.dead = true
        if (w.listening === k.gen) w.listening = null
        k.resolve()
      } else if (w.now - k.born >= (o.bootMs ?? 2000) && w.listening === null) w.listening = k.gen
    }
  }
  const deps: RestartDeps = {
    start(shop) {
      const g = ++gen
      const pid = 1000 + g
      let resolve!: () => void
      const exited = new Promise<void>(r => { resolve = r })
      kids.set(pid, { born: w.now, gen: g, signalledAt: null, killed: false, shop, dead: false, resolve })
      w.log.push(`start ${shop} gen${g}`)
      return { pid, exited, output: () => (w.now - (kids.get(pid)?.born ?? 0) >= (o.bootMs ?? 2000) + (o.printMs ?? 500) ? (o.printed?.(shop) ?? `env.SHOPIFY_SHOP ("${shop}") Environment Variable local`) : 'starting') }
    },
    killGroup(pid, signal) {
      w.log.push(`${signal} -${pid}`)
      const k = kids.get(pid)
      if (!k || k.dead) return
      if (signal === 'SIGKILL') k.killed = true
      k.signalledAt ??= w.now
    },
    async answers() { settle(); return w.listening !== null },
    async pause() { w.now += 500; settle() },
    nowMs: () => w.now,
    waitMs: 30_000,
    shopShown: (out, shop) => new RegExp(`SHOPIFY_SHOP[^\\n]*${shop}`).test(out),
  }
  return { w, deps, build: new Build(deps), alive: () => [...kids.values()].filter(k => !k.dead).map(k => k.shop) }
}

describe('restarting the build', () => {
  it('starts the first build, up and on the case\'s shop', async () => {
    const m = machine()
    await m.build.restart('example-mc-a')
    expect(m.w.listening).toBe(1)
    expect(m.alive()).toEqual(['example-mc-a'])
  })

  it('kills the old group, waits for its exit and for its port to go down, then starts the new one: never two at once', async () => {
    const m = machine({ dieMs: 3000 })
    await m.build.restart('example-mc-a')
    await m.build.restart('example-mc-b')
    expect(m.w.log).toEqual(['start example-mc-a gen1', 'SIGTERM -1001', 'start example-mc-b gen2'])
    expect(m.alive()).toEqual(['example-mc-b'])
    expect(m.w.listening).toBe(2)
    // The new build was started only after the old one had stopped answering.
    expect(m.w.log.indexOf('start example-mc-b gen2')).toBeGreaterThan(m.w.log.indexOf('SIGTERM -1001'))
  })

  it('escalates to SIGKILL when the old group ignores SIGTERM, and goes on once it is gone', async () => {
    const m = machine({ immune: true })
    await m.build.restart('example-mc-a')
    await m.build.restart('example-mc-b')
    expect(m.w.log).toContain('SIGKILL -1001')
    expect(m.alive()).toEqual(['example-mc-b'])
  })

  it('refuses when something else still answers at the address before the start (an old build the runner doesn\'t own)', async () => {
    const m = machine()
    m.w.listening = 99
    const deps = { ...m.deps, killGroup: m.deps.killGroup }
    const build = new Build(deps)
    await expect(build.restart('example-mc-a')).rejects.toMatchObject({ step: 'before starting' })
    expect(m.w.log).toEqual([])
  })

  it('fails when the new build exits while starting, with its last output', async () => {
    const m = machine({ crashAt: 1000, bootMs: 5000 })
    await expect(m.build.restart('example-mc-a')).rejects.toThrow(/exited while starting/)
  })

  it('fails when the new build never answers within the wait', async () => {
    const m = machine({ bootMs: 10 * 60_000 })
    await expect(m.build.restart('example-mc-a')).rejects.toBeInstanceOf(RestartError)
    expect(m.w.now).toBeGreaterThanOrEqual(30_000)
  })

  it('refuses a build that answers but isn\'t on the case\'s shop, and stops it', async () => {
    const m = machine({ printed: () => 'env.SHOPIFY_SHOP ("example-fixture") Environment Variable local' })
    await expect(m.build.restart('example-mc-a')).rejects.toMatchObject({ step: 'the build showing SHOPIFY_SHOP example-mc-a' })
    expect(m.alive()).toEqual([])
  })

  it('stop() with nothing started does nothing, and a second stop is harmless', async () => {
    const m = machine()
    await m.build.stop()
    await m.build.restart('example-mc-a')
    await m.build.stop()
    await m.build.stop()
    expect(m.alive()).toEqual([])
    expect(m.w.listening).toBeNull()
  })
})
