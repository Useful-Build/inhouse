# Ship specs

One ship spec per project: `<topic>.spec.ts`. One test per acceptance scenario, titled `S<n>: <plain sentence>`.
The title is the card shown before the scenario's clip in the reel.

They run only with `SHIP=1` (the `ship-desktop` and `ship-phone` projects), against a preview with `BASE_URL`, by the
`ship` workflow. `npm run test:e2e` never runs them. Seed state through localStorage and `?demo`, wait on conditions,
never on time.

The title cards are drawn by ffmpeg in the reel job (no per-spec code): the scenario title, the viewport and the short SHA.

The preview is built from the PR's merge commit while the specs run at the head SHA. For the final `fleet/*` -> `main`
PR the trees are identical (main is strict), but for worker PRs into `fleet/*` they can differ.
