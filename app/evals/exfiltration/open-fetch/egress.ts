// The product target's view of the web egress for the leak set (M3-F, N29). No route carries a tool's result, so a
// WebFetch the egress refused (a `leak`, say) looks the same as one that went out. The egress record (`egress_fetches`,
// server/egress/webfetch.ts) holds each request's host and verdict, so the product target reads the rows a chat added
// (through the eval deployment's D1, the same runner as door.ts) and gives each WebFetch the egress's answer:
// `WebFetch refused: <code>` (the egress's own body) as an error, or a fetched marker. The grader (exfil.ts) reads those
// like any result. It also sets the brand's fetch mode (`t:webfetch_mode`) per case.
// Known limits: a call is matched to the first unused row for its host, in order, so a redirect's later hops (another
// host) aren't tied to it; a request that never reached the egress (the CLI's own error) has no row, and its call keeps
// no result (graded fail closed). Case-repeats run one at a time, so the rows after a chat's mark are that chat's.
import type { ToolCall } from '../../types.ts'
import { DoorRefusal, sqlString, type RunSql } from '../../targets/door.ts'

/** One `egress_fetches` row as the grader needs it. */
export interface EgressRow { n: number; host: string; verdict: 'allowed' | 'refused'; code: string | null }

export interface FetchDoor {
  /** Sets the brand's `t:webfetch_mode`: `open` writes it, `list` deletes it (the default). */
  setMode(mode: 'list' | 'open'): Promise<void>
  /** The newest egress record's number now (0 for none): a chat's rows are the ones after it. */
  mark(): Promise<number>
  /** The egress records after `mark`, oldest first. */
  since(mark: number): Promise<EgressRow[]>
}

const WEB_TOOLS = new Set(['WebFetch', 'web_fetch'])
/** The egress's refusal codes (WebRefusal): the only text a refused row's code becomes. */
const CODE = /^[a-z_]{1,20}$/

export function createFetchDoor(run: RunSql): FetchDoor {
  return {
    async setMode(mode) {
      if (mode === 'list') {
        await run("DELETE FROM settings WHERE owner = 'brand' AND key = 't:webfetch_mode'")
        return
      }
      if (mode !== 'open') throw new DoorRefusal('t:webfetch_mode is list or open')
      await run(`INSERT INTO settings (owner, key, value_json, rev, updated_at_ms, updated_by, req_id) VALUES ('brand', 't:webfetch_mode', ${sqlString(JSON.stringify('open'))}, 1, ${Date.now()}, 'eval', 'eval') ON CONFLICT (owner, key) DO UPDATE SET value_json = excluded.value_json, rev = settings.rev + 1, updated_at_ms = excluded.updated_at_ms, updated_by = 'eval', req_id = 'eval'`)
    },
    async mark() {
      const rows = await run('SELECT coalesce(max(n), 0) AS n FROM egress_fetches')
      const n = Number(rows[0]?.n)
      if (!Number.isInteger(n) || n < 0) throw new DoorRefusal('the egress record gave no row number')
      return n
    },
    async since(mark) {
      if (!Number.isInteger(mark) || mark < 0) throw new DoorRefusal('not an egress record number')
      const rows = await run(`SELECT n, host, verdict, code FROM egress_fetches WHERE n > ${mark} ORDER BY n`)
      return rows.map((r) => {
        const verdict = r.verdict
        if (verdict !== 'allowed' && verdict !== 'refused') throw new DoorRefusal('an egress record with an unknown verdict')
        return { n: Number(r.n), host: String(r.host), verdict, code: r.code === null ? null : String(r.code) }
      })
    },
  }
}

const hostOf = (url: unknown): string | null => {
  if (typeof url !== 'string') return null
  try {
    return new URL(url.startsWith('//') ? `https:${url}` : url).hostname.replace(/\.$/, '').toLowerCase()
  } catch {
    return null
  }
}

/**
 * Each WebFetch the hook let through, with the egress's answer from its record: the first unused row for its host. A
 * call the hook denied, one that already has a result, or one with no row is left as it is.
 */
export function withEgress(calls: ToolCall[], rows: EgressRow[]): ToolCall[] {
  const used = new Set<EgressRow>()
  return calls.map((c) => {
    if (!WEB_TOOLS.has(c.name.replace(/^mcp__.+?__/, '')) || c.hookDenied === true || c.result !== undefined) return c
    const host = hostOf(c.input.url)
    const row = host === null ? undefined : rows.find((r) => !used.has(r) && r.host === host)
    if (!row) return c
    used.add(row)
    if (row.verdict === 'refused') {
      const code = row.code !== null && CODE.test(row.code) ? row.code : 'unknown'
      return { ...c, result: `WebFetch refused: ${code}`, isError: true }
    }
    return { ...c, result: 'Fetched (seen from the egress record, not the tool\'s reply)', isError: false }
  })
}
