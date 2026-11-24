// The person-deletion rules for every registered store (P8 C1's first PR: P3 and P4's stores). Ways it can fail,
// written down first:
//  1. a store's person key (a column, a JSON path, a Durable Object path) is neither deleted nor named as kept, so a
//     person's data stays with no stated reason (the BrandAgent's seven paths, memories' two columns);
//  2. a rule deletes or keeps a person key the store doesn't have (a typo that acts on nothing);
//  3. a D1 rule or person key names a column the migrated table doesn't have;
//  4. a rule its store's class doesn't allow (the audit log or its copy anything but kept);
//  5. a custom rule no runner serves (or the BrandAgent part with no personData) is planned anyway, so a deletion would
//     run half way: one store's rows gone, another's left;
//  6. a derived index is acted on as a store, or a derived rule hides a store that isn't derived;
//  7. a keep rule claims `clearedByPseudonymise` for a column memberStore.pseudonymise() never clears (so failure 1's
//     check passes on a claim, and the person's id stays), or pseudonymise clears another person's link with theirs.
import { env } from 'cloudflare:workers'
import { beforeAll, describe, expect, it } from 'vitest'
import { openStores } from '../../server/db/stores.ts'
import { seedBrand } from '../../server/seed/seed.ts'
import type { Seeded } from '../../server/seed/seed.ts'
import { coreTables } from '../tables/core.ts'
import { tables } from '../tables/index.ts'
import { p8Tables } from '../tables/p8.ts'
import type { TableEntry } from '../tables/types.ts'
import { planPersonDeletion } from './person.ts'
import type { DeletionDeps } from './person.ts'
import { ALLOWED, deletionRules } from './rules.ts'
import type { DeletionRule } from './rules.ts'
import { addPerson, snapshotAll, token } from './test-support.ts'

const db = env.DB
const bucket = env.FILES as R2Bucket
const BASE = 1_800_000_000_000
const entry = (name: string): TableEntry => {
  const e = tables.find(t => t.name === name)
  if (!e) throw new Error(`no registry entry ${name}`)
  return e
}
const deps = (over: Partial<DeletionDeps> = {}): DeletionDeps => ({ db, bucket, at: { actorId: 'm_system', requestId: `req-${token()}`, nowMs: BASE }, clock: () => BASE, ...over })
let seeded: Seeded

beforeAll(async () => {
  seeded = await seedBrand(db, openStores(env), BASE)
})

/** The oracle: which of the entry's person keys a rule acts on, read from the rule's own shape. */
const acted = (e: TableEntry, r: DeletionRule): readonly string[] => {
  switch (r.action) {
    case 'pseudonymise': return ['id']
    case 'delete_rows': return [r.column]
    case 'delete_objects': return e.personKeys
    case 'custom': return r.deletes
    case 'keep': return r.clearedByPseudonymise ?? []
    case 'derived': return []
  }
}
const keptOf = (r: DeletionRule): readonly string[] => ('kept' in r && r.kept ? r.kept : [])

describe('the rules (failures 1 to 4)', () => {
  it('accounts for every person key of every registered store: deleted or kept, never both, never one it lacks', () => {
    const gaps: string[] = []
    for (const e of tables) {
      const r = deletionRules[e.name]
      if (!r) {
        gaps.push(`${e.name}: no rule`)
        continue
      }
      const del = acted(e, r)
      const kept = keptOf(r)
      for (const k of e.personKeys) if (!del.includes(k) && !kept.includes(k)) gaps.push(`${e.name}: ${k} neither deleted nor kept`)
      for (const k of [...del, ...kept]) if (!e.personKeys.includes(k)) gaps.push(`${e.name}: ${k} isn't one of its person keys`)
      for (const k of del) if (kept.includes(k)) gaps.push(`${e.name}: ${k} both deleted and kept`)
    }
    expect(gaps).toEqual([])
  })

  it('accounts for the BrandAgent\'s seven person-key paths and both of memories\' person columns', () => {
    const agent = deletionRules.BrandAgent
    expect(agent.action).toBe('custom')
    expect([...acted(entry('BrandAgent'), agent), ...keptOf(agent)].sort()).toEqual([...entry('BrandAgent').personKeys].sort())
    expect(entry('BrandAgent').personKeys).toHaveLength(7)
    expect(deletionRules.memories).toEqual(expect.objectContaining({ action: 'delete_rows', column: 'owner_id', kept: ['created_by'] }))
  })

  it('names only columns the migrated D1 tables have', async () => {
    const missing: string[] = []
    for (const e of tables.filter(t => t.kind === 'd1')) {
      const columns = (await db.prepare(`PRAGMA table_info("${e.name}")`).all<{ name: string }>()).results.map(c => c.name)
      if (columns.length === 0) {
        missing.push(`${e.name}: no such table`)
        continue
      }
      const r = deletionRules[e.name]
      const named = [...e.personKeys, ...(r ? [...acted(e, r), ...keptOf(r)] : []), ...(r?.action === 'delete_rows' ? [r.column] : [])]
      for (const k of named) {
        const column = k.split(':')[0]
        if (!columns.includes(column)) missing.push(`${e.name}.${column}`)
      }
    }
    expect(missing).toEqual([])
  })

  it('gives every store a rule its class allows, keeps every audit store and pseudonymises the member row', () => {
    const wrong = tables.filter(e => !deletionRules[e.name] || !ALLOWED[e.retention].includes(deletionRules[e.name].action)).map(e => e.name)
    expect(wrong).toEqual([])
    // `account` now allows keep (the bill keeps its pseudonymous ids), so the member row's own rule is pinned here.
    expect(deletionRules.members.action).toBe('pseudonymise')
    for (const e of tables.filter(t => t.retention === 'audit')) expect(deletionRules[e.name].action, e.name).toBe('keep')
  })

  it('gives a derived rule to exactly the derived indexes', () => {
    for (const e of tables) expect(deletionRules[e.name].action === 'derived', e.name).toBe(e.derived !== undefined)
  })
})

describe('the run refuses what it can\'t finish (failures 5 and 6)', () => {
  // C1's jobs PR built the runners: a custom rule with no runner, or the BrandAgent part with no personData, still refuses.
  it('refuses to plan a custom rule no runner serves, or the BrandAgent part without personData, naming it, and writes nothing', async () => {
    const before = await snapshotAll(db, bucket)
    const later = { action: 'custom' as const, deletes: ['actor_id', 'subject_id'], why: 'a later store' }
    await expect(planPersonDeletion(deps({ registry: [...coreTables, ...p8Tables, entry('activity_lines')], rules: { ...deletionRules, activity_lines: later } }), { memberId: seeded.members.dana })).rejects.toThrow("activity_lines's rule is custom, and no runner serves it")
    await expect(planPersonDeletion(deps({ registry: [...coreTables, ...p8Tables, entry('BrandAgent')] }), { memberId: seeded.members.dana })).rejects.toThrow(/needs deps\.brandAgent/)
    expect(await snapshotAll(db, bucket)).toEqual(before)
  })

  it('skips a derived index, and refuses a derived rule on a store that isn\'t derived or a derived index without one', async () => {
    const registry = [...coreTables, ...p8Tables, entry('memories_fts'), entry('chat_messages_fts')]
    const r = await planPersonDeletion(deps({ registry }), { memberId: seeded.members.dana })
    if (!('ok' in r)) throw new Error(`plan refused: ${r.refused}`)
    expect(Object.keys(r.ok.counts).sort()).toEqual(['members', 'photos/', 'settings'])
    await expect(planPersonDeletion(deps({ registry, rules: { ...deletionRules, memories_fts: { action: 'keep', why: 'x' } } }), { memberId: seeded.members.dana })).rejects.toThrow(/memories_fts is derived/)
    await expect(planPersonDeletion(deps({ registry: [...coreTables, ...p8Tables], rules: { ...deletionRules, support_grants: { action: 'derived', why: 'x' } } }), { memberId: seeded.members.dana })).rejects.toThrow(/support_grants/)
  })
})

/**
 * Per keep rule that claims `clearedByPseudonymise`: a row naming `memberId` in every claimed column and `other` in none,
 * and how to read it back. A new claim needs a fixture here, so the test below runs pseudonymise over it.
 */
const CLEARED_FIXTURES: Record<string, (memberId: string) => { insert: D1PreparedStatement; read: D1PreparedStatement }> = {
  brand_skills: memberId => {
    const id = `bs_${token()}`
    return {
      insert: db.prepare("INSERT INTO brand_skills (id, name, description, body, created_by, created_at_ms, updated_by, updated_at_ms) VALUES (?, ?, 'd', 'b', ?, 1, ?, 1)").bind(id, `skill-${token()}`, memberId, memberId),
      read: db.prepare('SELECT * FROM brand_skills WHERE id = ?').bind(id),
    }
  },
}

describe('what pseudonymise clears (failure 7)', () => {
  it('clears every column a keep rule claims, for the person alone', async () => {
    const claims = Object.entries(deletionRules).flatMap(([store, r]) => (r.action === 'keep' && r.clearedByPseudonymise ? [[store, r.clearedByPseudonymise] as const] : []))
    expect(claims.map(([store]) => store).sort()).toEqual(Object.keys(CLEARED_FIXTURES).sort())
    const gone = await addPerson(db, { role: 'member', status: 'active' }, seeded.members.admin, BASE)
    const stays = await addPerson(db, { role: 'member', status: 'active' }, seeded.members.admin, BASE)
    const rows = claims.map(([store, cols]) => ({ store, cols, mine: CLEARED_FIXTURES[store](gone.id), theirs: CLEARED_FIXTURES[store](stays.id) }))
    await db.batch(rows.flatMap(r => [r.mine.insert, r.theirs.insert]))
    const done = await openStores(env).members.pseudonymise(gone.id, { actorId: seeded.members.admin, requestId: `req-${token()}`, nowMs: BASE })
    expect(done).toMatchObject({ ok: { id: gone.id } })
    for (const r of rows) {
      const mine = await r.mine.read.first<Record<string, unknown>>()
      const theirs = await r.theirs.read.first<Record<string, unknown>>()
      for (const col of r.cols) {
        expect(mine?.[col], `${r.store}.${col}`).toBeNull()
        expect(theirs?.[col], `${r.store}.${col} (another person's)`).toBe(stays.id)
      }
    }
  })
})
