# P0 S5: memory recall and tool choice

Date: 2026-11-19. Status: final. Backend plan open test 3. Plan: `docs/plans/2026-11-19-backend.md`.

**This is a Sonnet 5.5 baseline, not the product model choice.** The product model is chosen at the end of P3.

## What was tested

Does the Inhouse agent recall facts through our memory tool across separate chats, and pick the right tool with the
right key arguments, given our 20 `resource_action` tools (6 always loaded, 14 deferred) and connector tools beside
them?

- Sonnet 5.5 at medium effort, Agent SDK 0.3.328, on S1's runner (standard-1), one `query()` and a new session per
  chat. Tool search on. Built-ins locked to the decided 20.
- All 20 `inhouse` tools with their real names and descriptions, plus two read-only look-alike connectors (a store
  and a mail tool). Only memory was real: keyword search on R2 as a stand-in for D1 FTS5. Pending brand facts were
  hidden from search, per the admin-OK rule.
- 43 cases x 3 repeats, graded by code only: recall (11), recall across two chats (3), tool choice against a named
  look-alike (16), connector choice (5), negatives (8).

## Results

| Category | Pass |
|---|---|
| Recall | 30/33 (91%) |
| Recall across chats | 9/9 (100%) |
| Tool choice | 45/48 (94%) |
| Connector choice | 13/15 (87%) |
| Negatives | 24/24 (100%) |
| **All** | **121/129 (94%)**, repeats 93, 95, 93 |

- The agent searched memory in 100% of recall chats. All 3 R10 misses are a grader artefact: the agent didn't leak
  another person's fact, but its offer mentioned the word the grader banned.
- Tool choice across choice and connector cases: 58/63 (92%) strict. No real wrong-category errors against our names.
- `question_ask` beat the built-in AskUserQuestion 3/3; `memory_update` was used to correct a fact instead of a second
  save; `routine_update` vs `routine_delete` was right 3/3.
- Tool search found every deferred tool and connector tool; no run failed to find what it needed.
- Latency: median 5.2 s per chat, p95 9.7 s, at 2 chats at once on one standard-1. Cost: median $0.011 per chat; the
  full run cost about $1.6.

## Findings

1. **Names hold.** Keep `resource_action`, the 6 and 14 split, and the "use X instead" sentences.
2. **One connector key.** The only pair that wobbled was a product search against an inventory read with two optional
   keys. Suggest one key: the inventory tool takes `sku` only.
3. **Memory as a reflex.** The "search memory before answering about suppliers, policies, preferences or decisions"
   rule made the agent search memory in 28 chats that weren't about recall. Always right, about one extra turn each.
   Soften the rule (decided, Wasim 2026-11-19).
4. Grader fixes before the set becomes the real suite: R10, T02 (accept the fact in the person's language) and the T08
   stub data.

## Verdict

Open test 3 passes. Recall across chats works with only the memory tool carrying the fact, and tool choice with our
names is sound.

## What it changes in the plan

- The S5 case set and harness are the seed of P3's eval suite (Tests 7, acceptance 12), with the grader fixes.
  Still to add: routine creation, cost per conversation, injection and exfiltration sets.
- 94% on Sonnet 5.5 medium is the baseline to beat, not the model choice.
- Suggest `sku` as the only key on the inventory tool (connector design, P4).
- Soften the memory-first prompt rule: search memory when the question could depend on saved context, not on every
  chat. Decided, Wasim 2026-11-19. P3's eval checks that recall doesn't drop.
- The product FTS5 search runs the same vocabulary-gap cases. Semantic search isn't shown to be needed.

## Docs read (2026-11-19)

- https://code.claude.com/docs/en/agent-sdk/typescript (tools, `alwaysLoad`, effort)
- https://code.claude.com/docs/en/agent-sdk/skills
- `product/agent-tools.md` (tool names and descriptions, internal design doc)
