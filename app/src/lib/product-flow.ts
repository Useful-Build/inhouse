// What differs on the product from the demo on the Skills page, kept as plain functions so each decision has a test (the
// repo has no DOM test setup). `demo` is `demo !== null`.
import type { SkillTab } from '../state/store'

const TABS: [SkillTab, string][] = [['all', 'All'], ['team', 'By Inhouse team'], ['mine', 'By your team']]

/** The product has no skills made in a chat, so "By your team" is always empty there: it isn't offered. */
export const skillTabs = (demo: boolean): [SkillTab, string][] => (demo ? TABS : TABS.filter(([k]) => k !== 'mine'))
/** A saved "By your team" tab shows as All on the product. */
export const shownSkillTab = (demo: boolean, saved: SkillTab): SkillTab => (demo || saved !== 'mine' ? saved : 'all')

/** A skill's detail rows. On the product "Works from" is dropped at need 0 (every skill starts at Watch), and "Used" only shows when there is one. */
export function skillFacts(demo: boolean, s: { used: string; by: string; need: 0 | 1 | 2 }, stageTag: (need: 0 | 1 | 2) => string): [string, string][] {
  return [...(s.used ? [['Used', s.used] as [string, string]] : []), ['Made by', s.by], ...(demo || s.need > 0 ? [['Works from', stageTag(s.need)] as [string, string]] : [])]
}
