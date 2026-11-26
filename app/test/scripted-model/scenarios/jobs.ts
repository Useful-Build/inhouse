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

type Block = { type?: unknown; id?: unknown; tool_use_id?: unknown; is_error?: unknown; text?: unknown }
const blocksOf = (r: MessagesRequest): Block[] =>
  r.messages.flatMap(m => (Array.isArray(m.content) ? (m.content as Block[]).filter(b => typeof b === 'object' && b !== null) : []))

/**
 * M1-D's jobs (`long-job-run` for e2e/api/jobs.spec.ts, `long-job-soak` for the 2-hour proof): the same chain as
 * `long-job-chain`, but each step's tool call id carries the run's own token, written in the person's first message as
 * `run=<token>` (letters and digits). A spec then finds its own job's steps in the session store (the test-fakes
 * `transcripts` op) among every other chat's, and can tell a step that is running (a call with no result yet) from one
 * that ended, to kill the container while a step runs.
 */
export const JOB_RUN_STEPS = 3
/**
 * How long a `long-job-run` step holds its turn: three 20-second sleeps in one Bash call, so a spec that finds the step
 * running in the session store has most of a minute to kill the container under it (one 20-second sleep proved too
 * short on the sandbox: the store read and the kill landed after the step had ended).
 */
export const JOB_RUN_STEP_SECONDS = 60
export const JOB_RUN_DONE = 'All three steps are done: outputs/job-run.txt.'
export const JOB_RUN_FILE = 'outputs/job-run.txt'
/**
 * The soak's steps: each holds its turn for SOAK_STEP_SECONDS, as 20-second sleeps in one Bash call (the CLI's guard
 * refuses only a first `sleep` of 25 seconds or more) with a timeout past its length (the default is 2 minutes), so
 * the steps' sleeps alone add up to 2 hours: the job can't end sooner, whatever the overheads. Few, long steps keep the
 * session store small: each append is one stored part, and the test-fakes `transcripts` op reads at most 500.
 */
export const SOAK_STEP_SECONDS = 180
export const SOAK_STEPS = 40
/** The soak step's Bash timeout: a minute past its sleeps (the tool's own maximum is 10 minutes). */
export const SOAK_STEP_TIMEOUT_MS = (SOAK_STEP_SECONDS + 60) * 1000
export const SOAK_DONE = 'All soak steps are done: outputs/job-soak.txt.'
export const SOAK_FILE = 'outputs/job-soak.txt'
const RUN_TOKEN = /\brun=([A-Za-z0-9]{6,32})\b/

/**
 * The run token in the request's first user message, or `none` when it names none (the chain still runs, as every
 * scenario must for the runner's shared checks; only a spec that finds its steps needs a token of its own).
 */
export const NO_RUN_TOKEN = 'none'
export function runTokenOf(r: MessagesRequest): string {
  const first = r.messages.find(m => m.role === 'user')
  const text = first === undefined ? '' : typeof first.content === 'string' ? first.content
    : Array.isArray(first.content) ? (first.content as Block[]).map(b => (typeof b.text === 'string' ? b.text : '')).join(' ') : ''
  return RUN_TOKEN.exec(text)?.[1] ?? NO_RUN_TOKEN
}

/** The tool call id prefix of a run's steps: what a spec looks for in the session store. */
export const stepIdPrefix = (kind: 'run' | 'soak', token: string): string => `toolu_job${kind}_${token}_`

/** The next answer of a token chain, read from the transcript as `chainNext` does. */
function tokenChainNext(r: MessagesRequest, kind: 'run' | 'soak'): ScriptedBlock[] {
  const steps = kind === 'run' ? JOB_RUN_STEPS : SOAK_STEPS
  const prefix = stepIdPrefix(kind, runTokenOf(r))
  const tried = new Map<number, number>()
  const done = new Set<number>()
  const stepOf = (id: unknown): number | null => {
    if (typeof id !== 'string' || !id.startsWith(prefix)) return null
    const n = Number(id.slice(prefix.length).split('_')[0])
    return Number.isInteger(n) && n >= 1 && n <= steps ? n : null
  }
  for (const b of blocksOf(r)) {
    if (b.type === 'tool_use') { const n = stepOf(b.id); if (n !== null) tried.set(n, (tried.get(n) ?? 0) + 1) }
    if (b.type === 'tool_result' && b.is_error !== true) { const n = stepOf(b.tool_use_id); if (n !== null) done.add(n) }
  }
  for (let n = 1; n <= steps; n++) {
    if (done.has(n)) continue
    const file = kind === 'run' ? JOB_RUN_FILE : SOAK_FILE
    const seconds = kind === 'run' ? JOB_RUN_STEP_SECONDS : SOAK_STEP_SECONDS
    const hold = Array.from({ length: seconds / JOB_HOLD_SECONDS }, () => `sleep ${JOB_HOLD_SECONDS}`).join('; ')
    return [
      { type: 'text', text: `Working on step ${n}.` },
      {
        type: 'tool_use', id: `${prefix}${n}_${tried.get(n) ?? 0}`, name: 'Bash',
        input: { command: `${hold}; echo step-${n} >> ${file}`, description: `Run step ${n}`, ...(kind === 'soak' ? { timeout: SOAK_STEP_TIMEOUT_MS } : {}) },
      },
    ]
  }
  return [{ type: 'text', text: kind === 'run' ? JOB_RUN_DONE : SOAK_DONE }]
}

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
  const runTurn: ScriptedTurn = { content: [{ type: 'text', text: JOB_RUN_DONE }], contentFor: r => tokenChainNext(r, 'run'), expect: mainLoop('Bash') }
  const soakTurn: ScriptedTurn = { content: [{ type: 'text', text: SOAK_DONE }], contentFor: r => tokenChainNext(r, 'soak'), expect: mainLoop('Bash') }
  return {
    /** M1-D's short job (e2e/api/jobs.spec.ts): `scenario:long-job-run run=<token>`. A turn index past 40 is a miss. */
    'long-job-run': { turns: Array.from({ length: 40 }, () => runTurn) },
    /**
     * M1-D's 2-hour job (e2e/api/job-soak.spec.ts): `scenario:long-job-soak run=<token>`. SOAK_STEPS steps and room for
     * every one to be cut or lost once and run again, with the turns' own extra requests; past that is a miss.
     */
    'long-job-soak': { turns: Array.from({ length: SOAK_STEPS * 3 + 40 }, () => soakTurn) },
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
