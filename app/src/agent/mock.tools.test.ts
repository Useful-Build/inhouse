// The demo's answers to the Tools page's new calls (the contract suite holds the shape every target shares). Ways it can fail:
// connecting navigates away from the demo (an address that isn't the app's own), or disconnecting changes the sample brand.
import { describe, expect, test, vi } from 'vitest'

const store = new Map<string, string>()
vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v) }, removeItem: (k: string) => { store.delete(k) } })
const { MockAgent } = await import('./mock')

describe('the demo Tools calls', () => {
  test('connect answers an address of the app itself, never another site', async () => {
    const agent = new MockAgent()
    const { authorizeUrl } = await agent.connectTool('shopify')
    expect(authorizeUrl).toBe('/tools/shopify?connected=1')
    expect(authorizeUrl.startsWith('/')).toBe(true)
  })

  test('disconnect is unavailable in the demo, tells once, and changes nothing', async () => {
    const agent = new MockAgent()
    const heard: string[] = []
    agent.onNotice(n => { if (n.type === 'error') heard.push(n.text) })
    const before = agent.read().tools
    await expect(agent.disconnectTool('shopify')).rejects.toMatchObject({ code: 'unavailable' })
    expect(heard).toEqual(["Disconnecting isn't connected in this demo."])
    expect(agent.read().tools).toBe(before)
  })
})
