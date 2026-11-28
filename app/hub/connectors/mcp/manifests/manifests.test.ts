// Known-server manifests (Stage 1 M4-R1, N39): matched by the exact endpoint, never the origin. Ways it could go wrong:
// a manifest for one endpoint applied to another path, port or scheme on its origin; an entry that isn't an exact href.
import { describe, expect, it } from 'vitest'
import { HTTPS_ADDRESS } from '../../../index/schemas'
import { manifestFor, MANIFESTS } from './index'
import type { McpManifest } from './types'

describe('manifestFor', () => {
  const list: McpManifest[] = [{ endpoint: 'https://mcp.example.com/mcp', settings: { plain_tools: 'yes' } }]

  it('matches the exact endpoint (in its one spelling) and nothing else on its origin', () => {
    expect(manifestFor('https://mcp.example.com/mcp', list)?.settings).toEqual({ plain_tools: 'yes' })
    expect(manifestFor('https://MCP.example.com:443/mcp', list)?.settings).toEqual({ plain_tools: 'yes' })
    for (const other of ['https://mcp.example.com/mcp2', 'https://mcp.example.com/', 'https://mcp.example.com:8443/mcp', 'http://mcp.example.com/mcp', 'https://mcp.example.com/mcp/', 'not a url']) {
      expect(manifestFor(other, list), other).toBeNull()
    }
  })

  it('every listed manifest names an exact https endpoint in its one spelling, with bounded settings', () => {
    for (const m of MANIFESTS) {
      expect(m.endpoint).toBe(new URL(m.endpoint).href)
      expect(HTTPS_ADDRESS.test(m.endpoint)).toBe(true)
      expect(Object.keys(m.settings).length).toBeLessThanOrEqual(20)
    }
  })
})
