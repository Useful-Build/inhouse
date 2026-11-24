// The test implementation of the guards seam: the current OS user and no guards. Tests only; the production wiring
// (src/server/production.ts) refuses it because it's marked `test`.
import type { ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { BrandSkillFile } from '../../../../shared/protocol/brand-skills.ts'
import type { QueryGuards, SessionUser, SessionUsers } from '../../../src/session/seam.ts'
import { spawnSessionProcess, type SpawnSession } from '../../../src/server/session-host.ts'

export type TestUsersOpts = {
  /** Runs inside allocate, after the work folder exists (to gate it, or to drop a marker file in the folder). */
  onAllocate?: (sessionKey: string, dir: string) => Promise<void> | void
  /** Runs inside release. */
  onRelease?: (sessionKey: string, user: SessionUser) => Promise<void> | void
  /** The uid a session key gets (default: its own, from 20000 up, as production gives each session its own user). */
  uidFor?: (sessionKey: string) => number
  /** The gid a session key gets (default: yours). */
  gidFor?: (sessionKey: string) => number
}

export type TestUsers = SessionUsers & {
  dirs: Map<string, string>
  uids: Map<string, number>
  allocated: string[]
  released: string[]
  /** The brand skills each run was given, by session key, in order. */
  brandSkills: Map<string, (readonly BrandSkillFile[])[]>
}

let nextUid = 20000

export function testSessionUsers(opts: TestUsersOpts = {}): TestUsers {
  const dirs = new Map<string, string>()
  const uids = new Map<string, number>()
  const allocated: string[] = []
  const released: string[] = []
  const brandSkills = new Map<string, (readonly BrandSkillFile[])[]>()
  return {
    kind: 'test',
    quarantined: () => 0,
    dirs,
    uids,
    allocated,
    released,
    brandSkills,
    async writeBrandSkills(sessionKey, _user, skills) {
      brandSkills.set(sessionKey, [...(brandSkills.get(sessionKey) ?? []), skills])
    },
    async allocate(sessionKey) {
      let dir = dirs.get(sessionKey)
      if (dir === undefined) {
        dir = mkdtempSync(join(tmpdir(), `runner-test-${sessionKey}-`))
        dirs.set(sessionKey, dir)
      }
      allocated.push(sessionKey)
      await opts.onAllocate?.(sessionKey, dir)
      if (!uids.has(sessionKey)) uids.set(sessionKey, opts.uidFor?.(sessionKey) ?? nextUid++)
      const uid = uids.get(sessionKey)!
      return { uid, gid: opts.gidFor?.(sessionKey) ?? process.getgid!(), user: 'tester', home: dir, workDir: dir } satisfies SessionUser
    },
    async release(sessionKey, user) {
      await opts.onRelease?.(sessionKey, user)
      released.push(sessionKey)
    },
  }
}

export function cleanup(users: { dirs: Map<string, string> }) {
  for (const d of users.dirs.values()) rmSync(d, { recursive: true, force: true })
}

export const testQueryGuards: QueryGuards = { kind: 'test', apply: (options) => options }

/**
 * Spawns a fixture session script with the production spawn (its own process group, the channel on its stdio, the same Node flags).
 * The uids the test seam hands out aren't real users, so it runs as you. `onSpawn` sees each child.
 */
export function spawnFixture(script: string, opts: { onSpawn?: (child: ChildProcess) => void } = {}): SpawnSession {
  const spawn = spawnSessionProcess(fileURLToPath(new URL(`../fixtures/${script}`, import.meta.url)))
  return (user, env) => {
    const child = spawn({ ...user, uid: process.getuid!(), gid: process.getgid!() }, env)
    opts.onSpawn?.(child)
    return child
  }
}

/** A promise with its resolver, to gate a seam from a test. */
export function gate(): { promise: Promise<void>; open: () => void } {
  let open!: () => void
  const promise = new Promise<void>((r) => (open = r))
  return { promise, open }
}
