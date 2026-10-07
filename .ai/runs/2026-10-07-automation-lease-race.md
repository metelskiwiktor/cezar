# Fix automation lease race (#1117)

Goal: preserve exclusive automation leases while ensuring a contender that loses the proper-lockfile stale-guard race retries and can make progress.

Scope: `packages/cezar/src/automations/store.ts`, `store.test.ts`, and `store-lease-child.testkit.ts` only.

Non-goals: changing proper-lockfile, weakening live-owner checks, changing unrelated automation behavior, or merging/pushing to the base branch.

Risks: retries must be bounded and limited to the transient path-race error; live locks must remain busy and stale recovery must remain exclusive.

Implementation plan:

### Phase 1: Reproduce and fix

- [x] 1.1 Add a deterministic regression harness for the stale-guard churn and record the old-code zero-winner failure. — controlled ENOENT hook: old code red, new code green
- [x] 1.2 Retry the bounded transient stale-guard race without weakening exclusivity, with focused assertions. — 7048494c

### Phase 2: Validate and review

- [ ] 2.1 Run focused and configured validation, inspect the diff, and complete authoritative review.

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Reproduce and fix

- [ ] 1.1 Add a deterministic regression harness for the stale-guard churn and record the old-code zero-winner failure.
- [ ] 1.2 Retry the bounded transient stale-guard race without weakening exclusivity, with focused assertions.

### Phase 2: Validate and review

- [ ] 2.1 Run focused and configured validation, inspect the diff, and complete authoritative review.
