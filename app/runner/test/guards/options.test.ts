// The options builder. Ways it could fail, written first (properties over any run config and any base R1 might send):
// - the sandbox is off, optional, or lets a command retry unsandboxed;
// - a tool outside the 20, or a skill outside dataviz and ours, gets in (through the lists, the allow rules or the base);
// - a base that already sets a guarded option (tools, permissions, sandbox, settings...) is merged rather than refused;
// - permission mode isn't dontAsk, settings files are read, or an MCP server other than ours is configured;
// - the deny rules for .claude/, .mcp.json, the home and /opt are missing for the session's real paths;
// - HOME or TMPDIR isn't the session user's own folder (a HOME inside the session folder puts `$HOME/.claude` where
//   Bash writes), or a user name with a `/` or `..` in it steers either path;
// - WebFetch: the permission rules and the sandbox allowlist differ from the run config's list;
// - the container's own addresses or localhost aren't denied to sandboxed commands;
// - our hooks are dropped, or run after the base's, or the base's hooks are lost;
// - reads of other sessions, other users' homes and temp folders, /home, the runner's code or /root are open to Bash,
//   or its own home and temp folder aren't given back (the temp folder to write: the sandbox's sockets sit in it);
// - the in-process Read, Glob and Grep (unsandboxed, as the session uid) reach /proc or the shared tmp folders;
// - they reach another pool user's home or temp folder once its owner opens the modes (a chmod is the owner's), or the
//   rules shut the session's own folders too;
// - webFetchDomains lets in an IP literal, a local name, an internal name (`*.svc`, `*.corp`) or this container's own
//   address;
// - a cwd that only looks like a session folder (`/work/a/`) passes; `agents` or a non-http `inhouse` server gets in;
// - the audit hook isn't on the run's own transport (`RunContext.audit`), lets a call go before it resolved, or lets
//   one go when it rejected.
import { fc, it } from '@fast-check/vitest'
import type { HookCallbackMatcher, Options } from '@anthropic-ai/claude-agent-sdk'
import { describe, expect } from 'vitest'
import { AuditEntry } from '../../../shared/protocol/index.ts'
import { AuditRefusedError } from '../../src/guards/audit.ts'
import { RunConfig } from '../../src/protocol/local.ts'
import { baseOptions, cliEnv } from '../../src/session/core.ts'
import { sessionEnv } from '../../src/session/env.ts'
import type { RunContext } from '../../src/session/seam.ts'
import { ALLOWED_SKILLS, BUILT_IN_PLUGINS_OFF, BUILT_IN_TOOLS, BUNDLED_SKILLS_OFF } from '../../src/guards/lists.ts'
import { GUARDED_OPTIONS, GuardConfigError, LOCAL_NAMES, LOCAL_SUFFIXES, assertFetchDomain, createQueryGuards } from '../../src/guards/options.ts'
import { PLUGIN_DIR, sessionPaths, userPaths } from '../../src/guards/paths.ts'
import { POOL_SIZE, poolUserName } from '../../src/guards/users.ts'

const run: RunContext = { audit: async () => {} }
/** Names inside a company or a cluster, with no local suffix a resolver would know. */
const INTERNAL_NAMES = ['db.svc', 'api.prod.svc', 'api.prod.svc.cluster.local', 'wiki.corp', 'hr.intranet', 'nas.home', 'git.private', 'router.localdomain', 'xn--a.com']
const ADDRS = ['172.17.0.5', 'fe80::1', '127.0.0.1']
const guards = createQueryGuards({ hostAddresses: () => ADDRS })
/** The session user's own folders (the base below runs as s01). */
const own = userPaths('s01')

// No `--` in the third and fourth places: those labels are reserved, and the URL parser refuses an `xn--` one that
// isn't valid punycode (`xn--a`), which the guards then refuse too.
const plain = (l: string) => !/^.{2}--/.test(l)
const label = fc.stringMatching(/^[a-z0-9]([a-z0-9-]{0,10}[a-z0-9])?$/).filter(plain)
// The top label starts with a letter: `1.2` is IPv4 shorthand, which the guards refuse.
const tld = fc
  .stringMatching(/^[a-z]([a-z0-9-]{0,10}[a-z0-9])?$/)
  .filter((t) => plain(t) && !LOCAL_SUFFIXES.some((s) => `.${t}`.endsWith(s)) && t !== 'arpa' && t !== 'localhost')
const domain = fc.tuple(label, tld).map(([a, b]) => `${a}.${b}`)
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
  const env = sessionEnv({ uid: 30001, gid: 30001, user: 's01', home: own.home, workDir: p.workDir }, 8081)
  return baseOptions(c, p.workDir, cliEnv(env), new AbortController())
}

describe('the guarded options', () => {
  it.prop([config])('for any run config: sandbox mandatory, the 20 tools, the allowed skills, dontAsk, no settings files', (c) => {
    const o = guards.apply(base(c), c, run)
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
    const o = guards.apply(base(c), c, run)
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
    const s = guards.apply(base(c), c, run).settings as { skillOverrides: Record<string, string>; enabledPlugins: Record<string, boolean> }
    expect(Object.keys(s.skillOverrides).sort()).toEqual([...BUNDLED_SKILLS_OFF].sort())
    expect(new Set(Object.values(s.skillOverrides))).toEqual(new Set(['off']))
    expect(s.enabledPlugins).toEqual(Object.fromEntries(BUILT_IN_PLUGINS_OFF.map((p) => [p, false])))
  })

  it.prop([config])("deny rules cover the session's .claude/, .mcp.json, home, /opt and the runner's code", (c) => {
    const p = sessionPaths(c.chatId)
    const deny = (guards.apply(base(c), c, run).settings as { permissions: { deny: string[] } }).permissions.deny
    for (const rule of [
      `Edit(/${p.workDir}/.claude)`,
      `Edit(/${p.workDir}/.claude/**)`,
      `Edit(/${p.workDir}/.mcp.json)`,
      `Edit(/${own.home})`,
      `Edit(/${own.home}/**)`,
      'Edit(//opt/**)',
      'Read(//opt/runner/**)',
      'Read(//root/**)',
      'Read(//proc/**)',
      'Read(//tmp/**)',
      'Read(//var/tmp/**)',
      'Read(//dev/shm/**)',
      'Read(//dev/mqueue/**)',
    ]) {
      expect(deny).toContain(rule)
    }
  })

  it.prop([config, fc.integer({ min: 0, max: POOL_SIZE - 1 })])("Read, Glob and Grep: every other pool user's folders denied by name, the session's own not", (c, i) => {
    const user = poolUserName(i)
    const mine = userPaths(user)
    const b = base(c)
    const opts = guards.apply({ ...b, env: { ...b.env, USER: user, HOME: mine.home, TMPDIR: mine.tmp } }, c, run)
    const deny = (opts.settings as { permissions: { deny: string[] } }).permissions.deny.filter((r) => r.startsWith('Read(//users'))
    const others = Array.from({ length: POOL_SIZE }, (_, j) => poolUserName(j)).filter((u) => u !== user)
    expect(deny.sort()).toEqual(others.map((u) => `Read(/${userPaths(u).dir}/**)`).sort())
  })

  it.prop([config])('the network: only the listed domains, never this container', (c) => {
    const net = guards.apply(base(c), c, run).sandbox!.network!
    expect(net.allowedDomains).toEqual(c.webFetchDomains)
    expect(net.strictAllowlist).toBe(true)
    expect(net.allowLocalBinding).toBe(false)
    expect(net.allowAllUnixSockets).toBe(false)
    for (const a of [...ADDRS, ...LOCAL_NAMES]) expect(net.deniedDomains).toContain(a)
  })

  it.prop([config])("the filesystem: other sessions, other users' folders, /home, the runner and /root are unreadable; the session's own are", (c) => {
    const fs = guards.apply(base(c), c, run).sandbox!.filesystem!
    expect(fs.denyRead).toEqual(expect.arrayContaining(['/work', '/users', '/home', '/opt/runner', '/root']))
    expect(fs.allowRead).toEqual([sessionPaths(c.chatId).workDir, own.home, own.tmp])
    // Bash writes its temp folder (and the session folder, by default): never its home.
    expect(fs.allowWrite).toEqual([own.tmp])
  })

  it.prop([config, fc.constantFrom(...GUARDED_OPTIONS), fc.anything()])('a base that sets a guarded option is refused', (c, k, v) => {
    fc.pre(v !== undefined)
    expect(() => guards.apply({ ...base(c), [k]: v } as Options, c, run)).toThrow(GuardConfigError)
  })

  it.prop([config])('our hooks run first and block; the base keeps its own', (c) => {
    const theirs: HookCallbackMatcher = { hooks: [async () => ({})] }
    const post: HookCallbackMatcher = { hooks: [async () => ({})] }
    const o = guards.apply({ ...base(c), hooks: { PreToolUse: [theirs], PostToolUse: [post] } }, c, run)
    const pre = o.hooks!.PreToolUse!
    expect(pre).toHaveLength(3)
    expect(pre[0]!.matcher).toBe('WebFetch')
    expect(pre[1]!.matcher).toBeUndefined()
    for (const m of pre.slice(0, 2)) expect(m.onFailure).toBe('block')
    expect(pre[2]).toBe(theirs)
    expect(o.hooks!.PostToolUse).toEqual([post])
  })

  it("refuses settings files, a foreign MCP server, a cwd outside the work root and a home or temp folder that isn't the user's own", () => {
    const c = fc.sample(config, 1)[0]!
    const b = base(c)
    expect(() => guards.apply({ ...b, settingSources: ['project'] }, c, run)).toThrow(/settingSources/)
    expect(() => guards.apply({ ...b, settingSources: undefined }, c, run)).toThrow(/settingSources/)
    expect(() => guards.apply({ ...b, mcpServers: { other: { type: 'http', url: 'http://x.y' } } }, c, run)).toThrow(/MCP/)
    expect(() => guards.apply({ ...b, mcpServers: { inhouse: { type: 'http', url: 'http://x.y' } } }, c, run)).not.toThrow()
    expect(() => guards.apply({ ...b, mcpServers: { inhouse: { type: 'stdio', command: 'sh' } } }, c, run)).toThrow(/MCP/)
    expect(() => guards.apply({ ...b, mcpServers: { inhouse: { type: 'sse', url: 'http://x.y' } } }, c, run)).toThrow(/MCP/)
    for (const cwd of ['/tmp/x', '/work', '/work/a/b', '/work/a/', '/work//a', '/work/../etc', '/workx/a', undefined]) {
      expect(() => guards.apply({ ...b, cwd }, c, run), String(cwd)).toThrow(/cwd/)
    }
    for (const HOME of ['/root', `${b.cwd}/.home`, b.cwd!, userPaths('s02').home, `${own.home}/`, undefined]) {
      expect(() => guards.apply({ ...b, env: { ...b.env, HOME } }, c, run), String(HOME)).toThrow(/HOME/)
    }
    for (const TMPDIR of ['/tmp', `${b.cwd}/.tmp`, own.home, userPaths('s02').tmp, undefined]) {
      expect(() => guards.apply({ ...b, env: { ...b.env, TMPDIR } }, c, run), String(TMPDIR)).toThrow(/TMPDIR/)
    }
    for (const USER of ['../s01', 's01/..', '', 'S01', undefined]) {
      expect(() => guards.apply({ ...b, env: { ...b.env, USER } }, c, run), String(USER)).toThrow(/USER/)
    }
  })

  it('guards agents and disableBundledSkills', () => {
    expect(GUARDED_OPTIONS).toEqual(expect.arrayContaining(['agents', 'disableBundledSkills']))
  })

  it.prop([config, fc.oneof(fc.ipV4(), fc.ipV4Extended(), fc.constantFrom(...LOCAL_NAMES, ...ADDRS, 'a.localhost', 'printer.local', 'db.internal', 'r.home.arpa', '1.2', '0x7f.1', 'Example.com', 'example.com.', ...INTERNAL_NAMES))])(
    'refuses a WebFetch domain that is an IP literal, a local name or this container',
    (c, bad) => {
      expect(() => guards.apply(base(c), { ...c, webFetchDomains: [...c.webFetchDomains, bad] }, run)).toThrow(/webFetchDomains/)
    },
  )

  it('refuses every internal name, each one checked', () => {
    for (const name of INTERNAL_NAMES) expect(() => assertFetchDomain(name, ADDRS), name).toThrow(GuardConfigError)
  })

  it("a tool call waits on the run's audit: blocked when it rejects, allowed only once it resolves", async () => {
    const c = fc.sample(config, 1)[0]!
    const sent: AuditEntry[] = []
    let settle!: { resolve: () => void; reject: (e: Error) => void }
    const ctx: RunContext = { audit: (e) => (sent.push(e), new Promise<void>((resolve, reject) => (settle = { resolve, reject }))) }
    const hook = guards.apply(base(c), c, ctx).hooks!.PreToolUse!.find((m) => m.matcher === undefined)!
    expect(hook.onFailure).toBe('block')
    const call = (id: string) =>
      hook.hooks[0]!({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' }, tool_use_id: id, session_id: 's', transcript_path: '', cwd: '/work/a' } as never, id, {
        signal: new AbortController().signal,
      })
    const turn = () => new Promise<void>((r) => setImmediate(r))

    let allowed = false
    const first = call('u1').then((r) => ((allowed = true), r))
    for (let i = 0; i < 5; i++) await turn()
    expect(allowed).toBe(false)
    expect(sent).toEqual([{ hook: 'PreToolUse', toolName: 'Bash', toolUseId: 'u1', decision: 'allow', input: { cut: false, value: { command: 'ls' } } }])
    // The shape the root checks.
    expect(AuditEntry.safeParse(sent[0]).success).toBe(true)
    settle.resolve()
    await expect(first).resolves.toEqual({})

    const second = call('u2')
    for (let i = 0; i < 5; i++) await turn()
    settle.reject(new Error('audit refused: the Worker has gone'))
    await expect(second).rejects.toThrow(AuditRefusedError)
    await expect(second).rejects.toThrow(/the Worker has gone/)
  })
})
