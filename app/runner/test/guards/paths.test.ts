// Session keys and the paths they make. Ways it could fail, written first:
// - a key with `/`, `..`, `.` or a NUL makes a path outside the work root, or another session's folder;
// - a key that passes yields a path that isn't exactly one segment under the root;
// - an empty or overlong key passes;
// - a non-string passes;
// - a pool user's name with `/`, `..` or a NUL makes a path outside the users root, or another user's folders;
// - the session's TMPDIR or HOME (R1's `sessionEnv`) isn't the folder the host makes for its user;
// - HOME or TMPDIR is inside the session folder (Bash writes it, so the sandbox has to mask `$HOME/.claude` there);
// - a long chat id makes TMPDIR too long for the sandbox's bridge sockets (a Unix socket path holds 107 bytes).
import { basename, dirname, join, relative, resolve } from 'node:path'
import { fc, it } from '@fast-check/vitest'
import { describe, expect } from 'vitest'
import { InvalidSessionKeyError, InvalidUserNameError, USERS_ROOT, WORK_ROOT, sessionPaths, userPaths, validSessionKey } from '../../src/guards/paths.ts'
import { POOL_SIZE, poolUserName } from '../../src/guards/users.ts'
import { sessionEnv } from '../../src/session/env.ts'

/** What `sun_path` holds, less its closing NUL. */
const SOCKET_PATH_MAX = 107

const tricky = fc.oneof(
  fc.string({ maxLength: 80 }),
  fc.constantFrom('', '.', '..', '../x', 'a/b', '/etc', 'a\0b', 'a'.repeat(65), '..%2f', 'a/../..', ' a', 'é', '.home', 'a.b'),
  fc.stringMatching(/^[A-Za-z0-9_./-]{0,70}$/),
)

describe('session keys', () => {
  it.prop([tricky])('a key either is refused or makes exactly one plain segment under the work root', (key) => {
    if (!validSessionKey(key)) {
      expect(() => sessionPaths(key)).toThrow(InvalidSessionKeyError)
      return
    }
    const p = sessionPaths(key)
    expect(resolve(p.workDir)).toBe(p.workDir)
    expect(dirname(p.workDir)).toBe(WORK_ROOT)
    expect(basename(p.workDir)).toBe(key)
    for (const sub of [p.inputs, p.outputs]) expect(dirname(sub)).toBe(p.workDir)
  })

  it.prop([fc.anything()])('anything that is not a string is refused', (v) => {
    fc.pre(typeof v !== 'string')
    expect(validSessionKey(v)).toBe(false)
  })

  it('refuses the obvious escapes and edge lengths', () => {
    for (const k of ['', '.', '..', '../x', 'a/b', 'a\0b', 'a'.repeat(65), 'a.b']) expect(validSessionKey(k), k).toBe(false)
    for (const k of ['a', 'A-z_09', 'a'.repeat(64)]) expect(validSessionKey(k), k).toBe(true)
  })
})

describe("a pool user's own folders", () => {
  it.prop([fc.oneof(tricky, fc.stringMatching(/^[a-z_][a-z0-9_-]{0,40}$/))])('a name either is refused or makes exactly one plain segment under the users root', (name) => {
    let own
    try {
      own = userPaths(name)
    } catch (e) {
      expect(e).toBeInstanceOf(InvalidUserNameError)
      expect(/^[a-z_][a-z0-9_-]{0,31}$/.test(name)).toBe(false)
      return
    }
    expect(resolve(own.dir)).toBe(own.dir)
    expect(dirname(own.dir)).toBe(USERS_ROOT)
    expect(basename(own.dir)).toBe(name)
    for (const sub of [own.home, own.tmp]) expect(dirname(sub)).toBe(own.dir)
    expect(own.home).not.toBe(own.tmp)
  })

  it.prop([fc.anything()])('anything that is not a string is refused', (v) => {
    fc.pre(typeof v !== 'string')
    expect(() => userPaths(v)).toThrow(InvalidUserNameError)
  })

  it.prop([fc.stringMatching(/^[A-Za-z0-9_-]{1,64}$/), fc.nat(POOL_SIZE - 1)])(
    "the session's HOME and TMPDIR are its user's own folders, outside the session folder, and short for any chat id",
    (key, i) => {
      const user = poolUserName(i)
      const own = userPaths(user)
      const p = sessionPaths(key)
      const env = sessionEnv({ uid: 30000 + i, gid: 30000 + i, user, home: own.home, workDir: p.workDir }, 8081)
      expect(env.HOME).toBe(own.home)
      expect(env.TMPDIR).toBe(own.tmp)
      for (const d of [env.HOME!, env.TMPDIR!]) expect(relative(p.workDir, d).startsWith('..')).toBe(true)
      // The sandbox's bridge sockets: `<TMPDIR>/claude-socks-<16 hex>.sock`.
      expect(Buffer.byteLength(join(env.TMPDIR!, `claude-socks-${'f'.repeat(16)}.sock`))).toBeLessThanOrEqual(SOCKET_PATH_MAX)
    },
  )
})
