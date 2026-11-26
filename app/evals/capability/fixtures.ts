// Passing and failing fixtures for the three M1-H capability eval cases.
// Each negative fixture simulates an agent that says "Done." or omits the required end state (stored file content or source facts).
import type { Canned } from '../targets/fake.ts'

export const CAPABILITY_PASS_FIXTURES: Record<string, Canned> = {
  'CAP-01': {
    chats: [
      {
        calls: [
          ['memory_search', { query: 'ceramic mug supplier' }, 'Norda Ceramics: lead time 6 weeks, minimum order 120 units.'],
          [
            'Write',
            {
              file_path: 'reports/supplier-summary.md',
              content: '# Supplier Summary\n\n- Norda Ceramics: lead time 6 weeks, minimum order 120 units, payment terms net 30.\n',
            },
            'Wrote reports/supplier-summary.md',
          ],
        ],
        answer: 'Saved the summary to reports/supplier-summary.md: Norda Ceramics has a 6 weeks lead time and a minimum order of 120 units.',
      },
    ],
  },
  'CAP-02': {
    chats: [
      {
        calls: [
          [
            'Agent',
            {
              subagent_type: 'researcher',
              description: 'Check discontinued glaze and free shipping',
              prompt: 'Find our discontinued glaze replacement and free shipping threshold.',
            },
            'Moss glaze is discontinued; offer Fern instead. Free shipping starts at 60 euro.',
          ],
        ],
        answer: 'The Moss glaze is discontinued (offer Fern instead), and free shipping starts at 60 euro.',
      },
    ],
  },
  'CAP-03': {
    chats: [
      {
        calls: [
          ['WebSearch', { query: 'EU minimum standard VAT rate official' }, 'Minimum standard VAT rate in the EU is 15% (https://taxation-customs.ec.europa.eu/vat-rates_en).'],
          ['WebFetch', { url: 'https://taxation-customs.ec.europa.eu/vat-rates_en' }, 'Standard VAT rate: minimum 15%.'],
        ],
        answer: 'The EU minimum standard VAT rate is 15%, per https://taxation-customs.ec.europa.eu/vat-rates_en.',
      },
    ],
  },
}

export const CAPABILITY_FAIL_FIXTURES: Record<string, Canned> = {
  'CAP-01': {
    passes: false,
    chats: [
      {
        calls: [
          [
            'Write',
            {
              file_path: 'reports/supplier-summary.md',
              content: 'Done.',
            },
            'Wrote reports/supplier-summary.md',
          ],
        ],
        answer: 'Done.',
      },
    ],
  },
  'CAP-02': {
    passes: false,
    chats: [
      {
        calls: [],
        answer: 'Done.',
      },
    ],
  },
  'CAP-03': {
    passes: false,
    chats: [
      {
        calls: [
          ['WebSearch', { query: 'EU VAT rate' }, 'Results omitted.'],
        ],
        answer: 'Done.',
      },
    ],
  },
}
