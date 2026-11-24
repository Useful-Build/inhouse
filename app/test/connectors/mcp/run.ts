// Runs the nightly cases and says what failed, by name. Shared by `slack.live.ts` (the nightly and the orchestrator's live
// check) and by run.test.ts (hand-made hubs). Prints case names and fixed reasons only: never a token, a body or workspace data.
import type { NightlyCase } from './cases'

export async function runCases(cases: readonly NightlyCase[], opts: { house: boolean; print?: (line: string) => void }): Promise<{ failures: string[] }> {
  const print = opts.print ?? ((line: string) => console.log(line))
  const failures: string[] = []
  for (const c of cases) {
    if (c.houseOnly && !opts.house) {
      print(`SKIP ${c.name} (house deployment only)`)
      continue
    }
    if (c.skip !== undefined) {
      print(`SKIP ${c.name} (${c.skip})`)
      continue
    }
    let why: string | null
    try {
      why = await c.run()
    } catch (e) {
      // The error's name only: its text could carry a body.
      why = `threw ${e instanceof Error ? e.name : 'an error'}`
    }
    if (why === null) print(`ok   ${c.name}`)
    else {
      print(`FAIL ${c.name}: ${why}`)
      failures.push(`${c.name}: ${why}`)
    }
  }
  return { failures }
}
