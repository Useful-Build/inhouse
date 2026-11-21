// Route 59 (P4 W4): `GET /api/activity?cursor&limit`, the Activity page's lines, newest first, rendered at read time from
// their template, fields and member ids (names from the members table; a former member reads "A former member").
// brand_data: members, Admins and the Inhouse team under a live grant (the matrix and the request path decide).
import { ActivityPageSchema } from '../../shared/contract/activity.ts'
import { apiError, apiJson } from '../http.ts'
import { encodeCursor, readPage, storesOf } from '../db/handler-kit.ts'
import type { ApiCtx } from '../db/handler-kit.ts'
import { renderLine } from '../activity/render.ts'

const KEY = /^(\d{1,16})\.(\d{1,16})$/

export async function listActivity(c: ApiCtx): Promise<Response> {
  const page = readPage(c.request)
  if ('error' in page) return page.error
  let before: { atMs: number; n: number } | null = null
  if (page.ok.after !== null) {
    const m = KEY.exec(page.ok.after)
    if (!m) return apiError('invalid')
    before = { atMs: Number(m[1]), n: Number(m[2]) }
  }
  const { rows, names, last } = await storesOf(c).activity.page({ limit: page.ok.limit, before })
  return apiJson(ActivityPageSchema.parse({
    items: rows.map(r => renderLine(r, names)),
    nextCursor: last === null ? null : encodeCursor(`${last.atMs}.${last.n}`),
  }))
}

