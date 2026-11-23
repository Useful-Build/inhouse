# Backend runbook

Operations on a brand's backend: pause, rotate keys, remove a member, restore, tear down, roll back a release. For a
broken live site or a failed deploy, start with [runbook.md](runbook.md). For what data each store holds, see
[data-map.md](data-map.md).

Ground rules for every section:

- Commands that need a secret run through a T3 secret card or the ops repo's own workflow. No secret value goes in a
  command line, a log, an issue or this repo.
- The ops jobs (`app/ops/backup`, `app/ops/delete`, `app/ops/retention`) are library entry points. The private ops repo
  holds the workflows and scripts that call them, with each brand's names and ids. Steps below name the entry point; the
  ops repo's script name is a placeholder until it's rehearsed (see each Rehearsal record).
- Never rehearse on the house deployment from an unapproved head, and never with real brand data.
- Write down who approved what, and when, before you act. The audit log records the action, not the reason.

## Pause a brand

**When.** A brand's agent is misbehaving, a key leaked, or an Admin asks. Pausing stops the agent, not the app.

**Steps.**
1. An Admin presses Pause in Settings, or the Inhouse team calls route 36 (`POST /api/pause`) as an `inhouse` member.
   Every live turn is fenced, every queued one is cancelled and nothing new is admitted.
2. For a restore or a key leak, also stop scheduled work: switch off the brand's routines and tell the ops repo's
   scheduled jobs to skip the brand (person deletion, retention, the soak driver).

**Verify.** `GET /api/pause` (route 35) says paused. The audit log has a pause line with the actor's member id. A new
chat message gets the paused answer and starts no run.

**Roll back.** Resume (route 37, `POST /api/resume`). Resume starts nothing: send the next message, or run a routine
by hand. A cancelled queued turn doesn't come back.

**Rehearsal record.** Date: ___ Deployment: ___ Who: ___ Result: ___

## Rotate the model key and tool tokens

**When.** On a schedule, when someone with access leaves, or when a key may have leaked.

**Model key (Anthropic).**
1. Create the new key in the brand's Anthropic workspace. Keep payload logging off on it.
2. Put it on the product Worker through a secret card (`wrangler secret put`, which deploys a version). The secret's
   name is in the ops repo.
3. Revoke the old key in the Anthropic console only after step 4 passes.
4. Verify: send one chat message and one routine run. Both answer, and the run's usage shows on the new key.

**Hub key (`HUB_TOKEN_KEYS`).** Follow AGENTS.md, "Hub key rotation". Don't remove the old key until
`ServerGateway.status` shows the new `kid` for every account.

**Tool tokens** (the steps for Shopify's reconnect and Slack are to confirm in the rehearsal; no code here defines them).
Shopify: a client credentials account refreshes its own token (about every 12 hours). To replace the
app's client secret, rotate it in the Dev Dashboard, update the stored credential through the connector's reconnect
flow, then check `ServerGateway.status`. Slack: reinstall the app or rotate the signing secret in the Slack app
settings, then put the new value through a secret card.

**Verify.** One read through each connector works. Nothing logs `key_unavailable` or `signin_key_missing`.

**Roll back.** Until the old key is revoked, put the old value back through a secret card. After revoking, create a
new key: a revoked key can't be restored.

**Rehearsal record.** Date: ___ Deployment: ___ Who: ___ Result: ___

## Remove a member

**When.** Someone leaves the brand, or an account is compromised.

**Steps.**
1. An Admin removes the member in Settings (route 6, `DELETE /api/members/:id`). The Inhouse team can do it too.
   The last active Admin can't be removed (`last_admin`): make another Admin first (route 5).
2. Remove them from the brand's Cloudflare Access app policy, so they can't sign in at all.
3. If they asked for their data to go, run person deletion after: a plan (a dry run that counts), then a run that takes
   only that plan (`app/ops/delete/person.ts`). It pseudonymises the member row and keeps the id. The audit log stays.

**Verify.** The member list shows them removed. Their next request gets a refusal. The audit log has a
`member.removed` line. After deletion, the plan's counts and the run's counts match, and the deletion log has a `done`
entry.

**Roll back.** Removal isn't undone. Invite them again; they come back as a new membership. A deleted person can't be
restored (that's the point).

**Rehearsal record.** Date: ___ Deployment: ___ Who: ___ Result: ___

## Restore

**When.** The brand's database or stores are lost or damaged and an R2 backup is the way back. The restore never
writes to the live database: it builds a new one, and a switch at the end points the deployment at it.

Roles: the **operator** is an Inhouse team member running the steps. The **Admin** is the brand's Admin who approves.

### 1. Freeze and approve
1. Pause the brand (above).
2. Stop the person-deletion job and the retention cron from the snapshot until the switch. Anything either does after
   the snapshot would be lost, and step 5 refuses if it happened.
3. Get the Admin's approval **in writing** (the brand's chat with the Inhouse team, or email). Save the message. The
   confirm in step 4 names the Admin as `approvedBy`, so the approval must exist before it runs.
4. Pick the backup id and write down why.

### 2. Snapshot, write and prove (`app/ops/backup/restore.ts`)
Run the restore against a freshly migrated target database. Pass each Durable Object's recovery time from point-in-time
recovery. It runs, in order: snapshot the live audit log and the deletion log list to `restore/<restoreId>/snapshot/`;
check the backup (manifest, format, migration level, every part's rows and sha256); check the target is fresh; write
each part; re-read and prove every table against the manifest; write the restore record.

The result is `restored_unreconciled`. That is not done. If the live database can't be read, the snapshot records the
gap and the audit lines come from the daily copy, so lines after the last copied one are lost.

### 3. Reconcile (`app/ops/backup/reconcile/`)
Run it on the `restored_unreconciled` record. Each step is idempotent, so a refused or stopped run is finished by
running it again. In order:
1. **FTS rebuild** (`rebuildAfterRestore`, `app/ops/backup/fts/rebuild.ts`). It rebuilds both search indexes, runs
   FTS5's integrity check against the source and writes `restore/<restoreId>/fts.json`. The reconcile continues only if
   the call and that file both say `rebuilt`. **If it fails**, the search index isn't proven to match the data: don't
   confirm. Read `fts.json` for the failing index, fix the cause and run the reconcile again. Never switch with a
   failed rebuild.
2. **Audit re-append.** Audit lines newer than the backup come back with their own ids, so history never rewinds. A
   line whose actor has no member row in the restored database gets a placeholder row first, named "Former member",
   with no email, title or photo, and `removed` so it can't sign in. Each placeholder gets a
   `restore.member_placeholder` line.
3. **Member changes again.** Removals and role changes recorded in those lines are applied again, so a removed member
   doesn't come back with old access. Re-invites after a removal aren't replayed: invite them again.
4. **Outbox hold.** Not built yet. The record says `outbox: 'p8b_pending'`. Until P8b, no approved or sending outbox row
   exists to hold.
5. **Deletion-log replay.** Every deletion made after the restore point is made again, so a deleted person stays
   deleted.

A refusal is stored on the record (`reconcile.refusal`) and returned. Read it by name. `record_changed` means another
run wrote the record: stop the other run, then run the reconcile again.

**Paths you may hit.**
- **Inhouse-actor placeholder.** If a re-appended line's actor was an Inhouse operator who isn't in the restored
  database, the placeholder is a "Former member" row, not a working sign-in. That's expected.
- **The operator row for the confirm.** The confirm's actor must be an active `inhouse` row in the restored database.
  The restored `members` table is the backup's, so an operator who had signed in before the backup already has one.
  The only code that creates an `inhouse` row is the first sign-in to the deployment's bound database, and the target
  isn't bound until the switch.
  - (a) Before you pick the backup, run `SELECT id FROM members WHERE kind='inhouse' AND status='active'` on the
    target and use one of those ids as the actor.
  - (b) If no usable operator row is there, take a new backup after the operator has signed in on the live deployment,
    and restore from that. Never hand-INSERT a row into the target.
  - The reconcile's member step touches person rows only, so the replay never changes `inhouse` rows. Having the
    reconcile seed an operator row is a code change, and stays an open item.
- **Replay stopped on `last_admin`.** The replay deletes a person the same way person deletion does, and person
  deletion refuses the last active Admin. If the replay stops on `last_admin`, the brand has no other Admin in the
  restored database. Don't skip it. Have the Admin make a second Admin (or invite one), run the reconcile again, then
  go on. If the restored database has no active Admin at all, the operator may approve in step 4, but only then, and
  you record why in writing.
- **Replay stopped** (`replay_stopped`: a store is `busy`, or `last_admin` above). Fix the cause, then run the
  reconcile again. Each step is idempotent.
- **Replay refused for a custom store with no runner** (`replay_custom_unrun`). The replay is planned before anything is
  written, so nothing was written. Don't skip it: the store's runner has to exist first. Stop and ask the orchestrator.

### 4. Confirm
Run the confirm (`confirmRestore`) with two ids: the actor is the Inhouse operator (an active `inhouse` row in the
restored database), and `approvedBy` is the Admin whose written approval you hold. An operator approves only when the
restored database has no active Admin. The confirm refuses unless every step is done, and refuses if anything was
logged in the deletion log after the replay read it. It writes one `restore.confirmed` line and the record becomes
`restored`.

### 5. Hard gate: `checkBeforeSwitch`
Right before the switch, run `checkBeforeSwitch` against the live database. This is a **hard gate**: no switch on
anything but `{ ok: true }`. It refuses on `deletion_after_replay` (a deletion was logged after the replay read the
log) and `audit_after_snapshot` (the live database wrote an audit line after the snapshot). Either means the freeze
leaked. Start again from a new snapshot.

### 6. Switch
Point the deployment's D1 binding at the restored database through the ops repo's deploy (a new Worker version with the
new database id). Then resume the brand and re-enable person deletion and retention.

**Verify.** The record says `restored` and its confirm names both ids. A chat message, a Library search and the member
list work. A person deleted after the backup is still gone. The audit log runs unbroken: ids continue past the backup's
last line. The operator records the restore in the rehearsal record and the incident notes.

**Roll back.** Before the switch, nothing live changed: delete the target database, and keep the `restore/<restoreId>/`
prefix as the record. After the switch, redeploy the previous release's database binding. Then the old
database is live again but is missing whatever was written after the switch: pause first and plan the gap.

**Rehearsal record.** Date: ___ Deployment: ___ Who: ___ Backup id: ___ Result: ___

## Teardown

**When.** A brand leaves, or a test deployment is retired. Not for a restore.

**Don't do this by hand.** A teardown script (its own piece, owned by the ops repo) does it. Deleting a Worker leaves
its container applications behind, so the script must:
1. Require the brand id and an Admin's written approval, and refuse on the house deployment without Wasim's OK.
2. Pause the brand and take a final backup, and check that backup proves.
3. **List the container applications before** the teardown, and record the list.
4. Delete each container application **explicitly**, one by one.
5. Delete the Workers, the Durable Object classes, D1, R2 prefixes or buckets, queues and secrets, in the order the
   dependencies need.
6. Remove the Access applications, the DNS records and the custom domain.
7. **List the container applications after.** Fail loudly, with the leftover names, if any remain.
8. Write a record: what was removed, the before and after lists, who approved.

Steps for the operator: pause the brand, get the written approval, run the script in the ops repo, and read both lists.

For the container step, the ops workflow can run `node app/ops/teardown/containers.ts` with
`--account-id`, `--brand` and one scope. Use `--all-in-dedicated-account` when retiring a brand's whole account.
On a shared account, pass the retiring deployment's unique container name `--prefix` (ending in `_` or `-`),
such as the complete Worker and Preview prefix for a Preview. The token comes from `CLOUDFLARE_API_TOKEN`.
Review the initial list, then pass `--apply --approved-by` with the Admin's name. For house, also pass
`--house --house-approved` after Wasim's approval. Save both JSON lists with the offboarding record.
The script polls for asynchronous deletion and fails if any applications in scope remain.

**Verify.** The after list is empty. The Cloudflare dashboard shows no Worker, D1, R2 bucket or Access app for the brand.

**Roll back.** There isn't one after step 5. Before it, resume the brand. After it, the final backup is the only way
back, through Restore, into a new deployment.

**Rehearsal record.** Date: ___ Deployment: ___ Who: ___ Containers before: ___ after: ___ Result: ___

## Redeploy the previous release

**When.** A release broke something that isn't a data problem.

**Steps.** Follow [runbook.md](runbook.md), "Roll back": find the last good Worker version id and run the `deploy`
workflow with `rollback_to` set to it. A rollback doesn't undo a migration. If the bad release added one, check the
release notes before you roll back: an older Worker on a newer schema is only safe when the migration was additive.
If it wasn't, restore instead.

**Verify.** `wrangler deployments list` shows the old version at 100%. The workflow's live smoke passes. A chat message
works.

**Roll back.** Run the same workflow with the newer version id.

**Rehearsal record.** Date: ___ Deployment: ___ Who: ___ Result: ___
