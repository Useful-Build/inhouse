// The BrandAgent storage functions' schema pin (P8 C1). Way it can fail, written down first: P3 renames or drops a
// table or column these functions read, and retention silently counts or deletes nothing there.
import { runInDurableObject } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { token } from '../../delete/test-support.ts'
import { USED_COLUMNS, missingColumns } from './brand-agent-storage.ts'

describe('the BrandAgent storage functions', () => {
  it('fails by name when a BrandAgent table or column these functions use is missing', async () => {
    const stub = env.BRAND_AGENT.get(env.BRAND_AGENT.idFromName(`pin-${token()}`))
    await runInDurableObject(stub, async (_obj, state) => {
      await state.storage.deleteAlarm()
      // The real object's schema has every one.
      expect(missingColumns(state.storage.sql)).toEqual([])
      // The check itself, on a renamed column: it names the table and column.
      state.storage.sql.exec('ALTER TABLE runs RENAME COLUMN ended_at_ms TO finished_at_ms')
      expect(missingColumns(state.storage.sql)).toEqual(['runs.ended_at_ms'])
    })
    expect(Object.keys(USED_COLUMNS)).toContain('turn_rows')
  })
})
