// The guards seam. R1 defines and calls these; R2 implements them in src/guards/. A test implementation lives under
// test/ only, and the production wiring (src/server/production.ts) refuses anything that isn't marked production.
import type { Options } from '@anthropic-ai/claude-agent-sdk'
import type { AuditEntry } from '../../../shared/protocol/index.ts'
import type { BrandSkillFile } from '../../../shared/protocol/brand-skills.ts'
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
  /** How many uids a failed cleanup took out of the pool for good (reported on /health). */
  quarantined(): number
  /**
   * Before the session's process starts, for the live session that holds `user`: writes the run's brand skills as a
   * root-owned, read-only plugin the session can't change (none: an empty one, so nothing of an earlier run stays).
   * Rejects when it can't; the run then doesn't start.
   */
  writeBrandSkills(sessionKey: string, user: SessionUser, skills: readonly BrandSkillFile[]): Promise<void>
}

/**
 * Used inside the session process, around every `query()`: adds the sandbox, the tools lock, the skills lock, plugins,
 * hooks and the WebFetch list from the run config. Returns the options `query()` gets.
 */
export interface QueryGuards {
  readonly kind: 'production' | 'test'
  /**
   * No spawn hook to keep: the local channel is the session's fds 3 and 4 (close-on-exec), and the SDK's default spawn
   * gives the CLI fresh stdio pipes (src/session/channel.ts). A guard that sets `spawnClaudeCodeProcess` must not hand
   * the CLI the session's fds 3 or 4. `baseOptions` already holds the session store (`sessionStore`,
   * `sessionStoreFlush`); keep them.
   */
  apply(baseOptions: Options, runConfig: RunConfig, run: RunContext): Options
}

/** What the session gives the guards for one run. */
export type RunContext = {
  /**
   * The blocking audit log's transport, for the audit hook: resolves once the root has written the entry as an `audit`
   * event on the Worker's open stream; rejects on a refusal (the run ended, the Worker went), a closed channel or a
   * timeout. The hook must not let the call run unless this resolved.
   */
  audit(entry: AuditEntry): Promise<void>
  /**
   * For the defer hook (src/guards/defer.ts, N16): resolves true once the main agent's current turn holds `toolUseId`
   * as its only tool call and the model's message that carried it is complete; false when it holds others too, or when
   * neither is known within `withinMs` (the hook fires as soon as its block is streamed, before the run loop has read
   * the blocks after it). Completeness needs stream events (`includePartialMessages`, on since M2-Q and never sent to
   * the Worker; src/session/core.ts `TurnToolUses.lone`). Never rejects.
   */
  loneToolCall(toolUseId: string, withinMs: number): Promise<boolean>
}
