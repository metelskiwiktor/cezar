# Fix stale SHA task diffs

Goal: ensure task diff attribution stays anchored to the actual task fork when a run records a commit SHA instead of a branch name, without changing zero-config branch/ref behavior.

Scope: `packages/cezar/src/git-diff-base.ts` and its focused regression tests.

Non-goals: changing task-diff callers, persisted run schemas, branch creation, or unrelated Git safety behavior.

## Implementation Plan

### Phase 1: Reproduce and fix

- [x] 1.1 Add a regression fixture for a SHA-pinned base with an advanced `origin/main`, and prove the current implementation selects the stale SHA. — 3d47224f
- [x] 1.2 Resolve SHA-pinned bases against the freshest corresponding base ref while preserving explicit commit semantics and add focused coverage. — 3d47224f

### Phase 2: Verify and publish

- [x] 2.1 Run focused tests and the configured validation gate, review the final diff, and publish the fix PR with evidence.

Risks: a recorded SHA is also used for intentional in-place runs, so the fix must only replace it when Git can establish the corresponding branch/ref relationship; otherwise it must preserve the existing SHA fallback.

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append — <commit sha> when a step lands. Do not rename step titles.

### Phase 1: Reproduce and fix

- [x] 1.1 Add a regression fixture for a SHA-pinned base with an advanced `origin/main`, and prove the current implementation selects the stale SHA. — 3d47224f
- [x] 1.2 Resolve SHA-pinned bases against the freshest corresponding base ref while preserving explicit commit semantics and add focused coverage. — 3d47224f

### Phase 2: Verify and publish

- [x] 2.1 Run focused tests and the configured validation gate, review the final diff, and publish the fix PR with evidence.
