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
/** The demo agent's source: the mock, and the files its scripted answers and chat engine moved to (mock-script.ts, mock-chat.ts: they load after the first load). The answers written in code are checked wherever they are. */
export const mockSource = (): string => ['mock.ts', 'mock-script.ts', 'mock-chat.ts'].map(f => readFileSync(new URL(`../../src/agent/${f}`, import.meta.url), 'utf8')).join('\n')
