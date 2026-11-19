import { Component } from 'react'
import type { ReactNode } from 'react'
import { useUi } from './state/store'
import { Button } from './ui'
import { demoCrash, reportError } from './report-error'

/** Session storage: a line about the crash, read on the next load (App.tsx) to open Report a bug with it. */
export const CRASH_KEY = 'inhouse.crash.v1'

/** Last line of defence: a short message and a way out, instead of a white screen. Reload keeps every change. */
export class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean; message: string }> {
  state = { failed: false, message: '' }

  static getDerivedStateFromError(error: unknown) {
    return { failed: true, message: error instanceof Error ? error.message : String(error) }
  }

  componentDidCatch(error: unknown) {
    console.error('Inhouse: the app crashed.', error)
    reportError('boundary', error)
  }

  reload = () => location.reload()

  /** Reloads to Today with the team window open on Report a bug, holding one line about the crash (App.tsx opens it). */
  messageTeam = () => {
    const line = crashLine('The app crashed', this.state.message)
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

/** One line about a crash for Report a bug. */
const crashLine = (what: string, message: string) =>
  `${what} and showed "Something went wrong." The error was: ${message.replace(/\s+/g, ' ').slice(0, 200)}`

/** Throws while rendering, for the E2E specs only: `?demo&crash=screen`. */
function DemoCrash(): never {
  throw new Error('Demo crash for qa.person@example.com with token=demo0123456789abcdefghijklmn on https://inhouse.example/p?secret=1#frag')
}

/**
 * Around each screen (App.tsx, keyed by page), so one broken screen leaves the sidebar, top bar and windows working.
 * Going to another page remounts it; moving to another tool, chat or settings tab (`resetKey`) clears the error
 * without remounting a healthy screen.
 */
export class RouteBoundary extends Component<{ children: ReactNode; name: string; resetKey: string }, { failed: boolean; message: string }> {
  state = { failed: false, message: '' }

  componentDidUpdate(prev: { resetKey: string }) {
    if (prev.resetKey !== this.props.resetKey && this.state.failed) this.retry()
  }

  static getDerivedStateFromError(error: unknown) {
    return { failed: true, message: error instanceof Error ? error.message : String(error) }
  }

  componentDidCatch(error: unknown) {
    console.error(`Inhouse: the ${this.props.name} screen crashed.`, error)
    reportError('route', error)
  }

  retry = () => this.setState({ failed: false, message: '' })

  /** The shell still works here, so the team window opens in place on Report a bug. */
  messageTeam = () => useUi.getState().openTeam('bug', crashLine(`The ${this.props.name} screen crashed`, this.state.message))

  render() {
    if (!this.state.failed) return <>{demoCrash() === 'screen' && <DemoCrash />}{this.props.children}</>
    return (
      <div role="alert" className="flex flex-col items-center gap-1.5 px-6 py-16 text-center">
        <h2 className="text-2xl font-medium tracking-heading">Something went wrong.</h2>
        <p className="max-w-90 text-base text-foreground-3">This page didn't load. The rest of the app still works, and your changes are kept.</p>
        <div className="mt-3.5 flex flex-wrap justify-center gap-2">
          <Button onClick={this.retry} size="lg">Try again</Button>
          <Button variant="outline" onClick={this.messageTeam} size="lg">Message the team</Button>
        </div>
      </div>
    )
  }
}
