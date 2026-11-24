// Data and access (P8a D): "Export everything". Route 95 streams the brand's export for the caller as one NDJSON file
// with its own `Content-Disposition`, so the page navigates to it (as the audit log's CSV, route 20) and the browser
// saves it as it arrives: the file never sits in the page's memory. Before it navigates, the page asks route 96 whether
// the export would start (a brand too big for one request, a grant that ended, storage down): navigating to a refusal
// would replace the app with its JSON. Relative paths: the browser sends them to its own origin, with its sign-in. The
// retention row reads and writes `d:chats` and `d:steps` as settings (client.ts).
import { DATA_EXPORT_CHECK_PATH, DATA_EXPORT_PATH } from '../../../shared/contract/data-access'
import type { DataExportCheck } from '../../../shared/contract/data-access-check'
import type { Transport } from './transport'

export const dataExportUrl = (): string => DATA_EXPORT_PATH

/** Route 96: the export's size when it would start now; rejects with an `AgentError` (a 409 for a brand too big for one download, 403, 503). */
export const checkDataExport = (http: Transport): Promise<DataExportCheck> =>
  http.call({ method: 'GET', path: DATA_EXPORT_CHECK_PATH, schema: 'dataExportCheck' })
