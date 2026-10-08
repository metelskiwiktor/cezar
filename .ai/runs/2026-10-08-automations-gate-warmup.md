# Replace automations gate warm-up sleeps with observable completion

## Goal

Resolve #930 by making `automations-gate.test.ts` wait for the server boot work it
asserts, rather than relying on a fixed macrotask delay. Preserve the opt-out gate,
the scheduler-start expectation, and the requirement that stale polls are re-baselined
before the scheduler starts.

## Scope

- `packages/cezar/src/server/automations-gate.test.ts`
- This run plan

## Non-goals

- No production scheduler or server changes.
- No changes to the active #1107 claim or its implementation.
- No broad test-suite timing changes.

## Implementation Plan

### Phase 1: Replace timing assumptions

- [ ] 1.1 Reproduce the delay-sensitive failures with a deterministic slow-git shim and record the baseline.
- [ ] 1.2 Replace fixed warm-up sleeps with observable completion and restore the re-baseline-before-scheduler ordering assertion.
- [ ] 1.3 Run focused regression tests, the configured validation gate, and report evidence.

## Risks

Test-only changes could accidentally make negative assertions pass before boot work
settles, or weaken the ordering contract. The tests will retain explicit observable
completion and ordering checks.

## Progress

PR: #1330

> Convention: `- [ ]` pending, `- [x]` done. Append — <commit sha> when a step lands. Do not rename step titles.

### Phase 1: Replace timing assumptions

- [x] 1.1 Reproduce the delay-sensitive failures with a deterministic slow-git shim and record the baseline. — pending evidence in PR #1330
- [ ] 1.2 Replace fixed warm-up sleeps with observable completion and restore the re-baseline-before-scheduler ordering assertion.
- [ ] 1.3 Run focused regression tests, the configured validation gate, and report evidence.
