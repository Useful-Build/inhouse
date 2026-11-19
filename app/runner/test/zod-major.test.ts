import { describe, expect, it } from 'vitest'
import { zodMajorProblem } from '../scripts/check-zod-major.mjs'

// The ways the check could fail to protect us, written before the check itself.
// The protocol schemas in app/shared/protocol/ are bundled into the runner with the runner's own zod, and parsed by the
// Worker with the app's zod. Two majors would mean two schema dialects on one wire.
const pkg = (zod?: string, where: 'dependencies' | 'devDependencies' = 'dependencies') =>
  zod === undefined ? {} : { [where]: { zod } }

describe('zodMajorProblem', () => {
  it('passes when both pin the same major', () => {
    expect(zodMajorProblem(pkg('^4.1.0'), pkg('^4.6.7'))).toBeNull()
    expect(zodMajorProblem(pkg('~4.0.0'), pkg('4.6.7'))).toBeNull()
  })

  it('fails when the majors differ', () => {
    expect(zodMajorProblem(pkg('^3.25.0'), pkg('^4.6.7'))).toMatch(/major/)
  })

  it('fails when the runner has no zod', () => {
    expect(zodMajorProblem(pkg('^4.6.7'), pkg())).toMatch(/runner/)
  })

  it('passes while the app has no zod yet, and says so', () => {
    expect(zodMajorProblem(pkg(), pkg('^4.6.7'))).toBeNull()
  })

  it('reads devDependencies too', () => {
    expect(zodMajorProblem(pkg('^3.0.0', 'devDependencies'), pkg('^4.6.7'))).toMatch(/major/)
  })

  it('fails on a range it cannot read a major from', () => {
    expect(zodMajorProblem(pkg('*'), pkg('^4.6.7'))).toMatch(/read/)
    expect(zodMajorProblem(pkg('^4.6.7'), pkg('latest'))).toMatch(/read/)
    expect(zodMajorProblem(pkg('>=3'), pkg('^4.6.7'))).toMatch(/read/)
  })
})
