# Reuse process indexes per sample

Goal: build the process PID and child indexes once per sampler tick while preserving all existing process-usage results and helper signatures.

Scope: `packages/cezar/src/core/process-usage.ts` and its focused tests. The change is a low-priority efficiency cleanup with no promised cockpit latency improvement.

Non-goals: changing the `ps`/PowerShell snapshot, cadence, Windows CPU behavior, peak tracking, exported helper signatures, API contracts, or unrelated files.

## Implementation Plan

### Phase 1: Regression coverage

- [x] 1.1 Add focused tests for one index per sample, equivalent ancestor/descendant roots, cycle termination, and missing-root clearing. — 2d8215b7

### Phase 2: Minimal implementation

- [x] 2.1 Split reusable snapshot indexing from per-root traversal while preserving `aggregateTreeUsage(procs, rootPid)`. — 2d8215b7
- [x] 2.2 Index once in `sample()` and retain per-root traversal state and existing cadence/peak behavior. — 2d8215b7

### Phase 3: Verification and delivery

- [x] 3.1 Run focused regression tests and the configured validation gate, inspect scope, and create the issue PR. — d295b1e6
- [x] 3.2 Run local review and report the exact commit, PR URL, evidence, and validation limits. — d295b1e6

## Risks

- A shared traversal `seen` set would change totals for nested roots; each root must receive a fresh set.
- Missing roots must clear both `last` and `sampledAt`; successful roots must preserve peak updates and timestamps.

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append — <commit sha> when a step lands. Do not rename step titles.

### Phase 1: Regression coverage

- [x] 1.1 Add focused tests for one index per sample, equivalent ancestor/descendant roots, cycle termination, and missing-root clearing. — d295b1e6

### Phase 2: Minimal implementation

- [x] 2.1 Split reusable snapshot indexing from per-root traversal while preserving `aggregateTreeUsage(procs, rootPid)`. — d295b1e6
- [x] 2.2 Index once in `sample()` and retain per-root traversal state and existing cadence/peak behavior. — d295b1e6

### Phase 3: Verification and delivery

- [x] 3.1 Run focused regression tests and the configured validation gate, inspect scope, and create the issue PR. — d295b1e6
- [x] 3.2 Run local review and report the exact commit, PR URL, evidence, and validation limits. — d295b1e6
