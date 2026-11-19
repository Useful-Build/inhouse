// The decided lists (decision log: "Engine built-in tools", "Engine bundled skills and plugins", Q7). A change here is
// a product decision, not a code change: test/guards/lists.test.ts pins each list.

/** The 20 built-in tools the agent keeps. Everything else the engine offers is off. */
export const BUILT_IN_TOOLS = [
  // Files and search
  'Read',
  'Write',
  'Edit',
  'Glob',
  'Grep',
  // Run code (sandboxed)
  'Bash',
  // Web
  'WebSearch',
  'WebFetch',
  // Thinking helpers
  'Agent',
  'Skill',
  'AskUserQuestion',
  'ToolSearch',
  'TaskCreate',
  'TaskGet',
  'TaskList',
  'TaskUpdate',
  'TaskStop',
  // Our tools over MCP
  'ListMcpResourcesTool',
  'ReadMcpResourceTool',
  'WaitForMcpServers',
] as const

/** The one MCP server the agent gets: ours. Its tools are `mcp__inhouse__*`. */
export const INHOUSE_MCP_SERVER = 'inhouse'

/** The bundled skill we keep (its licence keeps it inside the engine, so it's allowlisted by name). */
export const KEPT_BUNDLED_SKILLS = ['dataviz'] as const

/** The other 15 bundled skills, each turned off (P0 S2's list for the pinned engine). */
export const BUNDLED_SKILLS_OFF = [
  'deep-research',
  'update-config',
  'verify',
  'debug',
  'code-review',
  'simplify',
  'batch',
  'fewer-permission-prompts',
  'doctor',
  'loop',
  'claude-api',
  'workflow-authoring',
  'run',
  'run-skill-generator',
  'plugin-authoring',
] as const

/** The built-in plugins turned off (`sec-default` can't be). */
export const BUILT_IN_PLUGINS_OFF = ['cc-plugin-agents-md@builtin', 'cc-plugin-privacy@builtin', 'cc-plugin-plugin-authoring@builtin'] as const

/** Our plugin's name (image/plugin/.claude-plugin/plugin.json); its skills are `inhouse:<skill>`. */
export const PLUGIN_NAME = 'inhouse'

/**
 * Our own skills, plugin-qualified. Empty until their content lands (Q7: one per file type, PDF, Word, spreadsheet).
 * Each one added here must exist under image/plugin/skills/.
 */
export const OUR_SKILLS: readonly string[] = []

/** The skills the agent may use: dataviz plus ours. */
export const ALLOWED_SKILLS: readonly string[] = [...KEPT_BUNDLED_SKILLS, ...OUR_SKILLS]
