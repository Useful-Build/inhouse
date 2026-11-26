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
// - (P4 H1) a server other than `inhouse` and `apps` gets in, either is not http, or its URL is anything but the
//   proxy's own route for it (`/mcp/` for `inhouse`, `/hub/` for `apps`);
// - the audit hook isn't on the run's own transport (`RunContext.audit`), lets a call go before it resolved, or lets
//   one go when it rejected.
import { fc, it } from '@fast-check/vitest'
import type { HookCallbackMatcher, Options } from '@anthropic-ai/claude-agent-sdk'
import { describe, expect } from 'vitest'
import { AuditEntry, auditInputSha256 } from '../../../shared/protocol/index.ts'
import { AUDIT_HOOK_TIMEOUT_S, AuditRefusedError } from '../../src/guards/audit.ts'
import { RunConfig } from '../../src/protocol/local.ts'
import { baseOptions, cliEnv } from '../../src/session/core.ts'
import { sessionEnv } from '../../src/session/env.ts'
import type { RunContext } from '../../src/session/seam.ts'
import { HELPER_ENV, helperDefinitions } from '../../src/guards/agents.ts'
import { ALLOWED_SKILLS, BUILT_IN_PLUGINS_OFF, BUILT_IN_TOOLS, BUNDLED_SKILLS_OFF } from '../../src/guards/lists.ts'
import { GUARDED_OPTIONS, GuardConfigError, LOCAL_NAMES, LOCAL_SUFFIXES, assertFetchDomain, createQueryGuards } from '../../src/guards/options.ts'
import { PLUGIN_DIR, sessionPaths, userPaths } from '../../src/guards/paths.ts'
import { POOL_SIZE, poolUserName } from '../../src/guards/users.ts'

const run: RunContext = { loneToolCall: async () => false, audit: async () => {} }
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
    sideModel: fc.constant('claude-haiku-5-5'),
    systemPrompt: fc.string({ maxLength: 50 }),
    attachments: fc.constant([]),
    effort: fc.constantFrom('low', 'medium', 'high', 'xhigh', 'max'),
    maxTurns: fc.integer({ min: 1, max: 500 }),
    maxBudgetUsd: fc.double({ min: 0.01, max: 1000, noNaN: true }),
    // null: WebFetch to any public host (Wasim, decision 20); a list: only those.
    webFetchDomains: fc.option(fc.uniqueArray(domain, { maxLength: 8 }), { nil: null, freq: 3 }),
    // P8a S: absent (a Worker from before it), false or true.
    webSearch: fc.option(fc.boolean(), { nil: undefined }),
    fileCaps: fc.constant({ maxFileBytes: 1, maxFilesPerTurn: 1, maxRestoreBytes: 0, allowedTypes: [] }),
  })
  .map((c) => RunConfig.parse({ ...c, expect: c.resume ? { mainEntries: 1, lastUuid: null, lastUuidIndex: null } : null }))

/** The built-in tools a run gets: WebSearch only when the run config turns it on (P8a S). */
const builtIns = (c: RunConfig) => BUILT_IN_TOOLS.filter((t) => t !== 'WebSearch' || c.webSearch === true)

/** R1's real base options for a session folder, as the session process builds them. */
function base(c: RunConfig): Options {
  const p = sessionPaths(c.chatId)
  const env = sessionEnv({ uid: 30001, gid: 30001, user: 's01', home: own.home, workDir: p.workDir }, 8081)
  return baseOptions(c, p.workDir, cliEnv(env), new AbortController())
}

describe('the guarded options', () => {
  // Structured output (R3 follow-up). Ways it could fail: StructuredOutput is available or pre-approved without an
  // outputFormat (the model could end a plain run on it), or missing with one (the SDK can't return the answer); a base
  // whose outputFormat differs from the run config's goes through.
  const SCHEMA = { type: 'object', properties: { n: { type: 'integer' } }, required: ['n'] }
  it.prop([config])('StructuredOutput is in tools and allowedTools exactly when the run config asks for structured output', (c) => {
    const plain = guards.apply(base({ ...c, outputFormat: undefined }), { ...c, outputFormat: undefined }, run)
    expect(plain.tools).not.toContain('StructuredOutput')
    expect(plain.allowedTools).not.toContain('StructuredOutput')
    expect(plain.outputFormat).toBeUndefined()
    const asked = { ...c, outputFormat: { type: 'json_schema' as const, schema: SCHEMA } }
    const o = guards.apply(base(asked), asked, run)
    expect(o.tools).toEqual([...builtIns(c), 'StructuredOutput'])
    expect(o.allowedTools).toContain('StructuredOutput')
    expect(o.outputFormat).toEqual({ type: 'json_schema', schema: SCHEMA })
  })

  // The WebSearch switch (P8a S). Ways it could fail: WebSearch is offered or pre-approved with the switch off or absent
  // (a Worker from before P8a), or missing with it on.
  it.prop([config])('WebSearch is in tools and allowedTools exactly when webSearch is true', (c) => {
    const o = guards.apply(base(c), c, run)
    expect((o.tools as string[]).includes('WebSearch')).toBe(c.webSearch === true)
    expect(o.allowedTools?.includes('WebSearch')).toBe(c.webSearch === true)
    for (const off of [undefined, false]) {
      const d = { ...c, webSearch: off }
      const p = guards.apply(base(d), d, run)
      expect(p.tools).not.toContain('WebSearch')
      expect(p.allowedTools).not.toContain('WebSearch')
    }
  })

  it.prop([config])("a base whose outputFormat isn't the run config's is refused", (c) => {
    const asked = { ...c, outputFormat: { type: 'json_schema' as const, schema: SCHEMA } }
    const plain = { ...c, outputFormat: undefined }
    expect(() => guards.apply(base(asked), plain, run)).toThrow(/outputFormat/)
    expect(() => guards.apply(base(plain), asked, run)).toThrow(/outputFormat/)
    expect(() => guards.apply({ ...base(asked), outputFormat: { type: 'json_schema', schema: { type: 'string' } } }, asked, run)).toThrow(/outputFormat/)
  })

  it.prop([config])('for any run config: sandbox mandatory, the 20 tools, the allowed skills, dontAsk, no settings files', (c) => {
    const o = guards.apply(base(c), c, run)
    expect(o.sandbox?.enabled).toBe(true)
    expect(o.sandbox?.failIfUnavailable).toBe(true)
    expect(o.sandbox?.allowUnsandboxedCommands).toBe(false)
    expect(o.tools).toEqual(builtIns(c))
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

  // Brand skills (P6a). Ways it could fail: a brand skill isn't in the skills lock (it never loads), one is listed
  // without its plugin (or ours is dropped), the brand plugin points anywhere but the user's own root-owned folder, or
  // a brand skill changes the tools, the permission mode or the allow rules.
  const brandName = fc.stringMatching(/^[a-z][a-z0-9]{0,8}(-[a-z0-9]{1,8}){0,2}$/).filter((n) => !['dataviz', 'pdf', 'word', 'spreadsheet'].includes(n))
  const brandSkills = fc.uniqueArray(brandName, { minLength: 1, maxLength: 5 }).map((ns) => ns.map((name) => ({ name, description: `Does ${name}.`, body: 'Steps.' })))
  it.prop([config, brandSkills])("a run's brand skills join the skills lock as brand:<name>, from the user's own brand plugin, and change nothing else", (c0, skills) => {
    const c = RunConfig.parse({ ...c0, brandSkills: skills })
    const o = guards.apply(base(c), c, run)
    const plain = guards.apply(base(c0), c0, run)
    expect(o.skills).toEqual([...ALLOWED_SKILLS, ...skills.map((s) => `brand:${s.name}`)])
    expect(o.plugins).toEqual([
      { type: 'local', path: PLUGIN_DIR, skipMcpDiscovery: true },
      { type: 'local', path: own.brandPlugin, skipMcpDiscovery: true },
    ])
    expect([o.tools, o.allowedTools, o.permissionMode, o.settings, o.sandbox]).toEqual([plain.tools, plain.allowedTools, plain.permissionMode, plain.settings, plain.sandbox])
    // None: no brand plugin at all.
    const none = RunConfig.parse({ ...c0, brandSkills: [] })
    expect(guards.apply(base(none), none, run).plugins).toEqual([{ type: 'local', path: PLUGIN_DIR, skipMcpDiscovery: true }])
  })

  it.prop([config])('every allow rule names one of the 20, our MCP server, or WebFetch for a listed domain', (c) => {
    const o = guards.apply(base(c), c, run)
    const allowed = new Set<string>(BUILT_IN_TOOLS)
    for (const rule of o.allowedTools ?? []) {
      const tool = rule.replace(/\(.*$/, '')
      if (rule === 'mcp__inhouse' || rule === 'mcp__apps') continue
      expect(allowed.has(tool), rule).toBe(true)
    }
    const fetchRules = (o.allowedTools ?? []).filter((r) => r.startsWith('WebFetch'))
    expect(fetchRules).toEqual(c.webFetchDomains === null ? ['WebFetch'] : c.webFetchDomains.map((d) => `WebFetch(domain:${d})`))
    // Writes only inside the session folder; never a bare Edit or Write.
    const wd = sessionPaths(c.chatId).workDir
    expect((o.allowedTools ?? []).filter((r) => /^(Edit|Write)\b/.test(r))).toEqual([`Edit(/${wd}/**)`])
    // A bare WebFetch rule only when it's open to any public host (the hook then decides each URL).
    if (c.webFetchDomains !== null) expect(o.allowedTools).not.toContain('WebFetch')
  })

  it.prop([config])('skills and plugins: the other 15 bundled skills and the 3 built-in plugins are off', (c) => {
    const s = guards.apply(base(c), c, run).settings as { skillOverrides: Record<string, string>; enabledPlugins: Record<string, boolean> }
    expect(Object.keys(s.skillOverrides).sort()).toEqual([...BUNDLED_SKILLS_OFF].sort())
    expect(new Set(Object.values(s.skillOverrides))).toEqual(new Set(['off']))
    expect(s.enabledPlugins).toEqual(Object.fromEntries(BUILT_IN_PLUGINS_OFF.map((p) => [p, false])))
  })

  // M1-P: the CLI's WebFetch preflight asks api.anthropic.com about each host, which the container can't reach, so every
  // fetch failed on the sandbox; our host list and the egress decide instead.
  it.prop([config])("WebFetch's preflight lookup is off on every run", (c) => {
    expect((guards.apply(base(c), c, run).settings as { skipWebFetchPreflight?: unknown }).skipWebFetchPreflight).toBe(true)
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

  // Stage 1 (N6): Bash has no network, whatever WebFetch may reach. Before, Bash reached the WebFetch list.
  it.prop([config])('the network: none for Bash (not even the WebFetch list), never this container', (c) => {
    const net = guards.apply(base(c), c, run).sandbox!.network!
    expect(net.allowedDomains).toEqual([])
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
    // Ours, in order: the helper hook (every tool), WebFetch's, the defer hook (question_ask), the audit hook (every tool).
    expect(pre).toHaveLength(5)
    expect(pre.map((m) => m.matcher)).toEqual([undefined, 'WebFetch', 'mcp__inhouse__question_ask', undefined, undefined])
    for (const m of pre.slice(0, 4)) expect(m.onFailure).toBe('block')
    expect(pre[3]!.timeout).toBe(AUDIT_HOOK_TIMEOUT_S)
    expect(pre[4]).toBe(theirs)
    expect(o.hooks!.PostToolUse).toEqual([post])
  })

  it("refuses settings files, a foreign MCP server, a cwd outside the work root and a home or temp folder that isn't the user's own", () => {
    const c = fc.sample(config, 1)[0]!
    const b = base(c)
    expect(() => guards.apply({ ...b, settingSources: ['project'] }, c, run)).toThrow(/settingSources/)
    expect(() => guards.apply({ ...b, settingSources: undefined }, c, run)).toThrow(/settingSources/)
    expect(() => guards.apply({ ...b, mcpServers: { other: { type: 'http', url: 'http://x.y' } } }, c, run)).toThrow(/MCP/)
    expect(() => guards.apply({ ...b, mcpServers: { inhouse: { type: 'http', url: 'http://x.y' } } }, c, run)).toThrow(/MCP/)
    expect(() => guards.apply({ ...b, mcpServers: { inhouse: { type: 'http', url: `${b.env!.INHOUSE_PROXY_URL}/mcp/` } } }, c, run)).not.toThrow()
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

  it('(P4 H1) allows exactly inhouse at the proxy /mcp/ and apps at its /hub/, both pre-approved in server form', () => {
    const c = fc.sample(config, 1)[0]!
    const b = base(c)
    const proxy = b.env!.INHOUSE_PROXY_URL!
    expect(b.mcpServers).toEqual({ inhouse: { type: 'http', url: `${proxy}/mcp/` }, apps: { type: 'http', url: `${proxy}/hub/` } })
    const o = guards.apply(b, c, run)
    expect(o.mcpServers).toEqual(b.mcpServers)
    expect(o.allowedTools).toEqual(expect.arrayContaining(['mcp__inhouse', 'mcp__apps']))
    expect((o.allowedTools ?? []).filter((r) => r.startsWith('mcp__'))).toEqual(['mcp__inhouse', 'mcp__apps'])
    const refused: [string, Options['mcpServers']][] = [
      ['an extra server', { ...b.mcpServers, hub: { type: 'http', url: `${proxy}/hub/` } }],
      ['a stdio apps', { ...b.mcpServers, apps: { type: 'stdio', command: 'sh' } }],
      ['an sse apps', { ...b.mcpServers, apps: { type: 'sse', url: `${proxy}/hub/` } }],
      ['apps off the proxy', { ...b.mcpServers, apps: { type: 'http', url: 'http://127.0.0.1:9999/hub/' } }],
      ['apps at another route', { ...b.mcpServers, apps: { type: 'http', url: `${proxy}/mcp/` } }],
      ['apps without its slash', { ...b.mcpServers, apps: { type: 'http', url: `${proxy}/hub` } }],
      ['apps climbing out', { ...b.mcpServers, apps: { type: 'http', url: `${proxy}/hub/../model/` } }],
      ['inhouse at /hub/', { ...b.mcpServers, inhouse: { type: 'http', url: `${proxy}/hub/` } }],
    ]
    for (const [why, mcpServers] of refused) expect(() => guards.apply({ ...b, mcpServers }, c, run), why).toThrow(/MCP/)
    // A server with no proxy in the env to check it against is refused too.
    expect(() => guards.apply({ ...b, env: { ...b.env, INHOUSE_PROXY_URL: undefined } }, c, run)).toThrow(/MCP/)
  })

  it('guards agents and disableBundledSkills', () => {
    expect(GUARDED_OPTIONS).toEqual(expect.arrayContaining(['agents', 'disableBundledSkills']))
  })

  it.prop([config, fc.oneof(fc.ipV4(), fc.ipV4Extended(), fc.constantFrom(...LOCAL_NAMES, ...ADDRS, 'a.localhost', 'printer.local', 'db.internal', 'r.home.arpa', '1.2', '0x7f.1', 'Example.com', 'example.com.', ...INTERNAL_NAMES))])(
    'refuses a WebFetch domain that is an IP literal, a local name or this container',
    (c, bad) => {
      expect(() => guards.apply(base(c), { ...c, webFetchDomains: [...(c.webFetchDomains ?? []), bad] }, run)).toThrow(/webFetchDomains/)
    },
  )

  it('refuses every internal name, each one checked', () => {
    for (const name of INTERNAL_NAMES) expect(() => assertFetchDomain(name, ADDRS), name).toThrow(GuardConfigError)
  })

  it("a tool call waits on the run's audit: blocked when it rejects, allowed only once it resolves", async () => {
    const c = fc.sample(config, 1)[0]!
    const sent: AuditEntry[] = []
    let settle!: { resolve: () => void; reject: (e: Error) => void }
    const ctx: RunContext = { loneToolCall: async () => false, audit: (e) => (sent.push(e), new Promise<void>((resolve, reject) => (settle = { resolve, reject }))) }
    // The audit hook: the fourth of ours (after the helper, WebFetch and defer hooks).
    const hook = guards.apply(base(c), c, ctx).hooks!.PreToolUse![3]!
    expect(hook.timeout).toBe(AUDIT_HOOK_TIMEOUT_S)
    expect(hook.onFailure).toBe('block')
    const call = (id: string) =>
      hook.hooks[0]!({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' }, tool_use_id: id, session_id: 's', transcript_path: '', cwd: '/work/a' } as never, id, {
        signal: new AbortController().signal,
      })
    const turn = () => new Promise<void>((r) => setImmediate(r))
    // The entry is built asynchronously (its inputSha256 is a crypto.subtle digest, off the event loop), so wait for it
    // to reach the transport (bounded, no fixed count of turns), then a few turns more for the hook to act if it would.
    const sentReaches = async (n: number) => {
      const deadline = Date.now() + 2_000
      while (sent.length < n) {
        if (Date.now() > deadline) throw new Error(`the audit entry ${n} never reached the transport`)
        await turn()
      }
      for (let i = 0; i < 5; i++) await turn()
    }

    let allowed = false
    const first = call('u1').then((r) => ((allowed = true), r))
    await sentReaches(1)
    expect(allowed).toBe(false)
    expect(sent).toEqual([
      { hook: 'PreToolUse', toolName: 'Bash', toolUseId: 'u1', decision: 'allow', input: { cut: false, value: { command: 'ls' } }, agentId: null, inputSha256: await auditInputSha256({ command: 'ls' }) },
    ])
    // The shape the root checks.
    expect(AuditEntry.safeParse(sent[0]).success).toBe(true)
    settle.resolve()
    await expect(first).resolves.toEqual({})

    const second = call('u2')
    await sentReaches(2)
    settle.reject(new Error('audit refused: the Worker has gone'))
    await expect(second).rejects.toThrow(AuditRefusedError)
    await expect(second).rejects.toThrow(/the Worker has gone/)
  })
})

// Stage 1 (N6): the helpers and the actions server. Ways it could fail, written first:
// - the Agent tool is pre-approved bare (any agent, a fork included), or a helper is approved on a run without helpers;
// - a fork or a built-in agent isn't denied by rule; the definitions aren't ours (the base can't set `agents`);
// - the session env lacks a cap or a foreground switch, holds another value, or forces the subagent model;
// - the `actions` server is there, or pre-approved, on a run that didn't ask for it; or is off its proxy route;
// - a start without `agents` or `actions` changes in any way beyond: no built-ins, no forks, Bash with no network.
describe('helpers and the actions server', () => {
  const AGENTS = { researcher: { description: 'Finds facts.', prompt: 'Research.' }, analyst: { description: 'Works numbers.', prompt: 'Analyse.' } }
  const withHelpers = config.map((c) => RunConfig.parse({ ...c, agents: AGENTS, subagentModel: 'claude-sonnet-5-5' }))

  it.prop([config])('without agents: no definitions, and no Agent rule at all in allowedTools; forks and built-ins denied by rule', (c) => {
    const o = guards.apply(base(c), c, run)
    expect(o.agents).toBeUndefined()
    expect((o.allowedTools ?? []).filter((r) => r === 'Agent' || r.startsWith('Agent('))).toEqual([])
    const deny = (o.settings as { permissions: { deny: string[] } }).permissions.deny
    expect(deny).toEqual(expect.arrayContaining(['Agent(fork)', 'Agent(web-fetch)', 'Agent(general-purpose)', 'Agent(Explore)', 'Agent(Plan)', 'Agent(claude)', 'Agent(claude-code-guide)', 'Agent(statusline-setup)']))
  })

  it.prop([withHelpers])('with agents: our two definitions, and exactly Agent(researcher) and Agent(analyst) pre-approved', (c) => {
    const o = guards.apply(base(c), c, run)
    expect(o.agents).toEqual(helperDefinitions(AGENTS, 'claude-sonnet-5-5', c.webSearch === true))
    expect((o.allowedTools ?? []).filter((r) => r === 'Agent' || r.startsWith('Agent('))).toEqual(['Agent(researcher)', 'Agent(analyst)'])
    expect((o.settings as { permissions: { deny: string[] } }).permissions.deny).toContain('Agent(fork)')
  })

  it.prop([config])('agents without subagentModel (or the other way round) is refused', (c) => {
    expect(() => guards.apply(base(c), { ...c, agents: AGENTS }, run)).toThrow(/agents and subagentModel/)
    expect(() => guards.apply(base(c), { ...c, subagentModel: 'claude-sonnet-5-5' }, run)).toThrow(/agents and subagentModel/)
  })

  it.prop([config, fc.constantFrom(...Object.keys(HELPER_ENV)), fc.option(fc.constantFrom('0', '2', '20', '120000', ''), { nil: undefined })])(
    'a base env without each cap and switch at its value is refused; a forced subagent model is refused',
    (c, k, v) => {
      const b = base(c)
      fc.pre(v !== HELPER_ENV[k as keyof typeof HELPER_ENV])
      expect(() => guards.apply({ ...b, env: { ...b.env, [k]: v } }, c, run)).toThrow(new RegExp(k))
      expect(() => guards.apply({ ...b, env: { ...b.env, CLAUDE_CODE_SUBAGENT_MODEL_FORCE: '1' } }, c, run)).toThrow(/CLAUDE_CODE_SUBAGENT_MODEL_FORCE/)
    },
  )

  it.prop([config, fc.option(fc.boolean(), { nil: undefined })])('the actions server and its approval only when actions is true; at the proxy /actions/ only', (c, actions) => {
    const asked = { ...c, actions }
    const b = base(asked)
    const proxy = b.env!.INHOUSE_PROXY_URL!
    const o = guards.apply(b, asked, run)
    const on = actions === true
    expect(Object.keys(o.mcpServers ?? {}).sort()).toEqual(on ? ['actions', 'apps', 'inhouse'] : ['apps', 'inhouse'])
    expect((o.allowedTools ?? []).filter((r) => r.startsWith('mcp__'))).toEqual(on ? ['mcp__inhouse', 'mcp__apps', 'mcp__actions'] : ['mcp__inhouse', 'mcp__apps'])
    // A base that adds the server on a run that didn't ask for it is refused.
    const extra = { ...b.mcpServers, actions: { type: 'http' as const, url: `${proxy}/actions/` } }
    if (!on) expect(() => guards.apply({ ...b, mcpServers: extra }, asked, run)).toThrow(/MCP/)
    else {
      for (const url of [`${proxy}/mcp/`, `${proxy}/actions`, 'http://127.0.0.1:9999/actions/', `${proxy}/actions/../model/`]) {
        expect(() => guards.apply({ ...b, mcpServers: { ...b.mcpServers, actions: { type: 'http', url } } }, asked, run), url).toThrow(/MCP/)
      }
      expect(() => guards.apply({ ...b, mcpServers: { ...b.mcpServers, actions: { type: 'stdio', command: 'sh' } } }, asked, run)).toThrow(/MCP/)
    }
  })

  // The rule for a start without the new keys: everything as before except the three changes N6 names. Compared against
  // the same start with each new key absent, false or present, the other guarded fields are the same.
  it.prop([config])('a start with actions: false gets the same options as one without the key', (c) => {
    const plain = guards.apply(base({ ...c, actions: undefined }), { ...c, actions: undefined }, run)
    const off = guards.apply(base({ ...c, actions: false }), { ...c, actions: false }, run)
    const strip = (o: Options) => ({ ...o, abortController: undefined, hooks: undefined, sessionStore: undefined })
    expect(strip(off)).toEqual(strip(plain))
  })
})
