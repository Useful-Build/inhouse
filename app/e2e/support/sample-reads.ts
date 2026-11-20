// Read-only reads of the mock's sample data folder and its source, for the data checks in e2e/sample-data.spec.ts.
// Mock only: P2's real client has no sample data, so these stay out of fx.ts.
import { readFileSync, readdirSync } from 'node:fs'

const DATA = new URL('../../src/agent/sample-data/', import.meta.url)

/** A sample data file, parsed (name like "usage.json"). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const sampleJson = (name: string): any => JSON.parse(readFileSync(new URL(name, DATA), 'utf8'))

/** The names of every sample data file. */
export const sampleFiles = (): string[] => readdirSync(DATA).filter(f => f.endsWith('.json'))

/** The source of the mock module, for the checks on the answers it writes in code. */
export const mockSource = (): string => readFileSync(new URL('../../src/agent/mock.ts', import.meta.url), 'utf8')
