# Ship specs

One ship spec per project: `<topic>.spec.ts`. One test per acceptance scenario, titled `S<n>: <plain sentence>`.
The title is the card shown before the scenario's clip in the reel.

They run only with `SHIP=1` (the `ship-desktop` and `ship-phone` projects), against a preview with `BASE_URL`, by the
`ship` workflow. From P2 on, backend phases dispatch it with `build=test`: the workflow builds and starts the test
build (`BASE_URL` = brand app, `TEST_BUILD_INHOUSE_URL` = inhouse app, `TEST_ISSUER_PRIVATE_JWK_FILE` = this run's
test issuer key for signing members in) instead of using a preview. `npm run test:e2e` never runs them. Seed state through the `fx` fixture (`e2e/support/fx.ts`), wait on conditions,
never on time.

The title cards are drawn by ffmpeg in the reel job (no per-spec code): the scenario title, the viewport and the short SHA.

The preview is built from the PR's merge commit while the specs run at the head SHA. Since main stopped requiring
branches to be up to date (decision 0028, merge queue), the two trees can differ on any PR whose base moved; record
the reel soon after a push, and the queue tests the combined result before it merges.
