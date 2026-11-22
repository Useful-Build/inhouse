import { useEffect } from 'react'
import { agent } from '../agent'
import { Button } from '../ui'

/**
 * The product build when an Inhouse team account signs in on a brand's app (a 403 wrong_kind): one screen in place of
 * the pages (App.tsx), final like "You're not on this team". Signing in again with the same account would only come
 * back here, so there's no retry: Sign out is a link to Access's logout, so they can come back with their brand sign-in.
 */
export function InhouseAccount() {
  useEffect(() => { document.title = 'This is an Inhouse team account · Inhouse' }, [])
  const out = agent.signOutUrl()
  return (
    <main id="main" tabIndex={-1} className="box-border flex min-h-dvh flex-col items-center justify-center gap-1.5 bg-background p-6 text-center outline-none">
      <h1 className="text-2xl font-medium tracking-heading">This is an Inhouse team account</h1>
      <p className="max-w-90 text-base text-foreground-3">
        You signed in with the account you use for the Inhouse team, so it can't open this brand's app. Sign out, then sign in with your brand account.
      </p>
      {out && <Button variant="outline" size="lg" className="mt-3" onClick={() => window.location.assign(out)}>Sign out</Button>}
    </main>
  )
}
