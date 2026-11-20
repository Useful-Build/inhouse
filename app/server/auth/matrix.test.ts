// The matrix types' own invariant: every CanKey maps to exactly one row. Against a fixture matrix here; PR 2 adds the
// checkAccess and canFor properties, and the same check on the committed rows once PR0b fills them.
import { describe, expect, it } from 'vitest'
import { CanKeySchema } from '../../shared/contract/me.ts'
import { canRowsProblems } from './matrix.ts'
import type { AccessRow, CanRows } from './matrix.ts'

const rows: AccessRow[] = [
  { method: 'POST', pattern: '/api/members/invites', class: 'brand_data', allow: ['admin'] },
  { method: 'PUT', pattern: '/api/members/:id/role', class: 'brand_data', allow: ['admin'] },
  { method: 'DELETE', pattern: '/api/members/:id', class: 'brand_data', allow: ['admin'] },
  { method: 'PUT', pattern: '/api/settings/brand/:key', class: 'baseline', allow: ['admin'] },
  { method: 'PUT', pattern: '/api/settings/technical/:key', class: 'technical', allow: ['inhouse', 'admin'], adminWrite: true },
  { method: 'POST', pattern: '/api/grants', class: 'baseline', allow: ['admin'] },
  { method: 'GET', pattern: '/api/members', class: 'brand_data', allow: ['member', 'admin', 'inhouse'] },
  { method: 'GET', pattern: '/api/audit', class: 'brand_data', allow: ['member', 'admin', 'inhouse'] },
  { method: 'GET', pattern: '/api/audit/export.csv', class: 'brand_data', allow: ['member', 'admin', 'inhouse'] },
]
const canRows: CanRows = {
  invite: { method: 'POST', pattern: '/api/members/invites' },
  changeRole: { method: 'PUT', pattern: '/api/members/:id/role' },
  remove: { method: 'DELETE', pattern: '/api/members/:id' },
  editBrandSettings: { method: 'PUT', pattern: '/api/settings/brand/:key' },
  editTechnical: { method: 'PUT', pattern: '/api/settings/technical/:key' },
  switchModelOff: { method: 'PUT', pattern: '/api/settings/technical/:key', as: 'adminWrite' },
  grantSupport: { method: 'POST', pattern: '/api/grants' },
  viewMembers: { method: 'GET', pattern: '/api/members' },
  viewAudit: { method: 'GET', pattern: '/api/audit' },
  exportAudit: { method: 'GET', pattern: '/api/audit/export.csv' },
}

describe('every CanKey maps to exactly one row', () => {
  it('holds on the fixture matrix, which names every CanKey', () => {
    expect(Object.keys(canRows).sort()).toEqual([...CanKeySchema.options].sort())
    expect(canRowsProblems(rows, canRows)).toEqual([])
  })
  it('fails on a missing row', () => {
    expect(canRowsProblems(rows.filter(r => r.pattern !== '/api/grants'), canRows)).toEqual(['grantSupport → POST /api/grants matches 0 rows'])
  })
  it('fails on a doubled row', () => {
    expect(canRowsProblems([...rows, rows[0]], canRows)).toEqual(['invite → POST /api/members/invites matches 2 rows'])
  })
})
