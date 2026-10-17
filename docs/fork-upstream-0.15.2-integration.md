# Fork ↔ upstream integration: open-mercato/cezar v0.15.2

Decision record for merging upstream `v0.15.2` into `metelskiwiktor/cezar` (2026-10-17).
Goal: stop the cycle of ad-hoc fork fixes — upstream Cezar as the base, plus a small,
named AGY / PR-review layer on top.

## 1. Pinned state

| What | SHA |
| --- | --- |
| Fork `main` at the first merge (`4af916d6`) | `5e8f4021b0f66b00313fc7e963ecf0d4b82e0552` |
| Fork `main` now (after #14) — the base PR #15 merges into | `9733573cd7d3f395baac0039b93e48c424b2ff45` |
| Upstream tag `v0.15.2` (merged) | `a9cc59b6fba6b24ea9b7c6944ecbd447ceafda90` |
| Merge-base | `1a34fe0fc262c1ea7d3a22f953bb19ac82c3acbf` (`v0.14.0-37-g1a34fe0f`) |
| `upstream/main` on 2026-10-17 | `bccdadb5` — 27 commits past `v0.15.2`, deliberately **not** merged (unreleased) |
| Fork PR #14 head | `358b13a9` (`cez/2d71bc32`) — **merged into fork `main` as `9733573c`**, then into this branch, see §12 |

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
| Claude timed out at 30 min | **fixed on fork `main` by #14** (`DEFAULT_CLAUDE_RUN_TIMEOUT_MS = 60 min`), preserved by the §12 merge; upstream default stays 30 min for other runners | `claude-cli-runner.ts:42` | `claude-cli-runner.test.ts` |
| evidence gate 1/29 inspections | **fixed on fork `main` by #14** (risk-based gate), preserved by §12 | `agy-review-evidence.ts` | `agy-hardening`/`review-checks` tests — pass |
| resume of pruned Claude sessions | **fixed upstream** (#1435), merged; fork adds `readOnly`/`prReview` to the relaunch | `run.ts` Continue `launch()` | upstream `continuation-missing-session.test.ts` — fails on this Windows host **identically on pure v0.15.2** (mock-claude spawn), so unproven here |
| native Windows check shell (Git Bash vs WSL) | **still open upstream** (#1338 OPEN). Checks `spawn('bash', ['-lc', …])`; on this host PATH order gives Git Bash first, but `C:\Windows\System32\bash.exe` (WSL) is next — a server started with a different PATH would run checks in WSL | `run.ts` `runCheckStep`; `where bash` | isolated instance §14: Git Bash (`MINGW64`) under the current PATH; WSL order hazard remains |
| tests accidentally under `.ai/cezar/tmp` | **fixed (test only, §12)**: the assertion is now relative to a controlled temp root (`TMPDIR`/`TMP`/`TEMP` stubbed), outside the reviewed repo and never under `.ai/cezar/worktrees`; production isolation unchanged | — | `review-checks.test.ts` |
| false read-only failures (`git push` blocked), `DISABLED_READ_ONLY_REVIEW` | own mechanisms; `agy-hardening.test.ts`, `review-checks.test.ts` (except the tmpdir case above), `pr-review-workflow.test.ts` all pass on the merge | — | E2E on a real PR: **pending** |
| PowerShell "don't ask" permissions | outside cezar code (Claude Code permission mode in headless runs) | — | — |
| test teardown race (#1147), check `retryOn` (#1265) | already in the fork before this merge (ancestors of the merge-base) | `git merge-base --is-ancestor` | — |

## 7. PR #14 (lighter pr-review + Claude 60 min)

The order ended up the reverse of what this section first recommended: **#14 landed on fork
`main` first** (`9733573c`), and this branch was then re-merged on top of it (§12) —
conflict-free, as `git merge-tree` had predicted. #14's files are byte-identical after it; only
`claude-cli-runner.ts` gains upstream's additions next to the 60-minute default.

## 8. cezar-adapter impact (adapter not edited)

Adapter calls `/api/v1/health`, `/projects`, `/p/:id/workflows`, `/p/:id/runs` (+ `prNumber`),
`runs/:id`, `history`, `continue`, `messages`, `cancel`, `changes`, `diff`, `git/push`, `pr`
(`src/services/cezar.ts`, adapter `e3dde0f`). Each was replayed against a real 0.15.2 server in
§14. `POST runs/:id/pr` with no body still means draft and now also accepts `{ "draft": false }`
(the adapter's follow-up `gh pr ready` becomes optional); for unpinned runs in the cezar repo
itself the PR target follows §4.

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

## 10. Rollback (git)

* Before PR #15 merges: nothing to roll back — fork `main` stays `9733573c`.
* After it merges: `git revert -m 1 <PR #15 merge commit>` on a branch, PR it. The fixes after
  the re-merge on this branch (`0e7c3d3e`, `be12ee38`, and the report/CodeQL commit) only make
  sense with 0.15.2, so they belong to the same revert.
* The running instance is a separately *installed* copy (§15); no git operation touches it.

## 11. First-pass verification on head `4af916d6` (historical — current status is §12–§14)

Kept as the record of the first merge. Its "not run" list is now partly closed: `build`, `test:package` and an isolated 0.15.2 instance are covered in §12/§14, and Linux CI is green.


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

## 12. Re-integration onto fork `main` with #14 (2026-10-17)

PR #15's head `4d3c9135` was two commits behind fork `main` `9733573c` (PR #14 merged there).
`git merge --no-ff origin/cez/8cdec23b` on top of `9733573c`: **no conflicts**. Checked after
the merge: every file #14 touched is byte-identical to `358b13a9`, except `claude-cli-runner.ts`/
`.test.ts`, which only gain upstream's additions (`exit` → `stdinOpen`, missing-session helper)
and keep `DEFAULT_CLAUDE_RUN_TIMEOUT_MS = 60 min`; `prTargetRemote` (pinned runs → `origin`) is
intact. Pushed as a fast-forward of `cez/8cdec23b` (contains both `4d3c9135` and `9733573c`).

GitHub Actions on `4d3c9135` (run 39064616984) failed 27 unit tests on Linux — real fork drift
that Windows runs had hidden behind host failures. Fixed here:

| Failure | Cause | Fix |
| --- | --- | --- |
| `open-in-app` `cli:agy` → null | `agy` missing from `AGENT_CLIS` | **production**: added (bin `agy` / `CEZ_AGY_BIN`) + cockpit icon |
| `models` ×5, `config-api` ×9 | agy strategy reported its hard-coded fallback as the agent's *native* model, which materialized in `defaultModels` and outranked an auto override (#906) | **production**: agy reports a native model only when `CEZ_AGY_MODEL`/`AGY_MODEL` pins one; the runner still falls back to `DEFAULT_AGY_MODEL` at launch. New regression case in `models.test.ts` |
| `agent-profiles` #582 guard | agy's discovered account home was `~/.claude` | **production**: `AgentHomePaths.agy = ~/.gemini` (where `agy` keeps `oauth_creds.json`/`google_accounts.json`, verified on the host) |
| `draft-pr-autosave` "does not retry a permanent failure" (timeout) | fork's `No commits between` retry assumed "ahead" when the base is unknown → 4 attempts, 9 s of backoff | **production**: unknown base → no retry (the upstream rule); a SHA base is compared directly instead of assumed ahead |
| `provider-auth` ×4, `providers-api` ×2, `agent-profiles-api`, `provider-settings` | descriptor-order fixtures listed 7 providers, agy is the 8th | fixtures extended (no assertion removed); `CEZ_AGY_BIN=agy` pinned so the probe never depends on a host install |
| `agent-profile-wiring` zero-config env | fork's documented empty `CEZ_PR_BASE_*` (clears inherited values, `docs/reference.md`) | fixture extended |
| `review-checks` `rg --files tests` EISDIR | CI has no ripgrep; the test's stand-in only read one file | stand-in covers exactly the argv shapes `reviewCommand` emits; verified with `rg` removed from PATH (62/62) |

Linux CI on `be12ee38` (runs 39065786871 CI, 39065786903 Desktop check, 39065786988 CodeQL):
**all success** — the three vitest shards, typecheck/build/E2E/package and the desktop build.

Local Windows gates, each with its real exit code (each command's own log, not piped through a
filter):

| Command | Exit | Result | Why it is not a pass |
| --- | --- | --- | --- |
| `npm run typecheck` | 0 | pass | — |
| `npm run build` (incl. `check:pack`) | 0 | pass, 836 files | — |
| targeted vitest (21 files: the CI-failure files plus `claude-cli-runner`, AGY, `pr-review`, `pr-fork` ×2, `pr-fork-publication`, `lightweight-workflows`, `catalog`, `open-in-menu`) | **1** | 605/624 | 19 host failures: Windows path separators (`agent-profiles` ×2, `catalog` ×3); a real `~/.local/bin/codex.exe` resolved by `providers-api` (×6, one `EBUSY` rmdir); POSIX `sh` `gh` stubs (`draft-pr-autosave` ×5); this cezar task's own `CEZ_API_URL`/`CEZ_BIN` leaking into `agent-profile-wiring` (11/11 with them unset); `claude-cli-runner` "exits 143" (fails identically on pristine `v0.15.2` — **baseline**, not patched) |
| `npm run test:unit` | **1** | 38/42 | the task's deep TEMP (`.ai/cezar/tmp/<uuid>`) hits Windows MAX_PATH in two `skills-remote` clones (40/42 with the normal `%LOCALAPPDATA%\Temp`); `test-env-launcher` spawns `/bin/sh` |
| `npm run test:package` | **1** | 16/17 | `package-cli` `execFile`s an npm `.cmd` without a shell → `spawn EINVAL` on Windows; the same job is green on Linux CI |
| `npm test` (full), `npm run test:e2e` | not run | — | covered by Linux CI on `be12ee38`; not repeated locally |

So the local Windows result is **not** a full pass; every failure above has a host cause, and
the platform-neutral verdict is Linux CI.

## 13. CodeQL alert 19 (`js/file-access-to-http`, `telemetry.ts:246`) — assessment

Open on `refs/pull/15/merge` only. The flagged flow: `readOwnVersion()` (`index.ts:861–868`)
reads cezar's **own** `package.json` and hands the version string to `initTelemetry`, which puts
it in the body `post()` sends. The code is **identical to upstream `v0.15.2`** (`git diff a9cc59b6
HEAD -- packages/cezar/src/telemetry.ts packages/cezar/src/index.ts` is empty); the alert appears
now because this is the fork's first scan of upstream's telemetry module.

Not a defect: every caller of `post()` goes through `telemetryEnabled()`/`stillGranted()`, which
require `consent === 'granted'` (an explicit yes stored in `~/.cezar/config.json`) and no block
(`CEZ_TELEMETRY=0`, `DO_NOT_TRACK=1`, CI, test runners, `CEZ_DRY_RUN=1`). The "file data" is the
public version number of the installed package, and AGENTS.md documents that envelope
(`service`, `version`, `platform`, `runtime`) as what consented telemetry sends. No code change.
The alert is left **open for the owner** to dismiss as "won't fix — intended flow"; it was not
dismissed automatically.

## 14. Isolated 0.15.2 instance (2026-10-17) — mock/contract, not live E2E

Built `dist` of this branch, served from a throwaway repo with two local bare remotes (`origin`,
`upstream`): `CEZ_HOME` = a fresh temp dir, port 4399, `CEZ_DRY_RUN=1` (mock agents, no model
calls, no secrets), `CEZ_TELEMETRY=0`, automations/dispatch/skill updates off, every inherited
`CEZ_*` cleared. The live 0.14.0 on `:4321` answered `/health` unchanged before and after; the
isolated server was stopped afterwards.

| Check | Result |
| --- | --- |
| Adapter call sequence (health, projects, workflows, `POST /runs` with the adapter's body, run/history/changes/diff, continue, messages, git/push, pr, cancel, list) | all answer with the shapes the adapter reads; invalid body → 400, unknown run → 404, unversioned `/api/runs` → 404 |
| `POST /runs/:id/pr` | only from a settled run (409 "still active" while `waiting`/`running` — correct); `{draft:false}` → 201 (dry-run fake URL) |
| Native Windows check shell | a check step reported `uname=MINGW64_NT-10.0-19045 ostype=msys bash=/usr/bin/bash` — **Git Bash, not WSL**, under this PATH. `C:\Windows\System32\bash.exe` exists and WSL `Ubuntu` is installed, so a server started with System32 ahead of Git on PATH would run checks in WSL (#1338, still open upstream) |
| Unpinned run env | `CEZ_PR_BASE_SHA`/`_BRANCH` present and empty |
| Continue with a pruned Claude session (`CEZ_MOCK_MISSING_SESSIONS=*`) | both runs relaunched in a fresh session with saved context (#1435) and settled `done` |
| Read-only (`analysis`) | 0 commits before and after a relaunched Continue; `POST /pr` → 409 "read-only runs cannot open a pull request" |
| PR target, real fork checkout (`resolveTaskRemotes`, read-only) | base = `upstream`, push = `origin`; `prTargetRemote` → **pinned: `origin`**, **unpinned: `upstream`** (§4 confirmed). Tabnote has only `origin` → unaffected |

Finding (pre-existing, also on fork `main`, not fixed): `POST /runs/:id/git/push` has no
read-only guard, so for a read-only run it pushes a branch ref with 0 commits.

**Limits — not live E2E:** dry-run returns a fixed PR URL before resolving any remote, so the
real `gh pr create` target, a pr-review publication on a pinned HEAD, real agy/Claude sessions
and the adapter process itself against 0.15.2 were **not** exercised. They need real
repositories and credentials and stay pending.

## 15. Deployment plan: backup, switch, verify, rollback (not executed)

Live today: `node ~/.cezar/versions/current/node_modules/@open-mercato/cezar/dist/index.js
--no-open` on `127.0.0.1:4321`, where `versions/current` → `0.14.0+main` (an installed copy, not a
link), serving `tabnote_poc_rn`. Also installed: `0.14.0+local`, `0.14.0+feat-agy-pr-review-v1`.

1. **Preconditions.** PR #15 merged into fork `main` and Linux CI green on that merge commit; no
   run active or queued in the cockpit; the owner has decided on
   `gh repo set-default metelskiwiktor/cezar` in the cezar checkout (§4).
2. **Backup**, with the server stopped so files are quiescent, into `~/cezar-backup-<date>/`:
   * `~/.cezar/config.json`, `config.json.bak`, `ui-state.json`, `agent-accounts.json` if
     present, and the `versions/current` target (`readlink ~/.cezar/versions/current`);
   * per served repo, `.ai/cezar/` **without** `worktrees/` and `tmp/` (`runs.json`, run NDJSON,
     automations, dispatch, drafts, `config.json`, `launch-key`) — for `tabnote_poc_rn` and the
     cezar checkout itself;
   * `cezar --version` and the git SHA the new build comes from.
   Verify the backup: file counts and `sha256sum` of every `runs.json`/`config.json` match the
   originals.
3. **Install beside the old version**: build the release tarball from the merged `main`
   (`npm run build`, `npm pack -w @open-mercato/cezar`) and install it as a new copy
   `~/.cezar/versions/0.15.2+fork` — not `cezar link`, which would make a worktree's rebuilds
   live. Keep `0.14.0+main`.
4. **Switch**: stop the 0.14.0 process, `cezar use 0.15.2+fork`, start it the same way
   (`--no-open`). Workspace migrations are additive and idempotent; run state never migrates.
5. **Verify**: `/api/v1/health` → `0.15.2` on `:4321`; `/api/v1/projects` lists the same
   projects; existing runs open in the cockpit; one quick-task on a scratch project; then the
   adapter's own smoke (`npm run smoke:projects` in cezar-adapter) against `:4321`.
6. **Rollback** on any failed check: stop 0.15.2, `cezar use 0.14.0+main`, restore
   `~/.cezar/config.json` and each repo's `.ai/cezar/runs.json`/`config.json` from step 2 —
   0.15.2 may have added fields 0.14 does not know, so restore instead of relying on tolerance —
   start it, and re-run step 5's health/projects checks expecting `0.14.0`. Runs created on
   0.15.2 in between drop out of the restored index; their worktree branches remain.
