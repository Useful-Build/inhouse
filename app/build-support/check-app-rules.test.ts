// scripts/check-app-rules.mjs rule 4 (no mock storage key, sample-data or mock-module reference in an E2E spec): each way
// of breaking it has a probe folder in scripts/check-app-rules-probes/, the script runs on that folder as its e2e/, and
// must fail on it. clean/ (the names in a comment, access through `fx`) and support-exempt/ (e2e/support/ may name them)
// must pass. The script runs on the app's real src/ (which lint keeps clean), so the e2e probe is the only difference.
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const SCRIPT = fileURLToPath(new URL('../scripts/check-app-rules.mjs', import.meta.url))
const PROBES = fileURLToPath(new URL('../scripts/check-app-rules-probes/', import.meta.url))
const SRC = fileURLToPath(new URL('../src/', import.meta.url))
const run = (probe: string) => spawnSync(process.execPath, [SCRIPT, SRC, join(PROBES, probe)], { encoding: 'utf8' })

describe('check-app-rules rule 4 fails on each probe', () => {
  const FAILS: [probe: string, mentions: string][] = [
    ['demo-key', 'inhouse.demo.v2'],
    ['ui-key', 'inhouse.ui.session.v1'],
    ['crash-key', 'inhouse.crash.last'],
    ['preload-key', 'inhouse.preload-reload'],
    ['theme-key', 'inhouse.theme'],
    ['sample-data-import', 'sample-data'],
    ['sample-alias', '@sample'],
    ['client-alias', '@client'],
    ['mock-module', 'agent/mock'],
    ['sample-reads', 'sample-reads'],
    // How rule 4 reads a file: a name is caught without the slash or with the extension after it, inside a longer string
    // (a `//` in a string opens no comment), and on the lines after a block comment (which keeps its line count).
    ['sample-data-no-slash', "agent/sample-data'"],
    ['mock-module-ext', 'agent/mock.ts'],
    ['name-in-string', "e2e/probe.spec.ts:2  export const note = 'saved under // inhouse.demo.v2 in the browser'"],
    ['after-block-comment', "e2e/probe.spec.ts:4  export const a = 'inhouse.demo.v2'"],
  ]
  for (const [probe, mentions] of FAILS) {
    it(probe, () => {
      const r = run(probe)
      expect(r.status).toBe(1)
      expect(r.stderr).toContain(mentions)
    })
  }
  it('after-block-comment: the code after a block comment that ends on its line is read too', () => {
    expect(run('after-block-comment').stderr).toContain("e2e/probe.spec.ts:5  export const b = 'inhouse.theme'")
  })
})

describe('check-app-rules rule 4 passes a clean input', () => {
  for (const probe of ['clean', 'support-exempt']) {
    it(probe, () => {
      const r = run(probe)
      expect(r.stderr).toBe('')
      expect(r.status).toBe(0)
    })
  }
})
