import { useEffect } from 'react'
import { agent } from '../agent'
import { Button } from '../ui'

/**
 * The product build when Access let the person in but the team has no active member for them (a 403 for a person not invited, or removed): one screen in place of the pages (App.tsx), beside "Not connected yet". Sign out is a link to Access's
 * logout, so they can come back as someone else. The email is shown when the client knows it.
 */
export function NotOnTeam() {
  useEffect(() => { document.title = "You're not on this team · Inhouse" }, [])
  const email = agent.me()?.email
  const out = agent.signOutUrl()
  return (
    <main id="main" tabIndex={-1} className="box-border flex min-h-dvh flex-col items-center justify-center gap-1.5 bg-background p-6 text-center outline-none">
      <h1 className="text-2xl font-medium tracking-heading">You're not on this team</h1>
      <p className="max-w-90 text-base text-foreground-3">
        {email ? `${email} isn't` : "This account isn't"} on this team's Inhouse. Ask an admin to invite you, then sign in again.
      </p>
      {out && <Button variant="outline" size="lg" className="mt-3" onClick={() => window.location.assign(out)}>Sign out</Button>}
    </main>
  )
}
