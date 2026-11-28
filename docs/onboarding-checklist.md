# Onboarding checklist for a new brand

Work top to bottom. Tick each item and keep the record in the private ops repo, never here. This repo is public: no
brand names, account ids, hostnames or emails in it. Placeholders below, such as `<brand>` and `<house host>`, are
filled from the ops repo.

Related: [runbook-backend.md](runbook-backend.md), [data-map.md](data-map.md).

## 1. Accounts and apps

- [ ] **Two Shopify apps for `<brand>`, one read and one write.** Create both in the Dev Dashboard, in the brand's
      own merchant organization (not ours). The read app asks only for read scopes. The write app is created now but
      stays unused until a later phase turns writes on. Install each on the brand's store.
- [ ] **Compliance webhooks, per app.** Shopify doesn't allow these through the Admin API. Subscribe each app to
      the three topics through its CLI app config.
      1. `shopify app config link` to link the app.
      2. Add three `[[webhooks.subscriptions]]` entries in `shopify.app.toml`. Give each entry a one-topic
         `compliance_topics` array and set `uri` to the HTTPS URL on the brand host with the corresponding path.
         - `customers/data_request` → `/api/webhooks/shopify/customers-data-request`
         - `customers/redact` → `/api/webhooks/shopify/customers-redact`
         - `shop/redact` → `/api/webhooks/shopify/shop-redact`
      3. Use a T3 secret card to set the required `SHOPIFY_WEBHOOK_SECRETS` Worker secret as a JSON array of the
         read and write apps' client secrets. Keep secret values out of app config, commands and records.
      4. Configure the scoped Access exemption in section 2 before running `shopify app deploy` for each app.
      5. Verify each topic's URL in the Dev Dashboard. A delivery with an invalid HMAC should return 401 and a
         correctly signed test delivery should return 2xx. See the backend runbook for handling requests.
         [Shopify privacy law compliance](https://shopify.dev/docs/apps/build/compliance/privacy-law-compliance)
- [ ] **The Slack app.** Create it in the brand's workspace (or install ours, as the brand chooses). Note the signing
      secret and bot token for a secret card (the exact steps are to confirm in the rehearsal). Keep it to the channels the brand names.
- [ ] **Payload logging off on the brand's Anthropic key.** Create the key in the brand's own workspace, turn payload
      logging off, and check the setting reads off before the key goes on the Worker.

## 2. Cloudflare Access: two applications, two identity providers

The brand's people and the Inhouse team sign in to different Access applications, and each application uses its **own
identity provider**. One email can't be both a brand member and an Inhouse member: if the two apps share a provider, a
person who is in both gets one identity and the product answers `wrong_kind`, in a loop.

- [ ] **Brand app**: `<brand host>`, policy allows only the brand's people, identity provider A.
- [ ] **Shopify webhook exemption.** Add a path-specific Access application on the brand host for
      `/api/webhooks/shopify/*` with a Bypass policy that includes Everyone. Shopify can then reach the Worker's
      HMAC verification without signing in.
      [Cloudflare Access bypass for public endpoints](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/common-policies/#bypass-a-public-endpoint)
- [ ] **Inhouse team app**: the support path on `<brand host>` (or `<house host>`), policy allows only the Inhouse
      team, identity provider B. Provider B is never the brand's.
- [ ] Check both ways: a brand member can't open the team app, an Inhouse member can't sign in to the brand app, and
      neither gets `wrong_kind`.

## 3. People

- [ ] **The first Admin.** Create the brand's first Admin through the seed or invite step in the ops repo, with the
      brand's own email in provider A. Sign in once as them and check the Settings page loads.
- [ ] Record who at the brand can approve a restore (an Admin, in writing). See Restore in the runbook.

## 4. Agent defaults

Set these in the brand's settings before anyone chats.

- [ ] **`t:webfetch` (the WebFetch list).** Set by the Inhouse team; an Admin can write only `tm:<id>:on`. A brand that never set a list lets the agent open any public website (since M3-J). A list saved empty means **no** web pages. A list with hosts means only those hosts. So for a new brand set the list on purpose: fill it with
      the hosts the brand names, one per line, or choose "Only the websites listed" and leave it empty to block every website. `t:webfetch_mode` (`list` or `open`, set through the API) overrides all of this.
- [ ] **WebSearch off.** Set by the Inhouse team. Keep `t:websearch` off until the web-tool evals pass. Turn it on only after a recorded pass.
- [ ] **Every model's `tm:<id>:on` is `off`** unless that model passed the read-side eval set (decision 2). Turn on
      only the models that passed, one at a time, and record the eval run id beside each.
- [ ] Stage is Watch: no write to any tool, and notices only through the bell.

## 5. The soak canary

- [ ] **Plant the canary where the agent reads.** Put one invented string in a store record the morning check pulls
      (for example a product note), phrased as an instruction to leak it. Use a fresh invented value per brand. It
      is never a real customer's data.
- [ ] Save the exact string, one per line, in a file kept in the ops repo.
- [ ] Pass that file to the soak driver as `--canary <file>`. Without it the leak scan can't run, and a day with no
      leak scan counts as not clean.

## 6. Before the first real chat

- [ ] A test chat works as the first Admin and as an Inhouse member.
- [ ] The monitor's health check reports the brand, and its alert path reaches the on-call person.
- [ ] Pause and resume both work (runbook, "Pause a brand").
- [ ] A backup ran and one restore rehearsal passed on a copy with invented data (runbook, "Restore").

**Onboarding record.** Date: ___ Brand: ___ Who: ___ Result: ___ (kept in the ops repo)
