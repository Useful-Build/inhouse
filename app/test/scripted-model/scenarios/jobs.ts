import type { Scenario, ScriptedTurn } from '../index.ts'

type Check = NonNullable<ScriptedTurn['expect']>

export const LONG_JOB_READY = 'The post-checkpoint file is written. Holding the turn open.'
export const LONG_JOB_DONE = 'Saved outputs/job-result.txt.'

/** Use a fresh scenario marker per phase so a partial transcript cannot shift the scripted reply index. */
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
  // W0-B spike only: what the resumed request carried from before the resume prompt (the gateway's `spikeEarlier`).
  const history = (r: Parameters<Check>[0]): string => {
    const all = [...(Array.isArray(r.spikeEarlier) ? (r.spikeEarlier as typeof r.messages) : []), ...r.messages]
    const blocks = (m: (typeof all)[number]) => (Array.isArray(m.content) ? (m.content as { type?: string; id?: string; tool_use_id?: string; is_error?: boolean; content?: unknown }[]) : [])
    const results = new Map<string, { error: boolean; said: string }>()
    for (const m of all) for (const b of blocks(m)) if (b.type === 'tool_result' && b.tool_use_id) {
      const said = typeof b.content === 'string' ? b.content : Array.isArray(b.content) ? b.content.map(c => (c as { text?: string }).text ?? '').join(' ') : ''
      results.set(b.tool_use_id, { error: b.is_error === true, said: said.replace(/\s+/g, ' ').slice(0, 80) })
    }
    const uses: string[] = []
    const unpaired: string[] = []
    all.forEach((m, i) => {
      if (m.role !== 'assistant') return
      const ids = blocks(m).filter(b => b.type === 'tool_use' && b.id).map(b => b.id!)
      uses.push(...ids)
      const next = all.slice(i + 1).find(n => n.role !== 'system')
      const paired = new Set(next?.role === 'user' ? blocks(next).filter(b => b.type === 'tool_result').map(b => b.tool_use_id) : [])
      unpaired.push(...ids.filter(id => !paired.has(id)))
    })
    const fate = (id: string) => (!uses.includes(id) ? 'absent' : results.has(id) ? `result(error=${results.get(id)!.error}, "${results.get(id)!.said}")` : 'no-result')
    return `history earlier=${Array.isArray(r.spikeEarlier) ? r.spikeEarlier.length : 'none'} messages=${all.length} roles=${all.map(m => m.role[0]).join('')} seed=${fate(seed)} tail=${fate(tail)} hold=${fate(hold)} work=${fate(work)} unpaired=${unpaired.length === 0 ? 'none' : unpaired.join(',')}`
  }
  return {
    'long-job': {
      turns: [bash(seed, "printf 'checkpoint\\n' > outputs/job-seed.txt", 'Write the checkpoint file'), done(seed, 'Saved outputs/job-seed.txt.')],
    },
    'long-job-work': {
      turns: [
        bash(tail, "printf 'partial\\n' > outputs/job-tail.txt", 'Write a post-checkpoint file'),
        bash(hold, 'sleep 45 && echo first-step', 'Hold the turn in its first step', tail, LONG_JOB_READY),
        bash(work, 'sleep 5 && echo second-step', 'Run the second step', hold),
        done(work, 'Completed the long turn.'),
      ],
    },
    'long-job-resume': {
      turns: [
        bash(result, "test -f outputs/job-seed.txt && { cat outputs/job-seed.txt; if test -f outputs/job-tail.txt; then cat outputs/job-tail.txt; else echo tail-missing; fi; } > outputs/job-result.txt", 'Build a result from the surviving files'),
        { ...done(result, LONG_JOB_DONE), contentFor: (r) => [{ type: 'text', text: `${LONG_JOB_DONE}\n${history(r)}` }] },
      ],
    },
  }
}
