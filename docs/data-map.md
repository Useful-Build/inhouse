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
| Store | Kind | Holds | Personal data | Retention | Export | Deletion | Backup | Accepted keep |
|---|---|---|---|---|---|---|---|---|
| `members` | D1 table | Team members and service accounts | Name, email, title, sign-in subject, photo key | Kept while the deployment lives | Yes | Name and email removed; the member id stays | Nightly, exact |  |
| `settings` | D1 table | Brand and personal settings | Personal settings; an approver setting names a member id | Kept while the deployment lives | Yes | Rows that belong to the person deleted | Nightly, exact |  |
| `support_grants` | D1 table | Support access the brand granted | Member ids of who granted and ended it | Kept while the deployment lives | Yes | Kept: the access history keeps the member id, which no longer names anyone | Nightly, exact |  |
| `audit_log` | D1 table | The audit log | Member ids only | Never shortened | Yes | Kept: the audit log is never shortened or edited | Nightly, exact (rows only added) |  |
| `photos/` | R2 prefix | Member photos | Photo bytes | Replaced on upload; deleted with the person | Yes | Objects that belong to the person deleted | Not backed up |  |
| `chats` | D1 table | Chats | Owner id, titles | Chats setting (default 12 months) from last activity; deleted chats 30 days after deletion | Yes | Deleted with all of the person's own chats, deleted ones included | Nightly, copied in pages (may lag the snapshot by minutes) |  |
| `chat_messages` | D1 table | Chat messages, the agent's answers too | Message text, author id | With its chat | Yes | Deleted with the person's chats | Nightly, exact (rows only added) |  |
| `tool_calls` | D1 table | A record of each tool call, without its inputs | Member id, input fingerprints | Steps setting (default 12 months); with its chat | Yes | Deleted with the person's chats | Nightly, exact unless rows arrive during the copy |  |
| `BrandAgent` | Durable Object | The agent's live state: runs, turns, run events, run tokens | Question text, run events, owner ids | Finished runs by the steps setting; a chat's state with the chat | No | The person's runs, turns, events and tokens deleted, once none of their turns is still running | Durable Object point-in-time recovery | A removed member's id in the removed list, so their sends stay refused |
| `sessions/` | R2 prefix | Agent session transcripts | Transcript text | With its chat | No | Deleted with the person's chats | Not backed up (kept through a database restore) |  |
| `chat_files` | D1 table | Chat attachments and outputs | File names, uploader id | With its chat; an output deleted from the Library goes 30 days after | Yes | Deleted with the person's chats | Nightly, copied in pages (may lag the snapshot by minutes) |  |
| `files/` | R2 prefix | Chat file bytes | File bytes | With its chat or its deleted file | Yes | Deleted with the person's chats | Not backed up (kept through a database restore) |  |
| `usage_months` | D1 table | Monthly AI spend and cap | None | Kept while the deployment lives | Yes | Kept: no personal data | Nightly, exact |  |
| `usage_turns` | D1 table | Each turn's reserved and settled spend | Member id | Kept while the deployment lives | Yes | Kept: the brand's bill keeps the member id, which no longer names anyone | Nightly, copied in pages (may lag the snapshot by minutes) |  |
| `usage_extends` | D1 table | Each model call's hold and cost | None | Kept while the deployment lives | No | Kept: no personal data | Nightly, copied in pages (may lag the snapshot by minutes) |  |
| `audit_copy_state` | D1 table | Where the audit log's daily copy has reached | None | Kept while the deployment lives | No | Kept: no personal data | Nightly, exact |  |
| `audit-copy/` | R2 prefix | The audit log's daily copy | Member ids only | Never shortened | No | Kept: the audit log's copy is never shortened | Not backed up (it is itself a copy) |  |
| `memories` | D1 table | Remembered facts, including waiting, approved and rejected brand facts | Fact text, owner and creator ids; the audit log records who approved or rejected a fact | Forgotten facts, including rejected ones, 30 days after their last change; waiting and active facts kept | Yes | Rows that belong to the person deleted | Nightly, exact | Brand facts a person saved |
| `memories_fts` | D1 table | The search index over facts | A copy of fact text | Follows its source | No | Follows its source | Rebuilt from its source after a restore |  |
| `chat_messages_fts` | D1 table | The search index over messages | A copy of message text | Follows its source | No | Follows its source | Rebuilt from its source after a restore |  |
| `Runner` | Durable Object | The agent runners' working state | None | Holds nothing kept | No | Kept: no personal data | Nothing to restore |  |
| `activity_lines` | D1 table | The Activity feed | Member ids only, names shown when read | Steps setting (default 12 months) | Yes | Kept: lines keep the member id and show "Former member" | Nightly, exact (rows only added) |  |
| `notices` | D1 table | The bell's notices | Member ids; team and admin notices may carry text | Steps setting (default 12 months) | No | Notices addressed only to the person deleted, with their reads | Nightly, copied in pages (may lag the snapshot by minutes) | Team and admin notice text |
| `notice_reads` | D1 table | Which member read which notice | Member id | With its notice | No | Rows that belong to the person deleted | Nightly, exact unless rows arrive during the copy |  |
| `routines` | D1 table | Routines | Instruction text, creator id | Kept while the routine is | Yes | Kept: a routine keeps running after its creator leaves; the creator id no longer names anyone | Nightly, exact | Routine instructions |
| `routine_slots` | D1 table | Each routine run | Prompt and result text, creator and requester ids | Steps setting (default 12 months) | Yes | Kept: routine history keeps the member ids, which no longer name anyone | Nightly, copied in pages (may lag the snapshot by minutes) | Routine prompts and results |
| `routine_alerts` | D1 table | Two internal counters | None | Kept while the deployment lives | No | Kept: no personal data | Nightly, exact |  |
| `library_uploads` | D1 table | Library uploads | File names, uploader id | Unfinished uploads after 1 day; deleted files 30 days after deletion; otherwise until deleted | Yes | Kept: the brand's own files keep the uploader id, which no longer names anyone | Nightly, copied in pages (may lag the snapshot by minutes) |  |
| `library_marks` | D1 table | Library files moved to the trash | Member id of who deleted | With its file | Yes | Kept: the brand's trash keeps the member id; marks on the person's chat outputs go with their chats | Nightly, exact |  |
| `library/` | R2 prefix | Library file bytes | File bytes | With its upload | Yes | Kept: the brand's own files | Not backed up (kept through a database restore) |  |
| `today_items` | D1 table | Today's items | Store data, no member id | Steps setting (default 12 months) | Yes | Kept: no member id | Nightly, copied in pages (may lag the snapshot by minutes) | Today item text |
| `today_aside` | D1 table | Today items set aside | Member id | Steps setting (default 12 months) | Yes | Kept: the team's Today keeps the member id, which no longer names anyone | Nightly, exact |  |
| `connector_accounts` | D1 table | Brand connector status and lifecycle | Member ids of who connected or disconnected | Kept while the deployment lives | Yes | Kept: member ids no longer identify the deleted person | Nightly, exact |  |
| `notify_channels` | D1 table | Current and removed Slack notice channels | Member ids of who added or removed each channel | Kept while the deployment lives | Yes | Kept: member ids no longer identify the deleted person | Nightly, exact |  |
| `notify_channel_list` | D1 table | Slack channel list revision | None | Kept while the deployment lives | Yes | Kept: no personal data | Nightly, exact |  |
| `notify_sends` | D1 table | Notice delivery outcomes, caps and deduplication keys | Sender and bell recipient ids | Steps setting (default 12 months) | No | Kept for caps and deduplication. Member ids no longer identify the deleted person | Nightly, copied in pages (may lag the snapshot by minutes) |  |
| `backups/` | R2 prefix | Database backups | Copies of every backed-up table | 30 days (bucket lifecycle rule) | No | Kept: backups expire after 30 days, so a deleted person leaves them within that window | Is the backup |  |
| `restore/` | R2 prefix | Restore records and snapshots | A copy of the audit log at a restore | 30 days (bucket lifecycle rule) | No | Kept: expires after 30 days, like the backups | Restore records |  |
| `deletion-log/` | R2 prefix | What each deletion and retention run removed | Member ids and counts only | Never shortened | Yes | Kept: the deletion log is never shortened | Not backed up (replayed after a restore) |  |
| `egress_fetches` | D1 table | Outbound web requests by host | None | 30 days | No | Kept: no member id; removed after 30 days | Nightly, exact (rows only added) |  |
| `SignIn` | Durable Object | The connector hub’s sealed tokens and pending OAuth state | Member ids of who connected or started connecting | Credentials kept while connected. Pending items expire | No | The brand connection stays. Member ids no longer identify the deleted person | Not restored: reconnect |  |
| `privacy_requests` | D1 table | Shopify privacy requests and their status | Shopify customer and order IDs while open | Request record kept while the deployment lives; customer and order IDs cleared on close | No | Kept: no team member ID | Nightly, exact |  |
| `team_requests` | D1 table | Requests to the support team | Requester id, request text and subject | Kept while the deployment lives or until the requester is deleted | Yes | Rows that belong to the person deleted | Nightly, copied in pages (may lag the snapshot by minutes) |  |
| `brand_skills` | D1 table | Skills written by the brand | Maker and editor ids, skill description and instructions | Kept until the skill is deleted | Yes | The skill stays; the deleted member’s maker and editor links are cleared | Nightly, exact | Skill description and instructions |
| `permission_ceiling` | D1 table | Which actions the agent may take at all, and their daily limits | Member ID of who last changed it | Kept while the deployment lives | Yes | Kept: the member ID no longer identifies the deleted person | Nightly, exact |  |
| `permission_grants` | D1 table | "Always allow" permissions, live and ended | Member IDs of the holder and of who granted and ended it | Kept while the deployment lives | Yes | The person's own permissions are deleted. Others keep who granted or ended them, which no longer identifies the deleted person | Nightly, exact |  |
| `permission_uses` | D1 table | How often each permission was used each day | None | Steps setting (default 12 months) | No | Kept: no personal data | Nightly, copied in pages (may lag the snapshot by minutes) |  |
<!-- stores:end -->

## Terms

- **Retention**: `chats` and `steps` follow the brand's Data and access settings (default 12 months). The audit log and
  the deletion log are never shortened. Backups are kept 30 days by the bucket's lifecycle rule, so a deleted person
  leaves them within that window.
- **Export**: "Export everything" (Data and access, route 95) holds the stores marked yes, for the person asking: the
  brand's shared data whole (the audit log, the deletion log, grants, usage, activity, routines, Today, the Library,
  brand skills, team requests) and only the brand's own part of the rest: brand settings and memory (active or
  waiting), and the caller's own personal settings, memories, photo and chats (with their messages, tool calls, files
  and file bytes). Never another person's personal rows. `members` holds person rows only, with the Members page's
  fields (no sign-in subject, no Inhouse team or service row). The Inhouse team under a grant gets no chats, no
  personal rows and no requester ids. Each store's rule is in `app/ops/export/brand-for-caller.ts` (interim default,
  master plan standing decision 10). The ops CLI's brand export holds every store marked yes, whole. A person's export
  holds what names them.
- **Deletion**: a person's deletion pseudonymises their member row (the id stays, so the audit log keeps naming them by
  id only), removes what they own and keeps references to their id. The accepted keeps say where free text that may
  name them stays, and why.
