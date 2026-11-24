// Route 95, `GET /api/data-access/export` (P8a D): Data and access's "Export everything". The brand's export for the
// caller (ops/export/export.ts, `brandForCaller` scope: the brand's shared data and the caller's own, never another
// person's personal rows; a header line naming every store and how much of it is included) as one NDJSON download,
// streamed as it's read. Admins, and the Inhouse team under a live grant (api.ts writes their support.access line
// first). The plan is made before the answer starts, so a storage failure is a 503 and not a cut-off file, and a brand
// too big for one request is a 409 `too_large`, with no `data.exported` line; the store writes that line (counts only)
// before the stream is handed back.
//
// Route 96, `GET /api/data-access/export/check`: the same plan, answered as its size or the same refusal, writing
// nothing of its own. The page asks it first, so a refusal shows in the app rather than as a JSON page.
//
// The retention row on the same page needs no route of its own: `d:chats` and `d:steps` are technical settings (routes
// 11 and 12), and the next cleanup is shared/contract/data-access.ts `nextCleanupMs`.
import { z } from 'zod'
import { dataExportFileName } from '../../shared/contract/data-access.ts'
import { DataExportCheckSchema } from '../../shared/contract/data-access-check.ts'
import { apiError, apiJson } from '../http.ts'
import { readQuery, storesOf, writer } from '../db/handler-kit.ts'
import type { ApiCtx } from '../db/handler-kit.ts'
import type { ExportCaller } from '../../ops/export/export.ts'

/** Who's asking: a person (an Admin) or the Inhouse team. The matrix rows (95, 96) let no service through. */
function callerOf(c: ApiCtx): ExportCaller {
  const p = c.principal
  if (p.kind === 'service') throw new Error('data export: a service reached a route its matrix row refuses')
  return { kind: p.kind, memberId: p.memberId }
}

const TOO_LARGE = () => apiError('conflict', { reason: 'too_large' })

export async function checkExport(c: ApiCtx): Promise<Response> {
  const query = readQuery(c.request, z.object({}).strict())
  if ('error' in query) return query.error
  const size = await storesOf(c).dataExport.check(writer(c), callerOf(c))
  if ('refused' in size) return TOO_LARGE()
  return apiJson(DataExportCheckSchema.parse(size))
}

export async function exportEverything(c: ApiCtx): Promise<Response> {
  const query = readQuery(c.request, z.object({}).strict())
  if ('error' in query) return query.error
  const exported = await storesOf(c).dataExport.brand(writer(c), callerOf(c))
  if ('refused' in exported) return TOO_LARGE()
  return new Response(exported.stream, {
    status: 200,
    headers: {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Content-Disposition': `attachment; filename="${dataExportFileName(c.nowMs)}"`,
      'X-Content-Type-Options': 'nosniff',
    },
  })
}
