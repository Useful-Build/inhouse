import { demo } from '../agent'

/** Demo switches show in dev builds, or in any build opened with ?demo. The product build has no demo controls, so never there. */
export const demoEnabled = () => demo !== null && (import.meta.env.DEV || new URLSearchParams(location.search).has('demo'))
