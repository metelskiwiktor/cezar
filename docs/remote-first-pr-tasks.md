# Remote-first PR tasks

A new workflow containing `github.draft-pr` declares PR intent, including conditional
publication paths. The engine applies this at execution/dequeue, before any agent or
check, regardless of autonomy or force-start. Such a task always gets an isolated
worktree. Local tasks without this node retain their explicit in-place/local fork
behavior. Agent-written `gh pr create` commands are not inferred from prose; express
publication through the graph node to get this contract.

The target is the run's explicit `baseBranch`, then the project's `baseBranch`, then
origin's advertised default branch. The engine validates the branch name, fetches
that exact origin branch with a bounded, noninteractive fetch, and resolves its SHA.
Missing origin, missing branch, fetch/auth/timeout errors fail closed with
`PR pre-flight failed`; stale tracking refs and local HEAD are never fallbacks.
`CEZ_DRY_RUN=1` makes no network calls and requires a seeded origin URL, tracking
ref and (when discovering the default) origin/HEAD.

Before creating the worktree the engine persists and flushes machine-owned
`RunRecord.prForkBase = { sha, targetBranch, remoteUrl }`. `baseBranch` holds the
SHA for stable scope/diff measurements; publication uses `targetBranch`, never
interprets that SHA as a GitHub branch. Queue recovery keeps an explicit target;
once forked, restart, Continue and worktree rematerialization keep the SHA, task
branch and worktree. No rebase or movement of existing worktrees occurs. A fresh
run encountering a surviving branch with a different HEAD fails and preserves it.
Legacy started runs retain their original provenance; they are not retrofitted.
Controlled child dispatch deliberately keeps the committed parent branch as its
local fork, rather than silently discarding the parent's work.

The publisher verifies pinned ancestry, task-branch HEAD and unchanged origin URL
before autosave/push. A changed origin URL blocks publication; an advanced tip does
not change the recorded base. It refreshes the target and blocks publication if a
rewrite has dropped the pinned commit. Existing deduplication, review-comment HEAD checks,
permissions and conflict/autosave refusal remain in place. Workflow path allowlists
and review still decide whether the task's own changes are in scope: ancestry alone
does not classify arbitrary edits or cherry-picked commits as related.
An explicit `git.sync-base` node still merges the latest validated remote target,
without changing the recorded fork SHA. PR graph `git.push` nodes apply the same
provenance gate before pushing; Continue alone never syncs a branch.

## Migrating Tabnote's `pr-scope-guard`

Do this separately in `.ai/cezar/workflows/tabnote-task.yaml`; this change does not
edit Tabnote. Its existing graph already contains `github.draft-pr`, so new runs
automatically receive remote-first pre-flight. The current guard re-derives the
fork from local `refs/heads/main` and fetches mutable `origin/main` at publication.
Replace that derivation for new runs with the machine-owned pinned base exported
to both agents and check steps as `CEZ_PR_BASE_SHA` / `CEZ_PR_BASE_BRANCH`:

```bash
[[ "$CEZ_PR_BASE_SHA" =~ ^[0-9a-f]{40}$ ]] || {
  echo "PR blocked: no pinned PR provenance; legacy/child run needs separate recovery"
  exit 1
}
case "$CEZ_PR_BASE_BRANCH" in ''|-*) echo "PR blocked: invalid target"; exit 1;; esac
git check-ref-format "refs/heads/$CEZ_PR_BASE_BRANCH" || exit 1
git merge-base --is-ancestor "$CEZ_PR_BASE_SHA" HEAD || {
  echo "PR blocked: HEAD no longer descends from the recorded fork"
  exit 1
}
if git diff --quiet "$CEZ_PR_BASE_SHA" && [ -z "$(git ls-files --others --exclude-standard)" ]; then
  echo "PR blocked: no task changes"
  exit 1
fi
git diff --stat "$CEZ_PR_BASE_SHA"
git ls-files --others --exclude-standard
```

Retain/add repository-specific path restrictions and tests against this SHA; do
not replace them with a moving merge-base or remove the unrelated-change checks.
Missing provenance must fail, not fall back to local main. Legacy runs should
keep their old guard until separately reviewed/recovered; controlled PR children
need an explicit parent-scope policy. Do not set these environment values manually.

Production evidence read independently: Tabnote runs `51cfc3b2-3501-4e02-ab84-ed3ccb6cc142`
(Codex) and `10e439a9-588f-439f-9156-e6c790949de3` (Claude), on 2026-10-10,
both recorded `base main` and their `pr-scope-guard` output rejected `9925845 msg`.
Commits `9925845` and remote tip `ec6fec2` share parent `ed6195f`; this was divergence,
not just a stale checkout. The old local fork deliberately preserved that history.
This fix prevents that inheritance for new PR graphs. It does not repair those
FAILED Retro Apply runs, publish their work, deploy Cezar or restart the cockpit.
