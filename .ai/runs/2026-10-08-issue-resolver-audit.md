# Issue resolver audit — 2026-10-08

## Goal
Resolve the five most actionable uncovered bugs through independent Codex Luna 5.6 tasks, each owning root cause, fix, tests and PR creation.

## Scope
Audited all 136 open issues and 116 open PRs using GitHub CLI. Existing high-priority reports #913, #798, #1267 and #475 already have PRs; do not duplicate them. No base-branch merges. Parent orchestrates only; children create individual PRs under om-auto-create-pr.

## Implementation Plan
### Phase 1: Independent fixes
1.1 #1325: stale SHA task diff anchor; git-diff-base module and tests only.
1.2 #1077: automation event dedup across edits; automations modules and tests only.
1.3 #1307: premature child settlement on unanswered questions; workflows/run and dispatch modules/tests only. Shared waits predicate is not on main; implement only if independently safe, without importing the unmerged waits feature.
1.4 #926: queued pasted attachment failure; server message routes and queued/attachment tests plus web composer if needed; no workflows/run edits.
1.5 #930: deterministic automation warm-up verification; server/automations-gate.test.ts only. Coordinate with existing #1107 owner; do not take an active claim.
### Phase 2: Verification
2.1 Inspect child diffs and reproduce reported targeted tests, preserving separate PRs.
2.2 Dispatch exactly one final read-only review of the parent branch and child PR heads; wait for verdict. No unreviewed merges.

## Non-goals
Features, base-branch merges, duplicate PRs, deployment, new settings, and changes outside assigned scopes.

## Risks
#1307 references an unmerged dependency; child must establish whether a standalone safe fix exists. Old reports can already be fixed: reproduce before changing, report no-action evidence honestly. Model availability is not yet verified. Full gate failures must be disclosed, not hidden.

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Independent fixes

- [ ] 1.1 Fix #1325
- [ ] 1.2 Fix #1077
- [ ] 1.3 Fix #1307
- [ ] 1.4 Fix #926
- [ ] 1.5 Fix #930

### Phase 2: Verification

- [ ] 2.1 Validate child evidence
- [ ] 2.2 Obtain final independent review
