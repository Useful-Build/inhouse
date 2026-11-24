// Route 96's answer (P8a D, `GET /api/data-access/export/check`): whether "Export everything" (route 95) would start
// now, as its size. Apart from data-access.ts, which the Settings page reads in its first load and keeps free of imports.
import { z } from 'zod'

/** How many stores the export holds, and how many rows and files it planned. */
export const DataExportCheckSchema = z.strictObject({ stores: z.number().int().nonnegative(), items: z.number().int().nonnegative() })
export type DataExportCheck = z.infer<typeof DataExportCheckSchema>
