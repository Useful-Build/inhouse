// The ship scenario `connectors-codemode` (app/test/scripted-model/scenarios.ts) holds a literal copy of the measured "lowest stock"
// script, because that file can't import the hub. This fails when the copy drifts (a recorded document changed), so the sandbox
// recording never finds out first. The scenarios file is read as text: importing it would pull the runner's program into the hub's.
/// <reference types="vite/client" />
import { describe, expect, it } from 'vitest'
import scenariosSource from '../../../test/scripted-model/scenarios.ts?raw'
import { MEASURE_CASES } from './scripts'

describe('the connectors-codemode scenario', () => {
  it('runs the measured lowest-stock script, verbatim', () => {
    const m = /export const CODE_MODE_SCRIPT: string = ("(?:[^"\\\n]|\\.)*")\n/.exec(scenariosSource)
    expect(m, 'CODE_MODE_SCRIPT is a JSON string literal in scenarios.ts').not.toBeNull()
    expect(JSON.parse(m![1]!)).toBe(MEASURE_CASES.find(c => c.id === 'lowest-stock')!.code)
  })
})
