# Fix premature child settlement reports

Goal: prevent a dispatched child stopped on an unanswered `CEZ:ASK` from reporting a false
terminal outcome to its parent, while preserving exactly-once reporting after the question is
answered or explicitly retired.

Scope: `packages/cezar/src/workflows/run.ts`, dispatch workflow tests, and this run plan.

Non-goals: cross-task waits (#1289), changes to terminal statuses, or persisted schema changes.

## Implementation Plan

### Phase 1: Reproduce and fix

- [x] 1.1 Add a manager-level regression covering no early report and later real settlement. — red without source fix; green with source fix
- [x] 1.2 Gate child report delivery on `awaitingAnswerSince` and run the focused tests. — `npm exec vitest -- run packages/cezar/src/workflows/recover-dispatch.test.ts`
- [x] 1.3 Add actual idle-close → Continue → settle and cancellation retirement coverage. — focused lifecycle tests green

### Phase 2: Validate and publish

- [ ] 2.1 Run the configured validation gate, review the diff, and publish the fix PR. — clean gate green; archive notification remains outside assigned scope

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append — <commit sha> when a step lands.

### Phase 1: Reproduce and fix

- [x] 1.1 Add a manager-level regression covering no early report and later real settlement.
- [x] 1.2 Gate child report delivery on `awaitingAnswerSince` and run the focused tests.
- [x] 1.3 Add actual idle-close → Continue → settle and cancellation retirement coverage. — focused lifecycle tests green

### Phase 2: Validate and publish

- [ ] 2.1 Run the configured validation gate, review the diff, and publish the fix PR.
