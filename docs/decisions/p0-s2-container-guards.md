# P0 S2: container guards, built-in tools, PDF and spreadsheet

Date: 2026-11-19. Status: final. Backend plan open tests 2 and 5. Plan: `docs/plans/2026-11-19-backend.md`.

## What was tested

A throwaway Durable Object with a standard-1 container on the house account, Agent SDK 0.3.325 (CLI 2.1.325), Haiku
5.5. A root runner started each session as its own OS user. Each guard was probed from the runner, from the agent's
Bash with the sandbox off and on, and from a script the agent wrote. The default built-in tool list and the bundled
skills and plugins were read from the SDK's init message.

## Results

| Guard | Result | What holds it |
|---|---|---|
| Pinned egress | Pass | Container intercepts (403 or timeout) and, separately, the sandbox ("Network is unreachable", proxy allowlist) |
| Session A can't read session B | Pass | OS user per session; the sandbox hides other folders from Bash too |
| No token reachable from Bash | Pass | No key or run token in any child env; the runner's `/proc` unreadable |
| Skills read-only through `plugins` | Pass | Root-owned folder (EACCES) and a read-only sandbox mount (EROFS) |
| `.claude/` not writable | Pass only with the sandbox and the `stubs` layout; **fails without the sandbox** | Sandbox plus layout |
| Sandboxed Bash, no unsandboxed retry | Pass | `enabled`, `failIfUnavailable`, `allowUnsandboxedCommands: false` |
| Blocking audit hook | Pass with `onFailure: 'block'`; with `continue` a failed audit let the write through | Runner hook |
| PDF and spreadsheet | Pass: a PDF and an xlsx made in the work folder by a skill and python | n/a |
| Script reaching outside the allowlist | Pass | Sandbox proxy, then container |
| Script reading outside its folder | Partial: our folders unreadable; system files like `/etc/passwd` stay readable (denying them breaks python) | Sandbox read rules |

**Slow start, cause and fix.** Same cause as S1: `process.report.getReport()` reverse-resolves open sockets and waits
on DNS timeouts with internet off. About 85 s for one run, 337 to 420 s for three starting together. With
`process.report.excludeNetwork = true` before the SDK loads: cold start 1.8 s to `system/init`, warm 0.8 s, three at
once about 3 s. The control run with the fix off took 394 s, all of it in the report call.

## Problems found (each a plan input)

1. bwrap needs a traversable parent: the work root must be 0755 (session folders stay 0700).
2. The sandbox mounts `/dev/null` over protected names. A root-owned empty `.claude/` made those mounts fail. The
   `stubs` layout fixes it: session folder `root:<group> 1770`, root-owned `.claude/` with the protected names
   pre-created.
3. Intercepts are per container, so a per-run token in intercept props was overwritten by the next concurrent run.
   The run token must be checked against a per-run table in the Durable Object.
4. The sandbox puts its own proxy credential in Bash's env. It opens only the allowlist proxy, so the "no token" test
   must allow it, not flag it.

## Built-in tools and skills

- Default list, headless: 22 tools, including Cron, Monitor, Workflow and SendMessage. Glob, Grep and the Task list
  tools appear only when named.
- **Locked tool list:** `tools: [the decided 20]` plus `mcpServers` gives exactly the kept built-ins plus our MCP
  tools. Everything else is gone. Of the 20, four didn't register headless: AskUserQuestion (likely needs a
  `canUseTool` host), ListMcpResourcesTool and ReadMcpResourceTool (likely only when a server exposes resources), and
  WaitForMcpServers (documented: only with tool search off). P3 re-checks them with the real `inhouse` server and
  `canUseTool`.
- Even with `settingSources: []`, 16 bundled skills and 3 built-in plugins load.
- **Locked skills config:** `skills: ["dataviz", <ours>]`, `settings.skillOverrides` off for the other 15 bundled
  skills, `settings.enabledPlugins` false for `cc-plugin-agents-md`, `cc-plugin-privacy` and
  `cc-plugin-plugin-authoring`. A typed `/code-review` is then refused.
- The `skills` list alone hides skills from the model but **doesn't block a typed `/command`** (documented). Not enough
  on its own.
- `dataviz` stays bundled: its licence is "All rights reserved" and it isn't in the public skills repo, so it can't be
  copied into our plugin. It costs about 500 input tokens per request.
- `disableBundledSkills: true` removes dataviz too, so it isn't used.

## Verdict

Every guard holds with the sandbox on. The sandbox is mandatory, not optional.

## What it changes in the plan

- Container guards: sandbox mandatory, work root 0755, `stubs` layout per session, run tokens in a per-run table in
  the BrandAgent object, audit hook `onFailure: 'block'`.
- Runner: `process.report.excludeNetwork = true` before the SDK loads; sessions spawned as separate uids from a root
  runner.
- Agent tools: the locked tool list and skills config above. P3 re-checks the four unregistered tools.
- Nightly guard tests (acceptance 8): the spike's probe set is the start; the "no token" check allows the sandbox's
  proxy credential.

## Docs read (2026-11-19)

- https://developers.cloudflare.com/containers/configuration/outbound-traffic/
- https://developers.cloudflare.com/containers/api/durable-object-container/
- https://developers.cloudflare.com/containers/get-started/
- https://code.claude.com/docs/en/agent-sdk/secure-deployment
- https://code.claude.com/docs/en/sandboxing
- https://code.claude.com/docs/en/agent-sdk/typescript
- https://code.claude.com/docs/en/agent-sdk/plugins
- https://code.claude.com/docs/en/agent-sdk/skills
- https://code.claude.com/docs/en/settings-reference
- https://code.claude.com/docs/en/plugins/cli-reference
- https://github.com/anthropics/skills
