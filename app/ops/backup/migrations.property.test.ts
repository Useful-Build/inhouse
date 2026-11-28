// The migration check between a backup and a restore target (#585), over random apply orders. Ways it can fail,
// written down first:
//  1. two databases holding the same migrations, applied in different orders, read as different (a good restore refused);
//  2. a migration missing on the target, or extra on it, reads as equal (a restore onto another schema accepted);
//  3. the refusal doesn't name exactly the missing and extra migrations;
//  4. a manifest whose list is unsorted, holds a name twice or disagrees with its `migration` parses.
import { fc, test } from '@fast-check/vitest'
import { describe, expect, it } from 'vitest'
import { BackupManifestSchema } from './manifest.ts'
import { migrationDiff, migrationMismatch, migrationSet } from './migrations.ts'

const nameArb = fc.tuple(fc.integer({ min: 0, max: 9999 }), fc.stringMatching(/^[a-z][a-z0-9_]{0,11}$/))
  .map(([n, slug]) => `${String(n).padStart(4, '0')}_${slug}.sql`)
const namesArb = fc.uniqueArray(nameArb, { minLength: 1, maxLength: 60 })
/** The names in some apply order: every order is one wrangler can record, given when each file merged. */
const applyOrder = (names: string[]) => fc.shuffledSubarray(names, { minLength: names.length, maxLength: names.length })
const sorted = (names: readonly string[]) => [...names].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
const manifest = (migrations: string[]) => ({ format: 1, backupId: 'b', takenAtMs: 0, migration: migrations.at(-1), migrations, tables: [], derived: [] })

describe('the same migrations in any apply order (failure 1)', () => {
  test.prop([namesArb.chain(names => fc.tuple(applyOrder(names), applyOrder(names)))], { numRuns: 300 })(
    'read as one set, and the restore check passes', ([source, target]) => {
      const backup = migrationSet(source)
      expect(backup).toEqual(sorted(source))
      expect(migrationSet(target)).toEqual(backup)
      expect(migrationMismatch(backup, migrationSet(target))).toBeNull()
      expect(BackupManifestSchema.parse(manifest(backup)).migration).toBe(backup.at(-1))
    },
  )

  it('0790 applied before 0780 on one side and in name order on the other', () => {
    const a = ['0770_outbox_batches.sql', '0790_connector_accounts_currency.sql', '0780_eval_write_log.sql']
    const b = ['0770_outbox_batches.sql', '0780_eval_write_log.sql', '0790_connector_accounts_currency.sql']
    expect(a.at(-1)).not.toBe(b.at(-1))
    expect(migrationMismatch(migrationSet(a), migrationSet(b))).toBeNull()
  })
})

describe('a migration missing or extra on the target (failures 2, 3)', () => {
  const caseArb = fc.uniqueArray(nameArb, { minLength: 2, maxLength: 60 }).chain(all => fc.record({
    // Each name is on both sides, the backup's only (missing on the target) or the target's only (extra on it).
    sides: fc.array(fc.constantFrom('both', 'backup', 'target'), { minLength: all.length, maxLength: all.length }),
    all: fc.constant(all),
  })).filter(c => c.sides.some(s => s !== 'both') && c.sides.some(s => s !== 'target'))

  test.prop([caseArb], { numRuns: 300 })('refuses, naming exactly the missing and extra ones', ({ all, sides }) => {
    const backup = all.filter((_, i) => sides[i] !== 'target')
    const target = all.filter((_, i) => sides[i] !== 'backup').reverse()
    const missing = sorted(all.filter((_, i) => sides[i] === 'backup'))
    const extra = sorted(all.filter((_, i) => sides[i] === 'target'))
    expect(migrationDiff(migrationSet(backup), migrationSet(target))).toEqual({ missing, extra })
    const reason = migrationMismatch(migrationSet(backup), migrationSet(target))
    expect(reason).not.toBeNull()
    const named = (label: string, names: string[]) => (names.length === 0 ? [] : [`${label} [${names.length <= 10 ? names.join(', ') : `${names.slice(0, 10).join(', ')} and ${names.length - 10} more`}]`])
    expect(reason).toBe([...named('missing on the target', missing), ...named('extra on the target', extra)].join('; '))
  })

  it('names one missing and one extra migration plainly', () => {
    const backup = ['0770_outbox_batches.sql', '0780_eval_write_log.sql']
    expect(migrationMismatch(backup, ['0770_outbox_batches.sql'])).toBe('missing on the target [0780_eval_write_log.sql]')
    expect(migrationMismatch(backup, [...backup, '0791_x.sql'])).toBe('extra on the target [0791_x.sql]')
    expect(migrationMismatch(backup, [])).toBe('missing on the target [0770_outbox_batches.sql, 0780_eval_write_log.sql]')
  })
})

describe('a malformed set (failure 4)', () => {
  test.prop([namesArb.filter(n => n.length > 1)], { numRuns: 100 })('d1_migrations naming one twice fails loud', names => {
    expect(() => migrationSet([...names, names[0]])).toThrow(`d1_migrations names ${names[0]} twice`)
  })
  test.prop([namesArb.filter(n => n.length > 1)], { numRuns: 100 })('a manifest list out of name order, or naming one twice, does not parse', names => {
    const set = migrationSet(names)
    expect(BackupManifestSchema.safeParse({ ...manifest(set), migrations: [...set].reverse() }).success).toBe(false)
    expect(BackupManifestSchema.safeParse({ ...manifest(set), migrations: [set[0], ...set] }).success).toBe(false)
  })
  test.prop([namesArb.filter(n => n.length > 1)], { numRuns: 100 })('a manifest whose migration is not the highest name does not parse', names => {
    const set = migrationSet(names)
    expect(BackupManifestSchema.safeParse({ ...manifest(set), migration: set[0] }).success).toBe(false)
  })
  it('a manifest taken before #585 (no list) still parses', () => {
    expect(BackupManifestSchema.parse({ ...manifest(['0001_a.sql']), migrations: undefined }).migrations).toBeUndefined()
  })
})
