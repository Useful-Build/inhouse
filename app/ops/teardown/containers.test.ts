import { describe, expect, it } from 'vitest'
import { teardownContainers } from './containers.ts'

const runner = { id: 'runner', name: 'test_runner' }
const preview = { id: 'preview', name: 'test_preview_runner' }
const other = { id: 'other', name: 'testing_runner' }

function scenario({ keep = false, deleteFails = false, invalidPage = false } = {}) {
  let apps = [runner, other, preview]
  let time = 0
  const deleting = new Set<string>()
  const calls: string[] = []
  const reports: unknown[] = []
  const fetchApi = async (url: URL, init: RequestInit) => {
    if (init.method === 'DELETE') {
      const id = url.pathname.split('/').at(-1)!
      calls.push(`DELETE ${id}`)
      if (deleteFails && id === runner.id) return Response.json({ success: false })
      deleting.add(id)
      return Response.json({ success: true })
    }
    const next = url.searchParams.get('page_token')
    calls.push(`GET ${next ?? 'first'}`)
    return Response.json({
      success: true, result: next ? apps.slice(1) : apps.slice(0, 1),
      result_info: { next_page_token: invalidPage || !next ? 'next' : '' },
    })
  }
  const run = (options: Partial<Parameters<typeof teardownContainers>[0]> = {}) => teardownContainers({
    accountId: 'a'.repeat(32), prefix: 'test_', brand: 'test', approvedBy: 'Test Admin',
    apply: true, token: 'fake-auth', fetchApi, report: (entry: unknown) => reports.push(entry),
    now: () => time, wait: async () => {
      time += 60_000
      if (!keep) apps = apps.filter(app => !deleting.has(app.id))
      deleting.clear()
    },
    ...options,
  })
  return { run, calls, reports }
}

describe('container teardown with a fake Cloudflare API', () => {
  it('lists every page before deleting each scoped application and verifies async deletion', async () => {
    const { run, calls, reports } = scenario()
    await run()
    expect(calls).toEqual(['GET first', 'GET next', 'DELETE runner', 'DELETE preview', 'GET first', 'GET next', 'GET first', 'GET next'])
    expect(reports).toEqual([
      { phase: 'before', brand: 'test', applications: [runner, preview] },
      { phase: 'after', brand: 'test', applications: [] },
    ])
  })

  it('deletes every app in a dedicated account, including apps without a deployment prefix', async () => {
    const { run, calls, reports } = scenario()
    await expect(run({ allInDedicatedAccount: true })).rejects.toThrow('Specify one scope')
    await expect(run({ prefix: undefined })).rejects.toThrow('Specify one scope')
    expect(calls).toEqual([])
    await run({ prefix: undefined, allInDedicatedAccount: true })
    expect(calls.filter(call => call.startsWith('DELETE'))).toEqual(['DELETE runner', 'DELETE other', 'DELETE preview'])
    expect(reports.at(-1)).toMatchObject({ phase: 'after', applications: [] })
  })

  it('fails with the names that remain after the verification deadline', async () => {
    const { run, reports } = scenario({ keep: true })
    await expect(run()).rejects.toMatchObject({ errors: [expect.objectContaining({ message: 'Container applications remain: test_runner, test_preview_runner' })] })
    expect(reports.at(-1)).toMatchObject({ phase: 'after', applications: [runner, preview] })
  })

  it('attempts every delete and reports leftovers when a delete fails', async () => {
    const { run, calls, reports } = scenario({ deleteFails: true })
    await expect(run()).rejects.toThrow('Container teardown failed')
    expect(calls).toContain('DELETE preview')
    expect(reports.at(-1)).toMatchObject({ phase: 'after', applications: [runner, preview] })
  })

  it('only lists in a dry run and requires approval before any calls for a deletion', async () => {
    const { run, calls } = scenario()
    await expect(run({ approvedBy: undefined })).rejects.toThrow('written Admin approval')
    await expect(run({ brand: 'house' })).rejects.toThrow('approval for house')
    expect(calls).toEqual([])
    await run({ apply: false, approvedBy: undefined })
    expect(calls).toEqual(['GET first', 'GET next'])
  })

  it('deletes nothing when pagination cannot be verified', async () => {
    const { run, calls } = scenario({ invalidPage: true })
    await expect(run()).rejects.toThrow('invalid page token')
    expect(calls).toEqual(['GET first', 'GET next'])
  })
})
