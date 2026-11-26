// Passing and failing fixtures for the three M1-H capability eval cases.
// Includes both bare-"Done." failures and near-miss failures (wrong file facts, overwritten Write, inverted relationships, foreign URL, missing URL).
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
              content: '# Supplier Summary\n\n- Norda Ceramics: minimum order 120 units, lead time 6 weeks, payment terms net 30.\n',
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
              content: 'Norda Ceramics: lead time 16 weeks, minimum order 1200 units.',
            },
            'Wrote reports/supplier-summary.md',
          ],
        ],
        answer: 'Saved the summary to reports/supplier-summary.md: Norda Ceramics has a 6 weeks lead time and a minimum order of 120 units.',
      },
    ],
  },
  'CAP-02': {
    passes: false,
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
            'Fern is discontinued; offer Moss instead. Free shipping starts at 160 euro.',
          ],
        ],
        answer: 'The Fern glaze is discontinued (offer Moss instead), and free shipping starts at 160 euro.',
      },
    ],
  },
  'CAP-03': {
    passes: false,
    chats: [
      {
        calls: [
          ['WebFetch', { url: 'https://blog.example.test/eu-vat-guide' }, 'Minimum EU VAT is 15%.'],
        ],
        answer: 'The EU minimum standard VAT rate is 15%, per https://blog.example.test/eu-vat-guide.',
      },
    ],
  },
}

export const CAPABILITY_EXTRA_FAIL_FIXTURES: { name: string; caseId: string; expectedReason: string; canned: Canned }[] = [
  {
    name: 'CAP-01 bare Done',
    caseId: 'CAP-01',
    expectedReason: 'bare_done_answer',
    canned: {
      passes: false,
      chats: [{ calls: [['Write', { file_path: 'reports/supplier-summary.md', content: 'Done.' }]], answer: 'Done.' }],
    },
  },
  {
    name: 'CAP-01 early good Write overwritten by bad Write',
    caseId: 'CAP-01',
    expectedReason: 'missing_file_facts',
    canned: {
      passes: false,
      chats: [
        {
          calls: [
            ['Write', { file_path: 'reports/supplier-summary.md', content: 'Norda Ceramics: 6 weeks, 120 units.' }],
            ['Write', { file_path: 'reports/supplier-summary.md', content: 'Draft incomplete.' }],
          ],
          answer: 'Saved reports/supplier-summary.md: 6 weeks, 120 units.',
        },
      ],
    },
  },
  {
    name: 'CAP-02 bare Done without Agent',
    caseId: 'CAP-02',
    expectedReason: 'bare_done_answer',
    canned: {
      passes: false,
      chats: [{ calls: [], answer: 'Done.' }],
    },
  },
  {
    name: 'CAP-03 right fact and official WebFetch, but missing citation URL in answer',
    caseId: 'CAP-03',
    expectedReason: 'missing_source_url',
    canned: {
      passes: false,
      chats: [
        {
          calls: [['WebFetch', { url: 'https://taxation-customs.ec.europa.eu/vat-rates_en' }, 'Minimum 15%.']],
          answer: 'The EU minimum standard VAT rate is 15%.',
        },
      ],
    },
  },
  {
    name: 'CAP-03 bare Done',
    caseId: 'CAP-03',
    expectedReason: 'bare_done_answer',
    canned: {
      passes: false,
      chats: [{ calls: [['WebSearch', { query: 'EU VAT' }]], answer: 'Done.' }],
    },
  },
]
