// evals/probe.ts, the eval host's lock probe. Ways it could fail, written down first:
//  1. it passes while the Worker answers anonymous calls itself (no lock in front);
//  2. it passes when Access refuses the service token, or when the Worker refuses the person (Access replaced the test
//     issuer's header), or when the brand isn't the eval brand;
//  3. the anonymous call carries a credential, or the signed one lacks the service token or the person token;
//  4. a secret or a token reaches a failure message.
import { generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { probeEvalLock } from './probe.ts'

const SECRET = 'eval-ci-secret-SHOULD-NOT-PRINT'
const keyFile = (() => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const dir = mkdtempSync(join(tmpdir(), 'probe-key-'))
  const file = join(dir, 'issuer-private.json')
  writeFileSync(file, JSON.stringify({ ...privateKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256' }))
  return file
})()
const ENV = {
  INHOUSE_EVAL_ORIGIN: 'https://eval.example.test', INHOUSE_EVAL_AUD: 'a'.repeat(64), INHOUSE_EVAL_ISSUER_JWK_FILE: keyFile,
  INHOUSE_EVAL_ACCESS_CLIENT_ID: 'id.access', INHOUSE_EVAL_ACCESS_CLIENT_SECRET: SECRET,
}
const workerJson = (status: number) => new Response(JSON.stringify({ error: { code: 'unauthorized' } }), { status, headers: { 'content-type': 'application/json' } })
const accessLogin = () => new Response('', { status: 302, headers: { location: 'https://team.cloudflareaccess.com/cdn-cgi/access/login/eval.example.test?kid=x' } })
const accessBlock = () => new Response('<html>Forbidden</html>', { status: 403, headers: { 'content-type': 'text/html' } })
const me = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
const notFound = () => new Response(JSON.stringify({ error: { code: 'not_found' } }), { status: 404, headers: { 'content-type': 'application/json' } })

/** A fake edge: `anon` answers a call with no service token, `signed` one with it. Records each call's headers. */
function edge(anon: () => Response, signed: () => Response, stop: () => Response = notFound) {
  const seen: Record<string, string>[] = []
  const f = (async (_url: string, init?: RequestInit) => {
    const h = (init?.headers ?? {}) as Record<string, string>
    seen.push(h)
    if (!h['CF-Access-Client-Id']) return anon()
    // The stop path (POST /api/turns/<id>/stop): a made-up turn answers 404 once signed in.
    return init?.method === 'POST' ? stop() : signed()
  }) as unknown as typeof fetch
  return { f, seen }
}

describe('the eval lock probe', () => {
  it('passes when Access refuses the anonymous call and lets the token and an eval person in', async () => {
    for (const refusal of [accessLogin, accessBlock]) {
      const e = edge(refusal, () => me({ evalBrand: true }))
      expect(await probeEvalLock(ENV, e.f)).toEqual([])
      // 3: the anonymous call carries nothing; the signed one the token and the person JWT in both headers.
      expect(e.seen[0]).toEqual({})
      expect(e.seen[1]).toMatchObject({ 'CF-Access-Client-Id': 'id.access', 'CF-Access-Client-Secret': SECRET })
      expect(e.seen[1]!['Cf-Access-Jwt-Assertion']).toMatch(/^ey/)
      expect(e.seen[1]!['X-Inhouse-Test-Assertion']).toBe(e.seen[1]!['Cf-Access-Jwt-Assertion'])
    }
  })
  it('fails when the Worker answers the anonymous call itself: no lock in front (1)', async () => {
    const f = await probeEvalLock(ENV, edge(() => workerJson(401), () => me({ evalBrand: true })).f)
    expect(f).toEqual([expect.stringMatching(/reached the Worker \(401\): nothing refuses it at the edge/)])
  })
  it('fails on a refused token, a refused person or a brand that is not the eval brand (2)', async () => {
    expect(await probeEvalLock(ENV, edge(accessLogin, accessBlock).f)).toEqual([expect.stringMatching(/refused at the edge \(403\): Access didn't take the service token/)])
    expect(await probeEvalLock(ENV, edge(accessLogin, () => workerJson(401)).f)).toEqual([expect.stringMatching(/Access likely replaced the test issuer's Cf-Access-Jwt-Assertion/)])
    expect(await probeEvalLock(ENV, edge(accessLogin, () => me({ evalBrand: false })).f)).toEqual([expect.stringMatching(/without evalBrand: true/)])
  })
  it('refuses without the service token or the origin, before any call, naming the variables only (4)', async () => {
    let calls = 0
    const f = (async () => { calls++; return accessLogin() }) as unknown as typeof fetch
    const { INHOUSE_EVAL_ACCESS_CLIENT_ID: _id, ...noId } = ENV
    await expect(probeEvalLock(noId, f)).rejects.toThrow(/INHOUSE_EVAL_ACCESS_CLIENT_ID and INHOUSE_EVAL_ACCESS_CLIENT_SECRET are not both set/)
    const { INHOUSE_EVAL_ORIGIN: _o, ...noOrigin } = ENV
    await expect(probeEvalLock(noOrigin, f)).rejects.toThrow(/INHOUSE_EVAL_ORIGIN is not set/)
    expect(calls).toBe(0)
    const { INHOUSE_EVAL_ACCESS_CLIENT_ID: _i, ...noIdButSecret } = ENV
    await expect(probeEvalLock(noIdButSecret, f)).rejects.not.toThrow(new RegExp(SECRET))
  })
  it('no failure names the secret or a token (4)', async () => {
    for (const [anon, signed] of [[() => workerJson(401), () => workerJson(401)], [accessBlock, accessBlock]] as const) {
      const f = await probeEvalLock(ENV, edge(anon, signed).f)
      expect(f.join(' ')).not.toContain(SECRET)
      expect(f.join(' ')).not.toMatch(/ey[A-Za-z0-9_-]{20,}/)
    }
  })
})

// The first paid baseline died on a refused POST /api/turns/<id>/stop (the stop path every case's reset takes). The probe
// now makes that call for a made-up turn, no spend: signed in, it answers 404; refused, the probe fails before any money.
describe('the probe\'s stop-path call', () => {
  it('passes on 404 not_found, sends the token, the person and the origin, and names a well-formed made-up turn', async () => {
    const e = edge(accessLogin, () => me({ evalBrand: true }))
    const calls: { url: string; init?: RequestInit }[] = []
    const f = (async (url: string, init?: RequestInit) => { calls.push({ url, init }); return e.f(url, init) }) as unknown as typeof fetch
    expect(await probeEvalLock(ENV, f)).toEqual([])
    const stop = calls.find((c) => c.init?.method === 'POST')!
    expect(stop.url).toMatch(/^https:\/\/eval\.example\.test\/api\/turns\/t_[A-Za-z0-9_-]{22}\/stop$/)
    const h = stop.init!.headers as Record<string, string>
    expect(h).toMatchObject({ 'CF-Access-Client-Id': 'id.access', Origin: 'https://eval.example.test', 'Content-Type': 'application/json' })
    expect(h['X-Inhouse-Test-Assertion']).toMatch(/^ey/)
  })
  it('fails when the stop path is refused (401 from the Worker, or the edge)', async () => {
    expect(await probeEvalLock(ENV, edge(accessLogin, () => me({ evalBrand: true }), () => workerJson(401)).f)).toEqual([expect.stringMatching(/POST \/api\/turns\/<made-up>\/stop answered 401/)])
    expect(await probeEvalLock(ENV, edge(accessLogin, () => me({ evalBrand: true }), accessBlock).f)).toEqual([expect.stringMatching(/POST \/api\/turns\/<made-up>\/stop answered 403/)])
  })
})
