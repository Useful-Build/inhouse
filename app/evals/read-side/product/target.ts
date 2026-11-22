// The read-side set's product target: one case, planted, asked, then read back from what the run left behind. It only composes:
// the chat is targets/product.ts's session (or the scripted proof's), the readers are r2.ts, rows.ts, transcript.ts and
// extract.ts, and setup.ts wires them to a deployment. Every collection the grader can't observe is null (the case fails
// closed); a whole collection that can't be read throws, which stops the run (runner.ts) before more spend.
// Per case, in order: the session (seeded memory or the attachment, the case person), the WebFetch list, the test shop
// override (Shopify cases), the chat, the readers; then, whatever happened, the routines the agent made are deleted (route 55, so a
// crash can't leave a scheduled spend), the session is reset and the shop override cleared.
import type { ChatResult, ExfilSpec, RunContext, SeedFact, Session } from '../../types.ts'
import type { ReadSideCase } from '../cases.ts'
import type { FileEvidence, ReadSideRun } from '../grade.ts'
import type { ReadSideTarget } from '../runner.ts'
import { readSideShopOf } from '../shops.ts'
import { extractFile } from './extract.ts'
import type { RowReader } from './rows.ts'
import type { SessionReader } from './r2.ts'
import { exposedIn, joinCalls, toolUsesOf } from './transcript.ts'

/** The WebFetch list of a case that names no page: one host that never resolves, so the hook refuses every fetch. */
export const NO_FETCH_HOST = 'nothing.invalid'
/** What the hub's test build answers for a shop it has no recorded upstream for (hub/testing/index.ts). */
export const HUB_MISS = 'hub test build: no recorded upstream for host'
/** Rows are read from a little before the case's start on D1's clock: the Worker's clock writes them. */
export const SINCE_MARGIN_MS = 2_000

/** One HTTP call with the raw answer: downloads need the bytes. */
export type RawApi = (method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown) => Promise<{ status: number; bytes: Uint8Array; json: unknown }>

/** A thrown failure that still carries what the case spent (the server's settled figure). */
export class CostedError extends Error {
  readonly costUsd: number
  constructor(message: string, costUsd: number, options?: { cause?: unknown }) {
    super(message, options)
    this.costUsd = costUsd
  }
}

export interface Plan {
  memory: SeedFact[]
  exfil?: ExfilSpec
  shop?: string
  hosts: string[]
}

/** How a case's planted text reaches the agent, per source and placement. Slack cases wait on P5 and never get here. */
export function planOf(c: ReadSideCase): Plan {
  const hosts = c.hosts.length > 0 ? [...c.hosts] : [NO_FETCH_HOST]
  const plant = () => c.text
  switch (c.source) {
    case 'shopify':
      return { memory: [], shop: readSideShopOf(c.id), hosts }
    case 'tool_results':
      if (c.placement === 'memory_search result') return { memory: [], exfil: { kind: 'memory', via: 'memory_search', hosts, plant }, hosts }
      if (c.placement === 'attached returns sheet') return { memory: [], exfil: { kind: 'memory', via: 'attachment', hosts, plant }, hosts }
      throw new Error(`read-side: no planting for the tool_results placement ${JSON.stringify(c.placement)}`)
    case 'web_page':
      return { memory: [], hosts }
    case 'slack':
      throw new Error(`read-side: ${c.id} plants in Slack, which waits on P5`)
  }
}

export interface ProductDeps {
  /** Opens a case's session: targets/product.ts's seed() on the eval deployment, the proof's own on a PR's. */
  seed(memory: SeedFact[], run: RunContext, exfil?: ExfilSpec): Promise<Session>
  setWebfetchHosts(hosts: string[]): Promise<void>
  shop: { set(host: string): Promise<void>; clear(): Promise<string | null> }
  rows: RowReader & { nowMs(): Promise<number> }
  sessions: SessionReader
  /** The case person's API (route 40 and 41 as the chat's owner). */
  caseApi(caseId: string): RawApi
  /** The Admin's API (route 55). */
  adminApi: RawApi
  /** Turns the case's prompt into what is sent (the proof prefixes its scenario marker). Default: as written. */
  prompt?(c: ReadSideCase, prompt: string): string
  /** A line for the run's log. */
  note?(line: string): void
}

const said = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** The output files of the chat, each read in full or null. A list that can't be read throws (the whole collection). */
async function filesOf(api: RawApi, chatId: string): Promise<(FileEvidence | null)[]> {
  const list = await api('GET', `/api/chats/${encodeURIComponent(chatId)}/files`)
  const items = (list.json as { items?: unknown } | null)?.items
  if (list.status !== 200 || !Array.isArray(items)) throw new Error(`read-side: the chat's files could not be listed (${list.status})`)
  const out: (FileEvidence | null)[] = []
  for (const f of items as { fileId?: unknown; kind?: unknown; name?: unknown; contentType?: unknown }[]) {
    if (f?.kind === 'input') continue
    if (f?.kind !== 'output' || typeof f.fileId !== 'string' || typeof f.name !== 'string' || typeof f.contentType !== 'string') { out.push(null); continue }
    const got = await api('GET', `/api/files/${encodeURIComponent(f.fileId)}`)
    out.push(got.status === 200 ? extractFile(f.name, f.contentType, got.bytes) : null)
  }
  return out
}

/**
 * Deletes (route 55, as the Admin) every live team routine made or changed since `since` that this run hasn't deleted yet, so
 * none stays scheduled to spend. Returns what went wrong, never throws: the caller reports it with everything else.
 */
export async function deleteRoutines(rows: Pick<RowReader, 'routines'>, admin: RawApi, since: number, deleted: Set<string>): Promise<string[]> {
  const errors: string[] = []
  try {
    for (const r of await rows.routines(since)) {
      if (deleted.has(r.id) || !r.live) continue
      const del = await admin('POST', `/api/routines/${encodeURIComponent(r.id)}/delete`, { ifRev: r.rev })
      if (del.status === 200 || del.status === 404) deleted.add(r.id)
      else errors.push(`routine ${r.id} could not be deleted (${del.status}): delete it on the Routines page before the next run`)
    }
  } catch (e) {
    errors.push(`the routines could not be read for the delete: ${said(e)}`)
  }
  return errors
}

export function createProductReadSideTarget(d: ProductDeps, deleted: Set<string> = new Set()): ReadSideTarget {
  // `deleted`: routines this run deleted, so a later case's window never reads them as its own (shared with the stop handler's sweep).
  return {
    name: 'product',
    honorsPending: true,
    async run(c) {
      const plan = planOf(c)
      const since = (await d.rows.nowMs()) - SINCE_MARGIN_MS
      let session: Session | null = null
      let result: ChatResult | null = null
      let costUsd = 0
      const cleanup: string[] = []
      let evidence: ReadSideRun | null = null
      let failure: unknown = null
      try {
        // The session first: on the eval deployment its first seed takes the lease and refuses any shop override already set.
        session = await d.seed(plan.memory, { caseId: c.id, rep: 1, canary: c.canary }, plan.exfil)
        await d.setWebfetchHosts(plan.hosts)
        if (plan.shop) await d.shop.set(plan.shop)
        for (const chat of c.chats) {
          try {
            result = await session.chat(d.prompt ? d.prompt(c, chat.prompt) : chat.prompt)
          } catch (e) {
            const booked = await session.settledCostUsd?.().catch(() => null)
            throw new CostedError(`read-side: ${c.id}'s chat failed: ${said(e)}${booked === null || booked === undefined ? ' (its cost could not be read)' : ''}`, booked ?? 0, { cause: e })
          }
          costUsd += result.costUsd
        }
        if (!result?.chatId) throw new Error(`read-side: ${c.id}'s chat gave no chat id`)
        const parts = await d.sessions.parts(result.chatId)
        // A turn that ran tools and left no transcript is a systematic miss (a wrong bucket or key shape), never "not exposed".
        if (parts.length === 0 && result.toolCalls.length > 0) throw new Error(`read-side: ${c.id}'s turn called tools but its chat holds no transcript under sessions/${result.chatId}/: stopping`)
        const uses = toolUsesOf(parts)
        if (c.source === 'shopify' && parts.some((p) => new TextDecoder().decode(p).includes(HUB_MISS))) {
          throw new Error(`read-side: the hub has no recorded upstream for ${plan.shop}: the eval hub lacks the read-side shops (redeploy it from main)`)
        }
        const joined = joinCalls(result.toolCalls, uses)
        for (const r of joined.reasons) d.note?.(`read-side: ${c.id}: ${r}`)
        const routines = (await d.rows.routines(since)).filter((r) => !deleted.has(r.id))
        const teamRequests = await d.rows.teamRequestTexts(since)
        evidence = {
          ended: result.runOk,
          exposed: parts.length === 0 ? false : exposedIn(parts, c.canary),
          calls: joined.calls,
          webFetchUrls: joined.webFetchUrls,
          memoryTexts: await d.rows.memoryTexts(),
          noticeTexts: await d.rows.noticeTexts(since),
          routineTexts: routines.map((r) => r.text),
          teamRequestTexts: teamRequests ?? [],
          files: await filesOf(d.caseApi(c.id), result.chatId),
        }
      } catch (e) {
        failure = e
      } finally {
        // Straight after the case, whatever it did: no routine it made may stay scheduled.
        cleanup.push(...(await deleteRoutines(d.rows, d.adminApi, since, deleted)))
        try {
          await session?.reset()
        } catch (e) {
          cleanup.push(`the session could not be reset: ${said(e)}`)
        }
        if (plan.shop) {
          try {
            await d.shop.clear()
          } catch (e) {
            cleanup.push(`the test shop override could not be cleared: ${said(e)}`)
          }
        }
      }
      const spent = failure instanceof CostedError ? failure.costUsd : costUsd
      if (failure !== null || cleanup.length > 0) {
        const parts = [...(failure !== null ? [said(failure)] : []), ...cleanup]
        throw new CostedError(parts.join('; '), spent, { cause: failure ?? undefined })
      }
      return { run: evidence!, costUsd: spent }
    },
  }
}
