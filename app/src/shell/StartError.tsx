import { useEffect } from 'react'
import { agent } from '../agent'
import type { AgentErrorCode } from '../agent/types'
import { LoadError } from '../ui/retry'

/**
 * The product build when the first read failed for a reason asking again can fix (a 5xx, offline, a timeout): the lists'
 * load error, for the whole app, in place of the pages (App.tsx). Retry reads `meta` again, and the rest after it; while
 * that read is under way (`retrying`) the last error's words stay and Retry is disabled.
 */
export function StartError({ error, retrying }: { error?: AgentErrorCode; retrying: boolean }) {
  useEffect(() => { document.title = "Couldn't load · Inhouse" }, [])
  return (
    <main id="main" tabIndex={-1} className="box-border flex min-h-dvh flex-col items-center justify-center bg-background p-6 outline-none">
      <h1 className="sr-only">Couldn't load Inhouse</h1>
      <div className="w-full max-w-160">
        <LoadError what="Inhouse" error={error} busy={retrying} onRetry={() => { void agent.retry('meta') }} />
      </div>
    </main>
  )
}
