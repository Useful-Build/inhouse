// Which scenario a turn plays when its text carries no `scenario:` marker (P4 W6, p4-w6.md section 4): the system routines'
// prompts are ours, fixed text with no marker, so a route names the scenario by a text the turn contains. Test build only: it is
// behind the same `@scripted-model` switch as the scenarios (server/model/scripted-off.ts exports no routes), so the deployable
// Worker carries no route. A `scenario:` marker in a user message always wins over a route (egress/gateway.ts `scenarioStart`).
// No import: the scenarios import this folder's types, and the prompts are handed in by the caller (the egress gateway), so no
// program that reads the scenarios is pulled into the server's modules.

export interface ScenarioRoute {
  /** The text a turn's first user message contains (never empty). */
  contains: string
  scenario: string
}

/**
 * The routes for the system routines' prompts (`SYSTEM_ROUTINE_PROMPTS`, by `prompt_ref`): the morning check's run plays the
 * `morning-check` scenario. Keyed on the prompt's own text, so it follows the prompt when the real one lands, with no phrase to
 * keep in step. A team routine's turn is a fixed preamble plus a person's instruction (`routinePrompt`), which never contains a
 * system prompt.
 */
export const routesFor = (prompts: Readonly<Record<string, string>>): readonly ScenarioRoute[] => {
  const text = prompts['morning-check']
  if (!text) throw new Error('scripted-model routes: the system prompts have no morning-check text')
  return [{ contains: text, scenario: 'morning-check' }]
}
