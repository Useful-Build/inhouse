// Data and access (P8a D): where "Export everything" downloads from. Route 95 streams the brand's whole export as one
// NDJSON file with its own `Content-Disposition`, so the page navigates to it (as the audit log's CSV, route 20) and the
// browser saves it as it arrives: the file never sits in the page's memory. A relative path: the browser sends it to
// its own origin, with its sign-in. The retention row reads and writes `d:chats` and `d:steps` as settings (client.ts).
import { DATA_EXPORT_PATH } from '../../../shared/contract/data-access'

export const dataExportUrl = (): string => DATA_EXPORT_PATH
