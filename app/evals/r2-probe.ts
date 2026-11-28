// The one object a preflight reads to prove its token can read objects, not only list them, when the bucket holds no eval
// chat yet (a fresh or lifecycle-expired eval bucket, a new per-PR bucket). The run's own token is never given R2 write: the
// deployer's seed step puts it (scripts/sandbox/seed-remote.mjs), outside `sessions/eval-` (so it never meets an eval chat's
// key) and outside `files/` (so the orphan sweep never sees it). No imports: the seed script reads this file too.
export const R2_PROBE_KEY = 'sessions/_eval-preflight.json'
export const R2_PROBE_BODY = '{"eval":"preflight-probe"}\n'
