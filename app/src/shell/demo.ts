/** Demo switches show in dev builds, or in any build opened with ?demo. */
export const demoEnabled = () => import.meta.env.DEV || new URLSearchParams(location.search).has('demo')
