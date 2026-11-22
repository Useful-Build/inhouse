// The decided lists, pinned. Ways they could go wrong, written first:
// - a tool is added to or dropped from the 20 by a code change rather than a decision;
// - a list holds a duplicate, so the count looks right with one missing;
// - dataviz is turned off with the others, or one of ours is turned off;
// - a skill outside dataviz and ours becomes allowed.
import { describe, expect, it } from 'vitest'
import { ALLOWED_SKILLS, BUILT_IN_PLUGINS_OFF, BUILT_IN_TOOLS, BUNDLED_SKILLS_OFF, KEPT_BUNDLED_SKILLS, OUR_SKILLS, PLUGIN_NAME } from '../../src/guards/lists.ts'

/** The decision log's 20 ("Engine built-in tools"), written out here, not imported. */
const DECIDED_20 = [
  'Read', 'Write', 'Edit', 'Glob', 'Grep',
  'Bash',
  'WebSearch', 'WebFetch',
  'Agent', 'Skill', 'AskUserQuestion', 'ToolSearch', 'TaskCreate', 'TaskGet', 'TaskList', 'TaskUpdate', 'TaskStop',
  'ListMcpResourcesTool', 'ReadMcpResourceTool', 'WaitForMcpServers',
]

describe('the decided lists', () => {
  it('the built-in tools are exactly the decided 20', () => {
    expect(BUILT_IN_TOOLS).toHaveLength(20)
    expect(new Set(BUILT_IN_TOOLS).size).toBe(20)
    expect([...BUILT_IN_TOOLS].sort()).toEqual([...DECIDED_20].sort())
  })

  it('the skills: dataviz plus ours, and the other 15 bundled skills off', () => {
    expect(KEPT_BUNDLED_SKILLS).toEqual(['dataviz'])
    expect(BUNDLED_SKILLS_OFF).toHaveLength(15)
    expect(new Set(BUNDLED_SKILLS_OFF).size).toBe(15)
    expect(BUNDLED_SKILLS_OFF).not.toContain('dataviz')
    expect(ALLOWED_SKILLS).toEqual(['dataviz', ...OUR_SKILLS])
    for (const s of OUR_SKILLS) expect(s.startsWith(`${PLUGIN_NAME}:`)).toBe(true)
    for (const s of ALLOWED_SKILLS) expect(BUNDLED_SKILLS_OFF as readonly string[]).not.toContain(s)
  })

  it('the three built-in plugins are off', () => {
    expect([...BUILT_IN_PLUGINS_OFF].sort()).toEqual(['cc-plugin-agents-md@builtin', 'cc-plugin-plugin-authoring@builtin', 'cc-plugin-privacy@builtin'])
  })
})
