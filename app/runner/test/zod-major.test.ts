import { describe, expect, it } from 'vitest'
import { zodMajorProblem } from '../scripts/check-zod-major.mjs'

// The ways the check could fail to protect us, written before the check itself.
// The protocol schemas in app/shared/protocol/ are bundled into the runner with the runner's own zod, and parsed by the
// Worker with the app's zod. Two majors would mean two schema dialects on one wire.
type Field = 'dependencies' | 'devDependencies' | 'peerDependencies' | 'optionalDependencies'
const pkg = (zod?: string, where: Field = 'dependencies') => (zod === undefined ? {} : { [where]: { zod } })

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

  it('passes while the app has no zod yet', () => {
    expect(zodMajorProblem(pkg(), pkg('^4.6.7'))).toBeNull()
  })

  it('reads every dependency field, not only dependencies', () => {
    for (const field of ['devDependencies', 'peerDependencies', 'optionalDependencies'] as const) {
      expect(zodMajorProblem(pkg('^3.0.0', field), pkg('^4.6.7'))).toMatch(/major/)
    }
  })

  it('fails when one package pins two majors in different fields', () => {
    const app = { dependencies: { zod: '^4.6.7' }, peerDependencies: { zod: '^3.0.0' } }
    expect(zodMajorProblem(app, pkg('^4.6.7'))).toMatch(/major/)
  })

  it('reads the short range forms', () => {
    for (const range of ['^4', '~4.6', '4.x', '4', '4.6.7', '^4.6.7-beta.1']) {
      expect(zodMajorProblem(pkg(range), pkg('^4.6.7'))).toBeNull()
    }
  })

  it('fails on a range it cannot read a major from', () => {
    expect(zodMajorProblem(pkg('*'), pkg('^4.6.7'))).toMatch(/read/)
    expect(zodMajorProblem(pkg('^4.6.7'), pkg('latest'))).toMatch(/read/)
    expect(zodMajorProblem(pkg('>=3'), pkg('^4.6.7'))).toMatch(/read/)
    expect(zodMajorProblem(pkg('^4.6.7 || ^5'), pkg('^4.6.7'))).toMatch(/read/)
  })

  it('says what to write when it cannot read a range', () => {
    expect(zodMajorProblem(pkg('>=4 <5'), pkg('^4.6.7'))).toMatch(/\^X\.Y\.Z/)
  })
})
