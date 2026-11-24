// The audit log and the reads, for the real targets: where the client's links point, and how a read is made to fail.
import type { ResourceKey } from '../../../types'

/** What `auditExportUrl()`, `dataExportUrl()` and `signOutUrl()` return in the product. */
export const links = { auditExport: '/api/audit/export.csv', dataExport: '/api/data-access/export', signOut: '/cdn-cgi/access/logout' }

/** The path the client reads each resource from. A resource the client has nothing to read for (yet) has none. */
export const READ_PATH: Partial<Record<ResourceKey, string>> = { meta: '/api/me', members: '/api/members', grants: '/api/grants', audit: '/api/audit' }

/**
 * A route the signed-in person can't read: the health check answers only the monitor. A read sent there comes back 403
 * from the Worker itself, as a read of anything the person may not see would.
 */
export const FORBIDDEN_PATH = '/api/health'
