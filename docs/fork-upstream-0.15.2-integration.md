# Fork ↔ upstream integration: open-mercato/cezar v0.15.2

Decision record for merging upstream `v0.15.2` into `metelskiwiktor/cezar` (2026-10-17).
Goal: stop the cycle of ad-hoc fork fixes — upstream Cezar as the base, plus a small,
named AGY / PR-review layer on top.

## 1. Pinned state

| What | SHA |
| --- | --- |
| Fork `main` before this merge | `5e8f4021b0f66b00313fc7e963ecf0d4b82e0552` |
| Upstream tag `v0.15.2` (merged) | `a9cc59b6fba6b24ea9b7c6944ecbd447ceafda90` |
| Merge-base | `1a34fe0fc262c1ea7d3a22f953bb19ac82c3acbf` (`v0.14.0-37-g1a34fe0f`) |
| `upstream/main` on 2026-10-17 | `bccdadb5` — 27 commits past `v0.15.2`, deliberately **not** merged (unreleased) |
| Open fork PR #14 head | `358b13a9` (`cez/2d71bc32`) — not in `main`, see §7 |

History since the merge-base: fork **31 commits** (22 non-merge + 9 PR merges), upstream
**79 commits** to `v0.15.2`. Fork diff vs merge-base: 101 files, +7273/−136. After the merge the
fork's residual diff vs `v0.15.2` is 97 files, +7366/−127 (this document included) — almost all of it NEW files
(AGY runner, review checks, PR-review automation, PR-fork pinning) rather than edits to upstream code.

## 2. Strategy: MERGE (not rebase, not cherry-pick)

* **Rebase** of 22 commits over 79 would rewrite every fork SHA that run records, PR #14 and
  the running 0.14 instance reference, and replay the same 7 conflict sites once per commit
  that touches them (run.ts is touched by most). High cost, no benefit.
* **Selective cherry-pick** of upstream fixes is what produced the current drift (e.g. the
  fork's own copy of #1334). It keeps the fork permanently "partly upstream" and makes the next
  sync harder.
* **Merge** resolved in one place: `git merge-tree` dry-run showed **7 conflicted files**, all
  textual and local. One merge commit, `git revert -m 1` as rollback, and every future sync is
  again one merge. Chosen.

## 3. Conflicts and their resolution

| File | Class | Resolution |
| --- | --- | --- |
| `vitest.setup.ts` | additive | both: fork's `HOME`/`USERPROFILE` sandbox + upstream's `GH_CONFIG_DIR`, `CEZ_AUTONAME=0`, `CEZ_MOCK_PACE` pins |
| `git-worktree.ts` `syncWithBase` | semantic (remote selection) | upstream `taskRemotes` (#1383) + fork's `fetch: false` for pinned runs |
| `forge/types.ts` | API rename | upstream `draft?: boolean` replaces fork `ready?: boolean`; fork keeps `retryDelayMs` test seam |
| `forge/github.ts` `createDraftPr` | **semantic (PR target)** | upstream adopt-existing-PR (#1430) + push/target split (#1383); fork's `findExistingBranchPrUrl`, auth regex and "URL in error" path **dropped** as redundant; kept as fork delta: 4 attempts with growing delay, `No commits between` as transient only while the branch is locally ahead, and `prTargetRemote` (below) |
| `server.ts` | import | union |
| `automations/task-template.ts` | two PR-head mechanisms | both kept: upstream `checkout: 'pr-head'` wins when set; otherwise the fork's read-only `prReview` checkout |
| `workflows/run.ts` (14 hunks) | mixed | imports/ctor options unioned; worktree creation = fork's PR-base pin + PR-review prep inside upstream's generated-branch-name flow; Continue session = upstream resume relaunch (#1435) + fork `readOnly`/`prReview`; autosave = upstream check-artifact exclusions + fork's "read-only runs never commit" (also applied to upstream's new pre-check checkpoint); check env = upstream secrets/context env + fork `CEZ_PR_BASE_*` |

Non-textual fallout found by typecheck/tests and fixed in the merge:

* `provider-auth.ts`: AGY descriptor lacked upstream's new required `overrideEnv` → `CEZ_AGY_BIN`.
* `run.ts` passed `{ ready: true }` through a spread (no excess-property check): after the rename
  it would have been **silently ignored and every `implement` PR would open as a draft**. Now
  `{ draft: false }`.
* `data-gitignore.ts`: fork's `node-text/` state dir was not in the allowlist (test already red on
  fork `main`; own regression from `b1f104ff`).
* `pr-fork.test.ts`: upstream now keeps check-step output out of autosave commits; two assertions
  expected an extra commit after the check.

## 4. Critical semantic conflict: PR target remote (#1383 vs fork pinning)

This repository has `origin = metelskiwiktor/cezar` (a GitHub fork of `open-mercato/cezar`)
and `remote.upstream.gh-resolved = base`. Upstream's `resolveTaskRemotes` therefore resolves
**base/PR-target = `upstream`** here (verified: `git config --get-regexp '^remote\.'`,
`gh api repos/metelskiwiktor/cezar --jq .parent.full_name` → `open-mercato/cezar`).

* Fork's pinned PR runs (`prForkBase`, every `github.draft-pr` graph incl. `implement`) pin
  `origin/<target>` and validate `origin`'s URL before publish. Upstream's new code would then
  have pushed to `origin` but opened the PR **on open-mercato/cezar**. Resolved by
  `prTargetRemote()` (`forge/github.ts`): a pinned run always targets `origin` — the repo whose
  SHA was pinned. Regression test: `pr-fork-publication.test.ts` "a pinned run targets origin…"
  (verified red with the guard removed, green with it).
* **Still upstream behavior for UNPINNED runs** (manual "Create PR" on a `quick-task`, the
  adapter's `POST /runs/:id/pr` for a run without `prForkBase`, new non-PR tasks' fork point):
  they follow #1383 and would target `upstream` **in this repository**. Mitigation, no code:
  `gh repo set-default metelskiwiktor/cezar` in the cezar checkout (moves `gh-resolved base` to
  `origin`). Not done by this task — it changes shared local git config; do it deliberately
  before deploying. Projects with only `origin` (e.g. Tabnote) are unaffected.

## 5. Commit map (22 non-merge fork commits)

| Commit | Subject | Decision |
| --- | --- | --- |
| d2b5a505, 8968def2, 99634590, 2dbe56b0 | native Antigravity (`agy`) runner + read-only guardrails | **KEEP** — no upstream equivalent. Guardrails are a *logical* sandbox (allowlist/arg policy), not OS isolation |
| 97806c64 | agy default model fallback | **KEEP** |
| 3f60e521, dd23a02a, 2ec88f4d, 0078f6c0, 764234ac, 1a299245 | Gemini PR review, guarded/idempotent publication, check policy | **KEEP** now; **REWRITE MINIMALLY** later onto upstream `checkout: 'pr-head'` + check nodes |
| b4837a72, 7534b5fa, 6bf38b50 | evidence gate, diff chunking, mid-turn check requests | **KEEP**, simplification target (PR #14's risk-based gate is the first step) |
| 35ad5508, d07961c1 | Windows broker for headless Agy checks, portable fixtures | **KEEP** — native Windows shell is still open upstream (#1338) |
| 05579e94 | PR-review checkout at PR HEAD | **KEEP**, overlaps upstream #1293 `pr-head` → **REWRITE** candidate (next iteration) |
| e8b05d9f | pin PR-producing tasks to fresh remote bases | **KEEP** + guarded against #1383 (§4) |
| 571e4483 | retry transient propagation lag in `createDraftPr` | **REPLACE WITH UPSTREAM** (#1430), small delta kept (§3) |
| c418020a | Windows absolute paths (#1334) | **REPLACE WITH UPSTREAM** — residual diff after merge is zero (one test line) |
| b1f104ff | lightweight implement / analysis / pr-review workflows | **KEEP** (+ gitignore fix) |
| 38437900 | tests isolate `USERPROFILE` | **KEEP** (candidate to upstream) |

Nothing was dropped wholesale; dropped *code*: fork's PR-lookup/auth-retry branch in
`createDraftPr` and the `ready` input flag (both superseded by upstream).

## 6. Incidents → status

| Incident | Status | Evidence | Regression test |
| --- | --- | --- | --- |
| PR publish `Head sha can't be blank` / `No commits between` | blank-sha: **fixed upstream** (#1430, retry + adopt existing PR); `No commits between` lag: **fork delta kept** | `forge/github.ts` `createDraftPr`, `CHANGELOG.md:16` | `pr-fork-publication.test.ts` (retry, adopt, empty-branch no-retry) — pass |
| implement → ready PR in the right repo | **own regression risk introduced by the merge, fixed** (`ready` spread; #1383 target) | §3, §4 | `pr-fork-publication.test.ts` — pass; `lightweight-workflows.test.ts` — pass |
| lost / stale base commits | **fixed** (fork pinning + upstream base-remote fetch) | `pr-fork.ts`, `git-worktree.ts` | `pr-fork.test.ts` 15/15 |
| Claude timed out at 30 min | **still open on main** — upstream default is still 30 min (`claude-cli-runner.ts:37`); PR #14 raises Claude to 60 | — | PR #14's `claude-cli-runner.test.ts` |
| evidence gate 1/29 inspections | **own regression, still open on main**; PR #14 (risk-based gate) | `agy-review-evidence.ts` | PR #14's `agy-hardening`/`review-checks` tests |
| resume of pruned Claude sessions | **fixed upstream** (#1435), merged; fork adds `readOnly`/`prReview` to the relaunch | `run.ts` Continue `launch()` | upstream `continuation-missing-session.test.ts` — fails on this Windows host **identically on pure v0.15.2** (mock-claude spawn), so unproven here |
| native Windows check shell (Git Bash vs WSL) | **still open upstream** (#1338 OPEN). Checks `spawn('bash', ['-lc', …])`; on this host PATH order gives Git Bash first, but `C:\Windows\System32\bash.exe` (WSL) is next — a server started with a different PATH would run checks in WSL | `run.ts` `runCheckStep`; `where bash` | pending (needs a real check run per PATH) |
| tests accidentally under `.ai/cezar/tmp` | **own test fragility, still open**: cezar sets the agent's temp dir to `.ai/cezar/tmp/<run>`, so `review-checks.test.ts` "runtimeDir never inside .ai" fails whenever the suite runs inside a cezar task | test output | fix the test to stub `os.tmpdir()` (next iteration) |
| false read-only failures (`git push` blocked), `DISABLED_READ_ONLY_REVIEW` | own mechanisms; `agy-hardening.test.ts`, `review-checks.test.ts` (except the tmpdir case above), `pr-review-workflow.test.ts` all pass on the merge | — | E2E on a real PR: **pending** |
| PowerShell "don't ask" permissions | outside cezar code (Claude Code permission mode in headless runs) | — | — |
| test teardown race (#1147), check `retryOn` (#1265) | already in the fork before this merge (ancestors of the merge-base) | `git merge-base --is-ancestor` | — |

## 7. PR #14 (lighter pr-review + Claude 60 min)

Touches 11 fork-owned files; the only upstream-touched one is `claude-cli-runner.ts`, which
auto-merges. `git merge-tree` of PR #14 against `v0.15.2` shows exactly the same 7 conflicts as
fork `main` and none of its own; against this merge it is **conflict-free** (tree `06802901`).
On that combined tree PR #14's suites (`claude-cli-runner`, `review-checks`, `agy-hardening`,
`agy-cli-runner`, `automations/pr-review`) give 217/219 — the two failures are the `.ai/cezar/tmp`
case (§6) and `claude-cli-runner` "exits 143", which fails identically on pristine `v0.15.2` here.
Recommendation: land this integration first, then merge PR #14 on top (or rebase it — it is one
commit). Nothing in this merge supersedes it.

## 8. cezar-adapter impact (read-only check, adapter not edited)

Adapter calls `/api/v1/health`, `/projects`, `/p/:id/workflows`, `/p/:id/runs` (+ `prNumber`),
`runs/:id`, `history`, `continue`, `messages`, `cancel`, `changes`, `diff`, `git/push`, `pr`.
All still exist with compatible shapes (`prNumber` stays in the contract; `POST runs/:id/pr`
with no body still means draft). Two things the adapter owner should know: `POST runs/:id/pr`
now accepts `{ "draft": false }` (the adapter's follow-up `gh pr ready` becomes optional), and
for unpinned runs in this repository the PR target follows §4.

## 9. Target architecture (cost reduction)

1. Upstream Cezar unchanged wherever possible; one merge per upstream release.
2. A fork layer limited to: `agy` runner + UI mapper, `review-checks`/`read-only-sandbox`
   (logical guard), `automations/pr-review` publication, `pr-fork` pinning, three workflow
   templates. Each entry point already lives in its own file; the remaining edits in upstream
   files are small hooks in `run.ts`, `forge/github.ts`, `task-template.ts`, `git-worktree.ts`.
3. Next iterations, in order: (a) move PR-review checkout onto `checkout: 'pr-head'` and drop
   `preparePrReviewCheckout`; (b) express review checks as upstream check nodes with `retryOn`
   and keep the broker only as the Windows shell shim until #1338 lands; (c) replace the
   evidence gate with PR #14's risk-based minimum; (d) offer `prTargetRemote` / USERPROFILE pin
   upstream.

## 10. Rollback

* Before merging the PR: nothing to roll back — fork `main` is untouched (`5e8f4021`).
* After merging: `git revert -m 1 <merge commit>` on a branch, PR it. The running 0.14 instance
  is unaffected until it is redeployed.
* Deploy precondition: `gh repo set-default metelskiwiktor/cezar` in the cezar checkout (§4).

## 11. What was actually verified (2026-10-17, Windows 10, Node 22.19)

* `npm run typecheck` (contract, api-client, server, web): **pass**.
* Targeted vitest, merge branch: fork suites `pr-fork`, `pr-fork-publication`, `pr-review-workflow`,
  `lightweight-workflows`, `automations/pr-review`, `task-template`, `agy-cli-runner`,
  `agy-hardening`, `agent-env`, `review-checks` (1 env failure, §6), `data-gitignore`,
  contract-parity/typed-bodies/versioned-surface/bc-route-inventory: **pass**.
* Upstream suites around the conflicts (`git-worktree`, `pr-head`, `draft-pr-autosave`,
  `auto-resume`, `check-retry-on`, `continuation-missing-session`, `route-parity`, `paths`,
  `workspace/config`): failures are **Windows-host failures that reproduce on a pristine
  `v0.15.2` worktree** (33 failures there vs 22 on the merge in the same files: POSIX `gh`
  stubs on a `:` PATH, `/tmp` separators, file mode `0600`, mock-claude spawn, timeouts).
  No failure is unique to the merge except `pr-head` "without checkout…", which passed on re-run.
* **Not run**: full monorepo vitest, `npm run build`/`test:package`, `test:e2e`, and any real
  GitHub E2E (implement → ready PR on the fork, pr-review publish on a pinned HEAD, analysis
  without modifications, resume, adapter against a 0.15.2 server). These need a running
  instance and real repositories and remain **pending**.
