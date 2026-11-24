// Route 95, `GET /api/data-access/export` (P8a D): Data and access's "Export everything". The brand's whole export
// (ops/export/export.ts, brand scope: every `export: true` store in the registry, a header line naming every store and
// whether it's included) as one NDJSON download, streamed as it's read. Admins, and the Inhouse team under a live grant
// (api.ts writes their support.access line first). The plan is made before the answer starts, so a storage failure is
// a 503 and not a cut-off file; the store writes the `data.exported` line (counts only) before the stream is handed
// back.
//
// The retention row on the same page needs no route of its own: `d:chats` and `d:steps` are technical settings (routes
// 11 and 12), and the next cleanup is shared/contract/data-access.ts `nextCleanupMs`.
import { z } from 'zod'
import { dataExportFileName } from '../../shared/contract/data-access.ts'
import { readQuery, storesOf, writer } from '../db/handler-kit.ts'
import type { ApiCtx } from '../db/handler-kit.ts'

export async function exportEverything(c: ApiCtx): Promise<Response> {
  const query = readQuery(c.request, z.object({}).strict())
  if ('error' in query) return query.error
  const exported = await storesOf(c).dataExport.brand(writer(c))
  return new Response(exported.stream, {
    status: 200,
    headers: {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Content-Disposition': `attachment; filename="${dataExportFileName(c.nowMs)}"`,
      'X-Content-Type-Options': 'nosniff',
    },
  })
}
