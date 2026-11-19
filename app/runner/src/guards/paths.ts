// Where sessions live in the image, and the one check every session key passes before it touches a path.
import { join } from 'node:path'

/** The work root: 0755 root, so bwrap can traverse it; each session's folder under it is closed to every other. */
export const WORK_ROOT = '/work'
/** The runner's own code: no session may read it. */
export const RUNNER_DIR = '/opt/runner'
/** Our skills, as a plugin: root-owned and read-only (app/runner/image/plugin/ in the repo). */
export const PLUGIN_DIR = '/opt/inhouse/plugin'

/**
 * A session key is the chat id (the wire protocol's `Id`). Only letters, digits, `_` and `-`, 1 to 64 of them: no `/`,
 * no `.`, so a key is always one plain path segment and never `.` or `..`.
 */
const SESSION_KEY = /^[A-Za-z0-9_-]{1,64}$/

export class InvalidSessionKeyError extends Error {}

export function validSessionKey(key: unknown): key is string {
  return typeof key === 'string' && SESSION_KEY.test(key)
}

export function assertSessionKey(key: unknown): asserts key is string {
  if (!validSessionKey(key)) throw new InvalidSessionKeyError('a session key must be 1 to 64 of A-Z, a-z, 0-9, _ and -')
}

/** The names under a session folder. `.home` is the session's HOME, closed to everything but its user. */
export const INPUTS = 'inputs'
export const OUTPUTS = 'outputs'
export const HOME = '.home'

export type SessionPaths = { workDir: string; home: string; inputs: string; outputs: string }

/** A session's folders. Throws on a key that isn't a single safe segment. */
export function sessionPaths(key: string, root: string = WORK_ROOT): SessionPaths {
  assertSessionKey(key)
  const workDir = join(root, key)
  return { workDir, home: join(workDir, HOME), inputs: join(workDir, INPUTS), outputs: join(workDir, OUTPUTS) }
}
