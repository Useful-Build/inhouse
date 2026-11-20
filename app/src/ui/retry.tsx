// What a page shows when one of its lists couldn't be read (C3): a short message and Retry. The page's other lists stay.
import type { AgentErrorCode } from '../agent/types'
import { Button } from './index'
import { canRetry } from './retry-rule'

const WHY: Partial<Record<AgentErrorCode, string>> = {
  offline: "You're offline. Check your connection and try again.",
  forbidden: "You don't have access to this.",
  unauthorized: 'Sign in again to see this.',
  rate_limited: 'Too many tries. Wait a moment and try again.',
}

/** "Couldn't load <what>." with the reason when it is known, and Retry (disabled while `busy`: a read is already under way). */
export function LoadError({ what, error, onRetry, busy = false }: { what: string; error?: AgentErrorCode; onRetry: () => void; busy?: boolean }) {
  return (
    <div role="alert" className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2.5 rounded-2xl border border-border bg-card px-5.5 py-4">
      <p className="m-0 min-w-0 grow basis-60 text-base text-foreground-2">{`Couldn't load ${what}. ${(error && WHY[error]) ?? 'Try again in a moment.'}`}</p>
      {canRetry(error) && <Button variant="outline" size="lg" disabled={busy} onClick={onRetry}>Retry</Button>}
    </div>
  )
}
