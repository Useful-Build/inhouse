// The per-session process limit. Ways it could fail, written first:
// - the guards stop pointing the SDK at the wrapper (a base can't set it, but the guards could drop it), so the CLI
//   runs with no limit;
// - the wrapper's number drifts from SESSION_PROCESS_LIMIT, or sets only the soft limit (Bash could raise it again);
// - the wrapper runs something other than the SDK's CLI, or drops the CLI's arguments.
// The limit itself (a fork bomb stops at it, and the uid's release still passes) is the container probe's.
import { readFileSync, statSync } from 'node:fs'
import { fc, it } from '@fast-check/vitest'
import { describe, expect } from 'vitest'
import { createQueryGuards } from '../../src/guards/options.ts'
import { CLI_WRAPPER, SESSION_PROCESS_LIMIT, sessionPaths, userPaths } from '../../src/guards/paths.ts'
import { baseOptions, cliEnv } from '../../src/session/core.ts'
import { sessionEnv } from '../../src/session/env.ts'
import { RunConfig } from '../../src/protocol/local.ts'

const wrapper = new URL('../../image/bin/claude', import.meta.url)
const text = readFileSync(wrapper, 'utf8')

describe('the CLI wrapper', () => {
  it('sets the soft and hard process limit to SESSION_PROCESS_LIMIT, then execs the linked CLI with every argument', () => {
    const lines = text.split('\n').filter((l) => l.trim() !== '' && !l.startsWith('#'))
    expect(text.startsWith('#!/bin/sh\n')).toBe(true)
    expect(lines).toEqual([`exec /usr/bin/prlimit --nproc=${SESSION_PROCESS_LIMIT}:${SESSION_PROCESS_LIMIT} -- /opt/inhouse/bin/claude-cli "$@"`])
    expect(statSync(wrapper).mode & 0o111).toBe(0o111)
    expect(CLI_WRAPPER).toBe('/opt/inhouse/bin/claude')
  })

  const chatId = fc.stringMatching(/^[A-Za-z0-9_-]{1,64}$/)
  it.prop([chatId])('the guards always start the CLI through it', (id) => {
    const c = RunConfig.parse({
      runId: 'r1', chatId: id, sessionId: '00000000-0000-4000-8000-000000000000', resume: false, prompt: 'hi', model: 'm', effort: 'low',
      maxTurns: 1, maxBudgetUsd: 1, webFetchDomains: [],
      fileCaps: { maxFileBytes: 1, maxFilesPerTurn: 1, maxRestoreBytes: 1, allowedTypes: [] },
    })
    const p = sessionPaths(id)
    const env = sessionEnv({ uid: 30001, gid: 30001, user: 's01', home: userPaths('s01').home, workDir: p.workDir }, 8081)
    const o = createQueryGuards({ hostAddresses: () => [] }).apply(baseOptions(c, p.workDir, cliEnv(env), new AbortController()), c, { audit: async () => {} })
    expect(o.pathToClaudeCodeExecutable).toBe(CLI_WRAPPER)
  })
})
