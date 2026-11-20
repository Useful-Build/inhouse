import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const appDir = path.resolve(import.meta.dirname, '..')
const cli = (...args: string[]) =>
  spawnSync(process.execPath, ['evals/run.ts', ...args], { cwd: appDir, encoding: 'utf8', env: { PATH: process.env.PATH ?? '' } })

describe('the eval CLI', () => {
  it('the product target without --paid refuses (exit 2) and writes nothing', () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'evals-'))
    const r = cli('--target', 'product', '--out', out, '--budget', '2')
    expect(r.status).toBe(2)
    expect(r.stderr).toMatch(/--paid/)
    expect(fs.existsSync(path.join(out, 'report.json'))).toBe(false)
  })

  it('the product target without the eval-brand flag refuses even with --paid and a budget', () => {
    const r = cli('--target', 'product', '--out', fs.mkdtempSync(path.join(os.tmpdir(), 'evals-')), '--paid', '--budget', '2')
    expect(r.status).toBe(2)
    expect(r.stderr).toMatch(/INHOUSE_EVAL_BRAND/)
  })

  it('a fake-target dry run writes raw files, graded.json, report.json and README.md', () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'evals-'))
    const r = cli('--target', 'fake', '--out', out, '--reps', '1', '--cases', 'R01,T05,X01')
    expect(r.status).toBe(0)
    expect(fs.readdirSync(path.join(out, 'raw')).sort()).toEqual(['R01-r1-c1.json', 'T05-r1-c1.json', 'X01-r1-c1.json'])
    const report = JSON.parse(fs.readFileSync(path.join(out, 'report.json'), 'utf8'))
    expect(report.summary.all).toMatchObject({ runs: 3, pass: 2 })
    expect(JSON.parse(fs.readFileSync(path.join(out, 'graded.json'), 'utf8'))).toHaveLength(3)
    expect(fs.readFileSync(path.join(out, 'README.md'), 'utf8')).toMatch(/## Conclusion/)
  })
})
