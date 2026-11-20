// Probe for check-app-rules rule 4: the sample data folder with no slash after its name (read as a folder, not imported)
import { readdirSync } from 'node:fs'
export default readdirSync(new URL('../../src/agent/sample-data', import.meta.url))
