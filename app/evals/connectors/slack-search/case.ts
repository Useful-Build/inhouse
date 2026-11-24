// S4's supplier-delay case (P5 W1 section 8, step 1). Slack search ANDs keywords exactly, so "supplier delay" misses a
// message that says "ships 2 weeks late". The case passes when the answer finds the planted message. The orchestrator
// reruns it on Sonnet 5.5 at medium through the live check before any engineering change (step 2, the hub fallback,
// only if it still misses). Registering it in evals/cases.ts is an orchestrator line. Invented names only.
import type { Case } from '../../types.ts'

/** Planted in the fake Slack's #suppliers channel (app/test/upstreams/mcp/server.ts, SUPPLIER_DELAY_TEXT). */
export const PLANTED = 'Supplier Kestrel Mills says the November restock of the Fern mug ships 2 weeks late'

export const SLACK_SEARCH_CASE: Case = {
  id: 'C-SLACK-01',
  cat: 'connector',
  note: 'S4 miss: lexical AND search; the description says to try one distinctive word at a time',
  needs: ['slack_search_public'],
  chats: [
    {
      prompt: 'Did anyone mention a supplier delay?',
      expect: { tool: 'slack_search_public', answer: [/kestrel/i, /2 weeks|two weeks/i] },
    },
  ],
}
