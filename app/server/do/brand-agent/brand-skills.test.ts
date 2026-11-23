// A turn's start carries the brand's own skills (P6a brand skills), read from D1 at each placement and never stored on
// the turn. Ways it could fail, written first: the start leaves them out, carries a stale set (read when the turn was
// built, not when it's placed), stores them in `start_json` (too big for a row at their cap), or sends an empty list
// instead of none.
import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { MEMBER, inAgent, settle } from '../../testing/brand-agent/core-harness.ts'
import { saveSkill } from '../../brand-skills/store.ts'

const db = env.DB
const NOW = 1_800_000_000_000
const save = async (name: string, body: string) => {
  const o = await saveSkill(db, { name, description: `Does ${name}.`, body }, { actorId: MEMBER, requestId: `req-ba-${name}-${body.length}`, nowMs: NOW })
  if (!('ok' in o)) throw new Error(JSON.stringify(o))
}

describe("the brand's skills on a turn's start", () => {
  it('none: no brandSkills field; some: exactly them, as they are at the placement, and never in start_json', () => inAgent(async h => {
    await db.prepare("INSERT INTO members (id, kind, role, status, name, created_at_ms) VALUES (?, 'person', 'member', 'active', 'Owner', 0) ON CONFLICT (id) DO NOTHING").bind(MEMBER).run()
    await db.prepare('DELETE FROM brand_skills').run()
    const starts = () => h.pool.calls.filter(c => c.method === 'place').map(c => c.args[0] as Record<string, unknown>)

    await h.submit('c1', 'key-bs001')
    await settle()
    expect(starts()[0]).not.toHaveProperty('brandSkills')

    await save('weekly-report', 'Read the orders.')
    await save('returns-check', 'Read the returns.')
    await h.submit('c2', 'key-bs002')
    await settle()
    expect(starts()[1]!.brandSkills).toEqual([
      { name: 'returns-check', description: 'Does returns-check.', body: 'Read the returns.' },
      { name: 'weekly-report', description: 'Does weekly-report.', body: 'Read the orders.' },
    ])
    const stored = h.sql.exec('SELECT start_json FROM turns').toArray().map(r => String(r.start_json))
    for (const s of stored) expect(s).not.toContain('Read the orders.')
    await db.prepare('DELETE FROM brand_skills').run()
  }))
})
