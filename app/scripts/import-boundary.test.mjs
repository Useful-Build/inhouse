// The P5 import boundary (p5-orchestrator.md section 2, approved as an orchestrator line in #251): app/server/egress/**
// may not import app/server/api/connect.ts, app/server/api/tools.ts, app/server/notify-slack/** or the hub's
// ConnectGateway or DeliveryGateway types. The rule is oxlint's `no-restricted-imports` in .oxlintrc.json, scoped to
// that folder by an override. This test runs the real config over a scratch tree laid out like app/: each forbidden
// import is reported, an allowed one (ReadGateway) isn't, and the same imports outside server/egress/ aren't.
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'

const app = fileURLToPath(new URL('..', import.meta.url))
const oxlint = join(app, 'node_modules', '.bin', 'oxlint')

/** Lays out `files` (relative paths under a scratch app/) beside a copy of the real config; returns oxlint's output. */
function lint(files) {
  const root = mkdtempSync(join(tmpdir(), 'import-boundary-'))
  const config = JSON.parse(readFileSync(join(app, '.oxlintrc.json'), 'utf8'))
  delete config.$schema
  writeFileSync(join(root, '.oxlintrc.json'), JSON.stringify(config))
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(root, path, '..'), { recursive: true })
    writeFileSync(join(root, path), text)
  }
  const r = spawnSync(oxlint, ['-c', '.oxlintrc.json', '--format', 'unix', 'server'], { cwd: root, encoding: 'utf8' })
  return { status: r.status, out: `${r.stdout}${r.stderr}` }
}

const lines = out => out.split('\n').filter(l => l.includes('no-restricted-imports'))

describe('the P5 import boundary', () => {
  test('each forbidden import from server/egress/ is an error', () => {
    const r = lint({
      'server/egress/a.ts': "import { startConnect } from '../api/connect.ts'\nexport const a = startConnect\n",
      'server/egress/b.ts': "import { listTools } from '../api/tools.ts'\nexport const b = listTools\n",
      'server/egress/c.ts': "import { postToSlack } from '../notify-slack/post.ts'\nexport const c = postToSlack\n",
      'server/egress/d.ts': "import type { ConnectGateway } from '../../hub/index/contract.ts'\nexport const d: ConnectGateway | null = null\n",
      'server/egress/deep/e.ts': "import type { DeliveryGateway } from '../../../hub/index/contract.ts'\nexport const e: DeliveryGateway | null = null\n",
    })
    expect(r.status).toBe(1)
    const hits = lines(r.out)
    for (const file of ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts']) expect(hits.some(l => l.includes(`/${file}:`)), file).toBe(true)
  })

  test("the egress may use the hub's ReadGateway types, and other folders aren't bound by the rule", () => {
    const r = lint({
      'server/egress/fine.ts': "import type { ReadGateway } from '../../hub/index/contract.ts'\nexport const f: ReadGateway | null = null\n",
      'server/api/other.ts': "import { startConnect } from './connect.ts'\nimport type { ConnectGateway } from '../../hub/index/contract.ts'\nexport const o: [unknown, ConnectGateway | null] = [startConnect, null]\n",
    })
    expect(lines(r.out)).toEqual([])
    expect(r.status).toBe(0)
  })
})
