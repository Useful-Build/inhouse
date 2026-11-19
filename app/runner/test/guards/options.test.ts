// The options builder. Ways it could fail, written first (properties over any run config and any base R1 might send):
// - the sandbox is off, optional, or lets a command retry unsandboxed;
// - a tool outside the 20, or a skill outside dataviz and ours, gets in (through the lists, the allow rules or the base);
// - a base that already sets a guarded option (tools, permissions, sandbox, settings...) is merged rather than refused;
// - permission mode isn't dontAsk, settings files are read, or an MCP server other than ours is configured;
// - the deny rules for .claude/, .mcp.json, the home and /opt are missing for the session's real paths;
// - WebFetch: the permission rules and the sandbox allowlist differ from the run config's list;
// - the container's own addresses or localhost aren't denied to sandboxed commands;
// - our hooks are dropped, or run after the base's, or the base's hooks are lost;
// - reads of other sessions, /home, the runner's code or /root are open to Bash.
import { fc, it } from '@fast-check/vitest'
import type { HookCallbackMatcher, Options } from '@anthropic-ai/claude-agent-sdk'
import { describe, expect } from 'vitest'
import { RunConfig } from '../../src/protocol/local.ts'
import { baseOptions, cliEnv } from '../../src/session/core.ts'
import { sessionEnv } from '../../src/session/env.ts'
import type { AuditChannel } from '../../src/guards/audit.ts'
import { ALLOWED_SKILLS, BUILT_IN_PLUGINS_OFF, BUILT_IN_TOOLS, BUNDLED_SKILLS_OFF } from '../../src/guards/lists.ts'
import { GUARDED_OPTIONS, GuardConfigError, LOCAL_NAMES, createQueryGuards } from '../../src/guards/options.ts'
import { PLUGIN_DIR, sessionPaths } from '../../src/guards/paths.ts'

const ack: AuditChannel = { send: async () => ({ ok: true }) }
const ADDRS = ['172.17.0.5', 'fe80::1', '127.0.0.1']
const guards = createQueryGuards({ audit: ack, hostAddresses: () => ADDRS })

const label = fc.stringMatching(/^[a-z0-9]([a-z0-9-]{0,10}[a-z0-9])?$/)
const domain = fc.tuple(label, label).map(([a, b]) => `${a}.${b}`)
const key = fc.stringMatching(/^[A-Za-z0-9_-]{1,64}$/)
const config = fc
  .record({
    runId: key,
    chatId: key,
    sessionId: fc.uuid(),
    resume: fc.boolean(),
    prompt: fc.string({ minLength: 1, maxLength: 50 }),
    model: fc.constantFrom('claude-sonnet-5-5', 'claude-opus-5-5'),
    effort: fc.constantFrom('low', 'medium', 'high', 'xhigh', 'max'),
    maxTurns: fc.integer({ min: 1, max: 500 }),
    maxBudgetUsd: fc.double({ min: 0.01, max: 1000, noNaN: true }),
    webFetchDomains: fc.uniqueArray(domain, { maxLength: 8 }),
    fileCaps: fc.constant({ maxFileBytes: 1, maxFilesPerTurn: 1, maxRestoreBytes: 0, allowedTypes: [] }),
  })
  .map((c) => RunConfig.parse(c))

/** R1's real base options for a session folder, as the session process builds them. */
function base(c: RunConfig): Options {
  const p = sessionPaths(c.chatId)
  const env = sessionEnv({ uid: 30001, gid: 30001, user: 's01', home: p.home, workDir: p.workDir }, 8081)
  return baseOptions(c, p.workDir, cliEnv(env), new AbortController())
}

describe('the guarded options', () => {
  it.prop([config])('for any run config: sandbox mandatory, the 20 tools, the allowed skills, dontAsk, no settings files', (c) => {
    const o = guards.apply(base(c), c)
    expect(o.sandbox?.enabled).toBe(true)
    expect(o.sandbox?.failIfUnavailable).toBe(true)
    expect(o.sandbox?.allowUnsandboxedCommands).toBe(false)
    expect(o.tools).toEqual([...BUILT_IN_TOOLS])
    expect(o.skills).toEqual([...ALLOWED_SKILLS])
    expect(o.permissionMode).toBe('dontAsk')
    expect(o.allowDangerouslySkipPermissions).toBeUndefined()
    expect(o.settingSources).toEqual([])
    expect(o.strictMcpConfig).toBe(true)
    expect(o.plugins).toEqual([{ type: 'local', path: PLUGIN_DIR, skipMcpDiscovery: true }])
    // R1's fields come through untouched.
    expect(o.model).toBe(c.model)
    expect(o.maxTurns).toBe(c.maxTurns)
    expect(o.cwd).toBe(sessionPaths(c.chatId).workDir)
  })

  it.prop([config])('every allow rule names one of the 20, our MCP server, or WebFetch for a listed domain', (c) => {
    const o = guards.apply(base(c), c)
    const allowed = new Set<string>(BUILT_IN_TOOLS)
    for (const rule of o.allowedTools ?? []) {
      const tool = rule.replace(/\(.*$/, '')
      if (rule === 'mcp__inhouse') continue
      expect(allowed.has(tool), rule).toBe(true)
    }
    const fetchRules = (o.allowedTools ?? []).filter((r) => r.startsWith('WebFetch'))
    expect(fetchRules).toEqual(c.webFetchDomains.map((d) => `WebFetch(domain:${d})`))
    // Writes only inside the session folder; never a bare Edit, Write or WebFetch.
    const wd = sessionPaths(c.chatId).workDir
    expect((o.allowedTools ?? []).filter((r) => /^(Edit|Write)\b/.test(r))).toEqual([`Edit(/${wd}/**)`])
    expect(o.allowedTools).not.toContain('WebFetch')
  })

  it.prop([config])('skills and plugins: the other 15 bundled skills and the 3 built-in plugins are off', (c) => {
    const s = guards.apply(base(c), c).settings as { skillOverrides: Record<string, string>; enabledPlugins: Record<string, boolean> }
    expect(Object.keys(s.skillOverrides).sort()).toEqual([...BUNDLED_SKILLS_OFF].sort())
    expect(new Set(Object.values(s.skillOverrides))).toEqual(new Set(['off']))
    expect(s.enabledPlugins).toEqual(Object.fromEntries(BUILT_IN_PLUGINS_OFF.map((p) => [p, false])))
  })

  it.prop([config])("deny rules cover the session's .claude/, .mcp.json, home, /opt and the runner's code", (c) => {
    const p = sessionPaths(c.chatId)
    const deny = (guards.apply(base(c), c).settings as { permissions: { deny: string[] } }).permissions.deny
    for (const rule of [
      `Edit(/${p.workDir}/.claude)`,
      `Edit(/${p.workDir}/.claude/**)`,
      `Edit(/${p.workDir}/.mcp.json)`,
      `Edit(/${p.home})`,
      `Edit(/${p.home}/**)`,
      'Edit(//opt/**)',
      'Read(//opt/runner/**)',
      'Read(//root/**)',
    ]) {
      expect(deny).toContain(rule)
    }
  })

  it.prop([config])('the network: only the listed domains, never this container', (c) => {
    const net = guards.apply(base(c), c).sandbox!.network!
    expect(net.allowedDomains).toEqual(c.webFetchDomains)
    expect(net.strictAllowlist).toBe(true)
    expect(net.allowLocalBinding).toBe(false)
    expect(net.allowAllUnixSockets).toBe(false)
    for (const a of [...ADDRS, ...LOCAL_NAMES]) expect(net.deniedDomains).toContain(a)
  })

  it.prop([config])('the filesystem: other sessions, /home, the runner and /root are unreadable; the session folder is', (c) => {
    const fs = guards.apply(base(c), c).sandbox!.filesystem!
    expect(fs.denyRead).toEqual(expect.arrayContaining(['/work', '/home', '/opt/runner', '/root']))
    expect(fs.allowRead).toEqual([sessionPaths(c.chatId).workDir])
  })

  it.prop([config, fc.constantFrom(...GUARDED_OPTIONS), fc.anything()])('a base that sets a guarded option is refused', (c, k, v) => {
    fc.pre(v !== undefined)
    expect(() => guards.apply({ ...base(c), [k]: v } as Options, c)).toThrow(GuardConfigError)
  })

  it.prop([config])('our hooks run first and block; the base keeps its own', (c) => {
    const theirs: HookCallbackMatcher = { hooks: [async () => ({})] }
    const post: HookCallbackMatcher = { hooks: [async () => ({})] }
    const o = guards.apply({ ...base(c), hooks: { PreToolUse: [theirs], PostToolUse: [post] } }, c)
    const pre = o.hooks!.PreToolUse!
    expect(pre).toHaveLength(3)
    expect(pre[0]!.matcher).toBe('WebFetch')
    expect(pre[1]!.matcher).toBeUndefined()
    for (const m of pre.slice(0, 2)) expect(m.onFailure).toBe('block')
    expect(pre[2]).toBe(theirs)
    expect(o.hooks!.PostToolUse).toEqual([post])
  })

  it('refuses settings files, a foreign MCP server, a cwd outside the work root and a home outside the session', () => {
    const c = fc.sample(config, 1)[0]!
    const b = base(c)
    expect(() => guards.apply({ ...b, settingSources: ['project'] }, c)).toThrow(/settingSources/)
    expect(() => guards.apply({ ...b, settingSources: undefined }, c)).toThrow(/settingSources/)
    expect(() => guards.apply({ ...b, mcpServers: { other: { type: 'http', url: 'http://x.y' } } }, c)).toThrow(/MCP/)
    expect(() => guards.apply({ ...b, mcpServers: { inhouse: { type: 'http', url: 'http://x.y' } } }, c)).not.toThrow()
    for (const cwd of ['/tmp/x', '/work', '/work/a/b', '/work/../etc', '/workx/a', undefined]) {
      expect(() => guards.apply({ ...b, cwd }, c), String(cwd)).toThrow(/cwd/)
    }
    expect(() => guards.apply({ ...b, env: { ...b.env, HOME: '/root' } }, c)).toThrow(/HOME/)
  })
})
