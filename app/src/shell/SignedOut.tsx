import { useEffect } from 'react'
import { Button } from '../ui'

/**
 * The product build after a 401: the Access session ended, at the first read or mid-session (every call would fail),
 * one screen in place of the pages (App.tsx). A full load of the current URL sends the person through Access again.
 */
export function SignedOut() {
  useEffect(() => { document.title = 'Your sign-in ended · Inhouse' }, [])
  return (
    <main id="main" tabIndex={-1} className="box-border flex min-h-dvh flex-col items-center justify-center gap-1.5 bg-background p-6 text-center outline-none">
      <h1 className="text-2xl font-medium tracking-heading">Your sign-in ended</h1>
      <p className="max-w-90 text-base text-foreground-3">Sign in again to keep using Inhouse.</p>
      <Button variant="outline" size="lg" className="mt-3" onClick={() => window.location.reload()}>Sign in again</Button>
    </main>
  )
}
