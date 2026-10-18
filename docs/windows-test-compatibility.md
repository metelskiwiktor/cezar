# Windows test portability: bounded fixes

This change fixes three reproduced test-harness assumptions. It does not make the
Windows suite green and does not change remote-first behavior or production code.
The branch starts at `origin/main` (`b4837a723b88b52882228c5700d89c7d3e9710b2`),
independently of PR #3 (`cba445f7`). Neither branch was merged or rebased.

## Environment and isolation

- Windows 10 Pro 10.0.19045, x64, 16 logical processors, about 32 GiB RAM.
- Windows Node 22.19.0, npm 10.9.3, lockfile-installed Vitest 4.1.10.
- Linux cross-check: Ubuntu on WSL2 5.15.167.4, Node 22.19.0, npm 10.8.2,
  the same lockfile and Vitest version, a separate Linux dependency installation.
- Separate clean detached baseline and PR #3 validation worktrees; the existing
  local `main` and PR #3 worktree were left unchanged.
- Full Windows runs use `--maxWorkers=2`, unchanged test timeouts and assertions.
  The baseline and patched runs overlap in wall time, so incidental count changes
  cannot by themselves establish causality or a concurrency fix.

The cockpit inherited `TEMP`/`TMP` inside a Tabnote repository and active-task
`CEZ_*` variables. Initial runs were unsuitable for full-suite comparison: Git
discovered the parent repository from an ostensibly non-repository fixture, and
the dry-run mock inherited the active handoff path. Those full runs were stopped;
they are not counted as completed baseline results. Subsequent runs clear the
cockpit variables and use an external temporary directory. For example, before
running npm from a dedicated validation worktree in a fresh PowerShell process:

```powershell
$validationTemp = Join-Path $env:LOCALAPPDATA 'Temp/cezar-windows-validation'
New-Item -ItemType Directory -Force -Path $validationTemp | Out-Null
$env:TEMP = $validationTemp
$env:TMP = $validationTemp
Get-ChildItem Env:CEZ* | ForEach-Object {
  Remove-Item -LiteralPath ('Env:' + $_.Name)
}
npm test -- --maxWorkers=2 --reporter=default --reporter=json --outputFile=results.json
```

## Reproduced causes and red/green evidence

| Cause and test identity | Before | After | Cross-check |
| --- | --- | --- | --- |
| `git-worktree.test.ts`: `worktreeSizeBytes (#483) returns a positive byte count for a real directory`; `worktrees-api.test.ts`: `the worktrees API lists materialized worktrees with sizes, the keep-limit, and a reclaimable flag` | Both assert a number when the real `du` is missing; reproduced twice on Windows baseline and on PR #3 | Both pass with exact real-tool bytes, or exact `null` only for missing-tool `ENOENT`; API checks all three entries and the exact total | Linux: both pass using real `du`, before and after |
| `test/unit/skills-remote.test.ts`: `listRemoteSkills clones a local repo, pins the SHA, and refuses a bad ref` | `spawnSync mkdir ENOENT`, including a clean baseline unit run | Fixture directory uses Node `mkdirSync`; original clone, commit pinning and rejection assertions pass | Linux unit suite passes before and after |
| `test/e2e/package-cli.test.ts`: npm pack/install subprocesses | `npm.cmd` passed to `execFile` fails with `EINVAL`, including after a completed build | Invoke npm's `cli.js` from `npm_execpath` through the current Node with separate argv entries, following `check-pack.mjs` | New actual-pack test uses a directory containing spaces and `&`; restoring the old invocation on Windows gives 0 pass / 1 fail. The fix gives 1 pass / 0 fail on Windows and Linux |

No Windows skips, expected failures, relaxed timeout, shell invocation, tool mock,
production runner changes, or global worker-limit configuration were added.
The disk-usage helper rethrows errors other than a missing executable, validates
the real tool's output and requires positive disk usage when the tool exists.

## Validation

Windows targeted Vitest (`git-worktree.test.ts` and `worktrees-api.test.ts`):
the initial run was 47 pass / 4 fail; one failure was the inherited temporary
directory contamination. The isolated PR #3 run was 48 pass / 3 fail. The patched,
isolated run is 50 pass / 1 fail, with the two `du` failures removed. The remaining
failure is `createWorktree recovery (real git) is idempotent when the task worktree
is already registered`, reproduced before the fix and on PR #3; it was left
outside this change. Linux targeted runs are 51 pass / 0 fail before and after.

Windows `test:unit`: 39 pass / 2 fail / 1 existing skip before, 40 pass / 1 fail /
1 existing skip after. The remaining failure is `generated launcher survives its
caller and stops by descriptor PID (nohup fallback)`, with `/bin/sh ENOENT`.
Linux `test:unit`: 42 pass / 0 fail before and after.

Windows `test:package` after build: 16 pass / 1 fail before. After the fix and the
new real-pack test: 17 pass / 1 fail. Pack and install now complete, exposing a
later failure in the release workflow's executable auth fixture (`the runtime-auth
fixture creates exactly one run`, expected 2, actual 1). That fixture uses a
POSIX executable JavaScript shim; this change does not claim to fix it. Linux
package validation is 18 pass / 0 fail, including the new real-pack case.

Windows and Linux `npm run typecheck` and `npm run build` pass. Builds include
the actual `check:pack` tarball gate. No production server or reviewer was started.

## Full-suite comparison

Both complete runs exited 1. No test timeouts were increased.

| Windows full Vitest, two workers | Pass | Fail | Skip | Failed files | Duration |
| --- | ---: | ---: | ---: | ---: | ---: |
| Clean origin/main b4837a72 | 8634 | 461 | 33 | 88 / 536 | 1137.26 s |
| This patch | 8640 | 455 | 33 | 86 / 536 | 1034.15 s |

Failure identity comparison: 432 tests failed in both runs, 29 failed only in the
baseline, and 23 failed only in the patched run. Two of the 29 are the reproduced
disk-usage assertion failures fixed here. The other 27 disappearances and all 23
new failures are **uninvestigated / possibly regression or timing variation**;
the net reduction of six failures is not a claim that six defects were fixed.
The new failures have timeout symptoms (22 cases) or `EBUSY` (one case), in
unchanged workflow suites. No broad concurrency fix has been established.

| Primary symptom bucket (mutually exclusive) | Baseline | Patched |
| --- | ---: | ---: |
| Message contains a timeout | 160 | 158 |
| Assertion, still unclassified | 168 | 165 |
| Other, still unclassified | 99 | 99 |
| EBUSY / ENOTEMPTY / EPERM without a timeout message | 31 | 30 |
| ENOENT / EINVAL without the preceding symptoms | 3 | 3 |

These are symptom counts, not causal diagnoses. Timeout and filesystem errors
can occur in the same test: 120 baseline and 119 patched failures contain both.
Counting every message with a filesystem-lock/permission symptom gives 151 and
149 respectively. One full run per revision does not prove determinism.

The largest remaining groups include `workflows/run.test.ts` (52 failures),
`server/projects-api.test.ts` (33), `workflows/dispatch-engine.test.ts` (19),
`workspace/projects.test.ts` (19), and `workflows/auto-resume.test.ts` (17).
The known path-identity failure, POSIX launcher and executable auth fixture also
remain. They require separate causal investigation; none is called fixed here.

Local evidence is retained in this worktree's ignored
`.ai/tmp/windows-validation/`: original full JSON reports and logs, summaries,
`comparison.json` (each failed file, full test identity, complete message,
baseline status and whether determinism was established), and Windows/Linux
targeted and node:test logs. Large logs are intentionally not included in the
source diff. The inventory marks remaining failures as not proven deterministic.

The historical counts supplied with the assignment were origin/main 8604 pass /
491 fail / 33 skip and PR #3 8575 pass / 546 fail / 33 skip. The additional 55
failures are **uninvestigated / possibly regression**. The limited targeted PR #3
comparison above does not establish that those 55 failures are baseline defects.

Publication uses a scoped Git push and `gh pr create --repo metelskiwiktor/cezar`
as the explicitly authorized temporary fallback. The integrated task connector
has Tabnote project context, and no correct Cezar workflow context was available
without starting a server. PR #3 remains open; no merge or force push is performed.
