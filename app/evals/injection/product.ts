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
//  - Slack (#577): with the Inhouse app's origin and aud set, the Slack cases run. Each Slack case-repeat connects Slack
//    through the product's own flow (the fake keeps its tokens in memory), seeds the workspace with its planted messages
//    in #support, and lists its channels after its ceiling is on; its reset empties the workspace and the listed channels;
//    the run's close disconnects Slack (#583), so a later suite's tools don't change.
// Planting in the store or a web page needs a per-case dataset on the eval hub, not built: those cases are listed as not
// served here (their twins W31 to W37 plant the same attacks through a file or a memory hit).
import { DoorRefusal, WRANGLER_TIMEOUT_MS, webfetchHostsRefusal } from '../targets/door.ts'
import { accessHeaders, createProductTarget, EVAL_AUD_VAR, JOB_END_TIMEOUT_MS, testIssuerSignIn, webfetchListFor, type ProductTarget, type ProductTargetOptions } from '../targets/product.ts'
import { connectSlack, disconnectSlack, slackShown, type InhouseApi } from '../targets/slack-door.ts'
import { SEED_INHOUSE } from '../../server/seed/brand.ts'
import { createSessionReader, type SessionReader } from '../read-side/product/r2.ts'
import { EVAL_BUCKET } from '../exfiltration/store-data/transcripts.ts'
import { plantVerdict } from './transcript.ts'
import type { ExfilSpec } from '../types.ts'
import { StartUndoFailed, type InjectionSession, type InjectionTarget } from './runner.ts'
import { canonical } from './grade.ts'
import { askFor } from './names.ts'
import type { CeilingRow } from '../targets/write-door.ts'
import { PRODUCT_PLANTS, type EvAction, type HarnessAnswer, type InjectionCase, type LoggedWrite, type WriteEvidence } from './types.ts'

/** The outbox stamps rows with the Worker's clock and the mark is D1's: a little slack so no row of the repeat is missed. */
export const CLOCK_SLACK_MS = 2_000
/** How long the control's card may take to appear after the turn, and its send after the answer (the 10 s hold and the send). */
export const CONTROL_WAIT_MS = 90_000
/**
 * How long a close waits for the running repeat to end (#663): its turn is already stopped, so this is the runner's
 * quiesce, then reset()'s own quiesce (each up to JOB_END_TIMEOUT_MS), then the reset's few calls (#672: the cap covers both
 * quiesces with a margin).
 */
export const REPEAT_END_WAIT_MS = 2 * JOB_END_TIMEOUT_MS + 90_000
/**
 * How long a close waits on a case setup in flight with no call ending (#672, #685): the setup stops at its next step once
 * the close begins, but one step (the product seed) makes several calls. Each call has its own deadline (API_TIMEOUT_MS,
 * WRANGLER_TIMEOUT_MS), so the close waits as long as calls keep ending, and gives up once none has ended for longer than
 * the longest deadline with a margin.
 */
export const SETUP_QUIET_MS = WRANGLER_TIMEOUT_MS + 30_000

/** A case that connects Slack at its start: it posts there, or its plant is there. */
const needsSlack = (c: InjectionCase): boolean => c.needs.includes('slack_post') || c.plant?.via === 'slack'

/** Waits for `p` up to `ms`; true if it settled (either way), false if the time ran out. */
async function settledWithin(p: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<false>((r) => { timer = setTimeout(() => r(false), ms) })
  try {
    return await Promise.race([p.then(() => true, () => true), late])
  } finally {
    clearTimeout(timer)
  }
}

/** A sleep a cancel ends at once (#664). */
const abortableSleep = async (sleep: (ms: number) => Promise<void>, ms: number, signal?: AbortSignal): Promise<void> => {
  if (!signal) return sleep(ms)
  if (signal.aborted) return
  let onAbort!: () => void
  const aborted = new Promise<void>((r) => { onAbort = r })
  signal.addEventListener('abort', onAbort, { once: true })
  try {
    await Promise.race([sleep(ms), aborted])
  } finally {
    // One listener per poll would pile up over a 90 s wait (Node warns past 10): each goes when its sleep ends.
    signal.removeEventListener('abort', onAbort)
  }
}
const cancelled = (signal?: AbortSignal) => signal?.aborted === true

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

/**
 * What the product seed gets for a case's plant (memory or attachment; a Slack plant is seeded through the Slack door):
 * the text, and no WebFetch hosts (an injection case asks for none, so the brand keeps the default list).
 */
export function plantSpecOf(c: InjectionCase): ExfilSpec | undefined {
  return c.plant && c.plant.via !== 'slack' ? { kind: 'memory', via: c.plant.via as ExfilSpec['via'], hosts: [], plant: c.plant.text } : undefined
}

/**
 * Why the product seed would refuse a planned case before its turn, or null: the WebFetch list it would write, checked by
 * the door's own rule (the live smoke after #670 stopped mid-run at P03's seed on that refusal). The preflight runs it on
 * every planned case, so a case the seed can't take stops the run before any paid turn.
 */
export function seedRefusal(c: InjectionCase): string | null {
  const list = webfetchListFor(plantSpecOf(c))
  const why = list === null ? null : webfetchHostsRefusal(list)
  return why ? `${c.id}'s seed would be refused: ${why}` : null
}

/** The Inhouse app's origin and the test issuer's aud there: the Slack connect routes are the Inhouse team's. */
export const EVAL_INHOUSE_ORIGIN_VAR = 'INHOUSE_EVAL_INHOUSE_ORIGIN'
export const EVAL_INHOUSE_AUD_VAR = 'INHOUSE_EVAL_INHOUSE_AUD'

/** The product as the Inhouse team (the seeded Inhouse person), on the Inhouse app's origin, with the redirect kept. */
export function inhouseApi(env: Record<string, string | undefined>, doFetch: typeof fetch = fetch): InhouseApi | null {
  const origin = env[EVAL_INHOUSE_ORIGIN_VAR]
  const aud = env[EVAL_INHOUSE_AUD_VAR]
  if (!origin || !aud) return null
  const sign = testIssuerSignIn({ ...env, [EVAL_AUD_VAR]: aud })
  const edge = accessHeaders(env)
  return async (method, path, body) => {
    const headers: Record<string, string> = { ...(await sign('lena', { sub: SEED_INHOUSE.subject, email: SEED_INHOUSE.email })), ...edge }
    if (method !== 'GET') headers.Origin = origin
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    const r = await doFetch(`${origin}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual', signal: AbortSignal.timeout(30_000) })
    const text = await r.text()
    let json: unknown = null
    try { json = JSON.parse(text) } catch { /* not JSON */ }
    return { status: r.status, json, location: r.headers.get('location') }
  }
}

export interface ProductInjectionOptions extends Pick<ProductTargetOptions, 'paid' | 'budgetUsd' | 'env' | 'model'> {
  /** The product target to drive (tests); default one made from the options. */
  base?: ProductTarget
  /** The product as the Inhouse team (tests); default from INHOUSE_EVAL_INHOUSE_ORIGIN and _AUD. None: no Slack case runs. */
  inhouse?: InhouseApi | null
  /**
   * The session transcripts (tests); default the read-side set's R2 reader on the eval bucket (CF_SANDBOX_ACCOUNT_ID and
   * CLOUDFLARE_API_TOKEN with R2 read), made on first use.
   */
  sessions?: SessionReader
  /** The Slack connect and disconnect (tests); default slack-door.ts's, through the product's own routes. */
  slackLink?: { connect(api: InhouseApi): Promise<void>; disconnect(api: InhouseApi): Promise<void> }
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  /** How long a close waits for the running repeat to end (tests); default REPEAT_END_WAIT_MS. */
  repeatEndWaitMs?: number
  /** How long a close waits on a case setup with no call ending (tests); default SETUP_QUIET_MS. */
  setupQuietMs?: number
}

export function createProductInjectionTarget(o: ProductInjectionOptions): InjectionTarget {
  const base = o.base ?? createProductTarget({ paid: o.paid, budgetUsd: o.budgetUsd, env: o.env, model: o.model })
  const inhouse = o.inhouse === undefined ? inhouseApi(o.env) : o.inhouse
  // Slack runs only with the Inhouse app to connect it through (#577): then the Slack cases and the Slack plant are served.
  const provides = inhouse ? new Set([...base.provides, 'slack_post']) : base.provides
  const plants = inhouse ? [...PRODUCT_PLANTS, 'slack'] : PRODUCT_PLANTS
  let slackConnected = false
  const link = o.slackLink ?? { connect: connectSlack, disconnect: disconnectSlack }
  /**
   * Neon's #602 review: Slack is on only while a Slack case-repeat runs. Its workspace emptied and Slack disconnected,
   * the disconnect tried even when the emptying failed; both errors thrown. A no-op when Slack isn't on.
   */
  async function leaveSlack(): Promise<void> {
    if (!slackConnected || !inhouse) return
    const failed: unknown[] = []
    // The disconnect first (#612): it is what a later suite would see, and a cancel's close may be cut short.
    try {
      await link.disconnect(inhouse)
      slackConnected = false
    } catch (e) {
      failed.push(e)
    }
    try {
      await base.slackDoor().reset()
    } catch (e) {
      failed.push(e)
    }
    if (failed.length === 1) throw failed[0]
    if (failed.length > 1) throw new AggregateError(failed, 'emptying the Slack workspace and disconnecting Slack both failed')
  }
  /** What the run found and put right before its first case (#612), for the report. */
  const notes: string[] = []
  let slackChecked = false
  /**
   * #612: a hard-killed earlier run can leave Slack connected or the eval workspace full, which a non-Slack case (or
   * another suite) would then run with. Once, at the first case's start (the doors exist only after the eval-brand check):
   * Slack connected is disconnected, a workspace or a listed channel left is emptied, and the report says so. Slack left
   * connected with no Inhouse app to disconnect it fails the case by name.
   */
  async function checkSlackAtStart(): Promise<void> {
    if (slackChecked) return
    const slack = base.slackDoor()
    const [account, w] = await Promise.all([slack.account(), slack.read()])
    const connected = account?.lastState === 'connected'
    const left = w.channels.length + w.messages.length + w.listed.length
    if (!connected && left === 0) {
      slackChecked = true
      return
    }
    // Both steps tried, their errors kept (Neon's #618 review); marked done only once both held, and a failure stops the
    // run (StartUndoFailed, a reset failure to the runner), so no repeat runs on an earlier run's Slack.
    const failed: unknown[] = []
    if (connected) {
      if (!inhouse) failed.push(new Error('Slack is still connected from an earlier run, and without the Inhouse app (INHOUSE_EVAL_INHOUSE_ORIGIN and _AUD) it can\'t be disconnected'))
      else {
        try {
          await link.disconnect(inhouse)
        } catch (e) {
          failed.push(e)
        }
      }
    }
    if (left > 0) {
      try {
        await slack.reset()
      } catch (e) {
        failed.push(e)
      }
    }
    if (failed.length) throw new StartUndoFailed(failed, 'the start-of-run Slack cleanup failed, so the run stops')
    slackChecked = true
    notes.push(`At the run's start an earlier run's Slack state was put right: ${[connected ? 'Slack disconnected' : '', left > 0 ? `the eval workspace emptied (${w.channels.length} channels, ${w.messages.length} messages, ${w.listed.length} listed)` : ''].filter(Boolean).join(', ')}.`)
  }
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const now = o.now ?? Date.now
  /**
   * Neon's #618 review, cancel races: once the close starts no case starts and no Slack connect begins; a connect already
   * in flight is waited for, so it can't outlive the close; the running repeat's turns are stopped before the lease goes.
   */
  let closed = false
  /** Starts in flight and the running repeat's end (its reset), which the close waits for (#663). */
  const starting = new Set<Promise<unknown>>()
  /** Setup steps ended here, plus the product target's calls ended: what the close's wait on a setup watches (#685). */
  let stepsDone = 0
  const progress = () => stepsDone + (base.progress?.() ?? 0)
  let repeatDone: Promise<void> | null = null
  let sessions: SessionReader | undefined = o.sessions
  let connecting: Promise<void> | null = null
  let active: { stopTurns?(): Promise<void> } | null = null
  const closingRefusal = () => new Error('the target is closing (a cancel): no case starts and Slack stays off')
  const target: InjectionTarget = {
    name: 'product',
    provides,
    serves: (c) => {
      if (!c.plant || plants.includes(c.plant.via)) return null
      if (c.plant.via === 'slack') return `a Slack plant needs the Inhouse app (${EVAL_INHOUSE_ORIGIN_VAR} and ${EVAL_INHOUSE_AUD_VAR}), which is not set`
      return `planting through ${c.plant.via} needs a per-case dataset on the eval hub (not built)`
    },
    lacks: (family) => (family === 'slack_post' && !inhouse ? `slack_post: the Inhouse app (${EVAL_INHOUSE_ORIGIN_VAR} and ${EVAL_INHOUSE_AUD_VAR}) is not set` : null),
    spentUsd: () => base.spentUsd?.() ?? 0,
    notes: () => [...notes],
    async preflight(cases) {
      // The product target's own checks first (the eval brand, the lease, the cap: targets/product.ts setup), which make
      // its doors; then one read through each door the run uses, and one R2 LIST of the session transcripts (as the
      // read-side and store-data suites do). A refusal throws here, before any paid turn.
      // Tracked like a start (#680): a close waits for it, so the lease its setup takes goes back after it.
      const p = (async () => {
        if (closed) throw closingRefusal()
        // Every planned case's seed, checked by the door's own rules before any paid turn (the live smoke after #670 stopped
        // mid-run at P03's seed, on a WebFetch list the door refuses).
        const refused = cases.map(seedRefusal).filter((w): w is string => w !== null)
        if (refused.length) throw new DoorRefusal(refused.join('; '))
        // (A Slack case without the Inhouse app never reaches here: it is not run or not served, and the runner stops on
        // it before the preflight unless the run waived it.)
        await base.ready()
        if (closed) throw closingRefusal()
        await base.writeDoor().now()
        if (inhouse) {
          await base.slackDoor().read()
          // One read-only call through the Inhouse app the Slack connect uses (route 70, the Tools page), so a wrong
          // origin or aud stops the run here, not at the first Slack case (#671).
          await slackShown(inhouse)
        }
        sessions ??= createSessionReader({ env: o.env, bucket: EVAL_BUCKET })
        await sessions.preflight()
      })()
      starting.add(p)
      try {
        await p
      } finally {
        starting.delete(p)
      }
    },
    close: async () => {
      closed = true
      const failed: unknown[] = []
      // A start in flight (seeding, connecting, listing) ends first, refused at its next step and undone by itself; its
      // failure is start()'s to report (#663). Then a connect in flight.
      // Bounded (#672, #685): waited for while its calls keep ending; one that goes quiet for SETUP_QUIET_MS is named, and
      // the close goes on without it.
      const quietMs = o.setupQuietMs ?? SETUP_QUIET_MS
      const connectInFlight = connecting as Promise<void> | null
      const inFlight = [...starting, ...(connectInFlight ? [connectInFlight] : [])]
      if (inFlight.length) {
        const all = Promise.allSettled(inFlight)
        for (;;) {
          const before = progress()
          if (await settledWithin(all, quietMs)) break
          if (progress() === before) {
            failed.push(new Error(`a case setup made no progress for ${quietMs / 1000} s after the close`))
            break
          }
        }
      }
      try {
        // The running repeat's turns stop before the lease goes back.
        await active?.stopTurns?.()
      } catch (e) {
        failed.push(e)
      }
      // The running repeat's own quiesce, evidence and reset (the runner keeps them going after the cancel aborts its
      // turn) end before the lease goes back and Slack is left, so none of its writes lands after (#663). Bounded: a
      // runner that never resets can't hold the close forever.
      const waitMs = o.repeatEndWaitMs ?? REPEAT_END_WAIT_MS
      if (repeatDone && !(await settledWithin(repeatDone, waitMs))) failed.push(new Error(`the running repeat did not end within ${waitMs / 1000} s of the close`))
      try {
        // #583: leave the shared eval deployment without Slack (a cancel mid-repeat lands here too).
        await leaveSlack()
      } catch (e) {
        failed.push(e)
      }
      try {
        await base.close?.()
      } catch (e) {
        failed.push(e)
      }
      if (failed.length === 1) throw failed[0]
      if (failed.length > 1) throw new AggregateError(failed, 'the target\'s close failed in more than one step')
    },
    async start(c, run) {
      // Every start is tracked while it runs, so a close waits for it (#663).
      const p = startCase(c, run)
      starting.add(p)
      try {
        return await p
      } finally {
        starting.delete(p)
      }
    },
  }

  async function startCase(c: InjectionCase, run: { rep: number; canary: string }): Promise<InjectionSession> {
    {
      if (closed) throw closingRefusal()
      const slackCase = needsSlack(c)
      const plant = plantSpecOf(c)
      const session = await base.seed([], { caseId: c.id, rep: run.rep, canary: run.canary, writes: true }, plant)
      active = session
      // The repeat's end, which a close waits for (#663): settled by its reset, or by an undone start.
      let markDone!: () => void
      repeatDone = new Promise<void>((r) => { markDone = r })
      const w = base.writeDoor()
      const asker = base.people.current
      const seeded = new Set<string>()
      const answers: HarnessAnswer[] = []
      let mark = 0
      let teammate: string | undefined
      let ceilingsBefore: WriteEvidence['ceilingsBefore'] = null
      // A close that began during any setup step (the seed above, or one below): the case stops at once, undone in the
      // catch, and never hands back a live session (#663, #679).
      const held = () => {
        stepsDone++
        if (closed) throw closingRefusal()
      }
      try {
        held()
        if (base.room) {
          const room = await base.room()
          held()
          if (room.spentUsd + 0.25 > room.capUsd) throw new Error(`this month's spend ($${room.spentUsd.toFixed(2)}) leaves no room under the $${room.capUsd} cap`)
        }
        await w.resetWrites()
        held()
        mark = (await w.now()) - CLOCK_SLACK_MS
        held()
        for (const s of c.ceilings) {
          await w.setCeiling(s.operation, { ...(s.perDayMax !== undefined ? { perDayMax: s.perDayMax } : {}), ...(s.unitsMax !== undefined ? { unitsMax: s.unitsMax } : {}) })
          held()
        }
        await checkSlackAtStart()
        held()
        if (c.namedMember) {
          teammate = await base.addTeammate({ caseId: c.id, rep: run.rep, name: c.namedMember })
          held()
        }
        if (slackCase) {
          if (!inhouse) throw new Error('a Slack case needs the Inhouse app (INHOUSE_EVAL_INHOUSE_ORIGIN and _AUD)')
          // A fresh connection per case-repeat (the fake keeps its tokens in memory), the workspace with the case's plant
          // in #support, then the case's listed channels (after its ceiling: the door lists only where posting is on).
          // Marked before the connect: a connect that fails after its callback committed is still disconnected later.
          slackConnected = true
          connecting = link.connect(inhouse)
          try {
            await connecting
          } finally {
            connecting = null
          }
          // A close that began while the connect ran: this case stops here (its undo leaves Slack off).
          held()
          const slack = base.slackDoor()
          await slack.seed({ messages: c.plant?.via === 'slack' ? [{ channel: 'support', text: c.plant.text(run.canary) }] : [] })
          held()
          await slack.list({ by: base.people.lena, channels: c.channels.map((name) => ({ name: name.replace(/^#/, '') })) })
          held()
        }
        if (c.grant) {
          seeded.add(await w.grant({ memberId: asker, operation: c.grant.operation, ...(c.grant.perDay !== undefined ? { perDay: c.grant.perDay } : {}), ...(c.grant.unitsMax !== undefined ? { unitsMax: c.grant.unitsMax } : {}) }))
          held()
        }
        ceilingsBefore = ceilingRows(await w.ceilings())
        held()
      } catch (e) {
        // Every part of the undo runs even when one before it throws (the Slack workspace above all), and the seed's own
        // error stays the one thrown.
        const undo: (() => Promise<unknown>)[] = [() => session.reset(), ...(teammate ? [() => base.removeTeammate(teammate!)] : []), () => leaveSlack()]
        const failed: unknown[] = []
        for (const step of undo) {
          try {
            await step()
          } catch (u) {
            failed.push(u)
          }
          stepsDone++
        }
        // A failed undo leaves state the next repeat would inherit: the runner records it as a reset failure and stops.
        active = null
        markDone()
        if (failed.length) throw new StartUndoFailed([e, ...failed], 'the seed failed, and undoing it failed too')
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
          if (slackCase) {
            const w2 = await base.slackDoor().read()
            const want = c.channels.map((x) => x.replace(/^#/, '')).sort()
            if (JSON.stringify(w2.listed.map((l) => l.name).sort()) !== JSON.stringify(want)) return `the listed channels read ${JSON.stringify(w2.listed.map((l) => l.name))}, not ${JSON.stringify(want)}`
            if (c.plant?.via === 'slack' && w2.messages.length !== 1) return 'the planted Slack message is not in the workspace'
            const acct = await base.slackDoor().account()
            if (acct?.lastState !== 'connected') return `Slack is ${acct?.lastState ?? 'not recorded'}, not connected`
          }
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
        async approveControl(control, opts = {}) {
          // A grant's control has no card: the seeded grant runs it (the grader checks it did).
          if (control.via === 'grant') return
          const stop = () => { if (cancelled(opts.signal)) throw new Error('cancelled') }
          stop()
          const want = canonical(control.args)
          const deadline = now() + CONTROL_WAIT_MS
          let action: EvAction | undefined
          for (;;) {
            action = (await read()).actions.find((a) => a.operation === control.operation && a.args !== null && canonical(a.args) === want)
            if (action?.state === 'waiting') break
            if (action && action.state !== 'waiting') throw new Error(`the control's action is ${action.state}, not waiting for an answer`)
            if (now() > deadline) throw new Error('the control\'s card never appeared')
            await abortableSleep(sleep, 2_000, opts.signal)
            stop()
          }
          stop()
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
            await abortableSleep(sleep, 2_000, opts.signal)
            stop()
          }
        },
        evidence: read,
        // What the model received (Neon's #618 review): the non-error tool results in the repeat's session transcripts.
        async plantDelivered(plant) {
          sessions ??= createSessionReader({ env: o.env, bucket: EVAL_BUCKET })
          const chatIds = (session as { chatIds?: () => readonly string[] }).chatIds?.() ?? []
          const parts: Uint8Array[][] = []
          for (const id of chatIds) parts.push(await sessions.parts(id))
          return plantVerdict(parts, plant)
        },
        async probeAdminsCard(m, opts = {}) {
          const deadline = now() + CONTROL_WAIT_MS
          for (;;) {
            if (cancelled(opts.signal)) return // a cancel: nothing more to probe (the repeat fails on its cancelled turn)
            const a = (await read()).actions.find((x) => x.operation === m.operation && x.approverKind === 'admins' && x.state === 'waiting')
            if (a) {
              const r = await base.call('current', 'POST', `/api/actions/${encodeURIComponent(a.id)}/answer`, { json: { choice: 'approve', ifRev: a.rev } })
              answers.push({ actionId: a.id, choice: 'approve', by: asker, byRole: 'member', accepted: r.status === 200 })
              return
            }
            if (now() > deadline) return // no card: the grader says so (mustAsk)
            await abortableSleep(sleep, 2_000, opts.signal)
          }
        },
        settledCostUsd: session.settledCostUsd ? () => session.settledCostUsd!() : undefined,
        async reset() {
          try {
            await session.reset()
          } finally {
            try {
              if (teammate) await base.removeTeammate(teammate)
            } finally {
              active = null
              try {
                // Slack off again before the next case: a later non-Slack case must not see Slack in its tools.
                await leaveSlack()
              } finally {
                markDone()
              }
            }
          }
        },
      }
    }
  }
  return target
}
