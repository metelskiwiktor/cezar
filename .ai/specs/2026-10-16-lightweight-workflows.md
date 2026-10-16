# Lightweight workflows: implement, analysis, pr-review

Stage 2 of the orchestration simplification. Three built-ins cover the everyday paths; every
other built-in (`quick-task`, `implement-and-verify`, `implement-review-pr`, `review-council`,
`fix-ci`) is unchanged.

## Split of responsibility

- **Agent**: analysis and implementation, proportionate tests, commits and its own self-check,
  all in the same session.
- **cezar**: worktree, session/queue, the pinned fresh Git base (`producesPullRequest` →
  `resolvePrForkBase`), push and PR publication. No extra orchestration framework.

## implement

`start → agent (implement) → github.draft-pr { ready: true } → end`. The agent prompt asks for
implementation → proportionate verification → re-reading its own diff and fixing → commit,
and forbids push/PR/merge. cezar then opens the PR ready for review: `github.draft-pr` gained
an optional `ready` flag (contract + server schema) that drops `--draft` from `gh pr create`
(`DraftPrInput.ready`). Absent = draft, so every existing graph and the cockpit's review-gate
button keep opening drafts. No check loop, no AI-review rounds, no human gate.

## analysis

A plain step workflow, one agent step with `review: true` and read tools only. A step workflow
whose every step is a `review: true` agent is read-only end to end (`isReadOnlyWorkflow`): the
run record gets `readOnly: true` at creation (so Continue stays read-only too), credentials are
stripped (agent-env), and **no autosave commit** happens on turn end, run finalize or the
periodic timer for any read-only run. That last rule also applies to PR review runs, which
never had anything legitimate to commit. Graph workflows never qualify — their `review` flag
means a fork reviewer.

## pr-review

The existing built-in, adapted:

- The review context says to read what the review needs (diff, affected code, AGENTS.md), not
  every file ritually, and allows justified tests that change no tracked file.
- **Inline comments**: an optional fenced `cez-inline-comments` JSON block of
  `{ path, line, body }`. `extractInlineComments` validates each entry on its own (relative
  path, positive line, no local/private path) and drops bad ones; malformed JSON drops the
  block. They are posted first, as one `POST /pulls/N/reviews` (`event: COMMENT`,
  `commit_id` = the reviewed HEAD, `side: RIGHT`); if GitHub refuses (422: a line outside the
  diff) they are folded into the main comment. The main comment and its PR+HEAD marker,
  dedup and stale-HEAD gate are unchanged — a duplicate HEAD posts neither.
- **Agy evidence**: supersedes the "every inspection must succeed" rule of
  `2026-10-12-pr-review-v3-headless`. A failed in-scope read (guessed module path, missing
  doc or source, unknown read error) no longer fails a review whose mandatory evidence is
  complete: the pinned diff fully read, AGENTS.md, at least one affected file, every trusted
  check result, no pending call. Kept fatal: permission denials, reads outside the checkout,
  mutating/terminal tools, checkout changes, timeouts. The late provider-format-error
  recovery keeps the stricter bar (`strictComplete`: guessed paths corrected, no failed call).

## Retro Lite

Stays a separate process with its own semantics; it is not a mandatory self-check step of any
of these workflows.
