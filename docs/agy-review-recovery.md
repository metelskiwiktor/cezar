# Antigravity review: recovered module path discovery

The local run `5f429b0d-e1bd-49cc-b151-76d35c9d7a07` failed in its review step,
before the publish node. Its read of `src/models/index.ts` failed with cortex's
`GetFileAttributesEx ... The system cannot find the path specified.` error.
Subsequent `view_file` calls successfully read `src/models.ts`. The log also
records successful full PR diff, AGENTS.md and changed-file inspection calls.
The successful lifecycle results omit file contents; they are still tool
completion evidence, rather than the model's own claim to have read a file.

The provider produced the missing-path error, but Cezar's `AgyCliRunner` turned
every failed inspection into a terminal failure, including recovered path
discovery. This is a Cezar adapter fix, not a cortex/agy update. It does not
change historical runs, retry the original PR review, or update installed runtime.

The exception is deliberately narrow: a failed `view_file` on a nonexistent,
checkout-local `module/index.{ts,tsx,js,jsx,mjs,cjs}` can recover only after a
successful read of the corresponding `module.{extension}`. The failed path
cannot be a required changed file. Arbitrary typo recovery is not inferred.
All other inspection failures remain terminal. Permission denial (including
EACCES/EPERM), attempted mutating tools, checkout changes, agent failures and
timeouts retain their fail-closed checks.

For machine-prepared PR contexts, the adapter additionally requires successful
AGENTS.md, exact full diff command, and every surviving changed-file read, even
if there were no tool errors. Required paths come from local Git using the exact
two SHAs supplied by Cezar; checkout HEAD must match. Deleted files are covered
by the full diff, since they cannot be read at HEAD. No pending tool call may
remain. Unknown or absent context cannot authorize recovery. This evidence
check accepts only `view_file` lifecycle results and the exact `run_command`
diff; other inspection strategies fail closed for prepared agy PR reviews.
The reviewed refs come from machine-owned `AgentRunSpec.prReview`, populated
from the run record on both opening and Continue spawns. They are never inferred
from prompt text: an injected `git diff HEAD HEAD` must not shrink the required
file set. Missing target metadata fails closed for a prepared review.

Publication still uses the existing recommendation check, live remote HEAD
guard and per-PR/HEAD deduplication. No publisher or graph edge is loosened.
Tests compose fake agy with the real runner and publisher and fake gh; they
send no GitHub comments. Regression RED was observed with the old runner:
`1 file inspection attempt(s) failed out of 4`. GREEN covers corrected path
and complete evidence, missing evidence, permission errors, unknown errors,
attempted mutation, moved HEAD and duplicate publication.
An additional RED regression exposed forged empty-diff prompt context; binding
the gate to workflow metadata closes it. The workflow capture harness verifies
that initial execution and Continue both pass the same stored PR target.

The existing ACL test used an uninitialized temporary directory without an
explicit baseline. In cockpit sessions that directory can inherit the parent
checkout's Git state. It now initializes an isolated test repo and compares an
explicit baseline, still verifying that file permissions are unchanged.

## Local verification (Windows, 2026-10-10)

- Regression RED against the old runner (source-only stash), then GREEN after
  restoring the fix. Final targeted runner/publication/workflow suites: 104 passed.
- `npm run typecheck` and `npm run build`: passed, including check:pack.
- Full `npm test`: 8569 passed, 517 failed, 33 skipped. The final targeted run
  uses `--maxWorkers=1` and passes; the full default-parallel run also encountered
  timeouts. No claim is made that all 517 failures have the same cause.
- `npm run test:unit`: 39 passed, 2 failed, 1 skipped. Both failures reproduce
  on the unmodified checkout (`spawnSync mkdir ENOENT`, `spawnSync /bin/sh ENOENT`).
- `paths.test.ts` on the unmodified checkout reproduces all 13 Windows failures
  seen for that file in the full suite.
- `npm run test:package`: 16 passed, 1 failed (`spawn EINVAL` in package CLI test),
  also reproduced on the unmodified checkout.

## Isolated Linux verification (2026-10-10)

Node 22 Alpine, LF source archive plus the final patch, non-root uid 1000,
four Vitest workers; dependencies installed from the unchanged lockfile inside
the task's isolated container. No host runtime or credentials were mounted.

- Typecheck, build/check:pack: passed.
- Full `npm test -- --maxWorkers=4`: 9099 passed, 25 failed, 4 skipped.
  All 25 failing cases reproduce against unchanged base commit
  `3f60e5215fab00f1ff4d8b7d2b2942312794a2da` in the same environment:
  24 in the eight provider/config/gitignore test files, plus the workspace
  agent-profile vendor-home case (run separately).
- `npm run test:unit`: 42 passed; `npm run test:package`: 17 passed.

An earlier Linux run was discarded because its Windows-generated archive
contained CRLF shebangs, ran as root, and lacked curl. Those failures are not
evidence about this patch. The corrected run above is the reported result.

The change is suitable for a draft PR, not a claim of a green repository-wide
gate. Existing suite failures remain outside this patch. Installed host
Cezar/agy versions and upstream history are unchanged.
