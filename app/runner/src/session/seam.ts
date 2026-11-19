// The guards seam. R1 defines and calls these; R2 implements them in src/guards/. A test implementation lives under
// test/ only, and the production wiring (src/server/production.ts) refuses anything that isn't marked production.
import type { Options } from '@anthropic-ai/claude-agent-sdk'
import type { RunConfig } from '../protocol/local.ts'

/** The OS user a session runs as. `workDir` is the session's work folder (the process's cwd). */
export type SessionUser = {
  uid: number
  gid: number
  user: string
  home: string
  workDir: string
}

/** Used by the root runner, before it spawns a session process. */
export interface SessionUsers {
  readonly kind: 'production' | 'test'
  /** One OS user per session key (the chat id). Idempotent: the same key gets the same user. */
  allocate(sessionKey: string): Promise<SessionUser>
  /** Called when the session's process has ended. */
  release(sessionKey: string, user: SessionUser): Promise<void>
}

/**
 * Used inside the session process, around every `query()`: adds the sandbox, the tools lock, the skills lock, plugins,
 * hooks and the WebFetch list from the run config. Returns the options `query()` gets.
 */
export interface QueryGuards {
  readonly kind: 'production' | 'test'
  apply(baseOptions: Options, runConfig: RunConfig): Options
}
