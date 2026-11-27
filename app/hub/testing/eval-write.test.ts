// EvalWriteGateway's source rules (Stage 1 M3-R, N30): it holds no credential and makes no outside request, and only the
// test build's main module exports it. Ways it could fail, written down first:
//  1. the gateway's module reaches the network (`fetch(`, a socket) or reads any binding but its log's D1 (a token key,
//     a client secret, a SignIn object);
//  2. it imports a connector, the SignIn objects or the test upstreams (a path to a real or fake store);
//  3. the deployable main module exports it, or the test build's main module stops exporting it (or anything the
//     deployable one exports).
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const src = (rel: string): string => readFileSync(join(import.meta.dirname, rel), 'utf8')
const code = (text: string) => text.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '')

describe('EvalWriteGateway holds nothing and reaches nothing (failures 1 and 2)', () => {
  const gateway = code(src('./eval-write.ts'))
  it('makes no outside request', () => {
    for (const needle of ['fetch(', 'fetch,', 'connect(', 'WebSocket', 'XMLHttpRequest', 'import(']) expect(gateway).not.toContain(needle)
  })
  it('reads no binding but EVAL_WRITE_LOG, and names no credential', () => {
    expect([...gateway.matchAll(/env\.([A-Za-z_]+)/g)].map(m => m[1])).toEqual(['EVAL_WRITE_LOG'])
    // The hub's credential names (HUB_TOKEN_KEYS, *_CLIENT_SECRET, the SignIn objects that hold tokens) and the generic ones.
    expect(gateway).not.toMatch(/secret|token|password|private|signin|api_?key|client_?id|authorization|bearer/i)
  })
  it('imports only the runtime\'s entrypoint class, the contract\'s types and its request schema', () => {
    const imports = [...gateway.matchAll(/from '([^']+)'/g)].map(m => m[1]).sort()
    expect(imports).toEqual(['../index/contract.js', '../index/schemas.js', 'cloudflare:workers'])
  })
})

describe('only the test build exports it (failure 3)', () => {
  it('the deployable main module never names it; the test build\'s main re-exports everything and adds it', () => {
    expect(src('../index/index.ts')).not.toContain('EvalWriteGateway')
    const entry = code(src('./entry/index.ts'))
    expect(entry).toContain("export * from '../../index/index'")
    expect(entry).toContain("export { default } from '../../index/index'")
    expect(entry).toContain("export { EvalWriteGateway } from '../eval-write'")
  })
  it('the test config builds from that main module, and the deployable config from its own', () => {
    expect(src('../../wrangler.hub.test.jsonc')).toMatch(/\n\t"main": "hub\/testing\/entry\/index\.ts",\n/)
    expect(src('../../wrangler.hub.jsonc')).toMatch(/\n\t"main": "hub\/index\/index\.ts",\n/)
  })
})
