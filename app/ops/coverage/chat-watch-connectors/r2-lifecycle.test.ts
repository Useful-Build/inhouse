// The R2 lifecycle proposal (P8 C1). Ways it can fail, written down first:
//  1. a registered prefix has no decision (a new store's objects with no rule and no stated reason);
//  2. a backup-class prefix doesn't expire at 30 days, or an audit-class one expires at all;
//  3. an expiry rule covers files/, sessions/ or library/ (an age rule there deletes a live chat's or file's bytes).
import { describe, expect, it } from 'vitest'
import { tables } from '../../tables/index.ts'
import { R2_LIFECYCLE_PROPOSAL, lifecycleConfig, registeredPrefixes } from './r2-lifecycle.ts'

describe('the R2 lifecycle proposal', () => {
  it('every registered R2 prefix has a lifecycle decision; backup-class prefixes expire at 30 days; audit-class never', () => {
    expect(R2_LIFECYCLE_PROPOSAL.map(d => d.prefix).sort()).toEqual([...registeredPrefixes()].sort())
    for (const e of tables.filter(t => t.kind === 'r2')) {
      const d = R2_LIFECYCLE_PROPOSAL.find(x => x.prefix === e.name)
      expect(d, e.name).toBeDefined()
      if (e.retention === 'backup') expect(d?.expireDays, e.name).toBe(30)
      if (e.retention === 'audit') expect(d?.expireDays, e.name).toBeNull()
      expect(d?.why.length, e.name).toBeGreaterThan(10)
    }
    const config = lifecycleConfig()
    expect(config.rules.find(r => r.conditions.prefix === 'backups/')).toMatchObject({ deleteObjectsTransition: { condition: { type: 'Age', maxAge: 30 * 86_400 } } })
  })

  it('no lifecycle rule covers files/, sessions/ or library/', () => {
    const deleting = lifecycleConfig().rules.filter(r => 'deleteObjectsTransition' in r)
    for (const prefix of ['files/', 'sessions/', 'library/']) {
      expect(deleting.filter(r => prefix.startsWith(r.conditions.prefix)).map(r => r.id), prefix).toEqual([])
    }
    // The bucket-wide rule only aborts incomplete multipart uploads.
    expect(lifecycleConfig().rules.filter(r => r.conditions.prefix === '')).toEqual([expect.objectContaining({ abortMultipartUploadsTransition: expect.anything() })])
    expect(lifecycleConfig().rules.filter(r => r.conditions.prefix === '').every(r => !('deleteObjectsTransition' in r))).toBe(true)
  })
})
