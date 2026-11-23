import { describe, expect, it } from 'vitest'
import { teardownContainers } from './containers.ts'

const runner = { id: 'runner', name: 'test_runner' }
const preview = { id: 'preview', name: 'test_preview_runner' }
const other = { id: 'other', name: 'testing_runner' }
const account = { id: 'a'.repeat(32), name: 'Test Brand Account' }

function scenario({ keep = false, deleteFails = false, invalidPage = false, lastPage = {} }: {
  keep?: boolean; deleteFails?: boolean; invalidPage?: boolean; lastPage?: Record<string, unknown>
} = {}) {
  let apps = [runner, other, preview]
  let time = 0
  const deleting = new Set<string>()
  const calls: string[] = []
  const reports: unknown[] = []
  const fetchApi = async (url: URL, init: RequestInit) => {
    if (init.method === 'DELETE') {
      const id = url.pathname.split('/').at(-1)!
      calls.push(`DELETE ${id}`)
      if (deleteFails && id === runner.id) return Response.json({ success: false }, { status: 403 })
      deleting.add(id)
      return Response.json({ success: true })
    }
    if (url.pathname === `/client/v4/accounts/${account.id}`) {
      calls.push('GET account')
      return Response.json({ success: true, result: account })
    }
    expect(url.pathname).toBe(`/client/v4/accounts/${account.id}/containers/applications`)
    expect(url.searchParams.get('per_page')).toBe('100')
    const next = url.searchParams.get('page_token')
    calls.push(`GET ${next ?? 'first'}`)
    return Response.json({
      success: true, result: next ? apps.slice(1) : apps.slice(0, 1),
      result_info: { next_page_token: invalidPage || !next ? 'next' : '', ...(next ? lastPage : {}) },
    })
  }
  const run = (options: Partial<Parameters<typeof teardownContainers>[0]> = {}) => teardownContainers({
    accountId: account.id, expectAccountName: account.name, expectIds: [preview.id, runner.id],
    prefix: 'test_', brand: 'test', approvedBy: 'Test Admin',
    apply: true, token: 'fake-auth', fetchApi, report: (entry: unknown) => reports.push(entry),
    now: () => time, wait: async () => {
      time += 60_000
      if (!keep) apps = apps.filter(app => !deleting.has(app.id))
      deleting.clear()
    },
    ...options,
  })
  return { run, calls, reports, setApps: (next: typeof apps) => { apps = next } }
}

describe('container teardown with a fake Cloudflare API', () => {
  it('lists every page before deleting each scoped application and verifies async deletion', async () => {
    const { run, calls, reports } = scenario()
    await run()
    expect(calls).toEqual(['GET account', 'GET first', 'GET next', 'DELETE runner', 'DELETE preview', 'GET first', 'GET next', 'GET first', 'GET next'])
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
    await run({ prefix: undefined, allInDedicatedAccount: true, expectIds: [runner.id, other.id, preview.id] })
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
    await expect(run()).rejects.toMatchObject({
      message: 'Container teardown failed',
      errors: expect.arrayContaining([expect.objectContaining({
        message: 'Delete failed for test_runner (runner)', cause: expect.objectContaining({ code: 403 }),
      })]),
    })
    expect(calls).toContain('DELETE preview')
    expect(reports.at(-1)).toMatchObject({ phase: 'after', applications: [runner, preview] })
  })

  it.each(['House', ' house ', ' HOUSE '])('requires house approval for %j and reports the canonical brand', async brand => {
    const { run, calls, reports } = scenario()
    await expect(run({ brand })).rejects.toThrow('approval for house')
    expect(calls).toEqual([])
    await run({ brand, houseApproved: true })
    expect(reports.every(report => (report as { brand: string }).brand === 'house')).toBe(true)
  })

  it('only lists in a dry run and requires approval before any calls for a deletion', async () => {
    const { run, calls } = scenario()
    await expect(run({ approvedBy: undefined })).rejects.toThrow('written Admin approval')
    await expect(run({ brand: 'house' })).rejects.toThrow('approval for house')
    await expect(run({ expectIds: undefined })).rejects.toThrow('--expect-ids')
    await expect(run({ apply: false, expectAccountName: undefined })).rejects.toThrow('--expect-account-name')
    expect(calls).toEqual([])
    await run({ apply: false, approvedBy: undefined, expectIds: undefined })
    expect(calls).toEqual(['GET account', 'GET first', 'GET next'])
  })

  it.each([false, true])('refuses an account with a different name (apply=%s)', async apply => {
    const { run, calls } = scenario()
    await expect(run({ apply, expectAccountName: 'Some Other Account' })).rejects.toThrow('account does not match')
    expect(calls).toEqual(['GET account'])
  })

  it.each([
    ['added', [runner, preview, { id: 'new', name: 'test_new_runner' }]],
    ['removed', [runner]],
    ['replaced', [runner, { ...preview, id: 'new' }]],
  ] as const)('deletes nothing if a scoped ID was %s after review', async (_change, freshApps) => {
    const { run, calls, setApps } = scenario()
    await run({ apply: false, expectIds: undefined })
    setApps([...freshApps])
    await expect(run()).rejects.toThrow('application IDs differ')
    expect(calls).toEqual(['GET account', 'GET first', 'GET next', 'GET account', 'GET first', 'GET next'])
  })

  it('deletes nothing when pagination cannot be verified', async () => {
    const { run, calls } = scenario({ invalidPage: true })
    await expect(run()).rejects.toThrow('invalid page token')
    expect(calls).toEqual(['GET account', 'GET first', 'GET next'])
  })

  it.each([
    { page: 2, total_pages: 3 },
    { total_count: 4 },
    { cursor: 'next' },
    { cursors: { after: 'next' } },
  ])('refuses a partial inventory indicated by %j without a page token', async lastPage => {
    const { run, calls, reports } = scenario({ lastPage })
    await expect(run()).rejects.toThrow('inventory is incomplete')
    expect(calls).toEqual(['GET account', 'GET first', 'GET next'])
    expect(reports).toEqual([])
  })

  it('accepts complete count-based metadata, including out-of-scope applications', async () => {
    const { run, reports } = scenario({ lastPage: { page: 2, total_pages: 2, total_count: 3 } })
    await run({ apply: false })
    expect(reports).toEqual([{ phase: 'before', brand: 'test', applications: [runner, preview] }])
  })
})
