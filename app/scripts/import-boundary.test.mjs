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
      // P5 W4 (B2, 2026-11-21): the notifications tool's handler and its delivery types are off limits too.
      'server/egress/f.ts': "import { notificationSend } from '../mcp/tools/notifications/send.ts'\nexport const f = notificationSend\n",
      'server/egress/g.ts': "import { handlers } from '../mcp/tools/notifications/index.ts'\nexport const g = handlers\n",
      'server/egress/h.ts': "import type { PostNoticeRequest } from '../../hub/index/contract.ts'\nexport const h: PostNoticeRequest | null = null\n",
      // Review round 1: deliveryOf from deps.ts, and the folder itself (its index).
      'server/egress/i.ts': "import { deliveryOf } from '../mcp/tools/notifications/deps.ts'\nexport const i = deliveryOf\n",
      'server/egress/j.ts': "import { handlers } from '../mcp/tools/notifications'\nexport const j = handlers\n",
    })
    expect(r.status).toBe(1)
    const hits = lines(r.out)
    for (const file of ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts', 'f.ts', 'g.ts', 'h.ts', 'i.ts', 'j.ts']) expect(hits.some(l => l.includes(`/${file}:`)), file).toBe(true)
  })

  test("the egress may use the hub's ReadGateway types, and other folders aren't bound by the rule", () => {
    const r = lint({
      'server/egress/fine.ts': "import type { ReadGateway } from '../../hub/index/contract.ts'\nexport const f: ReadGateway | null = null\n",
      // P5 W4: the one allowed import from the notifications tool, its opaque deps factory.
      'server/egress/deps-ok.ts': "import { notifyDeps } from '../mcp/tools/notifications/deps.ts'\nexport const n = notifyDeps\n",
      'server/api/other.ts': "import { startConnect } from './connect.ts'\nimport type { ConnectGateway } from '../../hub/index/contract.ts'\nexport const o: [unknown, ConnectGateway | null] = [startConnect, null]\n",
    })
    expect(lines(r.out)).toEqual([])
    expect(r.status).toBe(0)
  })
})

// Stage 1 M2-B (N11, N13): the egress may never import the outbox's dispatcher, the only holder of the hub's write
// binding, nor the write entrypoint's types. Its request path (outbox/store.ts) stays open to it (M2-D wires it).
describe('the outbox dispatcher boundary', () => {
  test('the egress importing the dispatcher or the write types is an error', () => {
    const r = lint({
      'server/egress/k.ts': "import { sendAction } from '../outbox/dispatch.ts'\nexport const k = sendAction\n",
      'server/egress/deep/l.ts': "import { outboxSend } from '../../outbox/dispatch'\nexport const l = outboxSend\n",
      'server/egress/m.ts': "import type { WriteGateway } from '../../hub/index/contract.ts'\nexport const m: WriteGateway | null = null\n",
    })
    expect(r.status).toBe(1)
    const hits = lines(r.out)
    for (const file of ['k.ts', 'l.ts', 'm.ts']) expect(hits.some(l => l.includes(`/${file}:`)), file).toBe(true)
  })

  test("the egress may use the outbox's request path, and BrandAgent's tasks may import the dispatcher", () => {
    const r = lint({
      'server/egress/fine-outbox.ts': "import { openOutbox } from '../outbox/store.ts'\nexport const o = openOutbox\n",
      'server/do/brand-agent/tasks/x.ts': "import { outboxSend } from '../../../outbox/dispatch.ts'\nexport const x = outboxSend\n",
    })
    expect(lines(r.out)).toEqual([])
    expect(r.status).toBe(0)
  })
})
