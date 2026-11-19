# Ship specs

One ship spec per project: `<topic>.spec.ts`. One test per acceptance scenario, titled `S<n>: <plain sentence>`.
The title is the card shown before the scenario's clip in the reel.

They run only with `SHIP=1` (the `ship-desktop` and `ship-phone` projects), against a preview with `BASE_URL`, by the
`ship` workflow. `npm run test:e2e` never runs them. Seed state through localStorage and `?demo`, wait on conditions,
never on time.
