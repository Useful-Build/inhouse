// Fails when app/ and app/runner/ pin different zod majors. The Worker-runner protocol schemas in app/shared/protocol/
// are parsed by the app's zod in the Worker and by the runner's own zod in the container, so both must be one major.
// While the app has no zod yet (before P1's shared schema), only the runner's pin is checked.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/** @param {string | undefined} range */
function majorOf(range) {
  const m = /^[\^~]?(\d+)\.\d+\.\d+(?:[-+][\w.+-]*)?$/.exec(range ?? '')
  return m ? Number(m[1]) : null
}

/** @param {{ dependencies?: Record<string, string>, devDependencies?: Record<string, string> }} pkg */
function zodRange(pkg) {
  return pkg.dependencies?.zod ?? pkg.devDependencies?.zod
}

/**
 * @param {{ dependencies?: Record<string, string>, devDependencies?: Record<string, string> }} appPkg
 * @param {{ dependencies?: Record<string, string>, devDependencies?: Record<string, string> }} runnerPkg
 * @returns {string | null} what's wrong, or null when the pins agree
 */
export function zodMajorProblem(appPkg, runnerPkg) {
  const runnerRange = zodRange(runnerPkg)
  if (runnerRange === undefined) return 'the runner has no zod dependency'
  const runnerMajor = majorOf(runnerRange)
  if (runnerMajor === null) return `can't read a major from the runner's zod range "${runnerRange}"`
  const appRange = zodRange(appPkg)
  if (appRange === undefined) return null
  const appMajor = majorOf(appRange)
  if (appMajor === null) return `can't read a major from the app's zod range "${appRange}"`
  if (appMajor !== runnerMajor) return `zod major differs: app ${appRange}, runner ${runnerRange}`
  return null
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const read = (/** @type {string} */ rel) => JSON.parse(readFileSync(new URL(rel, import.meta.url), 'utf8'))
  const appPkg = read('../../package.json')
  const problem = zodMajorProblem(appPkg, read('../package.json'))
  if (problem) {
    console.error(`check-zod-major: ${problem}`)
    process.exit(1)
  }
  console.log(zodRange(appPkg) === undefined ? 'check-zod-major: ok (the app has no zod yet)' : 'check-zod-major: ok')
}
