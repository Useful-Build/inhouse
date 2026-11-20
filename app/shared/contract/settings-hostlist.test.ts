// The P3 technical keys (p3-design 4.9): `t:webfetch`'s host list and `t:max_turns`. Expected values are literals here
// or the runner protocol's own `Hostname` rule. Ways it can fail, written down first:
//  1. a host list the runner would refuse saves (every turn then fails to start), or a good one is refused;
//  2. an IP literal, a trailing dot, 51 hosts or 4,001 characters saves;
//  3. an empty value is refused (6.2: empty is the default, any public host);
//  4. the table (the mock's check) and the zod registry (the server's) disagree on a list.
import { fc, test } from '@fast-check/vitest'
import { describe, expect, it } from 'vitest'
import { RunStartFields } from '../protocol/index.ts'
import { meetsRule, settingRow } from './settings-table.ts'
import { settingSpec } from './settings.ts'

const saves = (v: unknown) => settingSpec('t:webfetch')!.value.safeParse(v).success
const protocolHost = RunStartFields.shape.webFetchDomains.unwrap().element
/** An IPv4 literal: four dotted numbers (the test's own pattern, not the code's). */
const ipv4 = (h: string) => /^\d{1,3}(\.\d{1,3}){3}$/.test(h)

describe('t:webfetch (failures 1-3)', () => {
  it('saves these lists', () => {
    for (const v of ['', 'example.com', 'example.com\ndocs.example.org', 'a-b.example.co.uk', 'x1.io']) expect(saves(v), JSON.stringify(v)).toBe(true)
  })
  it('refuses these', () => {
    for (const v of [
      'example.com.', 'Example.com', 'localhost', '10.0.0.1', '192.168.1.1', '[::1]', '::1', 'example.com:443', 'https://example.com',
      'example.com\n', '\nexample.com', 'a.com\n\nb.com', ' example.com', 'example.com ', 'exa_mple.com', '-a.com', 'a-.com',
      'example.com\r\ndocs.example.com', true, null,
    ]) expect(saves(v), JSON.stringify(v)).toBe(false)
  })
  it('takes 50 hosts and refuses 51', () => {
    const hosts = (n: number) => Array.from({ length: n }, (_, i) => `h${i}.example.com`).join('\n')
    expect(saves(hosts(50))).toBe(true)
    expect(saves(hosts(51))).toBe(false)
  })
  it('takes 4,000 characters and refuses 4,001', () => {
    // Hosts of 249 characters (three 63-character labels and one of 57); sixteen joined by newlines make 3,999.
    const host = (last: number) => ['a'.repeat(63), 'b'.repeat(63), 'c'.repeat(63), 'd'.repeat(last)].join('.')
    expect(host(57)).toHaveLength(249)
    const list = (longer: number) => Array.from({ length: 16 }, (_, i) => host(i < longer ? 58 : 57)).join('\n')
    expect(list(0)).toHaveLength(3999)
    expect(list(1)).toHaveLength(4000)
    expect(saves(list(1))).toBe(true)
    expect(saves(list(2))).toBe(false)
  })
  test.prop([fc.array(fc.oneof(
    fc.domain(), fc.constantFrom('10.0.0.1', 'example.com.', 'EXAMPLE.com', 'a..b', '', 'x'.repeat(64) + '.com', '1.2.3.4'),
  ), { minLength: 1, maxLength: 6 })])('a list saves exactly when the protocol takes each host and none is an IP literal', hosts => {
    const v = hosts.join('\n')
    const expected = v === '' || hosts.every(h => protocolHost.safeParse(h).success && !ipv4(h) && !/\.\d+$/.test(h))
    expect(saves(v), JSON.stringify(v)).toBe(expected)
    expect(meetsRule(settingRow('t:webfetch')!.rule, v), JSON.stringify(v)).toBe(expected)
  })
  it('is redacted in the log (free text)', () => expect(settingSpec('t:webfetch')!.auditSafe).toBe(false))
})

describe('t:max_turns', () => {
  it('takes 10, 25, 50 and 100 only, logged as it is', () => {
    const spec = settingSpec('t:max_turns')!
    for (const v of ['10', '25', '50', '100']) expect(spec.value.safeParse(v).success, v).toBe(true)
    for (const v of ['5', '200', 25, '']) expect(spec.value.safeParse(v).success, String(v)).toBe(false)
    expect([spec.scope, spec.auditSafe]).toEqual(['technical', true])
  })
})
