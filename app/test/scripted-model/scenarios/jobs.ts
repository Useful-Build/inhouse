import type { MessagesRequest, Scenario, ScriptedBlock, ScriptedTurn } from '../index.ts'

type Check = NonNullable<ScriptedTurn['expect']>

export const LONG_JOB_READY = 'The post-checkpoint file is written. Holding the turn open.'
export const LONG_JOB_DONE = 'Saved outputs/job-result.txt.'

/**
 * How long a step holds its turn: the sleep `slow-bash` uses (SLOW_BASH_SECONDS), which the CLI's Bash guard allows.
 * The guard refuses a longer one (`sleep 45` came back as an error at once in the W0-B spike).
 */
export const JOB_HOLD_SECONDS = 20
/** The steps `long-job-chain` runs, each one Bash call that holds the turn for JOB_HOLD_SECONDS. */
export const JOB_CHAIN_STEPS = 3
export const JOB_CHAIN_DONE = 'All three steps are done: outputs/job-chain.txt.'
const CHAIN_PREFIX = 'toolu_job_chain_'

type Block = { type?: unknown; id?: unknown; tool_use_id?: unknown; is_error?: unknown }
const blocksOf = (r: MessagesRequest): Block[] =>
  r.messages.flatMap(m => (Array.isArray(m.content) ? (m.content as Block[]).filter(b => typeof b === 'object' && b !== null) : []))

/**
 * `long-job-chain`'s next answer, read from the transcript, never from the turn's index or a marker in the newest
 * message (M1-B: a job's continuation is the server's own text, with no `scenario:` marker, and the CLI may add its own
 * messages after a cut or a resume). The next step is the first one with no successful result yet: a step cut by the
 * server's interrupt, or lost with a killed container (the SDK then gives its call an error result), runs again under a
 * fresh tool call id. With every step done, the final answer.
 */
export function chainNext(r: MessagesRequest): ScriptedBlock[] {
  const blocks = blocksOf(r)
  const tried = new Map<number, number>()
  const done = new Set<number>()
  const stepOf = (id: unknown): number | null => {
    if (typeof id !== 'string' || !id.startsWith(CHAIN_PREFIX)) return null
    const n = Number(id.slice(CHAIN_PREFIX.length).split('_')[0])
    return Number.isInteger(n) && n >= 1 && n <= JOB_CHAIN_STEPS ? n : null
  }
  for (const b of blocks) {
    if (b.type === 'tool_use') { const n = stepOf(b.id); if (n !== null) tried.set(n, (tried.get(n) ?? 0) + 1) }
    if (b.type === 'tool_result' && b.is_error !== true) { const n = stepOf(b.tool_use_id); if (n !== null) done.add(n) }
  }
  for (let n = 1; n <= JOB_CHAIN_STEPS; n++) {
    if (done.has(n)) continue
    return [
      { type: 'text', text: `Working on step ${n}.` },
      {
        type: 'tool_use', id: `${CHAIN_PREFIX}${n}_${tried.get(n) ?? 0}`, name: 'Bash',
        input: { command: `sleep ${JOB_HOLD_SECONDS} && echo step-${n} >> outputs/job-chain.txt`, description: `Run step ${n}` },
      },
    ]
  }
  return [{ type: 'text', text: JOB_CHAIN_DONE }]
}

/**
 * Use a fresh scenario marker per phase so a partial transcript cannot shift the scripted reply index.
 *
 * `long-job-work` and `long-job-resume` serve W0-B's crash-resume spike only: each phase is a turn a spec sends itself,
 * with its own `scenario:` marker. A real job continuation is authored by the server (N3's job texts port), so it
 * carries no `scenario:` marker and would not select these. Job specs that drive real continuations need a
 * continuation-safe scenario (one that picks its reply from the transcript, not from a marker in the newest message),
 * which M1-B builds: `long-job-chain` below.
 */
export function jobScenarios(mainLoop: (tool?: string) => Check, resultIs: (id: string, error: boolean) => Check): Record<string, Scenario> {
  const bash = (id: string, command: string, description: string, after?: string, text?: string): ScriptedTurn => ({
    content: [
      ...(text === undefined ? [] : [{ type: 'text' as const, text }]),
      { type: 'tool_use', id, name: 'Bash', input: { command, description } },
    ],
    expect: after === undefined ? mainLoop('Bash') : resultIs(after, false),
  })
  const done = (id: string, text: string): ScriptedTurn => ({ content: [{ type: 'text', text }], expect: resultIs(id, false) })
  const seed = 'toolu_job_seed'
  const tail = 'toolu_job_tail'
  const hold = 'toolu_job_hold'
  const work = 'toolu_job_work'
  const result = 'toolu_job_result'
  const chainTurn: ScriptedTurn = { content: [{ type: 'text', text: JOB_CHAIN_DONE }], contentFor: chainNext, expect: mainLoop('Bash') }
  return {
    /**
     * M1-B's continuation-safe job (start it with `scenario:long-job-chain`): three steps of JOB_HOLD_SECONDS each, the
     * next one always read from the transcript (`chainNext`). With JOB_CUT_MS shortened (job-kit `setJobTimings`), the
     * server cuts each turn inside a step, so the root becomes a job and its continuations, which carry no marker,
     * finish the steps. A turn index past 40 is a miss.
     */
    'long-job-chain': { turns: Array.from({ length: 40 }, () => chainTurn) },
    'long-job': {
      turns: [bash(seed, "printf 'checkpoint\\n' > outputs/job-seed.txt", 'Write the checkpoint file'), done(seed, 'Saved outputs/job-seed.txt.')],
    },
    'long-job-work': {
      turns: [
        bash(tail, "printf 'partial\\n' > outputs/job-tail.txt", 'Write a post-checkpoint file'),
        bash(hold, `sleep ${JOB_HOLD_SECONDS} && echo first-step`, 'Hold the turn in its first step', tail, LONG_JOB_READY),
        bash(work, 'sleep 5 && echo second-step', 'Run the second step', hold),
        done(work, 'Completed the long turn.'),
      ],
    },
    'long-job-resume': {
      turns: [
        bash(result, "test -f outputs/job-seed.txt && { cat outputs/job-seed.txt; if test -f outputs/job-tail.txt; then cat outputs/job-tail.txt; else echo tail-missing; fi; } > outputs/job-result.txt", 'Build a result from the surviving files'),
        done(result, LONG_JOB_DONE),
      ],
    },
  }
}
