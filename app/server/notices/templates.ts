// The bell's fixed notices (p4-w4 section 2, revisions 3.2): a literal table, one row per template. A row names its
// fields (counts and fixed codes, see ../activity/fields.ts) and fills `{field}` slots at read time; `{person}` is the
// notice's `person_id` rendered from the members table. `body: { max }` marks the templates that may carry plain text
// (P5 and P6 content, in code points); every other template refuses a body. P5 W4 adds its eleven rows here as lines
// only (`notify_message`, `notify_report` at 1,622; the nine system kinds at 300): p5-w4.md section 3.
import type { FieldSpec } from '../activity/fields.ts'

export interface NoticeTemplate {
  /** The notice's producer: stored in `notices.source`. */
  source: string
  /** The notice's headline; `{field}` slots only. */
  text: string
  /** The notice's `who` line. */
  who: string
  fields: FieldSpec
  /** Present on the templates whose notices carry a `body`: the most code points it may hold. */
  body?: { max: number }
}

export const NOTICE_TEMPLATES: Readonly<Record<string, NoticeTemplate>> = {
  routine_failed: {
    source: 'routine-slot', text: 'A routine failed', who: 'Your Inhouse agent', fields: { code: 'code' },
  },
  morning_check_found: {
    source: 'morning-check', text: 'The morning check found {items:thing}', who: 'Your Inhouse agent', fields: { items: 'number' },
  },
  // P8a F2: Shopify sent a privacy (compliance) request for this store. To the brand's admins; no field names the customer.
  privacy_data_request: {
    source: 'shopify-privacy', text: 'Shopify sent a customer data request. The Inhouse team will answer it within 30 days', who: 'Inhouse', fields: {},
  },
  privacy_customer_redact: {
    source: 'shopify-privacy', text: "Shopify asked to erase a customer's data. The Inhouse team will handle it within 30 days", who: 'Inhouse', fields: {},
  },
  privacy_shop_redact: {
    source: 'shopify-privacy', text: "Shopify asked to erase this store's data. The Inhouse team will follow up with you", who: 'Inhouse', fields: {},
  },
}
