# check-product-config --sandbox fixtures

Plain JSON, no comments: sandbox mode reads a config with `JSON.parse` only, so a comment that wrangler's JSONC parser
ends somewhere else (a bare `\r`) can't hide config from the lock. Invented values only; the tests set
`CF_SANDBOX_ACCOUNT_ID=0123456789abcdef0123456789abcdef` and `SBX_ZONE=zone.example.test`.

- `pass-per-pr.json`: PR 12's test deployment.
- `pass-per-pr-generated.json`: PR 7's config as the ops repo's `config.mjs` writes it from the vite plugin's generated
  `wrangler.json`: every binding kind present but empty and the plugin's own rules kept, its config paths dropped and
  `migrations_dir` rebased beside the config.
- `raw-vite-output.json`: PR 7's config in the vite plugin's raw output shape (`@cloudflare/vite-plugin` 1.69.1's
  `getOutputConfig`, sandbox names already filled). The lock refuses it on exactly what `config.mjs` must rewrite: the
  plugin's config paths and a `migrations_dir` that leaves the build folder.
- `pass-candidate.json`: the candidate (the product build rehearsed on the shared sandbox resources); it passes the
  product rules too.
- `pass-per-pr-hub.json` (P4, `--hub`): PR 12's connector hub as the ops repo writes it from the hub's test bundle and
  `wrangler.hub.test.jsonc`: the bundle deployed as built (`no_bundle`), the SignIn Durable Object, the test switch on
  and invented test vars, no `define` or `secrets`.
- `pass-candidate-hub.json` (P4, `--hub`): the candidate's hub: the product hub config with its store vars empty and
  no `secrets` (its one secret goes in with the deploy).
