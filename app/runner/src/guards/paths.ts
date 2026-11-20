// Where sessions live in the image, and the one check every session key passes before it touches a path.
import { join } from 'node:path'

/**
 * The work root: 0711 root, so bwrap (and a session) can reach the session's own folder but no session can list the
 * chat ids. Each session's folder under it is closed to every other.
 */
export const WORK_ROOT = '/work'
/** The runner's own code: no session may read it. */
export const RUNNER_DIR = '/opt/runner'
/** Our skills, as a plugin: root-owned and read-only (app/runner/image/plugin/ in the repo). */
export const PLUGIN_DIR = '/opt/inhouse/plugin'
/**
 * The CLI as each session starts it: a wrapper (app/runner/image/bin/claude in the repo) that sets the per-session
 * process limit, then runs the SDK's own CLI. Root-owned and read-only.
 */
export const CLI_WRAPPER = '/opt/inhouse/bin/claude'
/**
 * RLIMIT_NPROC for the CLI and everything under it (Bash, its scripts): the most processes the session's uid may have
 * before a fork fails. The kernel counts every process of the uid, and a uid serves one session, so a fork bomb stops
 * here and the release's kill and wipe still run. The wrapper sets it; a test pins the two together.
 */
export const SESSION_PROCESS_LIMIT = 512

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

/**
 * The names under a session folder. `.home` is the session's HOME and `.tmp` its TMPDIR, each closed to everything but
 * its user.
 */
export const INPUTS = 'inputs'
export const OUTPUTS = 'outputs'
export const HOME = '.home'
export const TMP = '.tmp'

export type SessionPaths = { workDir: string; home: string; tmp: string; inputs: string; outputs: string }

/** A session's folders. Throws on a key that isn't a single safe segment. */
export function sessionPaths(key: string, root: string = WORK_ROOT): SessionPaths {
  assertSessionKey(key)
  const workDir = join(root, key)
  return { workDir, home: join(workDir, HOME), tmp: join(workDir, TMP), inputs: join(workDir, INPUTS), outputs: join(workDir, OUTPUTS) }
}
