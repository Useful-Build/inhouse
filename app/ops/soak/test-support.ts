import type { DayEvidence } from './types.ts'

/** A day where every facet is present and clean. */
export const cleanEvidence = (day = '2026-12-01'): DayEvidence => ({
  day,
  morning: { slots: [{ state: 'ended', kind: 'scheduled', reason: null, failure: null, outcome: 'done' }] },
  bell: { expectedIds: ['rf_a'], failedNoticeIds: ['rf_a'], morningNotices: 1, morningEnded: 1 },
  memory: { learnOffSaves: 0, teamFactsUnapproved: 0 },
  connectors: { readCalls: 4, failedReads: 0 },
  runs: { stuck: 0 },
  guards: { webfetchBypass: 0, leaks: 0 },
})
