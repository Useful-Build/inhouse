# Data map (template)

What each brand deployment stores, where, for how long, whether it holds personal data, and what happens to it on
export and on a person's deletion. This is the template: it names no brand. A brand's filled copy lives in the private
ops repo.

Each brand has its own deployment: its own D1 database for records, its own R2 bucket for files and backups, its own
Durable Objects for live state and its own connector hub.

## Stores

The block below is generated from the table registry (`app/ops/tables`) by `dataMapRows` in
`app/ops/coverage/chat-watch-connectors/data-map.ts`, and a test fails when the two differ. Don't edit it by hand.

<!-- stores:start -->
<!-- stores:end -->

## Terms

- **Retention**: `chats` and `steps` follow the brand's Data and access settings (default 12 months). The audit log and
  the deletion log are never shortened. Backups are kept 30 days by the bucket's lifecycle rule, so a deleted person
  leaves them within that window.
- **Export**: "Export everything" holds every store marked yes, whole. A person's export holds what names them.
- **Deletion**: a person's deletion pseudonymises their member row (the id stays, so the audit log keeps naming them by
  id only), removes what they own and keeps references to their id. The accepted keeps say where free text that may
  name them stays, and why.
