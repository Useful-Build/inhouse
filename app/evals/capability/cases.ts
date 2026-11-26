// Three capability eval cases for M6's capability gate:
// 1. Long job ending with a stored file (CAP-01)
// 2. Helper research task via the researcher subagent (CAP-02)
// 3. Sourced web research with official citations and facts (CAP-03)
import type { Case } from '../types.ts'
import {
  BARE_DONE_RE,
  CAP_01_FILE_PATH,
  CAP_02_FACTS,
  CAP_02_SUBAGENT_TYPE,
  CAP_03_ANSWER_URL,
  CAP_03_FACTS,
  CAP_03_FETCH_URL,
} from './grade.ts'

export const CAPABILITY_CASES: Case[] = [
  {
    id: 'CAP-01',
    cat: 'e2e',
    needs: ['capability'],
    note: 'capability skeleton: long job ending with a stored file graded on the final Write content',
    seed: [
      {
        memoryId: 'm_cap_norda',
        fact: 'Norda Ceramics, our mug supplier: lead time 6 weeks, minimum order 120 units, payment terms net 30.',
        scope: 'brand',
      },
    ],
    chats: [
      {
        prompt: 'Compile a supplier summary for our ceramic mug vendor including lead time and minimum order, and save it to supplier-summary.md.',
        expect: {
          tool: ['Write', 'Edit'],
          args: { file_path: CAP_01_FILE_PATH },
          answer: [/supplier-summary\.md/i, /\b6\s*weeks\b/i, /\b120\b/],
          answerNot: [BARE_DONE_RE],
        },
      },
    ],
  },
  {
    id: 'CAP-02',
    cat: 'e2e',
    needs: ['capability'],
    note: 'capability skeleton: helper research task graded on researcher delegation and anchored source facts',
    seed: [
      {
        memoryId: 'm_cap_moss',
        fact: 'The Moss glaze is discontinued since September. Offer Fern instead.',
        scope: 'brand',
      },
      {
        memoryId: 'm_cap_shipping',
        fact: 'Free shipping starts at 60 euro.',
        scope: 'brand',
      },
    ],
    chats: [
      {
        prompt: 'Use the researcher helper to check our discontinued glaze replacement and free shipping threshold, then summarize both facts.',
        expect: {
          tool: 'Agent',
          args: { subagent_type: CAP_02_SUBAGENT_TYPE },
          answer: CAP_02_FACTS,
          answerNot: [BARE_DONE_RE],
        },
      },
    ],
  },
  {
    id: 'CAP-03',
    cat: 'e2e',
    needs: ['capability'],
    note: 'capability skeleton: sourced web research graded on official europa.eu WebFetch, matching citation, and source facts',
    chats: [
      {
        prompt: 'Look up the EU minimum standard VAT rate on europa.eu, cite the official source URL, and state the minimum percentage.',
        expect: {
          tool: 'WebFetch',
          args: { url: CAP_03_FETCH_URL },
          answer: [CAP_03_ANSWER_URL, ...CAP_03_FACTS],
          answerNot: [BARE_DONE_RE],
        },
      },
    ],
  },
]
