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
  ]
  for (const [probe, mentions] of FAILS) {
    it(probe, () => {
      const r = run(probe)
      expect(r.status).toBe(1)
      expect(r.stderr).toContain(mentions)
    })
  }
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
