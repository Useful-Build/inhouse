// Session keys and the paths they make. Ways it could fail, written first:
// - a key with `/`, `..`, `.` or a NUL makes a path outside the work root, or another session's folder;
// - a key that passes yields a path that isn't exactly one segment under the root;
// - an empty or overlong key passes;
// - a non-string passes;
// - the session's TMPDIR or HOME (R1's `sessionEnv`) isn't the folder the host makes for it under the same name.
import { basename, dirname, resolve } from 'node:path'
import { fc, it } from '@fast-check/vitest'
import { describe, expect } from 'vitest'
import { InvalidSessionKeyError, WORK_ROOT, sessionPaths, validSessionKey } from '../../src/guards/paths.ts'
import { sessionEnv } from '../../src/session/env.ts'

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
    for (const sub of [p.home, p.tmp, p.inputs, p.outputs]) expect(dirname(sub)).toBe(p.workDir)
  })

  it.prop([fc.stringMatching(/^[A-Za-z0-9_-]{1,64}$/)])("the session's TMPDIR and HOME are the folders the host makes for it", (key) => {
    const p = sessionPaths(key)
    const env = sessionEnv({ uid: 30001, gid: 30001, user: 's01', home: p.home, workDir: p.workDir }, 8081)
    expect(env.TMPDIR).toBe(p.tmp)
    expect(env.HOME).toBe(p.home)
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
