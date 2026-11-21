// The runner harness's guards (harness/src/guards.ts). Ways it could fail, written first:
// - a deployed copy (no local-only var, or a wrong value) still serves the scripted model;
// - the model route hands the scripted model the run token or a credential the call carried.
import { fc, it } from '@fast-check/vitest'
import { describe, expect } from 'vitest'
import { LOCAL_ONLY_VAR, forScriptedModel, localOnlyRefusal } from '../../harness/src/guards.ts'

describe('the runner harness', () => {
  it.prop([fc.option(fc.string().filter((v) => v !== '1'), { nil: undefined })])('refuses unless the local-only var is "1"', (value) => {
    const res = localOnlyRefusal(value === undefined ? {} : { [LOCAL_ONLY_VAR]: value })
    expect(res?.status).toBe(403)
  })

  it('serves under `npm run dev` (the var set to "1")', () => {
    expect(localOnlyRefusal({ [LOCAL_ONLY_VAR]: '1' })).toBeNull()
  })

  it.prop([fc.string({ minLength: 1 }).filter((v) => /^[\x21-\x7e]+$/.test(v))])('the scripted model never sees the run token or a credential', async (secret) => {
    const call = new Request('http://egress.internal/model/v1/messages?beta=true', {
      method: 'POST',
      headers: { 'x-inhouse-run-token': secret, 'x-api-key': secret, authorization: `Bearer ${secret}`, 'anthropic-version': '2023-06-01' },
      body: '{"messages":[]}',
    })
    const out = forScriptedModel(call, '/v1/messages')
    expect(out.url).toBe('http://egress.internal/v1/messages?beta=true')
    expect([...out.headers.keys()].sort()).toEqual(['anthropic-version', 'content-type'])
    expect(await out.text()).toBe('{"messages":[]}')
  })
})
