// The local channel. Ways it could fail: the run token rides over it; a session can send `started` (the root's own);
// garbage parses; a huge SDK message is passed through whole.
import { fc, it } from '@fast-check/vitest'
import { describe, expect } from 'vitest'
import { RootMessage, RunConfig, capSdkMessage, parseSessionMessage } from '../../src/protocol/local.ts'
import { runStart } from '../run/support/root-client.ts'

describe('the local channel', () => {
  it('a run message with a runToken is refused', () => {
    const { runToken, ...config } = runStart()
    expect(RootMessage.safeParse({ type: 'run', config }).success).toBe(true)
    expect(RootMessage.safeParse({ type: 'run', config: { ...config, runToken } }).success).toBe(false)
    expect(Object.keys(RunConfig.shape)).not.toContain('runToken')
  })

  it('a session cannot send started', () => {
    const r = parseSessionMessage({ type: 'event', event: { type: 'started', sessionId: runStart().sessionId, resume: false } })
    expect(r.ok).toBe(false)
  })

  it.prop([fc.anything()])('anything that is not a session message is refused without throwing', (raw) => {
    const r = parseSessionMessage(raw)
    if (r.ok) expect(['ready', 'event']).toContain(r.message.type)
  })

  it.prop([fc.dictionary(fc.string(), fc.jsonValue()), fc.integer({ min: 10, max: 2000 })])(
    'capSdkMessage keeps a message within the cap whole, and stubs a bigger one',
    (message, cap) => {
      const out = capSdkMessage(message, cap)
      const bytes = Buffer.byteLength(JSON.stringify(message))
      if (bytes <= cap) expect(out).toEqual({ message, truncated: false })
      else {
        expect(out.truncated).toBe(true)
        expect(out.message.bytes).toBe(bytes)
        expect(Buffer.byteLength(JSON.stringify(out.message))).toBeLessThan(200)
      }
    },
  )
})
