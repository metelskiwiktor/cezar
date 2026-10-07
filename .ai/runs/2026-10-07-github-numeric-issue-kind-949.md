# GitHub numeric issue search kind — 2026-10-07

## Goal

Ensure a numeric search on the Issues tab cannot render a pull request as an issue when GitHub's issue search fallback returns both kinds.

## Scope

`packages/cezar/src/server/forge/github.ts` and its dedicated tests. No UI changes and no changes to the parent orchestration plan.

## Implementation Plan

### Phase 1: Regression and fix

1. Add a regression fixture proving an issue search result marked as a pull request is excluded after a wrong-kind numeric lookup.
2. Filter GitHub issue-search hits by the CLI's `isPullRequest` discriminator while preserving genuine issue hits.

### Phase 2: Verification

3. Run the focused forge test, typecheck, and configured validation gate; inspect the diff and report exact evidence.

## Risks

GitHub's `search issues` endpoint includes pull requests. The discriminator is requested only for the issue-search path and defaults safely for older/mock-shaped fixtures; PR search behavior remains unchanged.

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands.

### Phase 1: Regression and fix

- [x] 1.1 Add wrong-kind numeric-search regression — e38ac1a4
- [x] 1.2 Filter pull requests from issue search fallback — e38ac1a4

### Phase 2: Verification

- [x] 2.1 Run focused tests, typecheck and configured gate — focused forge suite passes; full gate has unrelated baseline failures (see PR report)
