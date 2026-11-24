import { useEffect } from 'react'
import { InhouseMark } from '../ui'

/**
 * The product build while its client has no data yet (the first read, `meta`, is loading): one neutral loading screen in
 * place of the pages (App.tsx, start-screen.ts). The demo never shows it: its Loading scenario keeps its own skeletons.
 */
export function NotConnected() {
  useEffect(() => { document.title = 'Inhouse' }, [])
  return (
    <main id="main" tabIndex={-1} className="box-border flex min-h-dvh flex-col items-center justify-center gap-3 bg-background p-6 text-center outline-none">
      <h1 className="sr-only">Loading Inhouse</h1>
      <InhouseMark size={24} className="text-foreground" />
      <p role="status" className="text-sm text-foreground-3">Loading…</p>
    </main>
  )
}
