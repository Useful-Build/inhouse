// @vitest-environment jsdom
// The demo's diagram answers against the real Mermaid parser: the E2E specs rely on the plain one drawing and the rough one
// failing to parse (so its card shows "Couldn't draw this diagram." for a parse error, not for an address check).
import { describe, expect, it } from 'vitest'
import { BROKEN_DIAGRAM_ANSWER, DIAGRAM_ANSWER } from './mock-script'
import { MERMAID_CONFIG } from '../screens/chat/markdown/diagram-theme'
import { checkSource } from '../screens/chat/markdown/diagram-svg'

const fence = (answer: string) => /```mermaid\n([\s\S]*?)\n```/.exec(answer)![1]

describe("the demo's diagram answers", () => {
  it('the plain diagram parses', async () => {
    const mermaid = (await import('mermaid')).default
    mermaid.initialize({ ...MERMAID_CONFIG })
    await expect(mermaid.parse(fence(DIAGRAM_ANSWER))).resolves.toBeTruthy()
  })

  it('the rough diagram passes the address check and fails to parse', async () => {
    const source = fence(BROKEN_DIAGRAM_ANSWER)
    expect(() => checkSource(source)).not.toThrow()
    const mermaid = (await import('mermaid')).default
    mermaid.initialize({ ...MERMAID_CONFIG })
    await expect(mermaid.parse(source)).rejects.toThrow(/Parse error/)
  })
})
