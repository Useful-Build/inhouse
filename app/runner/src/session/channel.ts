// The session's end of the local channel: NDJSON on two inherited descriptors, fd 3 to the root and fd 4 from it (the
// root spawns the session with `stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe']`). No Node IPC channel, so nothing
// the session sends is parsed by Node's own channel code in the root.
//
// Keeping fds 3 and 4 away from the CLI and its tools. They're inherited, so they aren't close-on-exec here, and on
// Linux libuv doesn't close inherited descriptors when it spawns (macOS's posix_spawn does). They're socketpairs, which
// can't be re-opened close-on-exec through /dev/fd. So the CLI is spawned through `spawnCli` (the SDK's
// `spawnClaudeCodeProcess` hook), which puts /dev/null on fds 3 and 4 of the CLI: neither the CLI nor anything it
// starts can write to the root or read what it sends. No zod here, so a plain-Node fixture can import it.
import { spawn } from 'node:child_process'
import { openSync } from 'node:fs'
import net from 'node:net'
import type { SpawnOptions, SpawnedProcess } from '@anthropic-ai/claude-agent-sdk'
import { LOCAL_LINE_MAX_BYTES, LineReader, encodeLine, type LineResult } from '../protocol/ndjson.ts'

export const TO_ROOT_FD = 3
export const FROM_ROOT_FD = 4

export type RootChannel = {
  send(message: unknown): void
  /** Every line from the root, parsed, or the one error that ends the channel. Lines that came early are queued. */
  onMessage(handler: (line: LineResult) => void): void
  /** Flushes what was sent, then closes both descriptors. */
  close(): Promise<void>
}

export function openRootChannel(maxLineBytes: number = LOCAL_LINE_MAX_BYTES): RootChannel {
  const out = new net.Socket({ fd: TO_ROOT_FD, readable: false, writable: true })
  const inp = new net.Socket({ fd: FROM_ROOT_FD, readable: true, writable: false })
  // The root went away: nothing more can be said; the root decides the run's end from how this process exits.
  out.on('error', (e) => process.stderr.write(`session: channel to the root failed: ${e.message}\n`))
  inp.on('error', (e) => process.stderr.write(`session: channel from the root failed: ${e.message}\n`))

  const reader = new LineReader(maxLineBytes)
  const queued: LineResult[] = []
  let handler: ((line: LineResult) => void) | null = null
  const deliver = (lines: LineResult[]) => {
    for (const l of lines) {
      if (handler) handler(l)
      else queued.push(l)
    }
  }
  inp.on('data', (chunk: Buffer) => deliver(reader.push(chunk)))
  inp.on('end', () => deliver(reader.end()))

  return {
    send: (m) => void out.write(encodeLine(m)),
    onMessage(h) {
      handler = h
      for (const l of queued.splice(0)) h(l)
    },
    close: () =>
      new Promise<void>((resolve) => {
        inp.destroy()
        out.end(() => resolve())
      }),
  }
}

let devNull: number | undefined

/**
 * Spawns the CLI the way the SDK's own local spawn does, except: fds 3 and 4 are /dev/null (see the top of this file),
 * and stderr goes to the session's stderr (the root keeps its tail), since the SDK reads no stderr from a custom spawn.
 */
export function spawnCli(options: SpawnOptions): SpawnedProcess {
  devNull ??= openSync('/dev/null', 'r+')
  return spawn(options.command, options.args, {
    cwd: options.cwd,
    env: options.env,
    signal: options.signal,
    stdio: ['pipe', 'pipe', 'inherit', devNull, devNull],
    windowsHide: true,
  }) as SpawnedProcess
}
