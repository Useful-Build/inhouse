import { useEffect } from 'react'

/**
 * The product build while its client has no data (the HTTP stub, until P2 connects it): one screen in place of the pages
 * (App.tsx). The demo never shows it: its Loading scenario keeps its own skeletons.
 */
export function NotConnected() {
  useEffect(() => { document.title = 'Not connected yet · Inhouse' }, [])
  return (
    <main id="main" tabIndex={-1} className="box-border flex min-h-dvh flex-col items-center justify-center gap-1.5 bg-background p-6 text-center outline-none">
      <h1 className="text-2xl font-medium tracking-heading">Not connected yet</h1>
      <p className="max-w-90 text-base text-foreground-3">Inhouse isn't connected to your agent yet. Check back soon.</p>
    </main>
  )
}
