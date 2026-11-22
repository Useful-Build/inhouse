// P6a's parts of the real target (W4), in the style of watch.ts: which of P6a's methods the real client serves over HTTP, the
// route a forced failure of each lands on, how team facts are put waiting for the approval case, how that fact is changed
// behind the client, and how the reset leaves none waiting. `index.ts` is the orchestrator's: the lines it needs are in the
// PR body (`SERVED`, `WRITES`, `routeOf`, `READ_PATH`, `seedWaitingMemory`, `reset`, `writeElsewhere`, the exempt warning).
//
// What the shared contract suite then covers on the real target: `waitingMemory` and `reviewMemory` in W2's case (list newest
// first, approve, reject, a stale rev answered `conflict` with the fact as it is now), each value parsed through the shared
// schema by the suite's own `parse` calls, and the rollback of `requestTool` and `requestSkill` on a forced failure
// (`injectError`). The skills list is route 79, read by `agent.skills`; `GET /api/skills`'s own checks are the API spec's.
import { MemoryIdSchema } from '../../../../../shared/contract/memory'
import { WaitingMemoryListSchema } from '../../../../../shared/contract/memory-approvals'
import { TeamRequestsListSchema } from '../../../../../shared/contract/team-requests'
import type { ResourceKey } from '../../../types'
import type { Signer } from './me'
import { persistDir } from './watch'

/** The P6a methods the real client serves over HTTP (the Team memory page's two, and the Request buttons). */
export const MS_SERVED = ['waitingMemory', 'reviewMemory', 'requestTool', 'requestSkill'] as const

/**
 * The P6a methods the real target does NOT serve, each with why (index.ts prints it once). The real client's behaviour for it
 * is held by `src/agent/http/team-requests.test.ts` and the API specs instead.
 */
export const MS_EXEMPT: Readonly<Record<string, string>> = {
  sendTeamRequest: "the shared case compares `getSnapshot().teamRequests[0]` with a mock-shaped fixture (its title, 'From Settings' and status 'Requested'), but the real client makes that list from the server's open requests (title from the words, status 'Sent', the server's time)",
}

/** The paths the client reads P6a's resources from (route 79 and route 80's list). */
export const MS_READ_PATH: Partial<Record<ResourceKey, string>> = { skills: '/api/skills', requests: '/api/team-requests' }

const enc = (v: unknown): string => encodeURIComponent(String(v))

/**
 * The route a served P6a write sends to (its verbs and exact path), from the call's arguments; null for any other method. A
 * tool request taken back (`on` false) goes to route 83 on a request id the call doesn't carry (the client looks it up), so it
 * has NO forced-failure route: an armed refusal for it never fires, and no shared case arms one for it.
 */
export function memorySkillsRoute(method: string, args: unknown[]): { verbs: string[]; path: string } | null {
  switch (method) {
    case 'reviewMemory': return { verbs: ['PUT'], path: `/api/memory/brand/${enc(args[0])}/approved` }
    case 'requestSkill': case 'sendTeamRequest': return { verbs: ['POST'], path: '/api/team-requests' }
    case 'requestTool': return args[1] === false ? null : { verbs: ['POST'], path: '/api/team-requests' }
    default: return null
  }
}

interface Waiting { key: string; rev: number }
const need = (what: string, r: { status: number; json: unknown }) => {
  if (r.status >= 300) throw new Error(`The real contract target couldn't ${what}: ${r.status} ${JSON.stringify(r.json)}`)
  return r.json
}
const waitingList = async (s: Signer): Promise<Waiting[]> => {
  const list = WaitingMemoryListSchema.parse(need('read the waiting facts', await s.api('admin', 'GET', '/api/memory/waiting')))
  return list.facts.map(f => ({ key: f.key, rev: f.rev }))
}

/** Leaves no team fact waiting (each is rejected at its rev, as the Admin), so the approval case reads only what it seeded. */
export async function resetWaitingMemory(s: Signer): Promise<void> {
  for (const f of await waitingList(s)) need(`reject waiting fact ${f.key}`, await s.api('admin', 'PUT', `/api/memory/brand/${enc(f.key)}/approved`, { approved: false, ifRev: f.rev }))
}

/** Takes back every open request the Admin made (route 83), so a request case starts with none of its own open (a tool request left open would fail the next run). */
export async function resetOpenRequests(s: Signer): Promise<void> {
  const open = TeamRequestsListSchema.parse(need('read the open requests', await s.api('admin', 'GET', '/api/team-requests?status=open')))
  for (const r of open.items.filter(x => x.mine)) need(`withdraw request ${r.id}`, await s.api('admin', 'PUT', `/api/team-requests/${enc(r.id)}/withdrawn`, { ifRev: r.rev }))
}

/** The slice of node:sqlite the seeding uses (this program has no Node types; the module is loaded by name at run time). */
interface Sqlite { DatabaseSync: new (file: string) => { prepare(sql: string): { get(...p: unknown[]): unknown; run(...p: unknown[]): unknown }; close(): void } }
interface Fs { readdirSync(dir: string, o: { recursive: true; withFileTypes: true }): { isFile(): boolean; name: string; parentPath: string }[] }
const node = async <T>(name: string): Promise<T> => (await import(/* @vite-ignore */ name)) as T

/** A fact id as the server makes it: `mem_` and 128 random bits, base64url (22 characters), checked against the shared schema. */
const newKey = (): string => MemoryIdSchema.parse(`mem_${btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16)))).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')}`)

/**
 * Puts team facts waiting into the test build's local D1, oldest first, as an agent's saves would leave them (no route makes
 * one). Any fact already waiting is rejected first, and any team fact left from an earlier run with these exact words is
 * deleted (the case approves some, so a re-run would find them active), all in one transaction: a failed insert leaves nothing. Returns the keys in the order given. Fails loud when no local D1 with a
 * `memories` table is found (CONTRACT_PERSIST_DIR names the test build's --persist-to directory).
 */
export async function seedWaitingMemory(s: Signer, createdBy: string, texts: string[], o: { dir?: string; now?: number } = {}): Promise<string[]> {
  await resetWaitingMemory(s)
  const { DatabaseSync } = await node<Sqlite>('node:sqlite')
  const { readdirSync } = await node<Fs>('node:fs')
  const dir = o.dir ?? persistDir()
  const files = readdirSync(dir, { recursive: true, withFileTypes: true }).filter(d => d.isFile() && d.name.endsWith('.sqlite')).map(d => `${d.parentPath}/${d.name}`)
  const start = o.now ?? Date.now()
  for (const file of files) {
    const db = new DatabaseSync(file)
    try {
      if (db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'memories'").get() === undefined) continue
      db.prepare('PRAGMA busy_timeout = 10000').run()
      db.prepare('BEGIN IMMEDIATE').run()
      try {
        for (const text of texts) db.prepare("DELETE FROM memories WHERE scope = 'brand' AND text = ?").run(text)
        const keys = texts.map((text, i) => {
          const key = newKey()
          db.prepare("INSERT INTO memories (id, scope, owner_id, text, status, created_by, created_at_ms, updated_at_ms) VALUES (?, 'brand', NULL, ?, 'waiting', ?, ?, ?)").run(key, text, createdBy, start + i, start + i)
          return key
        })
        db.prepare('COMMIT').run()
        return keys
      } catch (e) {
        db.prepare('ROLLBACK').run()
        throw e
      }
    } finally {
      db.close()
    }
  }
  throw new Error(`The real contract target found no local D1 with a memories table under ${dir} (CONTRACT_PERSIST_DIR names the test build's --persist-to directory).`)
}

/**
 * A waiting team fact changed behind the client, so its next decision is at a stale rev: the Admin forgets it and undoes that
 * (route 45), which sends a team fact back to `waiting`, two revisions on. It is still waiting, with the same words. Throws when
 * the fact isn't waiting: only a waiting fact is changed this way, so the case never decides one that isn't.
 */
export async function changeMemoryElsewhere(s: Signer, key: string): Promise<void> {
  const found = (await waitingList(s)).find(f => f.key === key)
  if (!found) throw new Error(`The real contract target can only change a waiting fact elsewhere, and ${key} isn't waiting.`)
  const forgot = need(`forget ${key}`, await s.api('admin', 'PUT', `/api/memory/brand/${enc(key)}/forgotten`, { forgotten: true, ifRev: found.rev })) as { rev?: unknown }
  if (typeof forgot.rev !== 'number') throw new Error(`The real contract target read no rev from forgetting ${key}: ${JSON.stringify(forgot)}`)
  need(`undo forgetting ${key}`, await s.api('admin', 'PUT', `/api/memory/brand/${enc(key)}/forgotten`, { forgotten: false, ifRev: forgot.rev }))
}
