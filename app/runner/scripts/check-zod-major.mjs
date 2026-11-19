// Fails when app/ and app/runner/ pin different zod majors. The Worker-runner protocol schemas in app/shared/protocol/
// are parsed by the app's zod in the Worker and by the runner's own zod in the container, so both must be one major.
// While the app has no zod yet (before P1's shared schema), only the runner's pin is checked.
import { readFileSync, realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const FIELDS = /** @type {const} */ (['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'])
const HOW = 'write it as ^X.Y.Z, ~X.Y.Z, X.Y.Z, ^X, ~X.Y or X.x'

/** @typedef {Partial<Record<(typeof FIELDS)[number], Record<string, string>>>} Pkg */

/** @param {string} range */
function majorOf(range) {
  // One major only: ^4, ~4.6, 4.x, 4.6.7, ^4.6.7-beta.1. Comparators and unions (>=4 <5, ^4 || ^5) aren't read.
  const m = /^[\^~]?(\d+)(?:\.(?:\d+|x|\*)){0,2}(?:[-+][\w.+-]*)?$/.exec(range.trim())
  return m ? Number(m[1]) : null
}

/**
 * Every zod range a package declares, in any dependency field.
 * @param {Pkg} pkg
 */
function zodRanges(pkg) {
  return FIELDS.flatMap((f) => (pkg[f]?.zod === undefined ? [] : [{ field: f, range: pkg[f].zod }]))
}

/**
 * The one zod major a package pins, or what's wrong with its pins.
 * @param {Pkg} pkg
 * @param {string} who
 * @returns {{ major: number | null } | { problem: string }}
 */
function pinnedMajor(pkg, who) {
  /** @type {number | null} */
  let major = null
  for (const { field, range } of zodRanges(pkg)) {
    const m = majorOf(range)
    if (m === null) return { problem: `can't read a major from the ${who}'s zod range "${range}" (${field}); ${HOW}` }
    if (major !== null && m !== major) return { problem: `the ${who} pins two zod majors (${major} and ${m})` }
    major = m
  }
  return { major }
}

/**
 * @param {Pkg} appPkg
 * @param {Pkg} runnerPkg
 * @returns {string | null} what's wrong, or null when the pins agree
 */
export function zodMajorProblem(appPkg, runnerPkg) {
  const runner = pinnedMajor(runnerPkg, 'runner')
  if ('problem' in runner) return runner.problem
  if (runner.major === null) return 'the runner has no zod dependency'
  const app = pinnedMajor(appPkg, 'app')
  if ('problem' in app) return app.problem
  if (app.major === null) return null
  if (app.major !== runner.major) return `zod major differs: app ${app.major}, runner ${runner.major}`
  return null
}

// Run as a script. realpath on both sides, so a checkout under a symlink still runs the check instead of passing silently.
if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const read = (/** @type {string} */ rel) => JSON.parse(readFileSync(new URL(rel, import.meta.url), 'utf8'))
  const appPkg = read('../../package.json')
  const problem = zodMajorProblem(appPkg, read('../package.json'))
  if (problem) {
    console.error(`check-zod-major: ${problem}`)
    process.exit(1)
  }
  console.log(zodRanges(appPkg).length === 0 ? 'check-zod-major: ok (the app has no zod yet)' : 'check-zod-major: ok')
}
