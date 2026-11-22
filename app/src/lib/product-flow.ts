// What differs on the product from the demo in the Skills page, the Inhouse team window and the Tools page's Request,
// kept as plain functions so each decision has a test (the repo has no DOM test setup). `demo` is `demo !== null`, `product` its opposite.
import { TEAM_REQUEST_TEXT_MAX } from '../../shared/contract/keys'
import type { ResourceStatus } from '../../shared/contract/common'
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

/** The screenshot box on a bug report: the demo's only (the product sends no screenshot). */
export const showScreenshotBox = (demo: boolean, isBug: boolean): boolean => demo && isBug
/** The line beside Send. On the product a bug has none (it doesn't send the page), and nothing promises a reply time. */
export function teamHelper(demo: boolean, isBug: boolean): string {
  if (demo) return isBug ? 'Goes straight to the team, with the page you were on.' : 'Every tool and job is included in your plan.'
  return isBug ? '' : 'Every tool and job is included in your plan.'
}
/** The team window's intro: the demo's copy promises a reply time; nobody has committed to one on the product. */
export const windowIntro = (demo: boolean): string => (demo ? 'Alex and the team build, connect and run your Inhouse agent. They reply within one working day.' : 'The people who build, connect and run your Inhouse agent.')
/** The toast after a send. */
export const sentToast = (demo: boolean, isBug: boolean): string => (isBug ? 'Bug sent to your Inhouse team. Thank you.' : demo ? 'Request sent. Your Inhouse team replies within one working day.' : 'Request sent to your Inhouse team.')
/** The help window's line under the guides: no reply time on the product. */
export const helpLine = (demo: boolean): string => (demo ? "Can't find it? Your Inhouse team replies within one working day." : "Can't find it? Ask your Inhouse team.")
export const counterText = (n: number): string => `${n} of ${TEAM_REQUEST_TEXT_MAX}`

/** A failed read of the open requests is an error line with Retry, never an empty list that reads as "none". */
export const requestsView = (s: Pick<ResourceStatus, 'status'>): 'error' | 'list' => (s.status === 'error' ? 'error' : 'list')

/**
 * Sending from the team window. The demo says sent at once (the mock is local). The product says sent, clears and closes
 * only once the server has the request; a refusal keeps the window and the words (the client has told the person why).
 */
export async function sendFromWindow(o: { product: boolean; send: () => Promise<void>; sent: () => void; done: () => void }): Promise<'sent' | 'kept'> {
  if (!o.product) {
    void o.send().catch(() => undefined)
    o.sent()
    o.done()
    return 'sent'
  }
  try { await o.send() } catch { return 'kept' }
  o.sent()
  o.done()
  return 'sent'
}

/** The Tools page's Request: the demo toasts at once, the product once the server has it (a refusal shows none). */
export function askForTool(o: { product: boolean; request: () => Promise<void>; say: () => void }): void {
  const sent = o.request()
  if (!o.product) { o.say(); void sent.catch(() => undefined); return }
  void sent.then(o.say, () => undefined)
}
