// The route list: access-matrix.ts and routes.ts agree, and every row has a case in the matrix spec (cases.ts). A new
// route, row or case that doesn't line up fails here, before the matrix spec can quietly skip it.
import { expect, test } from '@playwright/test'
import { CASES } from './cases.ts'
import { matrixRows, rowKey, routeList } from './kit.ts'

test('every route has exactly one matrix row, and every row a route', () => {
  const routes = routeList().map(([method, pattern]) => rowKey({ method, pattern }))
  const rows = matrixRows().map(rowKey)
  expect(new Set(routes).size, 'a route is listed twice').toBe(routes.length)
  expect(new Set(rows).size, 'a row is listed twice').toBe(rows.length)
  expect(routes.filter(r => !rows.includes(r)), 'routes with no row').toEqual([])
  expect(rows.filter(r => !routes.includes(r)), 'rows with no route').toEqual([])
})

test('every row has a case in the matrix spec, and every case a row', () => {
  const rows = matrixRows().map(rowKey)
  const cases = Object.keys(CASES)
  expect(rows.filter(r => !cases.includes(r)), 'rows with no case in cases.ts').toEqual([])
  expect(cases.filter(c => !rows.includes(c)), 'cases with no row').toEqual([])
})

test('the matrix keeps the design\'s invariants over every row', () => {
  for (const row of matrixRows()) {
    const where = rowKey(row)
    if (row.class === 'technical') expect(row.allow, `${where}: Inhouse writes and reads technical`).toContain('inhouse')
    if (row.class === 'personal') expect(row.allow, `${where}: personal is never Inhouse`).not.toContain('inhouse')
    if (row.method !== 'GET' && ['brand_data', 'baseline', 'personal'].includes(row.class)) expect(row.allow, `${where}: Inhouse never writes`).not.toContain('inhouse')
    if (row.services.includes('monitor')) expect(row.class, `${where}: monitor is for open rows`).toBe('open')
    if (row.services.includes('smoke')) expect(row.method, `${where}: smoke only reads`).toBe('GET')
    if (row.adminWrite) expect(row.class).toBe('technical')
  }
})
