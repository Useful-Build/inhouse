// Routes 19 and 20 (p2-design section 8): the audit log, read in keyset pages newest first, and its CSV export. Each
// line names its actor by their current name and says what happened through app/shared/audit-text.ts, the same text
// the page and the CSV show. Reading first writes any grant expiry not yet logged (section 9: the first request or audit
// read that sees it), so the log a reader sees is complete up to now.
import { auditText } from '../../shared/audit-text.ts'
import type { AuditLine } from '../../shared/contract/audit.ts'
import { AUDIT_CSV_HEADER, csvRow } from '../../shared/csv.ts'
import { apiError, apiJson } from '../http.ts'
import { encodeCursor, readPage, readQuery, storesOf } from '../db/handler-kit.ts'
import type { ApiCtx } from '../db/handler-kit.ts'
import type { StoredLine } from '../db/audit-read.ts'
import type { Stores } from '../db/stores.ts'
import { z } from 'zod'

const instant = (ms: number) => ({ iso: new Date(ms).toISOString(), ms })

const toLine = (l: StoredLine, names: Record<string, string>): AuditLine => ({
  id: l.id, at: instant(l.atMs), actorId: l.actorId, who: l.who, ...auditText(l.args, id => names[id] ?? null),
})

const logExpiries = (c: ApiCtx, stores: Stores) => stores.grants.logExpiries({ nowMs: c.nowMs, requestId: c.requestId })

/** Route 19, `GET /api/audit?cursor&limit`: `{ items: AuditLine[], nextCursor }`, newest first. */
export async function readAudit(c: ApiCtx): Promise<Response> {
  const page = readPage(c.request)
  if ('error' in page) return page.error
  let beforeId: number | null = null
  if (page.ok.after !== null) {
    if (!/^[1-9]\d{0,15}$/.test(page.ok.after)) return apiError('invalid')
    beforeId = Number(page.ok.after)
  }
  const stores = storesOf(c)
  if (beforeId === null) await logExpiries(c, stores)
  const { lines, names, lastId } = await stores.audit.page({ limit: page.ok.limit, beforeId })
  return apiJson({ items: lines.map(l => toLine(l, names)), nextCursor: lastId === null ? null : encodeCursor(String(lastId)) })
}

/** Lines per page while the export streams. */
const EXPORT_PAGE = 200

/**
 * Route 20, `GET /api/audit/export.csv`: every line, newest first, as CSV, streamed page by page. The first page is read
 * before the answer starts, so a D1 failure is a 503 and not a cut-off file; the pages follow the log as it was when the
 * export began (ids below the first line's).
 */
export async function exportAudit(c: ApiCtx): Promise<Response> {
  const query = readQuery(c.request, z.object({}).strict())
  if ('error' in query) return query.error
  const stores = storesOf(c)
  await logExpiries(c, stores)
  let next: Awaited<ReturnType<Stores['audit']['page']>> | null = await stores.audit.page({ limit: EXPORT_PAGE, beforeId: null })
  const encoder = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(csvRow(AUDIT_CSV_HEADER)))
    },
    async pull(controller) {
      if (!next) return controller.close()
      const { lines, names, lastId } = next
      controller.enqueue(encoder.encode(lines.map(l => {
        const line = toLine(l, names)
        return csvRow([line.at.iso, line.who, line.what, line.detail])
      }).join('')))
      next = lastId === null ? null : await stores.audit.page({ limit: EXPORT_PAGE, beforeId: lastId })
    },
  })
  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="inhouse-audit-log.csv"',
      'X-Content-Type-Options': 'nosniff',
    },
  })
}
