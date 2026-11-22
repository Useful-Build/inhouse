// Route 94, `POST /api/ops/privacy-requests/:id/close` (P8a F2): the `release` service token only (class `open`, like
// revive): the runbook's step once the Inhouse team has answered a Shopify privacy request (sent the merchant what Inhouse
// holds, erased what it found, or recorded why nothing was held). Clears the Shopify ids the request named and writes
// `privacy.closed` (actor `m_system`). An unknown id is 404 and writes no line; a closed one answers `already_closed`.
import { PrivacyRequestIdSchema } from '../../../shared/contract/audit.ts'
import { apiError, apiJson } from '../../http.ts'
import { storesOf } from '../../db/handler-kit.ts'
import type { Handler } from '../../routes.ts'

export const closePrivacyRequest: Handler = async c => {
  const id = c.params.id
  if (!PrivacyRequestIdSchema.safeParse(id).success) return apiError('not_found')
  const result = await storesOf(c).privacyRequests.close(id, { nowMs: c.nowMs, requestId: c.requestId })
  if (result === 'not_found') return apiError('not_found')
  return apiJson({ result })
}
