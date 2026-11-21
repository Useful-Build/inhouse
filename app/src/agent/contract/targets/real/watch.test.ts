import { describe, expect, it } from 'vitest'
import { WATCH_EXEMPT, WATCH_ONLY_ON_WATCH_BUILD, WATCH_READ_PATH, seedUnreadNotice, settleRuns, WATCH_SERVED, changeRoutineElsewhere, resetRoutines, watchRoute } from './watch'
import type { Signer } from './me'

describe('the real target\'s P4 parts', () => {
  it('serves exactly these methods besides the Library five (literal)', () => {
    expect([...WATCH_SERVED]).toEqual(['listNotifications', 'setAside'])
    expect(Object.keys(WATCH_EXEMPT)).toEqual(['markNoticesRead', 'deleteFiles', 'restoreFiles', 'runRoutine', 'deleteRoutine', 'restoreRoutine'])
    for (const why of Object.values(WATCH_EXEMPT)) expect(why.length).toBeGreaterThan(20)
    expect([...WATCH_ONLY_ON_WATCH_BUILD]).toEqual(['setAside'])
    for (const m of Object.keys(WATCH_EXEMPT)) expect(WATCH_SERVED as readonly string[], `${m} is not both served and exempt`).not.toContain(m)
  })
  it('reads each resource from the route the design numbers (literal)', () => {
    expect(WATCH_READ_PATH).toEqual({ routines: '/api/routines', activity: '/api/activity', notifications: '/api/notifications', library: '/api/library' })
  })
  it('sends each write to the route the design numbers (literal verbs and paths; ids are URL-encoded)', () => {
    expect(watchRoute('runRoutine', ['rt_a b'])).toEqual({ verbs: ['POST'], path: '/api/routines/rt_a%20b/run' })
    expect(watchRoute('deleteRoutine', ['routine-morning-check'])).toEqual({ verbs: ['POST'], path: '/api/routines/routine-morning-check/delete' })
    expect(watchRoute('restoreRoutine', ['routine-morning-check'])).toEqual({ verbs: ['POST'], path: '/api/routines/routine-morning-check/restore' })
    expect(watchRoute('setToggle', ['r:routine-morning-check', false])).toEqual({ verbs: ['PUT'], path: '/api/routines/routine-morning-check/enabled' })
    expect(watchRoute('markNoticesRead', [['n1']])).toEqual({ verbs: ['POST'], path: '/api/notifications/read' })
    expect(watchRoute('uploadFiles', [[]])).toEqual({ verbs: ['POST'], path: '/api/library/uploads' })
    expect(watchRoute('setAside', ['p_x', 'snoozed'])).toEqual({ verbs: ['PUT'], path: '/api/today/p_x/aside' })
    expect(watchRoute('deleteFiles', [['f']])).toEqual({ verbs: ['POST'], path: '/api/library/delete' })
    expect(watchRoute('restoreFiles', [['f']])).toEqual({ verbs: ['POST'], path: '/api/library/restore' })
  })
  it('leaves a setting\'s toggle and every other method to index.ts', () => {
    expect(watchRoute('setToggle', ['n:weekly', true])).toBeNull()
    expect(watchRoute('setSetting', ['k', 'v'])).toBeNull()
    expect(watchRoute('pause', [])).toBeNull()
  })

  const fake = (state: { routines: { id: string; rev: number }[]; deleted: { id: string; rev: number }[]; enabled: Record<string, boolean> }, fail?: string) => {
    const calls: string[] = []
    const s = {
      api: async (_who: string, method: string, path: string, body?: { ifRev: number; on?: boolean }) => {
        calls.push(`${method} ${path} ${JSON.stringify(body ?? null)}`)
        if (fail === path) return { status: 409, json: { error: { code: 'conflict' } } }
        if (path === '/api/routines') return { status: 200, json: structuredClone(state) }
        const m = /^\/api\/routines\/([^/]+)\/(restore|enabled)$/.exec(path)
        if (!m) throw new Error(`unexpected ${method} ${path}`)
        const id = m[1]!
        if (m[2] === 'restore') {
          const at = state.deleted.findIndex(r => r.id === id)
          expect(body?.ifRev, 'restores against the rev the list showed').toBe(state.deleted[at]!.rev)
          state.routines.push({ id, rev: state.deleted[at]!.rev + 1 })
          state.deleted.splice(at, 1)
        } else {
          state.enabled[id] = body!.on!
          state.routines.find(r => r.id === id)!.rev++
        }
        return { status: 200, json: {} }
      },
    } as unknown as Signer
    return { s, calls }
  }

  it('resets the routines: every deleted one is restored, every switched-off one switched on, in that order', async () => {
    const { s, calls } = fake({ routines: [{ id: 'a', rev: 3 }, { id: 'b', rev: 2 }], deleted: [{ id: 'c', rev: 5 }], enabled: { a: true, b: false, c: true } })
    await resetRoutines(s)
    expect(calls.filter(c => !c.startsWith('GET'))).toEqual([
      'POST /api/routines/c/restore {"ifRev":5}',
      'PUT /api/routines/b/enabled {"on":true,"ifRev":2}',
    ])
  })
  it('does nothing to routines that are already live and on', async () => {
    const { s, calls } = fake({ routines: [{ id: 'a', rev: 1 }], deleted: [], enabled: { a: true } })
    await resetRoutines(s)
    expect(calls.every(c => c.startsWith('GET'))).toBe(true)
  })
  it('takes a restore that finds the routine already restored (404) as done: another test file got there first', async () => {
    let listed = 0
    const s = { api: async (_w: string, method: string, path: string) => {
      if (path === '/api/routines') return { status: 200, json: ++listed === 1 ? { routines: [], deleted: [{ id: 'c', rev: 5 }], enabled: {} } : { routines: [{ id: 'c', rev: 6 }], deleted: [], enabled: { c: true } } }
      if (method === 'POST') return { status: 404, json: { error: { code: 'not_found' } } }
      throw new Error(`unexpected ${method} ${path}`)
    } } as unknown as Signer
    await resetRoutines(s)
  })
  it('fails loud, naming what is still wrong, when three passes leave a routine deleted', async () => {
    const s = { api: async (_w: string, _m: string, path: string) => (path === '/api/routines' ? { status: 200, json: { routines: [], deleted: [{ id: 'c', rev: 5 }], enabled: {} } } : { status: 409, json: { error: { code: 'conflict' } } }) } as unknown as Signer
    await expect(resetRoutines(s)).rejects.toThrow(/after 3 passes: deleted c/)
  })
  it('still fails loud on a refusal that is not a lost race', async () => {
    const s = { api: async (_w: string, _m: string, path: string) => (path === '/api/routines' ? { status: 200, json: { routines: [], deleted: [{ id: 'c', rev: 5 }], enabled: {} } } : { status: 500, json: { error: { code: 'unknown' } } }) } as unknown as Signer
    await expect(resetRoutines(s)).rejects.toThrow(/restore routine c.*500/)
  })

  it('changes a routine elsewhere so it ends as it was: delete then restore when live, restore then delete when deleted', async () => {
    const seen: string[] = []
    const other = { deleteRoutine: async (id: string) => { seen.push(`delete ${id}`) }, restoreRoutine: async (id: string) => { seen.push(`restore ${id}`) } }
    await changeRoutineElsewhere(other, 'r1')
    await changeRoutineElsewhere(other, 'r2', true)
    expect(seen).toEqual(['delete r1', 'restore r1', 'restore r2', 'delete r2'])
  })
})

describe('seeding an unread notice', () => {
  // Node's modules by name (this program has no Node types).
  const load = async <T>(name: string): Promise<T> => (await import(/* @vite-ignore */ name)) as T
  type Db = { exec(sql: string): void; prepare(sql: string): { all(...p: unknown[]): Record<string, unknown>[] }; close(): void }
  const make = async (files: Record<string, string>) => {
    const fs = await load<{ mkdtempSync(p: string): string; mkdirSync(p: string, o: { recursive: true }): void }>('node:fs')
    const os = await load<{ tmpdir(): string }>('node:os')
    const { DatabaseSync } = await load<{ DatabaseSync: new (f: string) => Db }>('node:sqlite')
    const dir = fs.mkdtempSync(`${os.tmpdir()}/w6-seed-`)
    fs.mkdirSync(`${dir}/v3/d1`, { recursive: true })
    for (const [name, sql] of Object.entries(files)) {
      const db = new DatabaseSync(`${dir}/v3/d1/${name}.sqlite`)
      db.exec(sql)
      db.close()
    }
    const rows = (name: string, q: string) => {
      const db = new DatabaseSync(`${dir}/v3/d1/${name}.sqlite`)
      try { return db.prepare(q).all() } finally { db.close() }
    }
    return { dir, rows }
  }
  const NOTICES = 'CREATE TABLE notices (id TEXT PRIMARY KEY, audience TEXT NOT NULL, audience_member_id TEXT, template TEXT NOT NULL, fields_json TEXT NOT NULL, body TEXT, icon TEXT NOT NULL, person_id TEXT, at_ms INTEGER NOT NULL, waiting INTEGER NOT NULL DEFAULT 0, link_json TEXT NOT NULL, source TEXT NOT NULL)'

  it('inserts one team notice with the morning check\'s template into the database that has the table, and leaves the others alone', async () => {
    const { dir, rows } = await make({ other: 'CREATE TABLE unrelated (x TEXT)', brand: NOTICES })
    const id = await seedUnreadNotice({ dir, now: 1234 })
    expect(rows('brand', 'SELECT * FROM notices')).toEqual([
      { id, audience: 'team', audience_member_id: null, template: 'morning_check_found', fields_json: '{"items":1}', body: null, icon: 'sun', person_id: null, at_ms: 1234, waiting: 0, link_json: '{"to":"page","page":"today"}', source: 'morning-check' },
    ])
    expect(rows('other', 'SELECT name FROM sqlite_master')).toEqual([{ name: 'unrelated' }])
  })
  it('gives each call its own id', async () => {
    const { dir } = await make({ brand: NOTICES })
    expect(new Set([await seedUnreadNotice({ dir }), await seedUnreadNotice({ dir })]).size).toBe(2)
  })
  it('fails loud when no database holds a notices table', async () => {
    const { dir } = await make({ other: 'CREATE TABLE unrelated (x TEXT)' })
    await expect(seedUnreadNotice({ dir })).rejects.toThrow(/no local D1 with a notices table/)
  })
})

describe('settling Run now', () => {
  const load = async <T>(name: string): Promise<T> => (await import(/* @vite-ignore */ name)) as T
  type Db = { exec(sql: string): void; close(): void }
  const make = async (rows: [string, string, string][]) => {
    const fs = await load<{ mkdtempSync(p: string): string; mkdirSync(p: string, o: { recursive: true }): void }>('node:fs')
    const os = await load<{ tmpdir(): string }>('node:os')
    const { DatabaseSync } = await load<{ DatabaseSync: new (f: string) => Db }>('node:sqlite')
    const dir = fs.mkdtempSync(`${os.tmpdir()}/w6-settle-`)
    fs.mkdirSync(`${dir}/v3/d1`, { recursive: true })
    const file = `${dir}/v3/d1/x.sqlite`
    const db = new DatabaseSync(file)
    db.exec('CREATE TABLE routine_slots (slot_key TEXT PRIMARY KEY, kind TEXT NOT NULL, state TEXT NOT NULL)')
    for (const [k, kind, state] of rows) db.exec(`INSERT INTO routine_slots VALUES ('${k}', '${kind}', '${state}')`)
    db.close()
    const set = (key: string, state: string) => { const d = new DatabaseSync(file); d.exec(`UPDATE routine_slots SET state = '${state}' WHERE slot_key = '${key}'`); d.close() }
    return { dir, set }
  }

  it('returns at once when no manual run is open (scheduled and ended ones do not count)', async () => {
    const { dir } = await make([['a', 'manual', 'ended'], ['b', 'scheduled', 'started'], ['c', 'manual', 'missed']])
    await settleRuns({ dir, sleep: async () => { throw new Error('should not wait') } })
  })
  it('waits while a manual run is claimed or started and returns when the last one ends', async () => {
    const { dir, set } = await make([['a', 'manual', 'claimed'], ['b', 'manual', 'started']])
    const slept: number[] = []
    await settleRuns({ dir, intervalMs: 5, sleep: async ms => { slept.push(ms); if (slept.length === 1) set('a', 'ended'); if (slept.length === 2) set('b', 'lost') } })
    expect(slept).toEqual([5, 5])
  })
  it('fails loud with the open slot keys once the deadline passes', async () => {
    const { dir } = await make([['now|rt|k1', 'manual', 'started']])
    let t = 0
    await expect(settleRuns({ dir, timeoutMs: 100, now: () => t, sleep: async () => { t += 60 } })).rejects.toThrow(/did not end before the deadline: now\|rt\|k1/)
  })
  it('fails loud when no database holds routine_slots', async () => {
    const { dir } = await make([])
    const fs = await load<{ rmSync(p: string, o: { recursive: true; force: true }): void }>('node:fs')
    fs.rmSync(`${dir}/v3`, { recursive: true, force: true })
    await expect(settleRuns({ dir })).rejects.toThrow()
  })
})

