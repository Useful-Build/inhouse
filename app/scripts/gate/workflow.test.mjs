// gate.yml's shape, held by test: what it runs on, what it checks out, and how its runs cancel each other. The sandbox
// workflows test (scripts/sandbox/workflows.test.mjs) holds the rules every workflow shares (pinned actions, secrets).
import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'
import { parse } from 'yaml'

const gate = parse(readFileSync(new URL('../../../.github/workflows/gate.yml', import.meta.url), 'utf8'))
const TRUSTED = `contains(fromJSON('["OWNER", "MEMBER", "COLLABORATOR"]'),`

describe('gate.yml', () => {
  test('runs on PRs from main\'s copy, on comments and reviews, and in the merge queue', () => {
    expect(Object.keys(gate.on)).toEqual(['pull_request_target', 'issue_comment', 'pull_request_review', 'merge_group'])
    expect(gate.on.pull_request_target).toEqual({ types: ['opened', 'synchronize', 'reopened', 'ready_for_review', 'labeled', 'unlabeled', 'edited'], branches: ['main', 'fleet/**'] })
    expect(gate.on.issue_comment).toEqual({ types: ['created', 'edited'] })
    expect(gate.on.pull_request_review).toEqual({ types: ['submitted', 'edited', 'dismissed'] })
    expect(gate.permissions).toEqual({})
  })
  test('the gate job is named gate, reads only, and checks out main alone', () => {
    const job = gate.jobs.gate
    expect(job.name).toBe('gate')
    expect(job.if).toBe("github.event_name == 'pull_request_target' || github.event_name == 'merge_group'")
    expect(job.permissions).toEqual({ contents: 'read', 'pull-requests': 'read', issues: 'read' })
    const checkouts = job.steps.filter(s => String(s.uses).startsWith('actions/checkout@'))
    expect(checkouts).toHaveLength(1)
    expect(checkouts[0].with.ref).toBe('main')
    expect(checkouts[0].with['persist-credentials']).toBe(false)
    // Every value from the event reaches the shell through env, never inside a run script.
    for (const step of job.steps) expect(String(step.run ?? '')).not.toContain('${{')
  })
  test('concurrency is per job, never workflow-wide (G): a comment that skips the recheck joins no group', () => {
    expect(gate.concurrency).toBeUndefined()
    expect(gate.jobs.gate.concurrency).toEqual({ group: 'gate-${{ github.event.pull_request.number || github.run_id }}', 'cancel-in-progress': true })
    expect(gate.jobs.recheck.concurrency).toEqual({ group: 'gate-recheck-${{ github.event.issue.number || github.event.pull_request.number }}', 'cancel-in-progress': true })
  })
  test('the recheck runs on trusted comments and reviews (H), and only those that touch a gate line', () => {
    const job = gate.jobs.recheck
    expect(job.name).toBe('gate-recheck')
    expect(job.if).toContain(`github.event_name == 'issue_comment' && github.event.issue.pull_request &&\n  ${TRUSTED} github.event.comment.author_association)`)
    expect(job.if).toContain(`github.event_name == 'pull_request_review' &&\n  ${TRUSTED} github.event.review.author_association)`)
    for (const field of ['github.event.comment.body', 'github.event.review.body', 'github.event.changes.body.from']) {
      expect(job.if).toContain(`contains(${field}, 'Gate check:')`)
      expect(job.if).toContain(`contains(${field}, 'wasim-approved:')`)
    }
    expect(job.permissions).toEqual({ actions: 'write', 'pull-requests': 'read' })
    expect(job.steps.every(s => !s.uses)).toBe(true)
    for (const step of job.steps) expect(String(step.run ?? '')).not.toContain('${{')
  })
})
