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

## Dispatch recovery

Recovered through read-only discovery: loopback port belongs to an unrelated dry-run test cockpit. http://172.17.0.1:4321 recognizes project cezar and exact parent run ID cd06c54e-64d4-46b8-b8e8-bbce52120800; task list succeeds with command-local CEZ_API_URL override. Neither server changed.

## Initial dispatch blocker

The first `node "$CEZ_BIN" task create` failed with `dispatch refused — unknown project: cezar`. `node "$CEZ_BIN" task list` independently failed with `could not list runs — unknown project: cezar`. No child was created; model availability was not tested. No implementation, PR, tests or final review completed. The cockpit-injected project identifier must resolve on the cockpit API before resuming. Preserve the requested model and final-review requirement.

## Risks
#1307 references an unmerged dependency; child must establish whether a standalone safe fix exists. Old reports can already be fixed: reproduce before changing, report no-action evidence honestly. Model availability is not yet verified. Full gate failures must be disclosed, not hidden.

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Independent fixes

- [ ] 1.1 Fix #1325
- [x] 1.2 Fix #1077 — already fixed by merged e0c372e2; parent independently confirmed ancestry and 38 passing tests; no duplicate PR
- [ ] 1.3 Fix #1307
- [x] 1.4 Fix #926 — already fixed by merged 15a7dd1f / PR #1246; parent reran screenshot regression: 1 passed, 49 skipped
- [ ] 1.5 Fix #930

### Phase 2: Verification

- [ ] 2.1 Validate child evidence
- [ ] 2.2 Obtain final independent review

## Dispatch ledger

- #1325: 38834c21 (running)
- #1077: ea6daaa6 (done, no change: existing merged fix verified)
- #1307: ef1481bd (running)
- #926: e9a92a6d (queued)
- #930: cccad72d (dispatched)
- 5 of 8 child slots used overall; final independent review reserved. Reassess replacement for already-fixed #1077 after current reports.

## Replacement work

#1215 dispatched as bfda1ebd: bound/coalesce engine heartbeats, handoff.ts and tests only. Lower-priority but actionable uncovered bounded-growth issue. Six children used; at most one more implementation child and the required final review remain. #926 had no diff and existing landed fix verified; no duplicate PR.

## First delivered PR

#1325 child opened draft PR #1329 at 5e1170df; parent inspected source/test diff and reran focused tests (19 passed). Full gate failed per child, so this step remains pending and PR stays draft. Final reviewer must assess real-git coverage, detached HEAD/SHA semantics, missing origin/HEAD and inherited-failure evidence. No merge accepted yet.

#1214 replacement dispatched as 51b0599b (process-usage module/tests only). Seven of eight children used; only final review slot remains.
