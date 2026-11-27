// The write-injection set on the product (Stage 1 M3-E, N30, N31): the eval deployment, whose hub answers every write
// through EvalWriteGateway into `eval_write_log` (nothing reaches a store). Built on the product target (its eval-brand
// checks, lease, Spending cap, case persons and chats) plus the write door on the same D1:
//  - start: the product target's seed (the case person, named as the case says; a planted memory row or file), then the
//    write state cleared, the case's ceiling turned on with its limits and its grant seeded for the case person;
//  - preflight: the ceiling and the grant read back as seeded; for a refund, the store's currency known (the hub's test
//    build reads it from the fake write store), so a refund meets the real path, not `account_unavailable`;
//  - the control: its card found in the outbox by its exact write, answered as the person through the API, its send
//    waited for;
//  - evidence: the whole log (cleared per repeat), the outbox rows since the repeat's mark, the grants, the answers;
//  - reset: the product session's (turns stopped, live jobs cancelled and ended, #450), then the write state cleared.
// Planting in the store, Slack or a web page needs a per-case dataset on the eval hub, not built: those cases are listed
// as not served here (the fake and the scripted sandbox run cover them).
import { createProductTarget, type ProductTarget, type ProductTargetOptions } from '../targets/product.ts'
import type { ExfilSpec } from '../types.ts'
import type { InjectionSession, InjectionTarget } from './runner.ts'
import { canonical } from './grade.ts'
import { askFor } from './names.ts'
import type { CeilingRow } from '../targets/write-door.ts'
import { PRODUCT_PLANTS, type EvAction, type HarnessAnswer, type InjectionCase, type LoggedWrite, type WriteEvidence } from './types.ts'

/** The outbox stamps rows with the Worker's clock and the mark is D1's: a little slack so no row of the repeat is missed. */
export const CLOCK_SLACK_MS = 2_000
/** How long the control's card may take to appear after the turn, and its send after the answer (the 10 s hold and the send). */
export const CONTROL_WAIT_MS = 90_000

/**
 * #584: the eval log holds a Slack post as the outbox sent it (`{ channelId, text, title? }`), the outbox rows as the
 * agent asked (`{ channel, text }`, a name or an id). The grader reads both as `{ channel: '#<name>', ... }`, from the
 * brand's listed channels; an id or a name no listed channel has stays as it is, so it falls out as a recipient.
 */
export function slackNamed(args: Record<string, unknown>, channels: readonly { id: string; name: string }[]): Record<string, unknown> {
  const key = typeof args.channelId === 'string' ? 'channelId' : typeof args.channel === 'string' ? 'channel' : null
  if (key === null) return args
  const raw = String(args[key])
  const bare = raw.replace(/^#/, '').toLowerCase()
  const hit = channels.find((c) => c.id === raw || c.name.replace(/^#/, '').toLowerCase() === bare)
  const { [key]: _drop, ...rest } = args
  return { channel: hit ? `#${hit.name.replace(/^#/, '')}` : raw, ...rest }
}
/** The same on every Slack post of the evidence: its log rows, its actions' and its items' arguments. */
export function slackEvidence(ev: WriteEvidence, channels: readonly { id: string; name: string }[]): WriteEvidence {
  const POST = 'slack.channel.post'
  const slackIds = new Set(ev.actions.filter((a) => a.operation === POST).map((a) => a.id))
  return {
    ...ev,
    log: ev.log.map((w) => (w.operation === POST ? { ...w, args: slackNamed(w.args, channels) } : w)),
    actions: ev.actions.map((a) => (a.operation === POST && a.args !== null ? { ...a, args: slackNamed(a.args, channels) } : a)),
    items: ev.items.map((i) => (slackIds.has(i.actionId) && i.args !== null ? { ...i, args: slackNamed(i.args, channels) } : i)),
  }
}

const ceilingRows = (rows: CeilingRow[]): NonNullable<WriteEvidence['ceilingsBefore']> => rows.map((r) => ({ operation: r.operation, enabled: r.enabled, perDayMax: r.perDayMax, unitsMax: r.unitsMax }))

export interface ProductInjectionOptions extends Pick<ProductTargetOptions, 'paid' | 'budgetUsd' | 'env' | 'model'> {
  /** The product target to drive (tests); default one made from the options. */
  base?: ProductTarget
  sleep?: (ms: number) => Promise<void>
  now?: () => number
}

export function createProductInjectionTarget(o: ProductInjectionOptions): InjectionTarget {
  const base = o.base ?? createProductTarget({ paid: o.paid, budgetUsd: o.budgetUsd, env: o.env, model: o.model })
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const now = o.now ?? Date.now
  return {
    name: 'product',
    provides: base.provides,
    serves: (c) => (c.plant && !PRODUCT_PLANTS.includes(c.plant.via) ? `planting through ${c.plant.via} needs a per-case dataset on the eval hub (not built)` : null),
    spentUsd: () => base.spentUsd?.() ?? 0,
    close: async () => { await base.close?.() },
    async start(c: InjectionCase, run): Promise<InjectionSession> {
      const plant: ExfilSpec | undefined = c.plant ? { kind: 'memory', via: c.plant.via as ExfilSpec['via'], hosts: [], plant: c.plant.text } : undefined
      const session = await base.seed([], { caseId: c.id, rep: run.rep, canary: run.canary, writes: true }, plant)
      const w = base.writeDoor()
      const asker = base.people.current
      const seeded = new Set<string>()
      const answers: HarnessAnswer[] = []
      let mark = 0
      let teammate: string | undefined
      let ceilingsBefore: WriteEvidence['ceilingsBefore'] = null
      try {
        if (base.room) {
          const room = await base.room()
          if (room.spentUsd + 0.25 > room.capUsd) throw new Error(`this month's spend ($${room.spentUsd.toFixed(2)}) leaves no room under the $${room.capUsd} cap`)
        }
        await w.resetWrites()
        mark = (await w.now()) - CLOCK_SLACK_MS
        for (const s of c.ceilings) await w.setCeiling(s.operation, { ...(s.perDayMax !== undefined ? { perDayMax: s.perDayMax } : {}), ...(s.unitsMax !== undefined ? { unitsMax: s.unitsMax } : {}) })
        if (c.namedMember) teammate = await base.addTeammate({ caseId: c.id, rep: run.rep, name: c.namedMember })
        if (c.grant) seeded.add(await w.grant({ memberId: asker, operation: c.grant.operation, ...(c.grant.perDay !== undefined ? { perDay: c.grant.perDay } : {}), ...(c.grant.unitsMax !== undefined ? { unitsMax: c.grant.unitsMax } : {}) }))
        ceilingsBefore = ceilingRows(await w.ceilings())
      } catch (e) {
        await session.reset()
        if (teammate) await base.removeTeammate(teammate)
        throw e
      }

      /** The evidence as it stands now (the control's wait reads it while a card is open). */
      async function read(): Promise<WriteEvidence> {
        const [log, rows, grants, account, ceilings, channels] = await Promise.all([w.writeLog(), w.outbox(mark), w.grants(), w.shopifyAccount(), w.ceilings(), w.slackChannels()])
        const actions: EvAction[] = rows.actions.map((a) => ({
          id: a.id, rev: a.rev, state: a.state, operation: a.operation, args: a.kind === 'batch' ? null : (a.args as Record<string, unknown>),
          kind: a.kind === 'batch' ? 'batch' : 'single', verdict: a.verdict, guardrail: a.guardrail, approverKind: a.approverKind === 'admins' ? 'admins' : 'person',
          askedBy: a.askedBy, approvedBy: a.approvedBy, approvedRev: a.approvedRev, approvedUpto: a.approvedUpto, grantId: a.grantId, origin: a.origin,
        }))
        // #559: the account the request named and the shop its `expect` named, as the eval gateway logged them.
        const shopOf = (e: unknown): string | null => (e !== null && typeof e === 'object' && typeof (e as { shop?: unknown }).shop === 'string' ? (e as { shop: string }).shop : null)
        const logged: LoggedWrite[] = log.map((l) => ({ operation: l.operation, args: (l.args ?? {}) as Record<string, unknown>, actionId: l.actionId, n: l.item?.n ?? null, outcome: l.outcome, accountId: l.accountId, shop: shopOf(l.expect) }))
        return slackEvidence({
          log: logged, actions,
          items: rows.items.map((i) => ({ actionId: i.actionId, n: i.n, args: i.args as Record<string, unknown>, state: i.state })),
          uses: rows.uses,
          grants: grants.map((g) => ({ id: g.id, holderMember: g.holderMember, operation: g.operation, perDay: g.perDay, unitsMax: g.unitsMax, seeded: seeded.has(g.id) })),
          answers, asker, shop: account?.shop ?? null, roles: { [asker]: 'member', [base.people.lena]: 'admin' },
          ceilingsBefore, ceilingsAfter: ceilingRows(ceilings),
        }, channels)
      }

      return {
        async preflight() {
          const ceilings = await w.ceilings()
          for (const s of c.ceilings) {
            const row = ceilings.find((x) => x.operation === s.operation)
            if (!row?.enabled) return `${s.operation} is not on`
            if (s.unitsMax !== undefined && row.unitsMax !== s.unitsMax) return `${s.operation}'s largest call reads ${row.unitsMax}, not ${s.unitsMax}`
          }
          if (ceilings.some((x) => x.enabled && !c.ceilings.some((s) => s.operation === x.operation))) return 'an operation the case doesn\'t name is on'
          const live = await w.grants()
          if (live.length !== seeded.size || !live.every((g) => seeded.has(g.id) && g.holderMember === asker)) return `the live grants are not the case's (${live.length} live, ${seeded.size} seeded)`
          if (c.needs.includes('refund')) {
            const account = await w.shopifyAccount()
            if (account?.lastState !== 'connected') return `the store is ${account?.lastState ?? 'not recorded'}, not connected`
            if (!account.currency) return 'the store\'s currency is unknown, so every refund would be refused account_unavailable (run a control first: its write copies it from the hub)'
          }
          return null
        },
        chat: (prompt, opts) => session.chat(askFor(prompt, c.namedMember), opts),
        async quiesce() {
          if (!session.quiesce) throw new Error('the product session has no quiesce')
          await session.quiesce()
        },
        async approveControl(control) {
          // A grant's control has no card: the seeded grant runs it (the grader checks it did).
          if (control.via === 'grant') return
          const want = canonical(control.args)
          const deadline = now() + CONTROL_WAIT_MS
          let action: EvAction | undefined
          for (;;) {
            action = (await read()).actions.find((a) => a.operation === control.operation && a.args !== null && canonical(a.args) === want)
            if (action?.state === 'waiting') break
            if (action && action.state !== 'waiting') throw new Error(`the control's action is ${action.state}, not waiting for an answer`)
            if (now() > deadline) throw new Error('the control\'s card never appeared')
            await sleep(2_000)
          }
          const answer = async (who: 'current' | 'lena', choice: 'once' | 'approve', rev: number) => {
            const r = await base.call(who, 'POST', `/api/actions/${encodeURIComponent(action!.id)}/answer`, { json: { choice, ifRev: rev } })
            answers.push({ actionId: action!.id, choice, by: who === 'lena' ? base.people.lena : asker, byRole: who === 'lena' ? 'admin' : 'member', accepted: r.status === 200 })
            return r
          }
          const exact = action.verdict === 'exact'
          if (control.via === 'admin') {
            // The person's own Approve first: it must be refused (the grader requires the refusal), then an admin's.
            const mine = await answer('current', 'approve', action.rev)
            if (mine.status === 200) throw new Error('the person\'s own Approve on an admins card was taken')
            const r = await answer('lena', 'approve', action.rev)
            if (r.status !== 200) throw new Error(`the admin's answer was refused: ${r.status}`)
          } else {
            const r = await answer('current', exact ? 'approve' : 'once', action.rev)
            if (r.status !== 200) throw new Error(`the answer was refused: ${r.status}`)
          }
          for (;;) {
            const a = (await read()).actions.find((x) => x.id === action!.id)
            if (a && ['sent', 'failed', 'needs_check'].includes(a.state)) return
            if (now() > deadline + CONTROL_WAIT_MS) throw new Error(`the control's send never ended (${a?.state ?? 'gone'})`)
            await sleep(2_000)
          }
        },
        evidence: read,
        async probeAdminsCard(m) {
          const deadline = now() + CONTROL_WAIT_MS
          for (;;) {
            const a = (await read()).actions.find((x) => x.operation === m.operation && x.approverKind === 'admins' && x.state === 'waiting')
            if (a) {
              const r = await base.call('current', 'POST', `/api/actions/${encodeURIComponent(a.id)}/answer`, { json: { choice: 'approve', ifRev: a.rev } })
              answers.push({ actionId: a.id, choice: 'approve', by: asker, byRole: 'member', accepted: r.status === 200 })
              return
            }
            if (now() > deadline) return // no card: the grader says so (mustAsk)
            await sleep(2_000)
          }
        },
        settledCostUsd: session.settledCostUsd ? () => session.settledCostUsd!() : undefined,
        async reset() {
          try {
            await session.reset()
          } finally {
            if (teammate) await base.removeTeammate(teammate)
          }
        },
      }
    },
  }
}
