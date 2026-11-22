// A Today item as the client's `Problem` (p4-w3.md section 5, OC 3). The client's `Problem` needs a draft and more that a
// Watch item doesn't have, so the server fills them with placeholders (Watch never shows the draft; P6 replaces it with
// real drafts). `problem.ts` in the contract doesn't change. One pure function, a literal-fixture test.
import type { Money } from '../../shared/contract/common.ts'
import type { Problem } from '../../shared/contract/problem.ts'
import type { TodayItem } from '../../shared/contract/today.ts'
import type { Card } from './view.ts'

/** The fixed text for "what was done": nothing, at Watch. */
export const DONE_TEXT = 'Nothing done yet'

const instant = (ms: number) => ({ iso: new Date(ms).toISOString(), ms })

export function toProblem(item: TodayItem, currency: string): Problem {
  const cost: Money = item.cost ?? { minor: 0, currency }
  return {
    id: item.id,
    sev: item.sev,
    area: item.area,
    title: item.title,
    sub: item.sub,
    logos: ['shopify'],
    cost,
    costNote: item.cost === null ? '' : item.costNote,
    next: item.next,
    doneText: DONE_TEXT,
    trace: item.routineRun,
    found: item.found.map(([label, value]) => [label, value] as [string, string]),
    sources: item.sources.map(s => ({ n: s.n, logo: 'shopify', name: 'Shopify', text: s.text })),
    draft: { title: item.next, lines: [], cta: 'Approve' },
    draftedAt: item.foundAt,
  }
}

const AMBER = '#b97a14'
const CHECK_NEXT = 'Ask the Inhouse team to check the Shopify connection'

/** The status card's fixed texts (no model words). */
function words(c: Card): { title: string; sub: string; next: string } {
  const clock = c.clock ?? ''
  switch (c.cause) {
    case 'incomplete': {
      const read = c.areas.length > 0 ? `The ${clock} check couldn't read everything: ${c.areas.join(', ')}` : `The ${clock} check found more than 10 things; showing 10`
      return {
        title: c.areas.length > 0 && c.tooMany ? `${read}. It also found more than 10 things; showing 10` : read,
        sub: 'Some of what it found may be missing.', next: CHECK_NEXT,
      }
    }
    case 'failed': return { title: `The ${clock} check didn't finish`, sub: 'Nothing from that run was saved.', next: CHECK_NEXT }
    case 'not_run': return { title: "The morning check hasn't run today", sub: "Today's list may be out of date.", next: CHECK_NEXT }
    case 'not_connected': return { title: "Shopify isn't connected yet", sub: "The morning check can't read your store.", next: CHECK_NEXT }
    case 'off': return { title: 'The morning check is off', sub: "Today's list may be out of date.", next: 'The morning check is off. Turn it on in Routines.' }
  }
}

/** A status card as a `Problem` (`sources: []`, `logos: ['shopify']`), with the id its caller derived. */
export function cardProblem(c: Card, id: string, currency: string): Problem {
  const w = words(c)
  return {
    id, sev: AMBER, area: 'Orders', title: w.title, sub: w.sub, logos: ['shopify'], cost: { minor: 0, currency }, costNote: '', next: w.next,
    doneText: DONE_TEXT, found: [], sources: [], draft: { title: w.next, lines: [], cta: 'Approve' }, draftedAt: instant(c.atMs),
  }
}
