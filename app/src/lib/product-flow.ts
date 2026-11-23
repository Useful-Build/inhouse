// What differs on the product from the demo in the Inhouse team window, the help window and the Tools page's Request,
// kept as plain functions so each decision has a test (the repo has no DOM test setup). `demo` is `demo !== null`, `product` its opposite.
import type { ResourceStatus } from '../../shared/contract/common'

/** The screenshot box on a bug report: the demo's only (the product sends no screenshot). */
export const showScreenshotBox = (demo: boolean, isBug: boolean): boolean => demo && isBug
/** The line beside Send. On the product a bug has none (it doesn't send the page), and nothing promises a reply time. */
export function teamHelper(demo: boolean, isBug: boolean): string {
  if (demo) return isBug ? 'Goes straight to the team, with the page you were on.' : 'Every tool and job is included in your plan.'
  return isBug ? '' : 'Every tool and job is included in your plan.'
}
/** The toast after a send. */
export const sentToast = (demo: boolean, isBug: boolean): string => (isBug ? 'Bug sent to your Inhouse team. Thank you.' : demo ? 'Request sent. Your Inhouse team replies within one working day.' : 'Request sent to your Inhouse team.')
/** The help window's line under the guides: no reply time on the product. */
export const helpLine = (demo: boolean): string => (demo ? "Can't find it? Your Inhouse team replies within one working day." : "Can't find it? Ask your Inhouse team.")

/** A failed read of the open requests is an error line with Retry, never an empty list that reads as "none". */
export const requestsView = (s: Pick<ResourceStatus, 'status'>): 'error' | 'list' => (s.status === 'error' ? 'error' : 'list')

/** The Tools page's Request: the demo toasts at once, the product once the server has it (a refusal shows none). */
export function askForTool(o: { product: boolean; request: () => Promise<void>; say: () => void }): void {
  const sent = o.request()
  if (!o.product) { o.say(); void sent.catch(() => undefined); return }
  void sent.then(o.say, () => undefined)
}
