// Code mode's real-model half of P5 acceptance 5 (P5 W2, A.5): the four S4 whole-list questions over the recorded
// fixture store (300 orders, 150 products). Each passes when the agent picks shopify_script_run by itself and answers
// right. The orchestrator runs them on Sonnet 5.5 at medium in its live check and also checks that at most
// MAX_TOOL_RESULT_CHARS of tool result reached the model per question (the harness's Expect has no size field).
// LIVE ONLY (B2, 2026-11-21): they run at the P5 live check against the real dev store, never against the recorded test
// store (which answers only its recorded documents, so a script the model writes gets ACCESS_DENIED there). The harness
// has no live-only field, so each case's note says it. The expected values are the fixture's, as the oracles in
// app/hub/codemode/measure/oracle.ts compute them (asked at 2026-11-20T18:00:00Z).
import type { Case } from '../../types.ts'

/** S4: 199 to 1,131 characters reached the model; the bound per question. */
export const MAX_TOOL_RESULT_CHARS = 1_500

export const CODEMODE_CASES: Case[] = [
  {
    id: 'C-CODEMODE-01',
    cat: 'connector',
    note: 'LIVE ONLY (P5 live check, real dev store). S4 lowest stock with a count over a price: the lowest is oversold at -4; 48 products sell for over $150',
    needs: ['shopify_script_run'],
    chats: [
      {
        prompt: 'Across the whole catalogue, which products are lowest on stock, and how many products sell for over $150?',
        expect: { tool: 'shopify_script_run', answer: [/trail rain jacket/i, /\b48\b/] },
      },
    ],
  },
  {
    id: 'C-CODEMODE-02',
    cat: 'connector',
    note: 'LIVE ONLY (P5 live check, real dev store). S4 paid orders unfulfilled over 3 days, as of 2026-11-20 18:00 UTC: one, #1001',
    needs: ['shopify_script_run'],
    chats: [
      {
        prompt: 'Going through all orders, which paid orders have been waiting more than 3 days to be fulfilled, as of 2026-11-20 18:00 UTC?',
        expect: { tool: 'shopify_script_run', answer: [/#?1001\b/] },
      },
    ],
  },
  {
    id: 'C-CODEMODE-03',
    cat: 'connector',
    note: 'LIVE ONLY (P5 live check, real dev store). S4 refund spike by product and reason: 21 refunds of P4-0062 (Summit Camp Stove), "Igniter failed"',
    needs: ['shopify_script_run'],
    chats: [
      {
        prompt: 'Is there a refund spike? Group all refunds by product and reason.',
        expect: { tool: 'shopify_script_run', answer: [/P4-0062|summit camp stove/i, /igniter/i, /\b21\b/] },
      },
    ],
  },
  {
    id: 'C-CODEMODE-04',
    cat: 'connector',
    note: 'LIVE ONLY (P5 live check, real dev store). S4 open returns not restocked: 11 open returns, all P4-0089, "Damaged or defective"',
    needs: ['shopify_script_run'],
    chats: [
      {
        prompt: 'Which open returns across all orders have not been restocked yet?',
        expect: { tool: 'shopify_script_run', answer: [/\b11\b/, /P4-0089|ridge compass/i] },
      },
    ],
  },
]
