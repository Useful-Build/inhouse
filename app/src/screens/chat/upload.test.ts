// The files a message carries, from the composer's chips to the ids route 29 takes. Ways it could break, written first:
//  - a sent turn names an id the client made up (the real client's ids come from route 39's answer only), or an id for the
//    wrong file (order lost, a refused file's slot taken by its neighbour);
//  - a refused file is sent anyway, or stops the files after it from uploading, or its reason is lost;
//  - a fault that isn't a refusal (offline, signed out) is swallowed and the message goes without the file;
//  - a cancel is shown as a refusal;
//  - a retry uploads a file that already has its id a second time;
//  - a chip whose File is gone (a reload) is sent as if it were kept.
import { fc, test as fcTest } from '@fast-check/vitest'
import { describe, expect, test } from 'vitest'
import { UploadCancelled } from '../../agent/http/files'
import { AgentError } from '../../agent/types'
import type { Attachment } from '../../agent/types'
import { uploadPending } from './upload'

const att = (name: string, o: Partial<Attachment> = {}): Attachment => ({ name, meta: '1 KB', icon: 'description', ...o })
const SERVER = (name: string) => `f_SRV${name.replace(/\W/g, '').padEnd(19, 'x').slice(0, 19)}`
const files = (names: string[]) => new Map(names.map(n => [`p_${n}`, new File(['x'], n)]))

function deps(over: Partial<Parameters<typeof uploadPending>[1]> = {}, names: string[] = []) {
  const kept = files(names)
  const calls: string[] = []
  return {
    calls,
    deps: {
      fileOf: (id: string) => kept.get(id),
      upload: async (f: File) => { calls.push(f.name); return { fileId: SERVER(f.name), name: f.name } },
      signal: new AbortController().signal,
      ...over,
    },
  }
}
const pend = (n: string) => att(n, { pending: `p_${n}` })

describe('uploadPending', () => {
  test('a sent turn carries the server ids, in the chips order', async () => {
    const d = deps({}, ['a.csv', 'b.pdf'])
    const r = await uploadPending([pend('a.csv'), pend('b.pdf')], d.deps)
    expect(r.refs).toEqual([{ fileId: 'f_SRVacsvxxxxxxxxxxxxxxx', name: 'a.csv' }, { fileId: 'f_SRVbpdfxxxxxxxxxxxxxxx', name: 'b.pdf' }])
    expect(r.atts.map(a => a.fileId)).toEqual(r.refs.map(x => x.fileId))
    expect(r.atts.every(a => a.pending === undefined)).toBe(true)
    expect(r.refused).toEqual([])
  })

  test('a chip that already has its id is sent as it is and not uploaded again', async () => {
    const d = deps({}, ['b.pdf'])
    const r = await uploadPending([att('a.csv', { fileId: 'f_ALREADYALREADYALREADY' }), pend('b.pdf')], d.deps)
    expect(d.calls).toEqual(['b.pdf'])
    expect(r.refs.map(x => x.fileId)).toEqual(['f_ALREADYALREADYALREADY', SERVER('b.pdf')])
  })

  test('a refused file is dropped with the server reason; the others still go, in order', async () => {
    const d = deps({
      upload: async (f: File) => {
        if (f.name === 'big.csv') throw new AgentError('invalid', 'x', { reason: 'too_large' })
        return { fileId: SERVER(f.name), name: f.name }
      },
    }, ['a.csv', 'big.csv', 'c.csv'])
    const r = await uploadPending([pend('a.csv'), pend('big.csv'), pend('c.csv')], d.deps)
    expect(r.refs.map(x => x.name)).toEqual(['a.csv', 'c.csv'])
    expect(r.atts.map(a => a.name)).toEqual(['a.csv', 'c.csv'])
    expect(r.refused).toEqual([{ att: expect.objectContaining({ name: 'big.csv' }), text: 'big.csv is over the 20 MB limit.' }])
  })

  test.each([
    ['offline', new AgentError('offline', 'x')],
    ['unauthorized', new AgentError('unauthorized', 'x')],
    ['not_found', new AgentError('not_found', 'x')],
    ['unavailable', new AgentError('unavailable', 'x')],
  ])('a %s fault rejects the whole send and the later files are not tried', async (_n, err) => {
    const d = deps({ upload: async () => { throw err } }, ['a.csv', 'b.csv'])
    await expect(uploadPending([pend('a.csv'), pend('b.csv')], d.deps)).rejects.toBe(err)
  })

  test('a cancel rejects as cancelled, not as a refusal', async () => {
    const err = new UploadCancelled()
    const d = deps({ upload: async () => { throw err } }, ['a.csv'])
    await expect(uploadPending([pend('a.csv')], d.deps)).rejects.toBe(err)
  })

  test('a chip whose File is gone is refused with words, not sent', async () => {
    const d = deps({}, [])
    const r = await uploadPending([pend('gone.csv')], d.deps)
    expect(r.refs).toEqual([])
    expect(r.refused[0]!.text).toBe('gone.csv is no longer attached. Attach it again.')
    expect(d.calls).toEqual([])
  })

  test('nothing pending, nothing uploaded', async () => {
    const d = deps()
    expect((await uploadPending([], d.deps))).toEqual({ atts: [], refs: [], refused: [] })
    expect(d.calls).toEqual([])
  })

  fcTest.prop([fc.uniqueArray(fc.stringMatching(/^[a-z]{1,8}\.csv$/), { minLength: 0, maxLength: 10 }), fc.array(fc.boolean(), { maxLength: 10 })])(
    'whatever is refused: refs are exactly the accepted files in order, each with the id the server gave that file',
    async (names, refuse) => {
      const refusedNames = new Set(names.filter((_, i) => refuse[i]))
      const d = deps({
        upload: async (f: File) => {
          if (refusedNames.has(f.name)) throw new AgentError('invalid', 'x', { reason: 'type_not_allowed' })
          return { fileId: SERVER(f.name), name: f.name }
        },
      }, names)
      const r = await uploadPending(names.map(pend), d.deps)
      const accepted = names.filter(n => !refusedNames.has(n))
      expect(r.refs).toEqual(accepted.map(n => ({ fileId: SERVER(n), name: n })))
      expect(r.refused.map(x => x.att.name)).toEqual([...refusedNames].sort((a, b) => names.indexOf(a) - names.indexOf(b)))
    },
  )
})
