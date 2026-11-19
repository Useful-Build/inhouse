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
  /**
   * Called once the session's process has exited and the root has killed its process group. Must not resolve until no
   * process of `user.uid` is left (a process that left the group with setsid included): the chat's slot, and with it
   * the uid, frees only after this settles, and a leftover holding the uid would otherwise act under the next run's
   * token. Also called for a run refused after `allocate` (a root uid). R2 implements it.
   */
  release(sessionKey: string, user: SessionUser): Promise<void>
}

/**
 * Used inside the session process, around every `query()`: adds the sandbox, the tools lock, the skills lock, plugins,
 * hooks and the WebFetch list from the run config. Returns the options `query()` gets.
 */
export interface QueryGuards {
  readonly kind: 'production' | 'test'
  /**
   * No spawn hook to keep: the local channel is the session's own stdin and stdout, and the SDK's default spawn gives
   * the CLI fresh stdio pipes (src/session/channel.ts). A guard that sets `spawnClaudeCodeProcess` must not hand the
   * CLI the session's stdin or stdout.
   */
  apply(baseOptions: Options, runConfig: RunConfig): Options
}
