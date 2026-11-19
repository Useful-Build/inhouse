// The test implementation of the guards seam: the current OS user and no guards. Tests only; the production wiring
// (src/server/production.ts) refuses it because it's marked `test`.
import { fork } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { QueryGuards, SessionUser, SessionUsers } from '../../../src/session/seam.ts'
import type { SpawnSession } from '../../../src/server/session-host.ts'

export function testSessionUsers(): SessionUsers & { dirs: Map<string, string> } {
  const dirs = new Map<string, string>()
  return {
    kind: 'test',
    dirs,
    async allocate(sessionKey) {
      let dir = dirs.get(sessionKey)
      if (dir === undefined) {
        dir = mkdtempSync(join(tmpdir(), `runner-test-${sessionKey}-`))
        dirs.set(sessionKey, dir)
      }
      return { uid: process.getuid!(), gid: process.getgid!(), user: 'tester', home: dir, workDir: dir } satisfies SessionUser
    },
    async release() {},
  }
}

export function cleanup(users: { dirs: Map<string, string> }) {
  for (const d of users.dirs.values()) rmSync(d, { recursive: true, force: true })
}

export const testQueryGuards: QueryGuards = { kind: 'test', apply: (options) => options }

/** Spawns a fixture session script as the "session user" (the current user here), the same way production forks. */
export function spawnFixture(script: string): SpawnSession {
  return (user, env) =>
    fork(fileURLToPath(new URL(`../fixtures/${script}`, import.meta.url)), [], {
      uid: user.uid,
      gid: user.gid,
      cwd: user.workDir,
      env,
      execArgv: [],
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      serialization: 'json',
    })
}
