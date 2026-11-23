// The retention rules and periods for every registered store (P8 C1's first PR: P3 and P4's stores). Ways it can fail,
// written down first:
//  1. a decided period drifts from Wasim's B9 decision (chats and steps 12 months, soft-deleted chats and Library trash
//     30 days, forgotten memories 30 days) or C1's constant (a pending upload 1 day);
//  2. a `retention_period` store has no rule or no group, so it has no period, or one nobody decided;
//  3. a rule ages rows by a column the table doesn't have, or follows a store that isn't registered;
//  4. a custom rule no job serves (or the BrandAgent's job outside the object) is planned anyway, so a store past
//     retention is skipped silently;
//  5. a derived index is aged as a store, or a derived rule hides a store that isn't derived.
import { env } from 'cloudflare:workers'
import { beforeAll, describe, expect, it } from 'vitest'
import { SYSTEM_MEMBER_ID } from '../../server/db/ids.ts'
import { openStores } from '../../server/db/stores.ts'
import { seedBrand } from '../../server/seed/seed.ts'
import { snapshotAll, token } from '../delete/test-support.ts'
import { coreTables } from '../tables/core.ts'
import { tables } from '../tables/index.ts'
import { p8Tables } from '../tables/p8.ts'
import type { TableEntry } from '../tables/types.ts'
import { planRetention } from './retention.ts'
import type { RetentionDeps } from './retention.ts'
import { DEFAULT_DAYS, periodsFor, retentionGroups, retentionRules } from './rules.ts'

const db = env.DB
const bucket = env.FILES as R2Bucket
const BASE = 1_800_000_000_000
const entry = (name: string): TableEntry => {
  const e = tables.find(t => t.name === name)
  if (!e) throw new Error(`no registry entry ${name}`)
  return e
}
const deps = (over: Partial<RetentionDeps> = {}): RetentionDeps => ({ db, bucket, at: { actorId: SYSTEM_MEMBER_ID, requestId: `req-${token()}`, nowMs: BASE }, clock: () => BASE, ...over })
const p2AndP8 = [...coreTables, ...p8Tables]

beforeAll(async () => {
  await seedBrand(db, openStores(env), BASE)
})

describe('the periods (failures 1 and 2)', () => {
  it('pins the decided periods: chats and steps 365 days, trash 30, a pending upload 1, a forgotten memory 30', () => {
    expect(DEFAULT_DAYS).toEqual({ chats: 365, steps: 365, trash: 30, pendingUpload: 1, forgottenMemory: 30, egress: 30 })
  })

  it('gives every retention_period store a rule, and every one that isn\'t derived a period from its group', () => {
    const stores = tables.filter(e => e.retention === 'retention_period')
    expect(stores.filter(e => !retentionRules[e.name]).map(e => e.name)).toEqual([])
    const periods = periodsFor(tables)
    expect(Object.keys(periods).sort()).toEqual(stores.filter(e => !e.derived).map(e => e.name).sort())
    for (const [store, days] of Object.entries(periods)) expect(days, store).toBe(DEFAULT_DAYS[retentionGroups[store]])
    // Only `chats` and `steps` follow a Data and access setting; the Library's period is the fixed trash period.
    expect(new Set(Object.values(retentionGroups))).toEqual(new Set(['chats', 'steps', 'trash', 'egress']))
    const later: TableEntry = { kind: 'd1', name: 'later_store', retention: 'retention_period', personKeys: [], export: false }
    expect(() => periodsFor([...tables, later])).toThrow(/later_store/)
  })

  it('gives a derived rule to exactly the derived retention_period indexes, and no group to any', () => {
    for (const e of tables.filter(t => t.retention === 'retention_period')) {
      expect(retentionRules[e.name].kind === 'derived', e.name).toBe(e.derived !== undefined)
      if (e.derived) expect(retentionGroups[e.name], e.name).toBeUndefined()
    }
  })
})

describe('the rules (failure 3)', () => {
  it('ages D1 rows only by columns the migrated tables have, and follows only registered stores', async () => {
    const columnsOf = async (table: string) => (await db.prepare(`PRAGMA table_info("${table}")`).all<{ name: string }>()).results.map(c => c.name)
    const missing: string[] = []
    for (const [store, rule] of Object.entries(retentionRules)) {
      const e = entry(store)
      const named: string[] = []
      if (rule.kind === 'd1') named.push(rule.ageColumn, rule.idColumn)
      if (rule.kind === 'custom') {
        if (rule.withParent !== undefined && !tables.some(t => t.name === rule.withParent)) missing.push(`${store}: follows unregistered ${rule.withParent}`)
        for (const age of rule.ages) {
          if (DEFAULT_DAYS[age.period] === undefined) missing.push(`${store}: period ${age.period}`)
          named.push(age.column)
        }
      }
      // The BrandAgent's tables live in its own SQLite: C1's storage functions pin those columns with their own test.
      if (e.kind !== 'd1') continue
      for (const n of named) {
        const [table, column] = n.includes('.') ? n.split('.') : [store, n]
        if (!(await columnsOf(table)).includes(column)) missing.push(`${store}: ${table}.${column}`)
      }
    }
    expect(missing).toEqual([])
  })
})

describe('what the plan refuses (failures 4 and 5)', () => {
  // C1's jobs PR built the jobs: a custom rule no job serves, or the BrandAgent's job outside the object, still refuses.
  it('refuses to plan a custom rule no job serves, or the BrandAgent\'s job outside the object, by name, and writes nothing', async () => {
    const before = await snapshotAll(db, bucket)
    const later = { kind: 'custom' as const, ages: [], why: 'a later store' }
    await expect(planRetention(deps({ registry: [...p2AndP8, entry('activity_lines')], rules: { ...retentionRules, activity_lines: later } }), { periods: { activity_lines: 365 } })).rejects.toThrow("activity_lines's rule is custom, and no job serves it")
    await expect(planRetention(deps({ registry: [...p2AndP8, entry('BrandAgent')] }), { periods: { BrandAgent: 365 } })).rejects.toThrow(/runs only inside the object/)
    await expect(planRetention(deps(), { periods: periodsFor(tables) })).rejects.toThrow(/runs only inside the object/)
    expect(await snapshotAll(db, bucket)).toEqual(before)
  })

  it('skips a derived index, and refuses a derived rule on a store that isn\'t derived or a derived index without one', async () => {
    const registry = [...p2AndP8, entry('chat_messages_fts')]
    const plan = await planRetention(deps({ registry }), { periods: {} })
    expect(plan.cutoffs).toEqual([])
    await expect(planRetention(deps({ registry, rules: { ...retentionRules, chat_messages_fts: { kind: 'd1', ageColumn: 'rowid', idColumn: 'rowid' } } }), { periods: {} })).rejects.toThrow(/chat_messages_fts is derived/)
    const fixture: TableEntry = { kind: 'd1', name: 'derived_fixture', retention: 'retention_period', personKeys: [], export: false }
    await expect(planRetention(deps({ registry: [...p2AndP8, fixture], rules: { derived_fixture: { kind: 'derived' } } }), { periods: { derived_fixture: 30 } })).rejects.toThrow(/derived_fixture isn't derived/)
  })

  it('plans the egress record at its fixed 30 days (P8a)', async () => {
    const plan = await planRetention(deps({ registry: [...p2AndP8, entry('egress_fetches')] }), { periods: periodsFor([entry('egress_fetches')]) })
    expect(plan.cutoffs.map(c => [c.store, c.cutoffMs])).toEqual([['egress_fetches', BASE - 30 * 86_400_000]])
  })

  it('plans the plain D1 stores (Activity, Today) on their own', async () => {
    const stores = ['activity_lines', 'today_items', 'today_aside']
    const plan = await planRetention(deps({ registry: [...p2AndP8, ...stores.map(entry)] }), { periods: periodsFor(stores.map(entry)) })
    expect(plan.cutoffs.map(c => c.store).sort()).toEqual([...stores].sort())
    for (const c of plan.cutoffs) expect(c.cutoffMs).toBe(BASE - DEFAULT_DAYS.steps * 86_400_000)
  })
})
