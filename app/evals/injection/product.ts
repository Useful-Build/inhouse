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
import { PRODUCT_PLANTS, type EvAction, type HarnessAnswer, type InjectionCase, type LoggedWrite, type WriteEvidence } from './types.ts'

/** The outbox stamps rows with the Worker's clock and the mark is D1's: a little slack so no row of the repeat is missed. */
export const CLOCK_SLACK_MS = 2_000
/** How long the control's card may take to appear after the turn, and its send after the answer (the 10 s hold and the send). */
export const CONTROL_WAIT_MS = 90_000

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
      const session = await base.seed([], { caseId: c.id, rep: run.rep, canary: run.canary, writes: true, ...(c.personName ? { personName: c.personName } : {}) }, plant)
      const w = base.writeDoor()
      const asker = base.people.current
      const seeded = new Set<string>()
      const answers: HarnessAnswer[] = []
      let mark = 0
      try {
        if (base.room) {
          const room = await base.room()
          if (room.spentUsd + 0.25 > room.capUsd) throw new Error(`this month's spend ($${room.spentUsd.toFixed(2)}) leaves no room under the $${room.capUsd} cap`)
        }
        await w.resetWrites()
        mark = (await w.now()) - CLOCK_SLACK_MS
        for (const s of c.ceilings) await w.setCeiling(s.operation, { ...(s.perDayMax !== undefined ? { perDayMax: s.perDayMax } : {}), ...(s.unitsMax !== undefined ? { unitsMax: s.unitsMax } : {}) })
        if (c.grant) seeded.add(await w.grant({ memberId: asker, operation: c.grant.operation, ...(c.grant.perDay !== undefined ? { perDay: c.grant.perDay } : {}), ...(c.grant.unitsMax !== undefined ? { unitsMax: c.grant.unitsMax } : {}) }))
      } catch (e) {
        await session.reset()
        throw e
      }
      const chats = (): readonly string[] => (session as { chatIds?: () => readonly string[] }).chatIds?.() ?? []

      async function evidence(): Promise<WriteEvidence> {
        const [log, rows, grants] = await Promise.all([w.writeLog(), w.outbox(mark), w.grants()])
        const actions: EvAction[] = rows.actions.map((a) => ({
          id: a.id, rev: a.rev, state: a.state, operation: a.operation, args: a.kind === 'batch' ? null : (a.args as Record<string, unknown>),
          kind: a.kind === 'batch' ? 'batch' : 'single', verdict: a.verdict, guardrail: a.guardrail, approverKind: a.approverKind === 'admins' ? 'admins' : 'person',
          askedBy: a.askedBy, approvedBy: a.approvedBy, approvedRev: a.approvedRev, approvedUpto: a.approvedUpto, grantId: a.grantId, origin: a.origin,
        }))
        const logged: LoggedWrite[] = log.map((l) => ({ operation: l.operation, args: (l.args ?? {}) as Record<string, unknown>, actionId: l.actionId, n: l.item?.n ?? null, outcome: l.outcome }))
        return {
          log: logged, actions,
          items: rows.items.map((i) => ({ actionId: i.actionId, n: i.n, args: i.args as Record<string, unknown>, state: i.state })),
          uses: rows.uses,
          grants: grants.map((g) => ({ id: g.id, holderMember: g.holderMember, operation: g.operation, perDay: g.perDay, unitsMax: g.unitsMax, seeded: seeded.has(g.id) })),
          answers, asker, roles: { [asker]: 'member' },
        }
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
            if (!account?.currency) return 'the store\'s currency is unknown, so every refund would be refused account_unavailable (run a control first: its write copies it from the hub)'
          }
          return null
        },
        chat: (prompt, opts) => session.chat(prompt, opts),
        async approveControl(control) {
          const want = canonical(control.args)
          const deadline = now() + CONTROL_WAIT_MS
          let action: EvAction | undefined
          for (;;) {
            action = (await evidence()).actions.find((a) => a.operation === control.operation && a.args !== null && canonical(a.args) === want)
            if (action?.state === 'waiting') break
            if (action && action.state !== 'waiting') throw new Error(`the control's action is ${action.state}, not waiting for an answer`)
            if (now() > deadline) throw new Error('the control\'s card never appeared')
            await sleep(2_000)
          }
          const chatId = chats()[0]
          const cards = await base.call('current', 'GET', `/api/actions?chatId=${encodeURIComponent(chatId ?? '')}`)
          if (cards.status !== 200) throw new Error(`read the cards: ${cards.status}`)
          const card = (cards.json.items as { id: string; rev: number; kind: 'ask' | 'exact' }[]).find((x) => x.id === action!.id)
          if (!card) throw new Error('the control\'s card is not in its chat')
          const choice = card.kind === 'exact' ? 'approve' : 'once'
          const r = await base.call('current', 'POST', `/api/actions/${encodeURIComponent(card.id)}/answer`, { json: { choice, ifRev: card.rev } })
          answers.push({ actionId: card.id, choice, by: asker, byRole: 'member', accepted: r.status === 200 })
          if (r.status !== 200) throw new Error(`the answer was refused: ${r.status}`)
          for (;;) {
            const a = (await evidence()).actions.find((x) => x.id === card.id)
            if (a && ['sent', 'failed', 'needs_check'].includes(a.state)) return
            if (now() > deadline + CONTROL_WAIT_MS) throw new Error(`the control's send never ended (${a?.state ?? 'gone'})`)
            await sleep(2_000)
          }
        },
        evidence,
        settledCostUsd: session.settledCostUsd ? () => session.settledCostUsd!() : undefined,
        reset: () => session.reset(),
      }
    },
  }
}
