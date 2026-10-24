# PR review publication and recovery

A PR review run has two results, reported separately (`GET /api/v1/runs/:id/review-publication`):

- **analysis**: `complete` (the review agent step finished and its full text is saved) or `incomplete`.
- **publication**: `pending`, `published`, `duplicate`, `blocked` (with `reason`) or `stale` (the PR moved to a new HEAD).

The task header shows both in one line; it never says published until GitHub confirmed it.

## Preflight

Before validation, `preflightReviewText` makes one deterministic pass over descriptive prose only:
a Windows executable path on an "executable … hardcoded" line becomes `[local executable path omitted]`,
and an exact `/bin/sh` (plain or as a lone code span, not followed by arguments) becomes `POSIX shell`.
Finding locations, fenced code, command snippets, links and every other path are untouched, and the whole
body is revalidated by the unchanged global path validator. The run gets a note that a formatting repair happened.

## Retrying a blocked publication

`POST /api/v1/runs/:id/review-publication/republish` (also the "Retry publishing" link in the task header)
posts the SAVED full review text of a finished analysis again. It never runs the agent, goes through the
same `publishReviewFromRun` as the graph node (pinned target, stale-HEAD check, validation, repo+PR+HEAD
marker dedup), and answers `409` with the reason for an incomplete analysis, a run that is still active,
or a publication that is not blocked. A new HEAD needs a new review.
