// The whole environment a session process (and so the CLI and Bash under it) sees. Built here and nowhere else.
// It has no token, no key and no secret: every credentialed call goes to the root's loopback proxy, which finds the
// caller's OS user and adds that run's token. The function takes no token, so it can't put one in.
import { HELPER_ENV } from '../guards/agents.ts'
import { userPaths } from '../guards/paths.ts'
import type { SessionUser } from './seam.ts'

/** The CLI wants an API key to be set; the proxy drops it and the Worker's egress adds the real one. Not a secret. */
export const PLACEHOLDER_API_KEY = 'inhouse-proxy-adds-credentials'

export function proxyBaseUrl(proxyPort: number): string {
  return `http://127.0.0.1:${proxyPort}`
}

/**
 * `extraCaCerts`: the intercept CA the image's entrypoint found (its path, from the root's own NODE_EXTRA_CA_CERTS), so
 * the CLI and Node in the session trust Cloudflare's HTTPS intercept too. A path, not a secret.
 */
export function sessionEnv(user: SessionUser, proxyPort: number, extraCaCerts?: string): Record<string, string> {
  const proxy = proxyBaseUrl(proxyPort)
  return {
    ...(extraCaCerts ? { NODE_EXTRA_CA_CERTS: extraCaCerts } : {}),
    PATH: '/usr/local/bin:/usr/bin:/bin',
    HOME: user.home,
    // Temp files stay in the user's own 0700 folder, never in the shared /tmp (R2's guards deny /tmp to Read). It's the
    // one the host makes for the pool user (guards/paths.ts), named by the user and not the chat id, so it's short for
    // any chat id: the sandbox keeps its bridge sockets in it, and a Unix socket path holds 107 bytes. Sandboxed Bash
    // gets `$TMPDIR/claude-<uid>` as its own `$TMPDIR` (the engine's docs, CLAUDE_CODE_TMPDIR).
    TMPDIR: userPaths(user.user).tmp,
    USER: user.user,
    LOGNAME: user.user,
    LANG: 'C.UTF-8',
    // The model base URL: the proxy's model route.
    ANTHROPIC_BASE_URL: `${proxy}/model`,
    ANTHROPIC_API_KEY: PLACEHOLDER_API_KEY,
    // The session's own adapters (the session store, file saves, the inhouse MCP URL) build their URLs from this.
    INHOUSE_PROXY_URL: proxy,
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DISABLE_AUTOUPDATER: '1',
    // Wait for `inhouse` and `apps` MCP servers to finish connecting before turn 0. The runner passes prompts as a
    // stream (`--input-format stream-json`), where the CLI defaults to non-blocking MCP startup and `inhouse` marks
    // only six tools to load up front using per-tool metadata (leaving the other 14 deferred); without this, a slow connect
    // drops every `mcp__inhouse__*` tool from turn 0.
    // Both are on the env-vars page (code.claude.com/docs/en/env-vars, read 2026-11-26): `MCP_CONNECT_TIMEOUT_MS` is how
    // long blocking startup waits for the connection batch before it snapshots the tool list (default 5000), and applies
    // with `MCP_CONNECTION_NONBLOCKING=0`. Recheck both on an SDK bump (pinned: CLI 2.1.328, agent SDK 0.3.328).
    MCP_CONNECTION_NONBLOCKING: '0',
    MCP_CONNECT_TIMEOUT_MS: '15000',
    // The helpers' caps, the foreground switches and the MCP tool timeout (Stage 1, N6 and N14; src/guards/agents.ts).
    ...HELPER_ENV,
  }
}
