import { expect, test } from '@playwright/test'
import { actor, call } from './kit.ts'

test("the team window list returns open, done, declined and withdrawn requests with the reader's permissions", async ({ request }) => {
  const member = actor('memberA')
  const inhouse = actor('inhouse')
  const prefix = `E2E team window ${crypto.randomUUID()}`
  const ids: string[] = []
  const pending = new Set<string>()
  try {
    for (const status of ['done', 'declined', 'withdrawn', 'open'] as const) {
      const filed = await call(request, member, 'POST', '/api/team-requests', { json: { kind: 'job', text: `${prefix} ${status}` } })
      expect(filed.status, filed.text).toBe(201)
      const { id, rev } = filed.json
      ids.push(id)
      pending.add(id)
      if (status === 'open') continue
      const changed = status === 'withdrawn'
        ? await call(request, member, 'PUT', `/api/team-requests/${id}/withdrawn`, { json: { ifRev: rev } })
        : await call(request, inhouse, 'PUT', `/api/team-requests/${id}/status`, { json: { status, ifRev: rev } })
      expect(changed.status, changed.text).toBe(200)
      pending.delete(id)
    }
    for (const who of [member, actor('memberB'), actor('admin'), inhouse]) {
      const list = await call(request, who, 'GET', '/api/team-requests?view=window')
      expect(list.status, list.text).toBe(200)
      const items = list.json.items as { id: string; status: string; mine: boolean; requestedBy?: string }[]
      expect(ids.map(id => items.find(item => item.id === id)?.status)).toEqual(['done', 'declined', 'withdrawn', 'open'])
      for (const item of items.filter(item => ids.includes(item.id))) {
        expect(item.mine).toBe(who === member)
        if (who === inhouse) expect(item).not.toHaveProperty('requestedBy')
      }
    }
    const open = await call(request, member, 'GET', '/api/team-requests?status=open')
    expect(open.status, open.text).toBe(200)
    expect(open.json.items.filter((item: { id: string }) => ids.includes(item.id)).map((item: { id: string }) => item.id)).toEqual([ids[3]])
  } finally {
    // An interrupted assertion can leave a fixture open. Release only the open slots this test took.
    for (const id of pending) {
      const r = await call(request, member, 'PUT', `/api/team-requests/${id}/withdrawn`, { json: { ifRev: 1 } })
      expect([200, 409], r.text).toContain(r.status)
    }
  }
})
