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
| Store | Kind | Holds | Personal data | Retention | Export | Deletion | Accepted keep |
|---|---|---|---|---|---|---|---|
| `members` | D1 table | Team members and service rows | Name, email, title, sign-in subject, photo key | Kept while the deployment lives | Yes | Pseudonymised in place (the id stays) |  |
| `settings` | D1 table | Brand and personal settings | Personal settings; an approver setting names a member id | Kept while the deployment lives | Yes | Rows whose `owner` is the person deleted |  |
| `support_grants` | D1 table | Inhouse team support grants | Member ids of who granted and ended them | Kept while the deployment lives | Yes | Kept: the brand access history: created_by and ended_by keep the pseudonymous id |  |
| `audit_log` | D1 table | The audit log | Member ids only | Never shortened | Yes | Kept: decision Q3: never shortened or edited |  |
| `photos/` | R2 prefix | Member photos | Photo bytes | Replaced on upload; with the person | Yes | Objects under the person's prefix deleted |  |
| `chats` | D1 table | Chats | Owner id, titles | Chats setting (default 12 months) from last activity; trash 30 days | Yes | Deleted: the chat cascade over the person's own chats, soft-deleted ones included |  |
| `chat_messages` | D1 table | Chat messages, the agent's answers too | Message text, author id | With its chat | Yes | Deleted: with its chat, in the chat cascade |  |
| `tool_calls` | D1 table | A redacted record of each tool call | Member id, input hashes | Steps setting (default 12 months); with its chat | Yes | Deleted: with its chat, in the chat cascade |  |
| `BrandAgent` | Durable Object | The agent's live state: runs, turns, run events, run tokens | Turn text, run events, owner ids | Ended runs by the steps setting; a chat's rows with the chat | No | Deleted: personData deletes the person's rows; authority.id keeps a removed member's id so their sends stay refused (an accepted keep, line A), flags.value (paused_by) keeps the pseudonymous id | A removed member's id in the removed set (refuses their sends) |
| `sessions/` | R2 prefix | Agent session transcripts | Transcript text | With its chat | No | Deleted: the transcripts under sessions/<chatId>/ of the person's chats, before their rows (keys name chats, not people) |  |
| `chat_files` | D1 table | Chat attachments and outputs | File names, uploader id | With its chat; a Library-deleted output 30 days after its mark | Yes | Deleted: with its chat, in the chat cascade |  |
| `files/` | R2 prefix | Chat file bytes | File bytes | With its chat or its trashed row | Yes | Deleted: the objects under files/<chatId>/ of the person's chats, before their rows (keys name chats, not people) |  |
| `usage_months` | D1 table | Monthly AI spend and cap | None | Kept while the deployment lives | Yes | Kept: no person data: the brand's monthly bill |  |
| `usage_turns` | D1 table | Each turn's reserved and settled spend | Member id | Kept while the deployment lives | Yes | Kept: the brand's bill: member_id is pseudonymous once the member row is |  |
| `usage_extends` | D1 table | Each model call's hold and cost | None | Kept while the deployment lives | No | Kept: no person data: a call's hold and cost, keyed by its turn |  |
| `audit_copy_state` | D1 table | The audit copy's cursor | None | Kept while the deployment lives | No | Kept: no person data: the audit copy's cursor |  |
| `audit-copy/` | R2 prefix | The audit log's daily copy | Member ids only | Never shortened | No | Kept: decision Q3: the audit log's daily copy is never shortened (people by member id only) |  |
| `memories` | D1 table | Remembered facts, brand and personal | Fact text, owner and creator ids | Forgotten facts 30 days after their last update; others kept | Yes | Rows whose `owner_id` is the person deleted | Brand facts a person saved |
| `memories_fts` | D1 table | The search index over facts | A copy of fact text | Follows its source | No | Follows its source |  |
| `chat_messages_fts` | D1 table | The search index over messages | A copy of message text | Follows its source | No | Follows its source |  |
| `Runner` | Durable Object | The runner pool's container state | None | Holds nothing kept | No | Kept: holds nothing of a person's (p3-design section 11) |  |
| `activity_lines` | D1 table | The Activity feed | Member ids only, names shown at read | Steps setting (default 12 months) | Yes | Kept: ids only, rendered as A former member once the member row is pseudonymised; no UPDATE needed |  |
| `notices` | D1 table | The bell's notices | Member ids; team and admin notices may carry text | Steps setting (default 12 months) | No | Deleted: a notice addressed only to the person (audience = member) goes, after its reads (notice_reads references notices); a team or admin notice keeps person_id and body (an accepted keep) | Team and admin notice text |
| `notice_reads` | D1 table | Which member read which notice | Member id | With its notice | No | Rows whose `member_id` is the person deleted |  |
| `routines` | D1 table | Routines | Instruction text, creator id | Kept while the routine is | Yes | Kept: a routine runs on after its creator is removed (Wasim, 2026-11-19): creator_id is pseudonymous; instruction is an accepted keep | Routine instructions (a routine runs on after its creator is removed) |
| `routine_slots` | D1 table | Each routine run | Prompt and result text, creator and requester ids | Steps setting (default 12 months) | Yes | Kept: routine history and Today's foreign key: the ids are pseudonymous; prompt_text and result_text are accepted keeps | Routine prompts and results |
| `routine_alerts` | D1 table | Two invariant counters | None | Kept while the deployment lives | No | Kept: no person data: two invariant codes and a count |  |
| `library_uploads` | D1 table | Library uploads | File names, uploader id | Pending after 1 day; trash 30 days after its mark; otherwise until deleted | Yes | Kept: the brand's own files: created_by is pseudonymous |  |
| `library_marks` | D1 table | Library trash marks | Member id of who deleted | With its file | Yes | Kept: the brand's trash: deleted_by is pseudonymous; a chat output's mark goes with the chat cascade |  |
| `library/` | R2 prefix | Library file bytes | File bytes | With its upload row | Yes | Kept: the brand's own files, with their library_uploads rows (keys name files, not people) |  |
| `today_items` | D1 table | Today's items | Store data, no person key | Steps setting (default 12 months) | Yes | Kept: store data with no person key; item_json is an accepted keep | Today item text |
| `today_aside` | D1 table | Today items set aside | Member id | Steps setting (default 12 months) | Yes | Kept: the team's Today state: by is pseudonymous |  |
| `backups/` | R2 prefix | D1 backups | Copies of every backed-up table | 30 days (bucket lifecycle rule) | No | Kept: kept 30 days by the R2 lifecycle rule (Q3) |  |
| `restore/` | R2 prefix | Restore records and snapshots | A copy of the audit log at a restore | 30 days (bucket lifecycle rule) | No | Kept: kept 30 days by the R2 lifecycle rule (Q3) |  |
| `deletion-log/` | R2 prefix | What each deletion and retention run removed | Member ids and counts only | Never shortened | Yes | Kept: the deletion log is never shortened |  |
| `egress_fetches` | D1 table | Outbound web requests by host | None | 30 days | No | Kept: no member id: the egress knows the container, not the run; retention removes rows after 30 days. A host can carry data in a subdomain from a refused exfil attempt: kept 30 days, ops-only and not exported. A host over 253 characters is not recorded, only logged |  |
| `SignIn` | Durable Object | The connector hub's sealed tokens | None (client credentials) | Kept while the connection is | No | Kept: the brand's connector token (client credentials): no person connects it on P4; pending items sweep themselves |  |
<!-- stores:end -->

## Terms

- **Retention**: `chats` and `steps` follow the brand's Data and access settings (default 12 months). The audit log and
  the deletion log are never shortened. Backups are kept 30 days by the bucket's lifecycle rule, so a deleted person
  leaves them within that window.
- **Export**: "Export everything" holds every store marked yes, whole. A person's export holds what names them.
- **Deletion**: a person's deletion pseudonymises their member row (the id stays, so the audit log keeps naming them by
  id only), removes what they own and keeps references to their id. The accepted keeps say where free text that may
  name them stays, and why.
