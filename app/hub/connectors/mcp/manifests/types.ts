// Known-server settings (Stage 1 M4-R1 lands the shape, M4-D the fixture entry; N39). A manifest names one exact MCP
// endpoint (scheme, host, port, path), never an origin, and carries settings only: it never adds a destination, a
// credential, a tool or a trust. Its settings hold across detect, the connection check, the list and every call.
// Settings use the binding's own bounds (index/schemas.ts): at most 20, each a lower-case name and a value of 200 at most.

export type McpManifest = {
  /** The exact endpoint, as a WHATWG URL's `href`. A second endpoint on the same origin is another server. */
  endpoint: string
  /** For example `{ plain_tools: 'yes' }` for a server with its own code mode. */
  settings: Readonly<Record<string, string>>
}
