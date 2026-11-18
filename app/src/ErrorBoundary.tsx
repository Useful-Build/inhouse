import { Component } from 'react'
import type { ReactNode } from 'react'
import { useUi } from './state/store'
import { Button } from './ui'

/** Session storage: a line about the crash, read on the next load (App.tsx) to open Report a bug with it. */
export const CRASH_KEY = 'inhouse.crash.v1'

/** Last line of defence: a short message and a way out, instead of a white screen. Reload keeps every change. */
export class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean; message: string }> {
  state = { failed: false, message: '' }

  static getDerivedStateFromError(error: unknown) {
    return { failed: true, message: error instanceof Error ? error.message : String(error) }
  }

  componentDidCatch(error: unknown) { console.error('Inhouse: the app crashed.', error) }

  reload = () => location.reload()

  /** Reloads to Today with the team window open on Report a bug, holding one line about the crash. */
  messageTeam = () => {
    const line = `The app crashed and showed "Something went wrong." The error was: ${this.state.message.replace(/\s+/g, ' ').slice(0, 200)}`
    try { sessionStorage.setItem(CRASH_KEY, line) }
    catch (e) { console.warn('Inhouse: could not keep the crash note for the team window.', e) }
    history.replaceState(null, '', '#/today')
    location.reload()
  }

  reset = () => {
    try { useUi.getState().resetDemo() }
    finally {
      history.replaceState(null, '', '#/today')
      location.reload()
    }
  }

  render() {
    if (!this.state.failed) return this.props.children
    // Reset demo (it clears every change) only for the demo's presenter.
    const demo = new URLSearchParams(location.search).has('demo')
    return (
      <div role="alert" className="box-border flex min-h-dvh flex-col items-center justify-center gap-1.5 bg-background p-6 text-center">
        <h1 className="text-2xl font-medium tracking-heading">Something went wrong.</h1>
        <p className="max-w-90 text-base text-foreground-3">Reload to carry on. Your changes are kept.</p>
        <div className="mt-3.5 flex flex-wrap justify-center gap-2">
          <Button onClick={this.reload} size="lg">Reload</Button>
          <Button variant="outline" onClick={this.messageTeam} size="lg">Message the team</Button>
          {demo && <Button variant="ghost" onClick={this.reset} size="lg">Reset demo</Button>}
        </div>
      </div>
    )
  }
}
