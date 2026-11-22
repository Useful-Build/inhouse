// A fake `fetch` for the real client's tests: answers by "METHOD path" (query included); a request nobody answers is a test
// mistake and throws. `reads` is what a brand Admin's first load asks, with every P3 read answered.
import { CAN_KEYS } from '../../../../shared/contract/keys'

export const iso = (ms: number) => ({ iso: new Date(ms).toISOString(), ms })
const can = (on: boolean) => Object.fromEntries(CAN_KEYS.map(k => [k, on]))
// Capital S: a quoted snake_case name in src/ reads as an icon name to scripts/check-icons.mjs (test files are skipped, this one isn't).
export const ME_ID = 'm_Sam'
export const me = (o: Record<string, unknown> = {}) => ({ memberId: ME_ID, name: 'Sam Mercer', email: 'sam@example.test', role: 'admin', can: can(true), photoUrl: null, grant: null, ...o })
export const record = (key: string, value: unknown, rev: number) => ({ key, value, rev, updatedAt: null, updatedBy: null })

export type Req = { method: string; path: string; headers: Record<string, string>; body: string | undefined }
export type Answer = { status?: number; body?: unknown; text?: string }
export type Routes = Record<string, Answer | ((r: Req) => Answer)>

export function server(routes: Routes) {
  const calls: Req[] = []
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(String(input), 'http://x.test')
    const req: Req = { method: init?.method ?? 'GET', path: decodeURIComponent(url.pathname) + url.search, headers: (init?.headers ?? {}) as Record<string, string>, body: typeof init?.body === 'string' ? init.body : undefined }
    calls.push(req)
    const route = routes[`${req.method} ${req.path}`]
    if (!route) throw new Error(`no answer for ${req.method} ${req.path}`)
    const a = typeof route === 'function' ? route(req) : route
    return new Response(a.text ?? JSON.stringify(a.body ?? {}), { status: a.status ?? 200 })
  }
  return { fetch, calls }
}
export const refusal = (status: number, code: string, extra: Record<string, unknown> = {}): Answer => ({ status, body: { error: { code, ...extra } } })

export const usage = (o: Record<string, unknown> = {}) => ({
  month: 'November', cap: { minor: 32000, currency: 'USD' }, alertAt: 80, total: { minor: 1000, currency: 'USD' }, conversations: 1, questionsAsked: 1, jobsRun: 0,
  daily: [], breakdown: { person: [], job: [], model: [], tool: [] }, monthKey: '2026-11', months: ['2026-11'], capReached: false, ...o,
})
export const ALL_MODELS = [
  { id: 'fable', label: 'Max', model: 'Fable 5.2', sub: 'Hardest problems and long jobs · costs most', effort: 'high' },
  { id: 'opus', label: 'Smart', model: 'Opus 5.5', sub: 'Best for most work', effort: 'medium' },
  { id: 'sonnet', label: 'Fast', model: 'Sonnet 5.5', sub: 'Quick answers, still thinks well · half the cost', effort: 'medium' },
  { id: 'haiku', label: 'Instant', model: 'Haiku 5.5', sub: 'Simple lookups and sorting · costs least', effort: 'low' },
]

export const chatRow = (id: string, o: Record<string, unknown> = {}) => ({ id, title: `Chat ${id}`, customTitle: null, pinned: false, deleted: false, at: iso(1000), rev: 1, running: false, ...o })

export const reads = (o: { chats?: unknown[]; models?: unknown; usage?: unknown; pause?: unknown; activity?: unknown[]; notifications?: unknown[]; library?: unknown[]; routines?: unknown; today?: unknown } = {}): Record<string, Answer> => ({
  'GET /api/me': { body: me() },
  'GET /api/settings/personal': { body: { items: [] } },
  'GET /api/settings/brand': { body: { items: [] } },
  'GET /api/settings/technical': { body: { items: [] } },
  'GET /api/members': { body: { items: [], nextCursor: null } },
  'GET /api/grants': { body: { items: [] } },
  'GET /api/audit': { body: { items: [], nextCursor: null } },
  'GET /api/memory': { body: { team: [], personal: [] } },
  'GET /api/activity?limit=100': { body: { items: o.activity ?? [], nextCursor: null } },
  'GET /api/notifications': { body: { items: o.notifications ?? [] } },
  'GET /api/library?limit=100': { body: { items: o.library ?? [], nextCursor: null } },
  'GET /api/chats?limit=50': { body: { items: o.chats ?? [], nextCursor: null } },
  'GET /api/models': { body: o.models ?? { default: 'opus', modes: ALL_MODELS } },
  'GET /api/usage': { body: o.usage ?? usage() },
  'GET /api/pause': { body: o.pause ?? { paused: false, at: null, by: null } },
  // P4 W2: route 52.
  'GET /api/routines': { body: o.routines ?? { routines: [], deleted: [], enabled: {} } },
  // P4 W3: route 57.
  'GET /api/today': { body: o.today ?? { items: [], aside: {} } },
})
