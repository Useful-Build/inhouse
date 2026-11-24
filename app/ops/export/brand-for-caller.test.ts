// "Export everything" for the caller (route 95's scope, P8a D). Ways it can fail, written down first:
//  1. an exported store has no policy (a new store would be exported whole, or not at all, without anyone deciding),
//     or a policy names a store that isn't exported, or doesn't fit its kind;
//  2. a person's export holds another person's personal memories, personal settings, photo or chats (their messages,
//     tool calls, files and file bytes);
//  3. the Inhouse team's export holds any member's chats, personal memories, personal settings or photos, or a
//     requester's id;
//  4. `members` holds a sign-in subject, an Inhouse team or service row, or a field the Members page (route 3,
//     `memberRecord`) doesn't show;
//  5. the caller's own data or the brand's shared data is missing;
//  6. the header doesn't say how much of each store the caller got.
import { env } from 'cloudflare:workers'
import { beforeAll, describe, expect, it } from 'vitest'
import { memberRecord } from '../../server/db/members.ts'
import type { MemberRow } from '../../server/db/members.ts'
import { chatFilesPrefix } from '../../server/db/r2-keys.ts'
import { openStores } from '../../server/db/stores.ts'
import { seedBrand } from '../../server/seed/seed.ts'
import type { Seeded } from '../../server/seed/seed.ts'
import { addPhoto, addSetting, readLines, token } from '../delete/test-support.ts'
import { tables } from '../tables/index.ts'
import { BRAND_FOR_CALLER, P5_EXPORT_EXCLUSIONS } from './brand-for-caller.ts'
import type { ExportCaller } from './brand-for-caller.ts'
import { planExport, runExport } from './export.ts'

const db = env.DB
const bucket = env.FILES as R2Bucket
const BASE = 1_800_000_000_000
const d = () => ({ db, bucket, at: { actorId: 'm_system', requestId: `req-${token()}`, nowMs: BASE } })
let seeded: Seeded

/** One person's private things, each marked with a text no one else's holds. */
interface Private { chat: string; memory: string; setting: string; photo: string; fileKey: string; mark: string }
const own: Record<string, Private> = {}

async function addPrivate(memberId: string): Promise<Private> {
  const mark = `PRIVATE${token()}`
  const chat = `c_${token()}`
  const turn = `t_${token()}`
  const fileKey = `${chatFilesPrefix(chat)}f_${token()}`
  await db.batch([
    db.prepare('INSERT INTO chats (id, owner_id, title, created_at_ms, last_at_ms) VALUES (?, ?, ?, ?, ?)').bind(chat, memberId, `${mark} chat`, BASE, BASE),
    db.prepare("INSERT INTO chat_messages (id, chat_id, run_id, turn_id, pos, role, author_id, text, at_ms) VALUES (?, ?, 'r_1', ?, 0, 'user', ?, ?, ?)").bind(`msg_${token()}`, chat, turn, memberId, `${mark} message`, BASE),
    db.prepare("INSERT INTO tool_calls (turn_id, n, chat_id, member_id, hook, tool, decision, input_bytes, input_sha256, at_ms) VALUES (?, 0, ?, ?, 'pre', 'Read', 'allow', 1, ?, ?)").bind(turn, chat, memberId, mark, BASE),
    db.prepare("INSERT INTO chat_files (id, chat_id, kind, path, name, content_type, bytes, sha256, r2_key, state, created_by, created_at_ms) VALUES (?, ?, 'input', 'a.txt', ?, 'text/plain', 1, 'x', ?, 'saved', ?, ?)").bind(`f_${token()}`, chat, `${mark}.txt`, fileKey, memberId, BASE),
    db.prepare("INSERT INTO memories (id, scope, owner_id, text, status, created_by, created_at_ms, updated_at_ms) VALUES (?, 'person', ?, ?, 'active', ?, ?, ?)").bind(`mem_${token()}`, memberId, `${mark} memory`, memberId, BASE, BASE),
  ])
  await bucket.put(fileKey, `${mark} file`, { httpMetadata: { contentType: 'text/plain' } })
  await addSetting(db, memberId, `${mark} setting`, memberId, BASE)
  const photo = await addPhoto(db, bucket, memberId)
  return { chat, memory: `${mark} memory`, setting: `${mark} setting`, photo: photo.key, fileKey, mark }
}

const BRAND_FACT = `BRANDFACT${token()}`
const WAITING_FACT = `WAITINGFACT${token()}`
const FORGOTTEN_FACT = `FORGOTTENFACT${token()}`
const REQUEST = `REQUEST${token()}`

beforeAll(async () => {
  seeded = await seedBrand(db, openStores(env), BASE)
  for (const id of [seeded.members.admin, seeded.members.dana, seeded.members.leo]) own[id] = await addPrivate(id)
  const fact = (text: string, status: string) => db.prepare("INSERT INTO memories (id, scope, owner_id, text, status, created_by, created_at_ms, updated_at_ms) VALUES (?, 'brand', NULL, ?, ?, ?, ?, ?)")
    .bind(`mem_${token()}`, text, status, seeded.members.dana, BASE, BASE)
  await db.batch([
    fact(BRAND_FACT, 'active'), fact(WAITING_FACT, 'waiting'), fact(FORGOTTEN_FACT, 'forgotten'),
    db.prepare("INSERT INTO team_requests (id, kind, text, requested_by, status, created_at_ms, updated_at_ms) VALUES (?, 'tool', ?, ?, 'open', ?, ?)").bind(`tr_${token()}`, REQUEST, seeded.members.dana, BASE, BASE),
  ])
  await addSetting(db, 'brand', 'BRANDSETTING', seeded.members.admin, BASE)
})

async function exportFor(caller: ExportCaller) {
  const planned = await planExport(d(), { kind: 'brandForCaller', caller })
  if (!('ok' in planned)) throw new Error(`refused: ${planned.refused}`)
  const { text, lines } = await readLines(runExport(d(), planned.ok))
  const rows = (store: string) => lines.filter(l => l.store === store && 'row' in l).map(l => l.row as Record<string, unknown>)
  const keys = (store: string) => lines.filter(l => l.store === store && 'key' in l).map(l => l.key as string)
  return { plan: planned.ok, text, lines, rows, keys }
}

describe('every exported store declares how (failure 1)', () => {
  it('has exactly one policy per export: true store, fitting its kind', () => {
    const exported = tables.filter(t => t.export)
    expect(Object.keys(BRAND_FOR_CALLER).sort()).toEqual(exported.map(t => t.name).sort())
    for (const t of exported) {
      const p = BRAND_FOR_CALLER[t.name]
      if (t.kind === 'd1') expect(['whole', 'rows'], t.name).toContain(p.kind)
      else expect(['whole', 'own_objects', 'own_chat_files'], t.name).toContain(p.kind)
      if (p.kind === 'own_objects') expect(t.personKeys.some(k => k.includes('<memberId>')), t.name).toBe(true)
      if (p.kind === 'own_chat_files') expect(t.name).toBe('files/')
      expect(p.why.length, t.name).toBeGreaterThan(0)
    }
  })

  it('keeps connector credentials and the notice ledger out of every export', () => {
    for (const [name, why] of Object.entries(P5_EXPORT_EXCLUSIONS)) {
      expect(tables.find(t => t.name === name), why).toMatchObject({ export: false })
      expect(BRAND_FOR_CALLER).not.toHaveProperty(name)
    }
  })

  it.each(['person', 'inhouse'] as const)('exports shared P5 configuration for %s with only safe fields', async kind => {
    await db.batch([
      db.prepare("INSERT OR REPLACE INTO connector_accounts (account_id, connector, last_state, last_state_at_ms, connected_by, connected_at_ms, req_id) VALUES ('slack:workspace', 'slack', 'connected', ?, ?, ?, 'connector-request-marker')").bind(BASE, seeded.members.dana, BASE),
      db.prepare("INSERT OR REPLACE INTO notify_channels (channel_id, name, added_by, added_at_ms, req_id) VALUES ('CEXPORT1', 'ops-example', ?, ?, 'channel-request-marker')").bind(seeded.members.dana, BASE),
      db.prepare("INSERT OR REPLACE INTO notify_channels (channel_id, name, added_by, added_at_ms, removed_at_ms) VALUES ('CEXPORT2', 'removed-example', ?, ?, ?)").bind(seeded.members.dana, BASE, BASE),
      db.prepare('INSERT OR REPLACE INTO notify_channel_list (id, rev, updated_at_ms) VALUES (1, 2, ?)').bind(BASE),
    ])
    const { rows, lines, text } = await exportFor({ kind, memberId: seeded.members.admin })
    expect(rows('connector_accounts').find(r => r.account_id === 'slack:workspace')).toEqual({
      account_id: 'slack:workspace', connector: 'slack', last_state: 'connected', last_state_at_ms: BASE, connected_at_ms: BASE, disconnected_at_ms: null,
    })
    expect(rows('notify_channels').find(r => r.channel_id === 'CEXPORT1')).toEqual({ channel_id: 'CEXPORT1', name: 'ops-example', alerts: 0 })
    expect(rows('notify_channels').some(r => r.channel_id === 'CEXPORT2')).toBe(false)
    expect(rows('notify_channel_list')).toEqual([{ rev: 2, updated_at_ms: BASE }])
    expect(lines.some(l => l.store === 'SignIn' || l.store === 'notify_sends')).toBe(false)
    expect(text).not.toContain('request-marker')
  })

  it('refuses to plan an exported store that has no policy, by name', async () => {
    const extra = { kind: 'd1' as const, name: 'later_table', retention: 'config' as const, personKeys: [], export: true }
    await expect(planExport({ ...d(), registry: [...tables, extra] }, { kind: 'brandForCaller', caller: { kind: 'person', memberId: seeded.members.admin } }))
      .rejects.toThrow(/later_table has no brandForCaller policy/)
  })
})

describe('an Admin\'s export (failures 2, 4, 5 and 6)', () => {
  it('holds the brand\'s shared data and the Admin\'s own, and no other person\'s personal rows', async () => {
    const me = seeded.members.admin
    const x = await exportFor({ kind: 'person', memberId: me })
    const mine = own[me]
    const myChats = x.rows('chats').map(r => r.id)
    // 5: their own things are there.
    expect(myChats).toEqual([mine.chat])
    for (const store of ['chat_messages', 'tool_calls', 'chat_files']) expect(x.rows(store).map(r => r.chat_id), store).toEqual([mine.chat])
    expect(x.keys('files/')).toEqual([mine.fileKey])
    expect(x.keys('photos/')).toEqual([mine.photo])
    expect(x.rows('memories').map(r => r.text)).toEqual(expect.arrayContaining([mine.memory, BRAND_FACT, WAITING_FACT]))
    expect(x.rows('settings').map(r => JSON.parse(r.value_json as string))).toEqual(expect.arrayContaining([mine.setting, 'BRANDSETTING']))
    expect(x.rows('team_requests').find(r => r.text === REQUEST)).toMatchObject({ requested_by: seeded.members.dana })
    // 2: never another person's.
    expect(x.rows('memories').every(r => r.scope === 'brand' || r.owner_id === me)).toBe(true)
    expect(x.rows('memories').some(r => r.status === 'forgotten')).toBe(false)
    expect(x.rows('settings').every(r => r.owner === 'brand' || r.owner === me)).toBe(true)
    for (const [id, theirs] of Object.entries(own)) if (id !== me) expect(x.text.includes(theirs.mark), id).toBe(false)
    // 4: members as route 3 shows them.
    const people = (await db.prepare("SELECT * FROM members WHERE kind = 'person' ORDER BY id").all<MemberRow>()).results
    expect(x.rows('members')).toEqual(people.map(memberRecord))
    expect(x.rows('members').some(r => 'subject' in r)).toBe(false)
    // No one's sign-in subject; no Inhouse team or service row, so no Inhouse team email.
    const subjects = (await db.prepare('SELECT subject FROM members WHERE subject IS NOT NULL').all<{ subject: string }>()).results
    expect(subjects.length).toBeGreaterThan(0)
    for (const s of subjects) expect(x.text.includes(`"${s.subject}"`), s.subject).toBe(false)
    const inhouse = await db.prepare('SELECT email_norm FROM members WHERE id = ?').bind(seeded.members.inhouse).first<string>('email_norm')
    expect(inhouse).toBeTruthy()
    expect(x.text.includes(inhouse!)).toBe(false)
    // 6: the header marks each store.
    const marks = Object.fromEntries((x.lines[0].stores as { name: string; included: string }[]).map(s => [s.name, s.included]))
    expect(x.lines[0]).toMatchObject({ format: 1, kind: 'brandForCaller', memberId: me })
    expect(marks).toMatchObject({ audit_log: 'all', chats: 'part', 'photos/': 'part', members: 'part', 'backups/': 'none', BrandAgent: 'none' })
    expect(x.lines.at(-1)).toEqual({ end: true, counts: x.plan.counts })
  })
})

describe('the Inhouse team\'s export (failures 3 and 4)', () => {
  it('holds no member\'s chats, personal memories, personal settings or photos, and no requester id', async () => {
    const x = await exportFor({ kind: 'inhouse', memberId: seeded.members.inhouse })
    for (const store of ['chats', 'chat_messages', 'tool_calls', 'chat_files', 'files/', 'photos/']) expect(x.plan.counts[store], store).toBe(0)
    for (const theirs of Object.values(own)) expect(x.text.includes(theirs.mark)).toBe(false)
    expect(x.rows('memories').every(r => r.scope === 'brand')).toBe(true)
    expect(x.rows('memories').map(r => r.text)).toEqual(expect.arrayContaining([BRAND_FACT, WAITING_FACT]))
    expect(x.rows('settings').every(r => r.owner === 'brand')).toBe(true)
    const request = x.rows('team_requests').find(r => r.text === REQUEST)
    expect(request).toBeDefined()
    expect(request).not.toHaveProperty('requested_by')
    expect(x.rows('members').every(r => !('subject' in r))).toBe(true)
    const marks = Object.fromEntries((x.lines[0].stores as { name: string; included: string }[]).map(s => [s.name, s.included]))
    expect(marks).toMatchObject({ chats: 'none', 'files/': 'none', 'photos/': 'none', audit_log: 'all' })
  })
})
