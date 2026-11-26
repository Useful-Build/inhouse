// Stage 1 plan, M2-F: the server's stages are retired, so ReadGateway's own write refusal is the barrier that stands
// between a run (or the server) and an outside write. These tests pin that it never depended on a stage. Ways it can
// fail, written first:
//  1. a hub source file reads a stage (a setting, a parameter, the server's stage module), so the refusal could open
//     with one;
//  2. a known Slack write, called by a run or by the server with any arguments, answers anything but write_refused, or
//     reaches the upstream.
// `callReadyTool` is what `ReadGateway.callTool` runs (index.ts); the write list below is a literal copy, never read
// from the module under test.
import { fc, test } from '@fast-check/vitest'
import { globSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { callReadyTool } from '../registry/registry'
import { codeOf, connect, readyDeps, RUN, SERVER, world } from '../oauth/testing/kit'

beforeEach(() => void vi.spyOn(console, 'log').mockImplementation(() => {}))
afterEach(() => vi.restoreAllMocks())

const SLACK_WRITES = [
  'slack_send_message', 'slack_schedule_message', 'slack_send_message_draft', 'slack_add_reaction', 'slack_create_conversation',
  'slack_create_canvas', 'slack_update_canvas', 'slack_create_list', 'slack_update_list', 'slack_add_list_record',
  'slack_update_list_record', 'slack_get_file_upload_url', 'slack_complete_file_upload',
]

describe('ReadGateway refuses writes with no stage anywhere (M2-F)', () => {
  it('no hub source file reads a stage', () => {
    const root = fileURLToPath(new URL('..', import.meta.url).href)
    const files = globSync('**/*.ts', { cwd: root, exclude: f => f === 'node_modules' || f.endsWith('.test.ts') || f === 'worker-configuration.d.ts' })
    expect(files.length).toBeGreaterThan(20)
    // "Stage 1" (the build plan's name) in a comment is not a stage read.
    const hits = files.filter(f => /\bstages?\b(?!\s*\d)|brandStage|server\/stage\//i.test(readFileSync(join(root, f), 'utf8')))
    expect(hits).toEqual([])
  })

  test.prop([fc.constantFrom(...SLACK_WRITES), fc.constantFrom(RUN, SERVER), fc.dictionary(fc.string(), fc.jsonValue())])(
    'a known Slack write is write_refused for a run and for the server, with no upstream request',
    async (name, scope, args) => {
      const w = world()
      await connect(w)
      const before = w.slack.requests.length
      expect(codeOf(await callReadyTool(readyDeps(w), scope, name, args))).toBe('write_refused')
      expect(w.slack.requests.length).toBe(before)
    },
  )
})
